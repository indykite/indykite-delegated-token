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

"""IndyKite delegated token propagation for AI agents and MCP servers.

On the server side, :func:`install` makes the delegated token of each incoming request available to its handler
through :func:`get_delegated_token`. On the client side, :mod:`indykite_delegated_token.client.httpx2`,
:mod:`indykite_delegated_token.client.httpx` and :mod:`indykite_delegated_token.client.a2a` send it on to the MCP
servers and A2A agents that announce the extension.
"""

from indykite_delegated_token._constants import (
    A2A_EXTENSION_URI,
    A2A_EXTENSIONS_HEADER,
    DELEGATED_TOKEN_HEADER,
    MCP_EXTENSION_ID,
)
from indykite_delegated_token._context import get_delegated_token, use_token
from indykite_delegated_token.version import __version__

__all__ = [
    "A2A_EXTENSIONS_HEADER",
    "A2A_EXTENSION_URI",
    "DELEGATED_TOKEN_HEADER",
    "MCP_EXTENSION_ID",
    "__version__",
    "get_delegated_token",
    "install",
    "use_token",
]


def _top_modules(server: object) -> set[str]:
    return {cls.__module__.split(".", 1)[0] for cls in type(server).__mro__}


def install(server: object) -> None:
    """Make the delegated token of each request available to the tools of ``server``.

    ``server`` is one of:

    - ``mcp.server.mcpserver.MCPServer`` or ``mcp.server.lowlevel.Server`` of the MCP SDK 2.x,
    - ``fastmcp.FastMCP`` of FastMCP 4,
    - ``mcp.server.fastmcp.FastMCP`` or ``mcp.server.lowlevel.Server`` of the MCP SDK 1.x.

    Calling it again on the same server does nothing. For other ASGI apps, such as A2A agents, wrap the app in
    :class:`indykite_delegated_token.server.asgi.DelegatedTokenASGIMiddleware` instead.
    """
    modules = _top_modules(server)
    if "fastmcp" in modules:
        from indykite_delegated_token.server import fastmcp

        fastmcp.install(server)
    elif "mcp" in modules and isinstance(getattr(server, "middleware", None), list):
        from indykite_delegated_token.server import mcp_v2

        mcp_v2.install(server)
    elif "mcp" in modules and hasattr(getattr(server, "_mcp_server", server), "request_handlers"):
        from indykite_delegated_token.server import mcp_v1

        mcp_v1.install(server)
    else:
        raise TypeError(f"unsupported server type {type(server).__qualname__}")
