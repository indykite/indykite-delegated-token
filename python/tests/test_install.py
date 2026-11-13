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

import pytest
from _harness import MCP_MAJOR, sdk

from indykite_delegated_token import install


def test_unsupported_server() -> None:
    with pytest.raises(TypeError, match="unsupported server type"):
        install(object())


@pytest.mark.skipif(MCP_MAJOR < 2, reason="needs mcp 2.x")
@pytest.mark.parametrize("module", ["mcp.server.mcpserver:MCPServer", "mcp.server.lowlevel:Server"])
def test_mcp_v2_once(module: str) -> None:
    from indykite_delegated_token.server.mcp_v2 import DelegatedTokenMiddleware

    path, name = module.split(":")
    server = getattr(sdk(path), name)("s")
    install(server)
    install(server)
    assert sum(isinstance(m, DelegatedTokenMiddleware) for m in server.middleware) == 1


@pytest.mark.skipif(MCP_MAJOR < 2, reason="needs mcp 2.x")
def test_mcp_v2_rejects_other_servers() -> None:
    from indykite_delegated_token.server import mcp_v2

    with pytest.raises(TypeError, match="expected an mcp 2.x"):
        mcp_v2.install(object())


@pytest.mark.skipif(MCP_MAJOR != 1, reason="needs mcp 1.x")
def test_mcp_v1_rejects_other_servers() -> None:
    from indykite_delegated_token.server import mcp_v1

    with pytest.raises(TypeError, match="expected an mcp 1.x"):
        mcp_v1.install(object())


def test_fastmcp_once() -> None:
    fastmcp = pytest.importorskip("fastmcp")
    from indykite_delegated_token.server import fastmcp as adapter

    server = fastmcp.FastMCP("s")
    install(server)
    install(server)
    assert sum(isinstance(m, adapter.DelegatedTokenMiddleware) for m in server.middleware) == 1
    with pytest.raises(TypeError):
        adapter.install(object())


@pytest.mark.skipif(MCP_MAJOR != 1, reason="needs mcp 1.x")
@pytest.mark.parametrize("kind", ["fastmcp", "lowlevel"])
def test_mcp_v1_wraps_every_handler(kind: str) -> None:
    types = sdk("mcp.types")
    if kind == "fastmcp":
        server = sdk("mcp.server.fastmcp").FastMCP("s")
        lowlevel = server._mcp_server
    else:
        server = lowlevel = sdk("mcp.server.lowlevel").Server("s")
    install(server)
    install(server)

    @lowlevel.list_prompts()  # registered after install
    async def prompts() -> list[object]:
        return []

    handlers = lowlevel.request_handlers
    assert types.ListPromptsRequest in handlers
    assert all(getattr(h, "__indykite_delegated_token__", False) for h in handlers.values())
    assert not hasattr(getattr(handlers[types.PingRequest], "__wrapped__", None), "__indykite_delegated_token__")
