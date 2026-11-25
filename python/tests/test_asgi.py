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
from typing import Any

import httpx
import pytest
from _harness import MCP_MAJOR, call_tool, mcp_session, sdk, serve

from indykite_delegated_token import get_delegated_token, install
from indykite_delegated_token.server.asgi import DelegatedTokenASGIMiddleware


def app(barrier: asyncio.Barrier | None = None) -> Any:
    async def inner(scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            await send({"type": "lifespan.startup.complete", "token": get_delegated_token()})
            return
        if barrier is not None:
            async with asyncio.timeout(5):
                await barrier.wait()
        body = (get_delegated_token() or "-").encode()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": body})

    return DelegatedTokenASGIMiddleware(inner)


async def test_token_of_each_request() -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app()), base_url="http://agent") as client:
        assert (await client.get("/", headers={"X-IK-Token": "tok"})).text == "tok"
        assert (await client.get("/", headers={"x-ik-token": "other"})).text == "other"
        assert (await client.get("/")).text == "-"
    assert get_delegated_token() is None


async def test_concurrent_requests() -> None:
    transport = httpx.ASGITransport(app(asyncio.Barrier(2)))
    async with httpx.AsyncClient(transport=transport, base_url="http://agent") as client:
        a, b = await asyncio.gather(
            client.get("/", headers={"X-IK-Token": "token-A"}),
            client.get("/", headers={"X-IK-Token": "token-B"}),
        )
    assert (a.text, b.text) == ("token-A", "token-B")


async def test_other_scopes_pass_through() -> None:
    sent: list[Any] = []

    async def send(message: Any) -> None:
        sent.append(message)

    async def receive() -> Any:
        return {"type": "lifespan.startup"}

    await app()({"type": "lifespan"}, receive, send)
    assert sent == [{"type": "lifespan.startup.complete", "token": None}]


def recorder(seen: list[Any]) -> Any:
    """An app that records the scope and the delegated token it was called with."""

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        seen.append((scope, get_delegated_token()))

    return inner


async def noop_receive() -> Any:
    return {}


async def noop_send(_: Any) -> None:
    return None


async def test_strip_header() -> None:
    headers = [
        (b"accept", b"a"),
        (b"X-IK-Token", b"tok"),
        (b"x-custom", b"1"),
        (b"x-ik-token", b"other"),
        (b"x-custom", b"2"),
        (b"authorization", b"Bearer b"),
    ]
    original = list(headers)
    scope = {"type": "http", "headers": headers}
    seen: list[Any] = []

    await DelegatedTokenASGIMiddleware(recorder(seen), strip_header=True)(scope, noop_receive, noop_send)

    [(app_scope, token)] = seen
    assert token is None  # two token headers are ambiguous, so none is used
    assert app_scope["headers"] == [
        (b"accept", b"a"),
        (b"x-custom", b"1"),
        (b"x-custom", b"2"),
        (b"authorization", b"Bearer b"),
    ]
    assert scope == {"type": "http", "headers": original}
    assert scope["headers"] is headers


async def test_strip_header_without_headers() -> None:
    seen: list[Any] = []
    await DelegatedTokenASGIMiddleware(recorder(seen), strip_header=True)({"type": "http"}, noop_receive, noop_send)
    assert seen == [({"type": "http", "headers": []}, None)]


async def test_keep_header_by_default() -> None:
    scope = {"type": "http", "headers": [(b"x-ik-token", b"tok")]}
    seen: list[Any] = []
    await DelegatedTokenASGIMiddleware(recorder(seen))(scope, noop_receive, noop_send)
    assert seen == [(scope, "tok")]
    assert seen[0][0] is scope


@pytest.mark.parametrize("kind", ["lifespan", "websocket"])
async def test_strip_header_other_scopes_pass_through(kind: str) -> None:
    scope = {"type": kind, "headers": [(b"x-ik-token", b"tok")]}
    seen: list[Any] = []
    await DelegatedTokenASGIMiddleware(recorder(seen), strip_header=True)(scope, noop_receive, noop_send)
    assert seen == [(scope, None)]
    assert seen[0][0] is scope


def whoami_server() -> Any:
    """A stateless MCP server with ``install()`` and a tool that returns the delegated token it sees."""
    if MCP_MAJOR >= 2:
        server = sdk("mcp.server.mcpserver").MCPServer("whoami")
    else:
        server = sdk("mcp.server.fastmcp").FastMCP("whoami", stateless_http=True, json_response=True)

    @server.tool()
    async def whoami() -> str:
        return json.dumps(get_delegated_token())

    install(server)
    if MCP_MAJOR >= 2:
        return server.streamable_http_app(stateless_http=True, json_response=True)
    return server.streamable_http_app()


@pytest.mark.parametrize(("strip", "expected"), [(False, "tok"), (True, None)])
async def test_install_behind_strip_header(strip: bool, expected: str | None) -> None:
    """``install()`` reads the header from the request, so a stripping middleware hides the token from it."""
    pytest.importorskip("mcp")
    app = DelegatedTokenASGIMiddleware(whoami_server(), strip_header=strip)
    async with serve(lambda _: app) as base, mcp_session(f"{base}/mcp", headers={"X-IK-Token": "tok"}) as session:
        assert await call_tool(session, "whoami") == expected
