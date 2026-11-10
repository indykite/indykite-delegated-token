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
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from indykite_delegated_token._constants import DELEGATED_TOKEN_HEADER
from indykite_delegated_token._context import use_token

__all__ = ["DelegatedTokenASGIMiddleware"]

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

_HEADER = DELEGATED_TOKEN_HEADER.lower().encode("latin-1")


def _token(scope: Scope) -> str | None:
    for name, value in scope.get("headers") or ():
        if name.lower() == _HEADER:
            return value.decode("latin-1") or None
    return None


class DelegatedTokenASGIMiddleware:
    """Runs each HTTP request with the token of its ``X-IK-Token`` header as the delegated token."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        with use_token(_token(scope)):
            await self.app(scope, receive, send)
