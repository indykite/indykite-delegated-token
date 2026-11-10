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
import importlib
from types import ModuleType
from typing import Any

import pytest
from _harness import serve

from indykite_delegated_token import MCP_EXTENSION_ID, use_token
from indykite_delegated_token.client import ExtensionRegistry, _transport_core
from indykite_delegated_token.client._transport_core import MAX_BODY

TARGET = "https://mcp.example.com/mcp"
METADATA = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
LINK = "https://mcp.example.com/prm"


@pytest.fixture(params=["httpx", "httpx2"])
def lib(request: pytest.FixtureRequest) -> tuple[ModuleType, ModuleType]:
    """The HTTP library and the package's adapter for it."""
    http = pytest.importorskip(request.param)
    adapter = importlib.import_module(f"indykite_delegated_token.client.{request.param}")
    return http, adapter


class Seen:
    """What the target saw of a request. The transport resends the same request object, so keep a copy."""

    def __init__(self, url: str, headers: dict[str, str], content: bytes) -> None:
        self.url = url
        self.headers = {name.lower(): value for name, value in headers.items()}
        self.content = content


class Target:
    """A fake MCP endpoint, served through the HTTP library's MockTransport."""

    def __init__(self, *, announced: bool = True, metadata_status: int = 200, challenge: str | None = None) -> None:
        self.announced = announced
        self.metadata_status = metadata_status
        self.challenge = challenge
        self.requests: list[Seen] = []

    def __call__(self, request: Any) -> Any:
        http = importlib.import_module(type(request).__module__.split(".")[0])
        self.requests.append(Seen(str(request.url), dict(request.headers), request.content))
        url = str(request.url)
        if url in (METADATA, LINK):
            if url == METADATA and self.challenge is not None:
                return http.Response(404)
            body = {"resource": TARGET, "mcp_extensions": {MCP_EXTENSION_ID: {}} if self.announced else {}}
            return http.Response(self.metadata_status, json=body)
        if self.challenge is not None and "X-IK-Token" not in request.headers:
            return http.Response(401, headers={"WWW-Authenticate": self.challenge})
        return http.Response(200, json={"seen": request.headers.get("X-IK-Token")})

    def calls(self) -> list[Seen]:
        return [r for r in self.requests if r.url not in (METADATA, LINK)]

    def metadata_requests(self) -> list[Seen]:
        return [r for r in self.requests if r.url in (METADATA, LINK)]


def client(lib: tuple[ModuleType, ModuleType], target: Target, **kwargs: Any) -> Any:
    http, adapter = lib
    return adapter.http_client(transport=http.MockTransport(target), registry=ExtensionRegistry(), **kwargs)


async def test_no_token_no_header_no_discovery(lib: tuple[ModuleType, ModuleType]) -> None:
    target = Target()
    async with client(lib, target) as c:
        response = await c.post(TARGET, content=b"{}")
    assert response.json() == {"seen": None}
    assert target.metadata_requests() == []


async def test_announced_target_gets_token(lib: tuple[ModuleType, ModuleType]) -> None:
    target = Target()
    async with client(lib, target, headers={"Authorization": "Bearer service"}) as c:
        with use_token("tok-a"):
            first = await c.post(TARGET, content=b"{}")
        with use_token("tok-b"):
            second = await c.post(TARGET, content=b"{}")
        third = await c.post(TARGET, content=b"{}")
    assert [first.json()["seen"], second.json()["seen"], third.json()["seen"]] == ["tok-a", "tok-b", None]
    [metadata] = target.metadata_requests()
    assert "authorization" not in metadata.headers
    assert "x-ik-token" not in metadata.headers


@pytest.mark.parametrize("status", [404, 500])
async def test_not_announced_target_gets_nothing(lib: tuple[ModuleType, ModuleType], status: int) -> None:
    target = Target(announced=False, metadata_status=status)
    async with client(lib, target) as c:
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}")
    assert response.json() == {"seen": None}


async def test_caller_header_is_kept(lib: tuple[ModuleType, ModuleType]) -> None:
    target = Target()
    async with client(lib, target) as c:
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}", headers={"X-IK-Token": "caller"})
    assert response.json() == {"seen": "caller"}


async def test_401_link_is_followed_and_retried_once(lib: tuple[ModuleType, ModuleType]) -> None:
    target = Target(challenge=f'Bearer resource_metadata="{LINK}"')
    async with client(lib, target) as c:
        with use_token("tok"):
            response = await c.post(TARGET, content=b'{"jsonrpc":"2.0"}')
            again = await c.post(TARGET, content=b"{}")
    assert response.status_code == 200
    assert response.json() == {"seen": "tok"}
    assert again.json() == {"seen": "tok"}
    calls = target.calls()
    assert [c.headers.get("x-ik-token") for c in calls] == [None, "tok", "tok"]
    assert calls[1].content == b'{"jsonrpc":"2.0"}'
    assert [r.url for r in target.metadata_requests()] == [METADATA, LINK]


