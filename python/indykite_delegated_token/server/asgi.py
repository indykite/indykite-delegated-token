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

"""ASGI middleware that makes the delegated token of each HTTP request available to its handler.

Use it for A2A agents and for apps that handle each MCP message within its HTTP request (stateless MCP). It is
pure ASGI, not Starlette's ``BaseHTTPMiddleware``, which runs the app in another task and breaks streaming.

For stateful MCP sessions, the handler of a message does not run within its HTTP request; use
:func:`indykite_delegated_token.install` on the MCP server instead.

Add it as the outermost middleware: anything above it still sees the header.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from indykite_delegated_token._constants import DELEGATED_TOKEN_HEADER
from indykite_delegated_token._context import token_in, use_token

__all__ = ["DelegatedTokenASGIMiddleware"]

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

_HEADER = DELEGATED_TOKEN_HEADER.lower().encode("latin-1")


def _without_token(scope: Scope) -> Scope:
    # A shallow copy: the server's scope and headers list stay unchanged
    headers = [(name, value) for name, value in scope.get("headers") or () if name.lower() != _HEADER]
    return {**scope, "headers": headers}


class DelegatedTokenASGIMiddleware:
    """Runs each HTTP request with the token of its ``X-IK-Token`` header as the delegated token.

    With ``strip_header=True``, the header is also removed from the request that the app sees. The app then reaches
    the token only through :func:`get_delegated_token`, so nothing below the middleware can log it or pass it on.
    a2a-sdk, for example, copies all request headers into its call context and logs that context at DEBUG.

    Do not set ``strip_header`` in front of an MCP server that uses :func:`indykite_delegated_token.install`: its
    adapters read the header from the request, so they would see no token.
    """

    def __init__(self, app: ASGIApp, *, strip_header: bool = False) -> None:
        self.app = app
        self.strip_header = strip_header

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        token = token_in(scope.get("headers") or ())
        if self.strip_header:
            scope = _without_token(scope)
        with use_token(token):
            await self.app(scope, receive, send)
