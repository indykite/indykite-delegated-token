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

"""LangChain MCP adapters: the delegated token of a LangGraph server run."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import TYPE_CHECKING, TypeVar

from indykite_delegated_token._context import token_from_headers, use_token

if TYPE_CHECKING:
    from langchain_mcp_adapters.interceptors import MCPToolCallRequest

__all__ = ["run_config_token", "token_from_run_config"]

T = TypeVar("T")


def run_config_token(config: object) -> str | None:
    """The ``X-IK-Token`` of a LangGraph run configuration, from ``config["configurable"]``, or ``None``.

    Use it where the graph is built for a run, around opening the client and listing its tools:
    ``with use_token(run_config_token(config)): tools = await client.get_tools()``.
    """
    if not isinstance(config, Mapping):
        return None
    return token_from_headers(config.get("configurable"))


async def token_from_run_config(
    request: MCPToolCallRequest, handler: Callable[[MCPToolCallRequest], Awaitable[T]]
) -> T:
    """A tool-call interceptor of ``langchain-mcp-adapters`` for the LangGraph server.

    A run there executes in a queue worker, not in the HTTP request. The deployment lists ``X-IK-Token`` in its
    setting for headers copied into the run configuration; this interceptor reads it from there and makes it the
    delegated token for the tool call, so the package's HTTP client sends it on. Without it in the run
    configuration, the tool call keeps the token of its context. Tool discovery happens before any tool call: wrap
    it in ``use_token(run_config_token(config))``.
    """
    token = run_config_token(getattr(request.runtime, "config", None))
    if token is None:
        return await handler(request)
    with use_token(token):
        return await handler(request)
