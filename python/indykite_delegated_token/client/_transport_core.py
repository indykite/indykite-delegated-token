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

"""Logic shared by the httpx and httpx2 transports, which have the same API but are different libraries."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Protocol, TypeVar

from indykite_delegated_token._constants import DELEGATED_TOKEN_HEADER
from indykite_delegated_token._context import get_delegated_token
from indykite_delegated_token.client._discovery import ExtensionRegistry, challenge_link, same_origin

__all__ = ["MAX_BODY", "READ_DEADLINE", "handle"]

# The most of a metadata answer or of a 401 that is read: both are small, and a target must not be able to make the
# client hold a large body in memory
MAX_BODY = 64 * 1024
# Seconds the package's own reads may take in all, whatever the per-operation timeouts, so a body that trickles in
# cannot hold up the call: a metadata fetch, and the read of a 401 before discovery
READ_DEADLINE = 30.0


class _Headers(Protocol):
    def get(self, key: str, /) -> str | None: ...
    def __contains__(self, key: object) -> bool: ...


class _Request(Protocol):
    @property
    def url(self) -> object: ...
    @property
    def headers(self) -> _Headers: ...
    @property
    def content(self) -> bytes: ...
    @property
    def extensions(self) -> MutableMapping[str, object]: ...


class _Response(Protocol):
    @property
    def status_code(self) -> int: ...
    @property
    def headers(self) -> _Headers: ...
    async def aread(self) -> bytes: ...
    async def aclose(self) -> None: ...


# Request extension with the URL of the first request of a redirect chain: the client copies the extensions of a
# request into the redirect it builds from it
_FIRST_URL = "indykite_delegated_token.first_url"

Req = TypeVar("Req", bound=_Request)
Resp = TypeVar("Resp", bound=_Response)

# Reads at most `limit` bytes of a response's body. Returns an equivalent response and whether it read all of it: then
# the connection is free. If not, the response replays what was read and then streams the rest.
# It closes the response and raises if the body does not arrive within `deadline` seconds, or on any other error.
Buffer = Callable[[Resp, int, float], Awaitable[tuple[Resp, bool]]]


def _replayable(request: _Request) -> bool:
    # A body that was given as bytes can be sent again; a streamed body that was never read cannot.
    try:
        request.content  # noqa: B018
    except Exception:
        return False
    return True


async def handle(
    request: Req,
    *,
    send: Callable[[Req], Awaitable[Resp]],
    make_get: Callable[[str, Req], Req],
    with_header: Callable[[Req, str, str], Req],
    buffer: Buffer[Resp],
    registry: ExtensionRegistry,
) -> Resp:
    """Send ``request``, with the delegated token if the target announced the extension.

    ``send`` sends a request through the wrapped transport. ``make_get(url, request)`` builds a plain GET request for
    the metadata fetch, without any of the client's headers but with the timeout of ``request``.
    ``with_header(request, name, value)`` returns a copy of ``request`` with one more header. ``buffer`` reads a
    response's body up to a limit, see :data:`Buffer`.

    ``request`` itself is never changed, but for one extension that records where a redirect chain started: the
    client builds redirects and retries from it, and they must not carry the token to a target that did not announce
    the extension, or to another origin. Each of them comes back through this function.
    """
    target = str(request.url)
    first_url = str(request.extensions.setdefault(_FIRST_URL, target))
    token = get_delegated_token()
    if token is None or DELEGATED_TOKEN_HEADER in request.headers:
        return await send(request)
    if not same_origin(first_url, target):
        # A redirect to another origin, or from https to http: the token only goes where the caller sent the request,
        # never where a server sends it on, even if that announces the extension
        return await send(request)

    async def fetch(url: str) -> tuple[int, bytes]:
        import anyio

        with anyio.fail_after(READ_DEADLINE):
            response = await send(make_get(url, request))
            try:
                encoding = response.headers.get("content-encoding")
                if encoding and encoding.lower() != "identity":  # asked for identity: a compressed body is unbounded
                    raise ValueError(f"unexpected content encoding {encoding}")
                response, complete = await buffer(response, MAX_BODY, READ_DEADLINE)
                if not complete:
                    raise ValueError(f"larger than {MAX_BODY} bytes")
                return response.status_code, await response.aread()
            finally:
                with anyio.CancelScope(shield=True):  # give the connection back, also after the deadline
                    await response.aclose()

    if await registry.discover(target, fetch):
        return await send(with_header(request, DELEGATED_TOKEN_HEADER, token))

    response = await send(request)
    if response.status_code != 401 or not _replayable(request):
        return response
    challenge = response.headers.get("www-authenticate")
    if not challenge or challenge_link(target, challenge) is None:
        return response  # as it came, unread
    # Read the 401 before discovery to free its connection: the metadata fetch may need it from a small pool, also
    # while this call waits for another call's fetch. A body too large to hold goes back to the caller without
    # discovery.
    response, complete = await buffer(response, MAX_BODY, READ_DEADLINE)
    if not complete or not await registry.learn_from_challenge(target, challenge, fetch):
        return response
    await response.aclose()
    return await send(with_header(request, DELEGATED_TOKEN_HEADER, token))
