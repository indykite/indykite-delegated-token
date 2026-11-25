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

"""Sample A2A agent that calls another A2A agent and an MCP server, with the delegated token.

The agent gateway in front of this agent sends the delegated token in ``X-IK-Token``. The ASGI middleware makes it
available to the executor, and the package's HTTP client and A2A interceptor send it on to targets that announce the
extension. The agent's card does not announce the extension: its gateway does.

The executor needs no model. It routes each message:
    a data part ``{"mcp_tool": "<name>", "arguments": {...}}`` calls that tool on TARGET_MCP_URL;
    any other message is sent as text to the agent at TARGET_AGENT_URL.

Environment:
    TARGET_MCP_URL          MCP endpoint that the agent calls, through its gateway
    TARGET_AGENT_URL        base URL of the A2A agent that the agent calls, through its gateway
    PUBLIC_URL              base URL of this agent in its card (default http://localhost:<PORT>)
    ALLOW_HTTP              set to 1 to also send the token over plain HTTP, such as to a gateway in a private
                            network (default: https only)
    HOST, PORT              where this agent listens (default 0.0.0.0:8000)
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
import uvicorn
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.helpers import get_data_parts, get_message_text, new_task, new_text_part
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes, create_rest_routes
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types.a2a_pb2 import (
    ROLE_USER,
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
    Message,
    Part,
    SendMessageRequest,
    Task,
    TaskState,
)
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from indykite_delegated_token.client import ExtensionRegistry
from indykite_delegated_token.client.a2a import DelegatedTokenInterceptor
from indykite_delegated_token.client.httpx2 import http_client
from indykite_delegated_token.server.asgi import DelegatedTokenASGIMiddleware

logger = logging.getLogger("sample_a2a_agent")


@dataclass(frozen=True)
class Config:
    """Where the agent is reachable, and the targets it calls. Targets come only from the operator."""

    public_url: str
    target_mcp_url: str
    target_agent_url: str
    allow_http: bool

    @classmethod
    def from_env(cls) -> Config:
        port = os.environ.get("PORT", "8000")
        return cls(
            public_url=os.environ.get("PUBLIC_URL", f"http://localhost:{port}").rstrip("/"),
            target_mcp_url=os.environ["TARGET_MCP_URL"],
            target_agent_url=os.environ["TARGET_AGENT_URL"],
            allow_http=os.environ.get("ALLOW_HTTP") == "1",
        )


async def call_mcp_tool(url: str, tool: str, arguments: dict[str, Any], registry: ExtensionRegistry) -> str:
    """Call a tool of the MCP server at ``url`` and return its text output. Raises if the tool returns an error.

    It opens a session per call to stay simple. A long-lived ``http_client()`` is safe too: it reads the token per
    request.
    """
    async with (
        http_client(registry=registry) as client,  # adds X-IK-Token if the target announces
        streamable_http_client(url, http_client=client) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        result = await session.call_tool(tool, arguments)
    text = "\n".join(getattr(content, "text", "") for content in result.content)
    if result.is_error:
        raise RuntimeError(f"tool {tool} failed: {text}")
    return text


def require_same_origin(card: AgentCard, url: str) -> None:
    """Raises if the card lists an interface on another origin than ``url``, so the token goes only to the target."""
    expected = urlsplit(url)
    for interface in card.supported_interfaces:
        actual = urlsplit(interface.url)
        if (actual.scheme, actual.netloc) != (expected.scheme, expected.netloc):
            raise ValueError(f"the target's card lists an interface on another origin: {interface.url}")


async def ask_agent(url: str, text: str, allow_http: bool) -> str:
    """Send a message to the A2A agent at ``url`` and return its text reply. Raises if its task does not complete."""
    # A target that requires its own credentials would get them here, e.g. httpx.AsyncClient(headers=...)
    async with httpx.AsyncClient(timeout=60) as http:
        card = await A2ACardResolver(http, url).get_agent_card()
        require_same_origin(card, url)
        client = ClientFactory(ClientConfig(streaming=False, httpx_client=http)).create(
            card,
            # adds X-IK-Token if the card lists the extension
            interceptors=[DelegatedTokenInterceptor(allow_http=allow_http)],
        )
        request = SendMessageRequest(
            message=Message(role=ROLE_USER, message_id=str(uuid.uuid4()), parts=[Part(text=text)])
        )
        replies = []
        async for response in client.send_message(request):
            if response.HasField("message"):
                replies.append(get_message_text(response.message))
            if response.HasField("task"):
                replies.extend(task_text(response.task))
    return "\n".join(replies)


def task_text(task: Task) -> list[str]:
    """The text of the task's artifacts. Raises if the task did not complete."""
    if task.status.state != TaskState.TASK_STATE_COMPLETED:
        raise RuntimeError(f"the target's task ended in {TaskState.Name(task.status.state)}")
    return [part.text for artifact in task.artifacts for part in artifact.parts]


