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

"""MCP Python SDK 1.x: a tool that calls another MCP server with the delegated token.

The mcp 1.x client sends its requests from a task started when the client connects, so open the client inside the
tool call, as below. A client opened before the call would not send the call's token.
"""

import os

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.fastmcp import FastMCP

from indykite_delegated_token import install
from indykite_delegated_token.client.httpx import http_client

server = FastMCP("sample")
install(server)


@server.tool()
async def call_target(tool: str) -> str:
    """Call ``tool`` of the MCP server at TARGET_MCP_URL and return its text output."""
    # The target comes from the server's configuration, never from the caller: any server that announces the
    # extension receives the token, so a caller-chosen URL could hand it to anyone
    url = os.environ["TARGET_MCP_URL"]
    async with (
        http_client() as client,
        streamable_http_client(url, http_client=client) as (read, write, _),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        result = await session.call_tool(tool, {})
    return "\n".join(getattr(content, "text", "") for content in result.content)


if __name__ == "__main__":
    server.run(transport="streamable-http")
