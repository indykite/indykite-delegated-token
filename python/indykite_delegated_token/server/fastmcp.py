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

"""Middleware for FastMCP 4 (``fastmcp.FastMCP``)."""

from __future__ import annotations

from typing import Any

from fastmcp import FastMCP
from fastmcp.server.dependencies import fastmcp_request_ctx
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext

from indykite_delegated_token._context import token_from_headers, use_token

__all__ = ["DelegatedTokenMiddleware", "install"]


def _token() -> str | None:
    # The request bound for this message. FastMCP's `get_http_request()` falls back to the request that opened a
    # stateful session, which would leak that request's token to later messages.
    request_context = fastmcp_request_ctx.get()
    request = request_context.request if request_context is not None else None
    headers = getattr(request, "headers", None)
    return token_from_headers(headers) if headers is not None else None


class DelegatedTokenMiddleware(Middleware):
    """Runs each request with the ``X-IK-Token`` of its HTTP request as the delegated token."""

    # skipcq: PYL-R0201 - overrides fastmcp's Middleware.on_request
    async def on_request(self, context: MiddlewareContext[Any], call_next: CallNext[Any, Any]) -> Any:  # noqa: ANN401
        with use_token(_token()):
            return await call_next(context)


def install(server: object) -> None:
    """Add :class:`DelegatedTokenMiddleware` to a ``fastmcp.FastMCP`` server, once."""
    if not isinstance(server, FastMCP):
        raise TypeError(f"expected fastmcp.FastMCP, got {type(server).__qualname__}")
    if not any(isinstance(item, DelegatedTokenMiddleware) for item in server.middleware):
        server.add_middleware(DelegatedTokenMiddleware())
