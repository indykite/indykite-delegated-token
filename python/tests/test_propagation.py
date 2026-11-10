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

"""End-to-end propagation through each kind of server, with concurrent requests.

A sample MCP server with ``install(server)`` has a ``relay`` tool. Two clients call it at the same time, twice in the
same session, each call with its own token. The tool waits until both calls run, then calls an MCP target and an A2A
agent that announce the extension, and an MCP target and an A2A agent that do not. Each must see the token of the call
it belongs to, or none.

The token changes between the calls of a session on purpose: a stateful session handles its messages in a task
started by its first request, so a token read from the wrong place would stay the first call's.

Where FastMCP is installed, the tool also calls both MCP targets with FastMCP's client and the package's
``httpx_client_factory``, as documented.
"""

import asyncio
import importlib.util
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

import pytest
from _harness import (
    MCP_MAJOR,
    a2a_agent,
    ask_agent,
    call_tool,
    mcp_session,
    mcp_target,
    sdk,
    serve,
)

from indykite_delegated_token import A2A_EXTENSION_URI, get_delegated_token, install, use_token
from indykite_delegated_token.client import ExtensionRegistry

pytest.importorskip("mcp")
pytest.importorskip("a2a")

HAS_FASTMCP = importlib.util.find_spec("fastmcp") is not None


@dataclass
class Targets:
    mcp: str
    mcp_silent: str
    agent: str
    agent_silent: str


@pytest.fixture
async def targets() -> AsyncIterator[Targets]:
    async with (
        serve(mcp_target(announce=True)) as mcp,
        serve(mcp_target(announce=False)) as mcp_silent,
        serve(a2a_agent(announce=True)) as agent,
        serve(a2a_agent(announce=False)) as agent_silent,
    ):
        yield Targets(f"{mcp}/mcp", f"{mcp_silent}/mcp", agent, agent_silent)


async def fastmcp_echo(url: str) -> Any:
    """Call the ``echo`` tool of ``url`` with FastMCP's client and the package's factory."""
    from indykite_delegated_token.client.httpx2 import httpx_client_factory

    transport = sdk("fastmcp.client.transports").StreamableHttpTransport(url, httpx_client_factory=httpx_client_factory)
    async with sdk("fastmcp").Client(transport) as client:
        result = await client.call_tool("echo", {})
    return json.loads(result.content[0].text)


def relay(targets: Targets, barrier: asyncio.Barrier) -> Callable[[], Any]:
    """The body of the sample server's tool."""
    registry = ExtensionRegistry()

    async def body() -> str:
        async with asyncio.timeout(10):
            await barrier.wait()  # both calls are running now
        seen: dict[str, Any] = {"server": get_delegated_token()}
        async with mcp_session(targets.mcp, propagate=True, registry=registry) as session:
            seen["mcp"] = await call_tool(session, "echo")
        async with mcp_session(targets.mcp_silent, propagate=True, registry=registry) as session:
            seen["mcp_silent"] = await call_tool(session, "echo")
        if HAS_FASTMCP:
            seen["fastmcp"] = await fastmcp_echo(targets.mcp)
            seen["fastmcp_silent"] = await fastmcp_echo(targets.mcp_silent)
        seen["agent"] = await ask_agent(targets.agent)
        seen["agent_silent"] = await ask_agent(targets.agent_silent)
        return json.dumps(seen)

    return body


def sample_mcp_v2(body: Callable[[], Any], stateless: bool) -> Any:
    if MCP_MAJOR < 2:
        pytest.skip("needs mcp 2.x")
    server = sdk("mcp.server.mcpserver").MCPServer("sample")

    @server.tool()
    async def relay() -> str:
        return str(await body())

    install(server)
    return server.streamable_http_app(stateless_http=stateless)


def sample_fastmcp(body: Callable[[], Any], stateless: bool) -> Any:
    fastmcp = pytest.importorskip("fastmcp")
    server = fastmcp.FastMCP("sample")

    @server.tool()
    async def relay() -> str:
        return str(await body())

    install(server)
    return server.http_app(path="/mcp", stateless_http=stateless)


def sample_mcp_v1(body: Callable[[], Any], stateless: bool) -> Any:
    if MCP_MAJOR >= 2:
        pytest.skip("needs mcp 1.x")
    server = sdk("mcp.server.fastmcp").FastMCP("sample", stateless_http=stateless)

    @server.tool()
    async def relay() -> str:
        return str(await body())

    install(server)
    return server.streamable_http_app()


SAMPLES = {"mcp_v2": sample_mcp_v2, "fastmcp": sample_fastmcp, "mcp_v1": sample_mcp_v1}


@pytest.mark.parametrize("stateless", [True, False], ids=["stateless", "stateful"])
@pytest.mark.parametrize("kind", list(SAMPLES))
async def test_concurrent_requests_keep_their_tokens(targets: Targets, kind: str, stateless: bool) -> None:
    barrier = asyncio.Barrier(2)
    app = SAMPLES[kind](relay(targets, barrier), stateless)

    async def user(url: str, tokens: list[str]) -> list[Any]:
        async with mcp_session(url, headers={"X-IK-Token": tokens[0]}) as session:
            calls = []
            for token in tokens:
                session.http.headers["X-IK-Token"] = token
                calls.append(await call_tool(session, "relay"))
            return calls

    users = [["token-A1", "token-A2"], ["token-B1", "token-B2"]]
    async with serve(lambda _: app) as sample:
        results = await asyncio.gather(*(user(f"{sample}/mcp", tokens) for tokens in users))

    for tokens, calls in zip(users, results, strict=True):
        for token, seen in zip(tokens, calls, strict=True):
            expected = {
                "server": token,
                "mcp": token,
                "mcp_silent": None,
                "agent": {"token": token, "extensions": A2A_EXTENSION_URI},
                "agent_silent": {"token": None, "extensions": None},
            }
            if HAS_FASTMCP:
                expected |= {"fastmcp": token, "fastmcp_silent": None}
            assert seen == expected


async def test_long_lived_client(targets: Targets) -> None:
    """A client session opened before the token is set.

    The mcp 2.x client sends each message in the context of its sender, so the token of each call goes out. The mcp
    1.x client sends from a task started when the session opened: open it inside the tool call instead.
    """
    async with mcp_session(targets.mcp, propagate=True, registry=ExtensionRegistry()) as session:
        seen = []
        for token in ["token-A", "token-B"]:
            with use_token(token):
                seen.append(await call_tool(session, "echo"))
    if MCP_MAJOR >= 2:
        assert seen == ["token-A", "token-B"]
    else:
        assert seen == [None, None]
