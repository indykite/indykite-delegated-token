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

"""In-process servers for the end-to-end tests: fake MCP targets, a fake A2A agent, and MCP client helpers.

The helpers use whichever major version of the MCP SDK is installed, so the same tests run in both environments.
"""

import asyncio
import contextlib
import importlib
import json
import socket
import uuid
from collections.abc import AsyncIterator, Callable
from contextvars import ContextVar
from importlib.metadata import PackageNotFoundError, version
from typing import Any

import httpx
import uvicorn
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from indykite_delegated_token import A2A_EXTENSION_URI, MCP_EXTENSION_ID
from indykite_delegated_token.client import ExtensionRegistry

try:
    MCP_MAJOR = int(version("mcp").split(".")[0])
except PackageNotFoundError:  # the tests that need the MCP SDK are skipped
    MCP_MAJOR = 0


def sdk(module: str) -> Any:
    """Import a module of an SDK whose API differs between its major versions, untyped."""
    return importlib.import_module(module)


AppFactory = Callable[[str], Any]


@contextlib.asynccontextmanager
async def serve(factory: AppFactory) -> AsyncIterator[str]:
    """Serve the app built by ``factory(base_url)`` on a free local port, in the running event loop."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    base_url = f"http://127.0.0.1:{sock.getsockname()[1]}"
    config = uvicorn.Config(factory(base_url), log_level="warning", timeout_graceful_shutdown=1, lifespan="on")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        while not server.started:
            if task.done():
                task.result()
                raise RuntimeError("test server exited before startup completed")
            await asyncio.sleep(0.01)
        yield base_url
    finally:
        server.should_exit = True
        await task
        sock.close()


def _prm_route(base_url: str, announce: bool) -> Route:
    async def metadata(_: Request) -> Response:
        if not announce:
            return Response(status_code=404)
        return JSONResponse({"resource": f"{base_url}/mcp", "mcp_extensions": {MCP_EXTENSION_ID: {}}})

    return Route("/.well-known/oauth-protected-resource/mcp", metadata)


_target_seen: ContextVar[str | None] = ContextVar("target_seen", default=None)


def mcp_target(announce: bool) -> AppFactory:
    """A stateless MCP server with an ``echo`` tool that returns the ``X-IK-Token`` it received.

    Stateless with JSON responses, each message is handled within its HTTP request, so a plain ASGI wrapper records
    the header. The targets do not use the package.
    """

    def factory(base_url: str) -> Any:
        if MCP_MAJOR >= 2:
            server = sdk("mcp.server.mcpserver").MCPServer("target")
        else:
            server = sdk("mcp.server.fastmcp").FastMCP("target", stateless_http=True, json_response=True)

        @server.tool()
        async def echo() -> str:
            return json.dumps(_target_seen.get())

        if MCP_MAJOR >= 2:
            app = server.streamable_http_app(stateless_http=True, json_response=True)
        else:
            app = server.streamable_http_app()
        app.router.routes.append(_prm_route(base_url, announce))

        async def recording(scope: Any, receive: Any, send: Any) -> None:
            headers = dict(scope.get("headers") or ())
            seen = headers.get(b"x-ik-token")
            reset = _target_seen.set(seen.decode() if seen is not None else None)
            try:
                await app(scope, receive, send)
            finally:
                _target_seen.reset(reset)

        return recording

    return factory


def a2a_agent(announce: bool) -> AppFactory:
    """An A2A agent that answers each message with the ``X-IK-Token`` and ``A2A-Extensions`` it received."""

    def factory(base_url: str) -> Any:
        from a2a.server.agent_execution import AgentExecutor, RequestContext
        from a2a.server.events import EventQueue
        from a2a.server.request_handlers import DefaultRequestHandler
        from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
        from a2a.server.tasks import InMemoryTaskStore
        from a2a.types.a2a_pb2 import (
            ROLE_AGENT,
            AgentCapabilities,
            AgentCard,
            AgentExtension,
            AgentInterface,
            AgentSkill,
            Message,
            Part,
        )
        from starlette.applications import Starlette

        class Echo(AgentExecutor):
            async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:  # skipcq: PYL-R0201
                headers = context.call_context.state.get("headers", {})
                seen = {"token": headers.get("x-ik-token"), "extensions": headers.get("a2a-extensions")}
                await event_queue.enqueue_event(
                    Message(
                        role=ROLE_AGENT,
                        message_id=str(uuid.uuid4()),
                        context_id=context.context_id or "",
                        parts=[Part(text=json.dumps(seen))],
                    )
                )

            async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
                raise NotImplementedError

        extensions = [AgentExtension(uri=A2A_EXTENSION_URI)] if announce else []
        card = AgentCard(
            name="echo",
            description="echoes the headers it received",
            version="1.0.0",
            capabilities=AgentCapabilities(streaming=False, extensions=extensions),
            supported_interfaces=[
                AgentInterface(url=f"{base_url}/", protocol_binding="JSONRPC", protocol_version="1.0")
            ],
            skills=[AgentSkill(id="echo", name="echo", description="echoes the headers", tags=["test"])],
            default_input_modes=["text/plain"],
            default_output_modes=["text/plain"],
        )
        handler = DefaultRequestHandler(agent_executor=Echo(), task_store=InMemoryTaskStore(), agent_card=card)
        return Starlette(routes=[*create_agent_card_routes(card), *create_jsonrpc_routes(handler, "/")])

    return factory


async def ask_agent(base_url: str) -> Any:
    """Send a message to the agent with the package's interceptor and return what the agent saw."""
    from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
    from a2a.types.a2a_pb2 import ROLE_USER, Message, Part, SendMessageRequest

    from indykite_delegated_token.client.a2a import DelegatedTokenInterceptor

    async with httpx.AsyncClient() as http:
        card = await A2ACardResolver(http, base_url).get_agent_card()
        client = ClientFactory(ClientConfig(streaming=False, httpx_client=http)).create(
            card, interceptors=[DelegatedTokenInterceptor()]
        )
        request = SendMessageRequest(
            message=Message(role=ROLE_USER, message_id=str(uuid.uuid4()), parts=[Part(text="hi")])
        )
        async for response in client.send_message(request):
            if response.HasField("message"):
                return json.loads(response.message.parts[0].text)
    raise AssertionError("the agent did not answer with a message")


@contextlib.asynccontextmanager
async def mcp_session(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    propagate: bool = False,
    registry: ExtensionRegistry | None = None,
) -> AsyncIterator[Any]:
    """An initialized MCP ``ClientSession``. With ``propagate``, its HTTP client is the package's.

    The session's HTTP client is ``session.http``: change its headers to send other headers on the next calls.
    """
    client_session = sdk("mcp.client.session").ClientSession
    transports = sdk("mcp.client.streamable_http")
    lib = "httpx2" if MCP_MAJOR >= 2 else "httpx"
    adapter = sdk(f"indykite_delegated_token.client.{lib}")
    http = (
        adapter.http_client(headers=headers, registry=registry) if propagate else sdk(lib).AsyncClient(headers=headers)
    )
    async with (
        http,
        transports.streamable_http_client(url, http_client=http) as streams,
        client_session(streams[0], streams[1]) as session,
    ):
        await session.initialize()
        session.http = http
        yield session


async def call_tool(session: Any, name: str, arguments: dict[str, Any] | None = None) -> Any:
    """Call a tool and return its text result, decoded from JSON."""
    result = await session.call_tool(name, arguments or {})
    is_error = getattr(result, "is_error", None) if MCP_MAJOR >= 2 else getattr(result, "isError", None)
    assert not is_error, result
    return json.loads(result.content[0].text)