def mcp_call(message: Message) -> dict[str, Any] | None:
    """The first data part that names an MCP tool, if any."""
    for data in get_data_parts(message.parts):
        if isinstance(data, dict) and "mcp_tool" in data:
            return data
    return None


class RelayExecutor(AgentExecutor):
    """Relays each message to the configured MCP server or A2A agent, and replies with one text artifact."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.registry = ExtensionRegistry(allow_http=config.allow_http)  # one for the process, so answers are cached

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        task_id, context_id = context.task_id or "", context.context_id or ""
        if context.current_task is None:
            await event_queue.enqueue_event(new_task(task_id, context_id, TaskState.TASK_STATE_SUBMITTED))
        updater = TaskUpdater(event_queue, task_id, context_id)
        try:
            reply = await self.relay(context.message)
        except Exception:
            logger.exception("call to the target failed")
            await updater.failed(updater.new_agent_message([new_text_part("the call to the target failed")]))
            return
        await updater.add_artifact([new_text_part(reply)])
        await updater.complete()

    async def relay(self, message: Message | None) -> str:
        if message is None:
            raise ValueError("no message")
        call = mcp_call(message)
        if call is not None:
            arguments = call.get("arguments") or {}
            return await call_mcp_tool(self.config.target_mcp_url, call["mcp_tool"], arguments, self.registry)
        return await ask_agent(self.config.target_agent_url, get_message_text(message), self.config.allow_http)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise NotImplementedError


def agent_card(config: Config) -> AgentCard:
    """The agent's card. It does not list the delegated token extension: its gateway does."""
    return AgentCard(
        name="sample-a2a-agent",
        description="Calls an MCP server and an A2A agent with the delegated token",
        version="1.0.0",
        capabilities=AgentCapabilities(streaming=True),
        supported_interfaces=[
            AgentInterface(url=f"{config.public_url}/", protocol_binding="JSONRPC", protocol_version="1.0"),
            AgentInterface(url=f"{config.public_url}/rest", protocol_binding="HTTP+JSON", protocol_version="1.0"),
        ],
        skills=[
            AgentSkill(
                id="call_mcp_tool",
                name="call_mcp_tool",
                description='Calls a tool on the MCP server. Send a data part {"mcp_tool": ..., "arguments": ...}',
                tags=["mcp"],
            ),
            AgentSkill(
                id="ask_agent",
                name="ask_agent",
                description="Sends the text of the message to the A2A agent and returns its reply",
                tags=["a2a"],
            ),
        ],
        default_input_modes=["text/plain", "application/json"],
        default_output_modes=["text/plain"],
    )


async def healthz(_: Request) -> PlainTextResponse:
    """Liveness probe for the container's health check."""
    return PlainTextResponse("ok")


def build_app(config: Config) -> Starlette:
    """The agent as a Starlette app, with JSON-RPC at ``/`` and REST at ``/rest``."""
    card = agent_card(config)
    handler = DefaultRequestHandler(
        agent_executor=RelayExecutor(config), task_store=InMemoryTaskStore(), agent_card=card
    )
    routes = [
        *create_agent_card_routes(card),
        *create_jsonrpc_routes(handler, "/"),
        *create_rest_routes(handler, path_prefix="/rest"),
        Route("/healthz", healthz),
    ]
    # Outermost, and with strip_header: only get_delegated_token() reaches the token, never a2a-sdk's logs
    return Starlette(routes=routes, middleware=[Middleware(DelegatedTokenASGIMiddleware, strip_header=True)])


if __name__ == "__main__":
    uvicorn.run(
        build_app(Config.from_env()),
        host=os.environ.get("HOST", "0.0.0.0"),  # nosec B104 - listens in a container
        port=int(os.environ.get("PORT", "8000")),
    )
