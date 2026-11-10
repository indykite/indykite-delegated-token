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

"""Per-message middleware for the MCP Python SDK 2.x (``MCPServer`` and the low-level ``Server``).

A stateful session runs its handlers in a task started by the session's first HTTP request, so a contextvar set by
ASGI middleware would not reach them. This middleware reads the token from the HTTP request of each message.
"""

from __future__ import annotations

from typing import Any

from mcp.server.context import CallNext, HandlerResult, ServerMiddleware, ServerRequestContext

from indykite_delegated_token._context import token_from_headers, use_token

__all__ = ["DelegatedTokenMiddleware", "install"]


def _token(ctx: ServerRequestContext[Any, Any]) -> str | None:
    request = ctx.request
    headers = getattr(request, "headers", None)
    return token_from_headers(headers) if headers is not None else None


class DelegatedTokenMiddleware(ServerMiddleware[Any]):
    """Runs each message with the ``X-IK-Token`` of its HTTP request as the delegated token."""

    async def __call__(self, ctx: ServerRequestContext[Any, Any], call_next: CallNext) -> HandlerResult:
        with use_token(_token(ctx)):
            return await call_next(ctx)


def install(server: object) -> None:
    """Add :class:`DelegatedTokenMiddleware` to an ``MCPServer`` or a low-level ``Server``, once."""
    middleware = getattr(server, "middleware", None)
    if not isinstance(middleware, list):
        raise TypeError(f"expected an mcp 2.x MCPServer or low-level Server, got {type(server).__qualname__}")
    if not any(isinstance(item, DelegatedTokenMiddleware) for item in middleware):
        middleware.append(DelegatedTokenMiddleware())