async def test_401_cross_origin_link_is_ignored(lib: tuple[ModuleType, ModuleType]) -> None:
    target = Target(challenge='Bearer resource_metadata="https://evil.example.com/prm"')
    async with client(lib, target) as c:
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}")
    assert response.status_code == 401
    assert len(target.calls()) == 1


async def test_401_not_announced_is_not_retried(lib: tuple[ModuleType, ModuleType]) -> None:
    target = Target(announced=False, challenge=f'Bearer resource_metadata="{LINK}"')
    async with client(lib, target) as c:
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}")
    assert response.status_code == 401
    assert len(target.calls()) == 1


@pytest.mark.parametrize(
    "challenge",
    [
        'Bearer realm="mcp"',
        'Bearer resource_metadata="https://evil.example.com/prm"',
        'Bearer resource_metadata="https://mcp.example.com:bad/prm"',
    ],
    ids=["no-link", "cross-origin", "malformed"],
)
async def test_401_without_usable_link_is_not_read(lib: tuple[ModuleType, ModuleType], challenge: str) -> None:
    http, adapter = lib
    read: list[bool] = []

    class Body(http.AsyncByteStream):  # type: ignore[name-defined,misc]
        async def __aiter__(self) -> Any:
            read.append(True)
            yield b"denied"

    def answer(request: Any) -> Any:
        if "/.well-known/" in str(request.url):
            return http.Response(404)
        return http.Response(401, headers={"WWW-Authenticate": challenge}, stream=Body())

    async with adapter.http_client(transport=http.MockTransport(answer), registry=ExtensionRegistry()) as c:
        with use_token("tok"):
            async with c.stream("POST", TARGET, content=b"{}") as response:
                assert response.status_code == 401
                assert read == []
                assert await response.aread() == b"denied"


async def test_streamed_body_is_not_replayed(lib: tuple[ModuleType, ModuleType]) -> None:
    http, adapter = lib
    metadata = Target(challenge=f'Bearer resource_metadata="{LINK}"')
    sent: list[str] = []

    class Inner(http.AsyncBaseTransport):  # type: ignore[name-defined,misc]
        """Answers the endpoint with a 401 without reading the streamed body, as a network transport would."""

        async def handle_async_request(self, request: Any) -> Any:
            sent.append(str(request.url))
            if str(request.url) in (METADATA, LINK):
                return metadata(request)
            return http.Response(401, headers={"WWW-Authenticate": metadata.challenge})

    async def body() -> Any:
        yield b"{}"

    async with adapter.http_client(transport=Inner(), registry=ExtensionRegistry()) as c:
        with use_token("tok"):
            response = await c.post(TARGET, content=body())
    assert response.status_code == 401
    assert sent == [METADATA, TARGET]


@pytest.mark.parametrize(
    "location",
    ["https://evil.example.com/steal", "https://mcp.example.com/other"],
    ids=["cross-origin", "same-origin-not-announced"],
)
async def test_redirect_does_not_carry_the_token(lib: tuple[ModuleType, ModuleType], location: str) -> None:
    http, _ = lib
    seen: dict[str, str | None] = {}

    def answer(request: Any) -> Any:
        url = str(request.url)
        seen[url] = request.headers.get("X-IK-Token")
        if url == METADATA:
            return http.Response(200, json={"resource": TARGET, "mcp_extensions": {MCP_EXTENSION_ID: {}}})
        if url == TARGET:
            return http.Response(307, headers={"Location": location})
        return http.Response(404 if "/.well-known/" in url else 200)

    async with client(lib, answer, follow_redirects=True) as c:  # type: ignore[arg-type]
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}")
    assert response.status_code == 200
    assert seen[TARGET] == "tok"
    assert seen[location] is None
    assert "x-ik-token" not in response.request.headers


