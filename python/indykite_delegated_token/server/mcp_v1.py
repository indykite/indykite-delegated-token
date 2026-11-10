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

"""Handler wrapping for the MCP Python SDK 1.x (``mcp.server.fastmcp.FastMCP`` and the low-level ``Server``).

mcp 1.x has no per-message middleware. A stateful session runs its handlers in a task started by the session's first
HTTP request, so a contextvar set by ASGI middleware would not reach them. Every handler instead runs with
``request_ctx`` set to the context of its own message, which carries the message's HTTP request: each handler in
``request_handlers`` is wrapped to read the token from there.
"""

from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable
from typing import ParamSpec, TypeVar

from mcp.server.lowlevel.server import request_ctx

from indykite_delegated_token._context import token_from_headers, use_token

__all__ = ["install"]

P = ParamSpec("P")
R = TypeVar("R")
Handler = Callable[..., Awaitable[object]]


def _token() -> str | None:
    try:
        request = request_ctx.get().request
    except LookupError:
        return None
    headers = getattr(request, "headers", None)
    return token_from_headers(headers) if headers is not None else None


def _wrap(handler: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
    if getattr(handler, "__indykite_delegated_token__", False):
        return handler

    @functools.wraps(handler)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
        with use_token(_token()):
            return await handler(*args, **kwargs)

    wrapped.__indykite_delegated_token__ = True  # type: ignore[attr-defined]
    return wrapped


class _WrappingHandlers(dict[type, Handler]):
    """Wraps every handler stored in it, including the ones registered after :func:`install`."""

    def __setitem__(self, key: type, value: Handler) -> None:
        super().__setitem__(key, _wrap(value))


def install(server: object) -> None:
    """Wrap the request handlers of a mcp 1.x ``FastMCP`` or low-level ``Server``, once."""
    lowlevel = getattr(server, "_mcp_server", server)
    handlers = getattr(lowlevel, "request_handlers", None)
    if not isinstance(handlers, dict):
        raise TypeError(f"expected an mcp 1.x FastMCP or low-level Server, got {type(server).__qualname__}")
    if isinstance(handlers, _WrappingHandlers):
        return
    wrapping = _WrappingHandlers()
    for key, handler in handlers.items():
        wrapping[key] = handler
    setattr(lowlevel, "request_handlers", wrapping)  # noqa: B010
    # The experimental handlers keep a reference to the dict they register into, and mcp 1.x has no public way to
    # repoint it: without this, handlers registered through `server.experimental` would skip the wrapper
    experimental = getattr(lowlevel, "_experimental_handlers", None)
    if experimental is not None and getattr(experimental, "_request_handlers", None) is handlers:
        experimental._request_handlers = wrapping  # skipcq: PYL-W0212 - see above
