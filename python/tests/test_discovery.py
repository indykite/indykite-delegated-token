# Copyright (c) 2026 IndyKite
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import asyncio
import json
import threading

import anyio
import anyio.to_thread
import pytest

from indykite_delegated_token import MCP_EXTENSION_ID
from indykite_delegated_token.client import _discovery
from indykite_delegated_token.client._discovery import (
    ExtensionRegistry,
    challenge_link,
    metadata_url,
    resource_metadata_link,
    same_origin,
    secure_transport,
    target_key,
)

TARGET = "https://mcp.example.com/tools/mcp"
METADATA = "https://mcp.example.com/.well-known/oauth-protected-resource/tools/mcp"


def prm(resource: str = "https://mcp.example.com/tools/mcp", announced: bool = True) -> bytes:
    body: dict[str, object] = {"resource": resource}
    if announced:
        body["mcp_extensions"] = {MCP_EXTENSION_ID: {}}
    return json.dumps(body).encode()


class FakeFetch:
    def __init__(self, *answers: tuple[int, bytes] | Exception) -> None:
        self.answers = list(answers)
        self.urls: list[str] = []

    async def __call__(self, url: str) -> tuple[int, bytes]:
        self.urls.append(url)
        await asyncio.sleep(0)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


class Clock:
    """Replaces the registry's monotonic clock, so a test can move time forward."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.now = 0.0
        monkeypatch.setattr(_discovery, "monotonic", lambda: self.now)


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://Example.com:443/mcp?q=1#f", "https://example.com/mcp?q=1"),
        ("http://example.com:8080/mcp", "http://example.com:8080/mcp"),
        ("http://user:pw@example.com/", "http://example.com/"),
        ("https://example.com", "https://example.com/"),
        ("http://[::1]:8080/mcp", "http://[::1]:8080/mcp"),
    ],
)
def test_target_key(url: str, expected: str) -> None:
    assert target_key(url) == expected


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (TARGET, METADATA),
        ("https://mcp.example.com", "https://mcp.example.com/.well-known/oauth-protected-resource"),
        ("https://mcp.example.com/", "https://mcp.example.com/.well-known/oauth-protected-resource"),
        ("https://mcp.example.com/mcp/", "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/"),
        ("https://mcp.example.com/mcp?t=a", "https://mcp.example.com/.well-known/oauth-protected-resource/mcp?t=a"),
        ("https://mcp.example.com/?t=a", "https://mcp.example.com/.well-known/oauth-protected-resource?t=a"),
    ],
)
def test_metadata_url(url: str, expected: str) -> None:
    assert metadata_url(url) == expected


def test_same_origin() -> None:
    assert same_origin("https://a.com/x", "https://a.com:443/y")
    assert not same_origin("https://a.com/x", "http://a.com/x")
    assert not same_origin("https://a.com/x", "https://b.com/x")


def test_challenge_link() -> None:
    link = "https://mcp.example.com/prm"
    assert challenge_link(TARGET, f'Bearer resource_metadata="{link}"') == link
    assert challenge_link(TARGET, 'Bearer resource_metadata="https://evil.example.com/prm"') is None
    assert challenge_link(TARGET, 'Bearer resource_metadata="https://mcp.example.com:bad/prm"') is None
    assert challenge_link(TARGET, 'Bearer realm="x"') is None


async def test_query_selects_another_resource() -> None:
    registry = ExtensionRegistry()
    fetch = FakeFetch((200, prm(resource=f"{TARGET}?tenant=a")))
    assert await registry.discover(f"{TARGET}?tenant=a", fetch)
    assert not await registry.discover(f"{TARGET}?tenant=b", fetch)
    assert fetch.urls == [f"{METADATA}?tenant=a", f"{METADATA}?tenant=b"]


def test_resource_metadata_link() -> None:
    assert resource_metadata_link('Bearer realm="x", resource_metadata="https://a/b"') == "https://a/b"
    assert resource_metadata_link("Bearer resource_metadata=https://a/b, error=x") == "https://a/b"
    assert resource_metadata_link('Bearer realm="x"') is None


async def test_announced() -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch((200, prm()))
    assert await registry.discover(TARGET, fetch)
    assert await registry.discover(TARGET, fetch)
    assert fetch.urls == [METADATA]
    assert registry.known(TARGET) is True


@pytest.mark.parametrize(
    "answer",
    [
        (200, prm(announced=False)),
        (200, prm(resource="https://other.example.com/tools/mcp")),
        (200, prm(resource="https://mcp.example.com:bad/tools/mcp")),
        (200, prm(resource="https://[mcp.example.com/tools/mcp")),
        (200, b"not json"),
        (200, b"[]"),
        (404, b""),
    ],
    ids=["not-announced", "wrong-resource", "bad-port", "bad-ipv6", "not-json", "not-object", "404"],
)
async def test_not_announced_is_cached(answer: tuple[int, bytes]) -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch(answer)
    assert not await registry.discover(TARGET, fetch)
    assert not await registry.discover(TARGET, fetch)
    assert len(fetch.urls) == 1
    assert registry.known(TARGET) is False


@pytest.mark.parametrize(
    ("answer", "ttl"),
    [((200, prm()), 3600), ((404, b""), 3600), ((503, b""), 60), ((401, b""), 60)],
    ids=["announced", "404", "5xx", "401"],
)
async def test_answers_expire(answer: tuple[int, bytes], ttl: int, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = Clock(monkeypatch)
    registry, fetch = ExtensionRegistry(), FakeFetch(answer, (200, prm(announced=answer[0] != 200)))
    first = await registry.discover(TARGET, fetch)
    clock.now = ttl - 1
    assert await registry.discover(TARGET, fetch) is first
    clock.now = ttl
    assert await registry.discover(TARGET, fetch) is not first  # the target changed its answer
    assert len(fetch.urls) == 2


@pytest.mark.parametrize(("answer", "ttl"), [((404, b""), 3600), ((200, prm(announced=False)), 3600), ((503, b""), 60)])
async def test_challenge_answers_are_cached(
    answer: tuple[int, bytes], ttl: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    registry, fetch = ExtensionRegistry(), FakeFetch(answer)
    challenge = 'Bearer resource_metadata="https://mcp.example.com/prm"'
    assert not await registry.learn_from_challenge(TARGET, challenge, fetch)
    clock.now = ttl - 1
    assert not await registry.learn_from_challenge(TARGET, challenge, fetch)  # the target keeps answering 401
    assert len(fetch.urls) == 1
    other = 'Bearer resource_metadata="https://mcp.example.com/other"'
    assert not await registry.learn_from_challenge(TARGET, other, fetch)  # another link is followed
    clock.now = ttl
    assert not await registry.learn_from_challenge(TARGET, challenge, fetch)  # and the first one again once expired
    assert len(fetch.urls) == 3


async def test_challenge_overrides_well_known() -> None:
    registry = ExtensionRegistry()
    assert not await registry.discover(TARGET, FakeFetch((404, b"")))
    challenge = 'Bearer resource_metadata="https://mcp.example.com/prm"'
    assert await registry.learn_from_challenge(TARGET, challenge, FakeFetch((200, prm())))
    assert registry.known(TARGET) is True


async def test_network_errors_are_not_cached() -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch(OSError("refused"), (200, prm()))
    assert not await registry.discover(TARGET, fetch)
    assert registry.known(TARGET) is None
    assert await registry.discover(TARGET, fetch)
    assert len(fetch.urls) == 2


async def test_least_recently_used_targets_are_dropped() -> None:
    registry, fetch = ExtensionRegistry(max_targets=2), FakeFetch((404, b""))
    a, b, c = (f"https://mcp.example.com/{path}" for path in "abc")
    await registry.discover(a, fetch)
    await registry.discover(b, fetch)
    assert registry.known(a) is False  # used after b
    await registry.discover(c, fetch)
    assert [registry.known(a), registry.known(b), registry.known(c)] == [False, None, False]


async def test_concurrent_first_calls_fetch_once() -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch((200, prm()))
    results = await asyncio.gather(*(registry.discover(TARGET, fetch) for _ in range(10)))
    assert all(results)
    assert fetch.urls == [METADATA]


async def test_concurrent_calls_share_a_failure() -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch(OSError("timeout"), (200, prm()))
    results = await asyncio.gather(*(registry.discover(TARGET, fetch) for _ in range(10)))
    assert not any(results)
    assert fetch.urls == [METADATA]
    assert await registry.discover(TARGET, fetch)  # a later call tries again
    assert fetch.urls == [METADATA, METADATA]


async def test_concurrent_challenges_fetch_once() -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch((200, prm(announced=False)))
    challenge = 'Bearer resource_metadata="https://mcp.example.com/prm"'
    results = await asyncio.gather(*(registry.learn_from_challenge(TARGET, challenge, fetch) for _ in range(10)))
    assert not any(results)
    assert fetch.urls == ["https://mcp.example.com/prm"]


async def test_announced_is_not_downgraded() -> None:
    registry, slow, started = ExtensionRegistry(), asyncio.Event(), asyncio.Event()

    async def well_known(url: str) -> tuple[int, bytes]:
        started.set()
        await slow.wait()
        return 404, b""

    discovery = asyncio.create_task(registry.discover(TARGET, well_known))
    await started.wait()
    challenge = 'Bearer resource_metadata="https://mcp.example.com/prm"'
    async with asyncio.timeout(5):  # the challenge must not wait for the well-known fetch
        assert await registry.learn_from_challenge(TARGET, challenge, FakeFetch((200, prm())))
    slow.set()
    assert not await discovery  # the well-known URL itself did not announce
    assert registry.known(TARGET) is True


def test_separate_event_loops() -> None:
    registry = ExtensionRegistry()
    both = threading.Barrier(2, timeout=5)
    results: list[bool] = []

    async def fetch(url: str) -> tuple[int, bytes]:
        await anyio.to_thread.run_sync(both.wait)  # the fetches of both loops are in progress at once
        return 200, prm()

    def run() -> None:
        results.append(anyio.run(registry.discover, TARGET, fetch))

    threads = [threading.Thread(target=run, daemon=True) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
    assert results == [True, True]


async def test_targets_are_separate() -> None:
    registry = ExtensionRegistry()
    assert await registry.discover(TARGET, FakeFetch((200, prm())))
    assert registry.known("https://mcp.example.com/other") is None


async def test_challenge_same_origin() -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch((404, b""), (200, prm()))
    assert not await registry.discover(TARGET, fetch)
    link = "https://mcp.example.com/custom-metadata"
    assert await registry.learn_from_challenge(TARGET, f'Bearer resource_metadata="{link}"', fetch)
    assert fetch.urls == [METADATA, link]
    assert registry.known(TARGET) is True


async def test_challenge_cross_origin_is_refused() -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch((200, prm()))
    challenge = 'Bearer resource_metadata="https://evil.example.com/.well-known/oauth-protected-resource"'
    assert not await registry.learn_from_challenge(TARGET, challenge, fetch)
    assert fetch.urls == []


@pytest.mark.parametrize("link", ["https://mcp.example.com:bad/prm", "https://[mcp.example.com/prm"])
async def test_challenge_malformed_link_is_ignored(link: str) -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch((200, prm()))
    assert not await registry.learn_from_challenge(TARGET, f'Bearer resource_metadata="{link}"', fetch)
    assert fetch.urls == []


async def test_challenge_without_link() -> None:
    registry, fetch = ExtensionRegistry(), FakeFetch((200, prm()))
    assert not await registry.learn_from_challenge(TARGET, 'Bearer realm="x"', fetch)
    assert fetch.urls == []


async def test_clear() -> None:
    registry = ExtensionRegistry()
    assert await registry.discover(TARGET, FakeFetch((200, prm())))
    registry.clear()
    assert registry.known(TARGET) is None


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://mcp.example.com/mcp", True),
        ("http://localhost:8000/mcp", True),
        ("http://127.0.0.2/mcp", True),
        ("http://[::1]:8000/mcp", True),
        ("http://mcp.example.com/mcp", False),
        ("ftp://mcp.example.com/mcp", False),
        ("http://mcp.example.com:bad/mcp", False),
    ],
)
def test_secure_transport(url: str, expected: bool) -> None:
    assert secure_transport(url) is expected