@pytest.mark.parametrize(
    ("location", "expected"),
    [
        ("https://evil.example.com/steal", None),
        ("http://mcp.example.com/mcp", None),
        ("https://mcp.example.com/other", "tok"),
    ],
    ids=["cross-origin", "https-to-http", "same-origin"],
)
async def test_redirect_to_announcing_target(
    lib: tuple[ModuleType, ModuleType], location: str, expected: str | None
) -> None:
    http, _ = lib
    seen: dict[str, str | None] = {}

    def answer(request: Any) -> Any:
        url = str(request.url)
        if "/.well-known/oauth-protected-resource" in url:  # every target announces, the redirect's too
            resource = url.replace("/.well-known/oauth-protected-resource", "")
            return http.Response(200, json={"resource": resource, "mcp_extensions": {MCP_EXTENSION_ID: {}}})
        seen[url] = request.headers.get("X-IK-Token")
        if url == TARGET:
            return http.Response(307, headers={"Location": location})
        return http.Response(200)

    async with client(lib, answer, follow_redirects=True) as c:  # type: ignore[arg-type]
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}")
    assert response.status_code == 200
    assert seen == {TARGET: "tok", location: expected}


async def test_caller_request_is_not_changed(lib: tuple[ModuleType, ModuleType]) -> None:
    target = Target()
    async with client(lib, target) as c:
        request = c.build_request("POST", TARGET, content=b"{}")
        with use_token("tok"):
            response = await c.send(request)
    assert response.json() == {"seen": "tok"}
    assert "x-ik-token" not in request.headers


async def test_metadata_fetch_has_a_timeout(lib: tuple[ModuleType, ModuleType]) -> None:
    http, adapter = lib
    timeouts: list[Any] = []

    def answer(request: Any) -> Any:
        if str(request.url) == METADATA:
            timeouts.append(request.extensions.get("timeout"))
        return http.Response(404)

    for timeout in (http.Timeout(5.0), None):
        transport = adapter.DelegatedTokenTransport(http.MockTransport(answer), registry=ExtensionRegistry())
        async with http.AsyncClient(transport=transport, timeout=timeout) as c:
            with use_token("tok"):
                await c.post(TARGET, content=b"{}")
    assert timeouts == [http.Timeout(5.0).as_dict(), http.Timeout(10.0).as_dict()]


async def test_401_frees_its_connection_before_discovery(lib: tuple[ModuleType, ModuleType]) -> None:
    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse, Response
    from starlette.routing import Route

    http, adapter = lib

    def app(base_url: str) -> Starlette:
        async def endpoint(request: Request) -> Response:
            if "x-ik-token" not in request.headers:
                return Response(b"x" * 10_000, 401, {"WWW-Authenticate": f'Bearer resource_metadata="{base_url}/prm"'})
            return JSONResponse({"seen": request.headers["x-ik-token"]})

        async def metadata(_: Request) -> Response:
            if _.url.path == "/prm":
                return JSONResponse({"resource": f"{base_url}/mcp", "mcp_extensions": {MCP_EXTENSION_ID: {}}})
            return Response(status_code=404)

        return Starlette(
            routes=[
                Route("/mcp", endpoint, methods=["POST"]),
                Route("/prm", metadata),
                Route("/.well-known/oauth-protected-resource/mcp", metadata),
            ]
        )

    async with serve(app) as base_url:
        inner = http.AsyncHTTPTransport(limits=http.Limits(max_connections=1))
        transport = adapter.DelegatedTokenTransport(inner, registry=ExtensionRegistry())
        async with http.AsyncClient(transport=transport, timeout=http.Timeout(5.0)) as c:
            with use_token("tok"):
                async with asyncio.timeout(10):
                    # concurrent calls: the ones that wait for another's metadata fetch must not hold the connection
                    responses = await asyncio.gather(*(c.post(f"{base_url}/mcp", content=b"{}") for _ in range(3)))
    assert [r.json() for r in responses] == [{"seen": "tok"}] * 3


@pytest.mark.parametrize("size", [MAX_BODY, MAX_BODY + 1], ids=["small", "large"])
async def test_streamed_401_is_returned_intact(lib: tuple[ModuleType, ModuleType], size: int) -> None:
    http, adapter = lib
    body = b"x" * size
    urls: list[str] = []

    class Chunks(http.AsyncByteStream):  # type: ignore[name-defined,misc]
        async def __aiter__(self) -> Any:
            for start in range(0, len(body), 1000):
                yield body[start : start + 1000]

    def answer(request: Any) -> Any:
        urls.append(str(request.url))
        if "/.well-known/" in str(request.url) or str(request.url) == LINK:
            return http.Response(404)
        return http.Response(401, headers={"WWW-Authenticate": f'Bearer resource_metadata="{LINK}"'}, stream=Chunks())

    async with adapter.http_client(transport=http.MockTransport(answer), registry=ExtensionRegistry()) as c:
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}")
    assert response.status_code == 401
    assert response.content == body
    assert (LINK in urls) == (size <= MAX_BODY)  # a body too large to hold skips the discovery


