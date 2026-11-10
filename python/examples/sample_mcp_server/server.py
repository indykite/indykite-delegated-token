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

"""Sample MCP server whose tools call another MCP server and an A2A agent, with the delegated token.

The agent gateway in front of this server sends the delegated token in ``X-IK-Token``. ``install(server)`` makes it
available to the tools, and the package's HTTP client and A2A interceptor send it on to targets that announce the
extension. A gateway that announces the extension needs nothing else: the token is the only credential of the call.

Environment:
    TARGET_MCP_URL          MCP endpoint that ``call_mcp_tool`` calls, through its gateway
    TARGET_AGENT_URL        base URL of the A2A agent that ``ask_agent`` calls, through its gateway
    HOST, PORT              where this server listens (default 0.0.0.0:8000)
"""

import os
import uuid

import httpx
import uvicorn
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.types.a2a_pb2 import ROLE_USER, Message, Part, SendMessageRequest
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.mcpserver import MCPServer
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from indykite_delegated_token import install
from indykite_delegated_token.client.a2a import DelegatedTokenInterceptor
from indykite_delegated_token.client.httpx2 import http_client

server = MCPServer("sample-mcp-server")
install(server)  # the tools see the delegated token of the request they handle


@server.tool()
async def call_mcp_tool(tool: str, arguments: dict[str, object] | None = None) -> str:
    """Call a tool of the MCP server at TARGET_MCP_URL and return its text output."""
    async with (
        http_client() as client,  # adds X-IK-Token if the target announces
        streamable_http_client(os.environ["TARGET_MCP_URL"], http_client=client) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        result = await session.call_tool(tool, arguments or {})
    return "\n".join(getattr(content, "text", "") for content in result.content)


@server.tool()
async def ask_agent(text: str) -> str:
    """Send a message to the A2A agent at TARGET_AGENT_URL and return its text reply."""
    async with httpx.AsyncClient(timeout=60) as http:
        card = await A2ACardResolver(http, os.environ["TARGET_AGENT_URL"]).get_agent_card()
        client = ClientFactory(ClientConfig(streaming=False, httpx_client=http)).create(
            card,
            interceptors=[DelegatedTokenInterceptor()],  # adds X-IK-Token if the card lists the extension
        )
        request = SendMessageRequest(
            message=Message(role=ROLE_USER, message_id=str(uuid.uuid4()), parts=[Part(text=text)])
        )
        replies = []
        async for response in client.send_message(request):
            if response.HasField("message"):
                replies.extend(part.text for part in response.message.parts)
            elif response.HasField("task"):
                for artifact in response.task.artifacts:
                    replies.extend(part.text for part in artifact.parts)
    return "\n".join(replies)


@server.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> PlainTextResponse:
    """Liveness probe for the container's health check."""
    return PlainTextResponse("ok")


if __name__ == "__main__":
    uvicorn.run(
        server.streamable_http_app(),
        host=os.environ.get("HOST", "0.0.0.0"),  # nosec B104 - listens in a container
        port=int(os.environ.get("PORT", "8000")),
    )