async def test_large_metadata_is_refused(lib: tuple[ModuleType, ModuleType]) -> None:
    http, _ = lib
    padding = "x" * MAX_BODY

    def answer(request: Any) -> Any:
        if str(request.url) == METADATA:
            body = {"resource": TARGET, "mcp_extensions": {MCP_EXTENSION_ID: {}}, "padding": padding}
            return http.Response(200, json=body)
        return http.Response(200, json={"seen": request.headers.get("X-IK-Token")})

    async with client(lib, answer) as c:  # type: ignore[arg-type]
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}")
    assert response.json() == {"seen": None}


async def test_compressed_metadata_is_refused(lib: tuple[ModuleType, ModuleType]) -> None:
    import gzip
    import json

    http, _ = lib
    accept_encoding: list[str | None] = []
    body = {"resource": TARGET, "mcp_extensions": {MCP_EXTENSION_ID: {}}, "padding": " " * (8 * 1024 * 1024)}
    compressed = gzip.compress(json.dumps(body).encode())
    assert len(compressed) < MAX_BODY  # small on the wire, 8 MiB once decoded

    def answer(request: Any) -> Any:
        if str(request.url) == METADATA:
            accept_encoding.append(request.headers.get("Accept-Encoding"))
            return http.Response(200, headers={"Content-Encoding": "gzip"}, content=compressed)
        return http.Response(200, json={"seen": request.headers.get("X-IK-Token")})

    async with client(lib, answer) as c:  # type: ignore[arg-type]
        with use_token("tok"):
            response = await c.post(TARGET, content=b"{}")
    assert response.json() == {"seen": None}
    assert accept_encoding == ["identity"]


async def test_slow_401_times_out_and_is_closed(
    lib: tuple[ModuleType, ModuleType], monkeypatch: pytest.MonkeyPatch
) -> None:
    http, adapter = lib
    monkeypatch.setattr(_transport_core, "READ_DEADLINE", 0.2)
    closed: list[bool] = []

    class Trickle(http.AsyncByteStream):  # type: ignore[name-defined,misc]
        async def __aiter__(self) -> Any:
            while True:  # never ends, but never waits long for a chunk either
                await asyncio.sleep(0.01)
                yield b" "

        async def aclose(self) -> None:
            closed.append(True)

    def answer(request: Any) -> Any:
        return http.Response(401, headers={"WWW-Authenticate": f'Bearer resource_metadata="{LINK}"'}, stream=Trickle())

    async with adapter.http_client(transport=http.MockTransport(answer), registry=ExtensionRegistry()) as c:
        with use_token("tok"), pytest.raises(http.ReadTimeout):
            async with asyncio.timeout(5):
                await c.post(TARGET, content=b"{}")
    assert closed


async def test_metadata_fetch_has_a_deadline(
    lib: tuple[ModuleType, ModuleType], monkeypatch: pytest.MonkeyPatch
) -> None:
    http, _ = lib
    monkeypatch.setattr(_transport_core, "READ_DEADLINE", 0.2)

    class Trickle(http.AsyncByteStream):  # type: ignore[name-defined,misc]
        async def __aiter__(self) -> Any:
            while True:  # never ends, but never waits long for a chunk either
                await asyncio.sleep(0.01)
                yield b" "

    def answer(request: Any) -> Any:
        if str(request.url) == METADATA:
            return http.Response(200, stream=Trickle())
        return http.Response(200, json={"seen": request.headers.get("X-IK-Token")})

    async with client(lib, answer) as c:  # type: ignore[arg-type]
        with use_token("tok"):
            async with asyncio.timeout(5):
                response = await c.post(TARGET, content=b"{}")
    assert response.json() == {"seen": None}


async def test_http_client_defaults(lib: tuple[ModuleType, ModuleType]) -> None:
    http, adapter = lib
    async with adapter.httpx_client_factory(headers={"A": "b"}) as c:
        assert c.timeout == http.Timeout(30.0, read=300.0)
        assert not c.follow_redirects
        assert c.headers["A"] == "b"
        assert isinstance(c._transport, adapter.DelegatedTokenTransport)
    async with adapter.httpx_client_factory(follow_redirects=True, timeout=http.Timeout(5.0)) as c:
        assert c.follow_redirects
        assert c.timeout == http.Timeout(5.0)


async def test_transport_closes_inner(lib: tuple[ModuleType, ModuleType]) -> None:
    http, adapter = lib
    closed: list[bool] = []

    class Inner(http.AsyncBaseTransport):  # type: ignore[name-defined,misc]
        async def aclose(self) -> None:
            closed.append(True)

    transport = adapter.DelegatedTokenTransport(Inner())
    async with transport:
        pass
    await transport.aclose()
    assert closed == [True, True]
