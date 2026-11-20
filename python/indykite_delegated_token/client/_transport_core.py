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

import functools
from collections.abc import AsyncIterator, Awaitable, Callable, MutableMapping
from contextvars import ContextVar
from types import ModuleType, TracebackType
from typing import Any, Protocol, Self, TypeVar, cast

from indykite_delegated_token._constants import DELEGATED_TOKEN_HEADER
from indykite_delegated_token._context import get_delegated_token
from indykite_delegated_token.client._discovery import ExtensionRegistry, challenge_link, same_origin, secure_transport

__all__ = [
    "MAX_BODY",
    "READ_DEADLINE",
    "WrappingTransport",
    "handle",
    "in_chain",
    "sending",
]

# The most of a metadata answer or of a 401 that is read: both are small, and a target must not be able to make the
# client hold a large body in memory
MAX_BODY = 64 * 1024
# Seconds the package's own reads may take in all, whatever the per-operation timeouts, so a body that trickles in
# cannot hold up the call: a metadata fetch, and the read of a 401 before discovery
READ_DEADLINE = 30.0
# Headers of the metadata fetch: uncompressed only, so the size limit on the body holds for what is decoded too
_METADATA_HEADERS = {"Accept": "application/json", "Accept-Encoding": "identity"}
# Seconds of the metadata fetch's timeouts that the request leaves unset, so a stalled endpoint cannot block the call
# forever
_METADATA_TIMEOUT = 10.0


class _Headers(Protocol):
    def get(self, key: str, /) -> str | None: ...
    def __contains__(self, key: object) -> bool: ...
    def copy(self) -> MutableMapping[str, str]: ...


class _Request(Protocol):
    @property
    def method(self) -> str: ...
    @property
    def url(self) -> object: ...
    @property
    def headers(self) -> _Headers: ...
    @property
    def content(self) -> bytes: ...
    @property
    def stream(self) -> object: ...
    @property
    def extensions(self) -> MutableMapping[str, object]: ...


class _Response(Protocol):
    @property
    def status_code(self) -> int: ...
    @property
    def headers(self) -> _Headers: ...
    @property
    def extensions(self) -> object: ...
    @property
    def is_stream_consumed(self) -> bool: ...
    @property
    def content(self) -> bytes: ...
    def aiter_raw(self) -> AsyncIterator[bytes]: ...
    async def aread(self) -> bytes: ...
    async def aclose(self) -> None: ...


class _Transport(Protocol):
    async def __aenter__(self) -> Any: ...  # noqa: ANN401 - the transport itself

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None = None,
        exc_value: BaseException | None = None,
        traceback: TracebackType | None = None,
    ) -> None: ...

    async def aclose(self) -> None: ...


# Request extension with the URL of the first request of a redirect chain: the client copies the extensions of a
# request into the redirect it builds from it
_FIRST_URL = "indykite_delegated_token.first_url"

# Set while the package sends a request, so the global hook does not handle it a second time
_sending: ContextVar[bool] = ContextVar("indykite_delegated_token_sending", default=False)

Req = TypeVar("Req", bound=_Request)
Resp = TypeVar("Resp", bound=_Response)


def sending() -> bool:
    """Whether the current request is sent by :func:`handle`."""
    return _sending.get()


def in_chain(request: _Request) -> bool:
    """Whether ``request`` belongs to a redirect chain that :func:`handle` started."""
    return _FIRST_URL in request.extensions


def _flagged(send: Callable[[Req], Awaitable[Resp]]) -> Callable[[Req], Awaitable[Resp]]:
    async def flagged(request: Req) -> Resp:
        reset = _sending.set(True)
        try:
            return await send(request)
        finally:
            _sending.reset(reset)

    return flagged


def _replayable(request: _Request) -> bool:
    # A body that was given as bytes can be sent again; a streamed body that was never read cannot.
    try:
        request.content  # noqa: B018
    except Exception:
        return False
    return True


def metadata_timeout(request: _Request) -> dict[str, Any]:
    """The timeouts of the metadata fetch for ``request``: its own, with 10 seconds for those it leaves unset.

    Only the timeout is taken from the request, never its headers, credentials included. The metadata fetch is the
    package's own request, so it is bounded even when the client has no timeout.
    """
    timeout: dict[str, Any] = dict.fromkeys(("connect", "read", "write", "pool"), _METADATA_TIMEOUT)
    requested: Any = request.extensions.get("timeout") or {}
    timeout.update((key, value) for key, value in requested.items() if value is not None)
    return timeout


# The functions below take the HTTP library, ``httpx`` or ``httpx2``, whose APIs are the same


def _plain_get(lib: ModuleType, url: str, request: Req) -> Req:
    """A plain GET of ``url`` for the metadata fetch, without any of the client's headers but with its timeout."""
    return cast(
        Req, lib.Request("GET", url, headers=_METADATA_HEADERS, extensions={"timeout": metadata_timeout(request)})
    )


def _with_header(lib: ModuleType, request: Req, name: str, value: str | None) -> Req:
    """A copy of ``request`` with the header ``name`` set to ``value``, or removed when ``value`` is ``None``."""
    headers = request.headers.copy()
    headers.pop(name, None)
    if value is not None:
        headers[name] = value
    return cast(
        Req,
        lib.Request(request.method, request.url, headers=headers, stream=request.stream, extensions=request.extensions),
    )


class _Replay:
    """The raw body chunks already read from a response, then the rest of it, if any.

    :func:`_replay_class` combines it with each library's ``AsyncByteStream``.
    """

    def __init__(self, read: list[bytes], rest: AsyncIterator[bytes] | None, response: _Response) -> None:
        self._read = read
        self._rest = rest
        self._response = response

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._chunks()

    async def _chunks(self) -> AsyncIterator[bytes]:
        for chunk in self._read:
            yield chunk
        if self._rest is not None:
            async for chunk in self._rest:
                yield chunk

    async def aclose(self) -> None:
        await self._response.aclose()


@functools.cache
def _replay_class(lib: ModuleType) -> type[_Replay]:
    return type("_Replay", (_Replay, lib.AsyncByteStream), {})


async def _buffer(lib: ModuleType, response: Resp, limit: int, deadline: float) -> tuple[Resp, bool]:
    """Read at most ``limit`` bytes of the body of ``response``.

    Returns an equivalent response and whether it read all of it: then the connection is free. If not, the response
    replays what was read and then streams the rest. ``deadline`` is in all, not per read: a body that trickles in must
    not hold up the call. On that and any other error the response is closed, because a body read in part cannot be
    returned.
    """
    import anyio

    if response.is_stream_consumed:  # a body given in memory, as by a mock transport, is read already
        return response, len(response.content) <= limit
    # Raw bytes, before any decompression, so the limit holds; the client decodes the replayed body as usual
    raw = response.aiter_raw()
    read: list[bytes] = []
    size = 0
    complete = True
    try:
        with anyio.fail_after(deadline):
            async for chunk in raw:
                read.append(chunk)
                size += len(chunk)
                if size > limit:
                    complete = False
                    break
    except BaseException as exc:
        with anyio.CancelScope(shield=True):  # give the connection back
            await response.aclose()
        if isinstance(exc, TimeoutError):
            raise lib.ReadTimeout(f"response body not read within {deadline} seconds") from exc
        raise
    stream = _replay_class(lib)(read, None if complete else raw, response)
    copy = lib.Response(response.status_code, headers=response.headers, stream=stream, extensions=response.extensions)
    return cast(Resp, copy), complete


class WrappingTransport:
    """Opens and closes the transport it wraps, ``_transport``, with itself.

    Each library's module combines it with its ``AsyncBaseTransport``.
    """

    _transport: _Transport

    async def __aenter__(self) -> Self:
        await self._transport.__aenter__()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None = None,
        exc_value: BaseException | None = None,
        traceback: TracebackType | None = None,
    ) -> None:
        await self._transport.__aexit__(exc_type, exc_value, traceback)

    async def aclose(self) -> None:
        await self._transport.aclose()


def _may_carry(target: str, first_url: str, registry: ExtensionRegistry) -> bool:
    """Whether ``target`` may get the token if it announces the extension."""
    if not same_origin(first_url, target):
        # A redirect to another origin, or from https to http: the token only goes where the caller sent the request,
        # never where a server sends it on, even if that announces the extension
        return False
    # Over plain HTTP, neither the token nor the metadata that announces it would be protected
    return registry.allow_http or secure_transport(target)


async def handle(
    request: Req,
    *,
    send: Callable[[Req], Awaitable[Resp]],
    lib: ModuleType,
    registry: ExtensionRegistry,
) -> Resp:
    """Send ``request``, with the delegated token only if the target announced the extension.

    The token is the one the caller set in ``X-IK-Token``, or else the one of the context. A target that does not
    announce, another origin after a redirect, or plain HTTP without ``allow_http``, gets no token, also when the
    caller set it.

    ``send`` sends a request through the wrapped transport of ``lib``, the HTTP library: ``httpx`` or ``httpx2``.

    ``request`` itself is never changed, but for one extension that records where a redirect chain started: the
    client builds redirects and retries from it, and they must not carry the token to a target that did not announce
    the extension, or to another origin. Each of them comes back through this function.
    """
    send = _flagged(send)
    target = str(request.url)
    first_url = str(request.extensions.setdefault(_FIRST_URL, target))
    token = request.headers.get(DELEGATED_TOKEN_HEADER) or get_delegated_token()
    if token is None:
        return await send(request)
    bare = request
    if DELEGATED_TOKEN_HEADER in request.headers:
        bare = _with_header(lib, request, DELEGATED_TOKEN_HEADER, None)
    if not _may_carry(target, first_url, registry):
        return await send(bare)

    async def fetch(url: str) -> tuple[int, bytes]:
        import anyio

        with anyio.fail_after(READ_DEADLINE):
            response = await send(_plain_get(lib, url, request))
            try:
                encoding = response.headers.get("content-encoding")
                if encoding and encoding.lower() != "identity":  # asked for identity: a compressed body is unbounded
                    raise ValueError(f"unexpected content encoding {encoding}")
                response, complete = await _buffer(lib, response, MAX_BODY, READ_DEADLINE)
                if not complete:
                    raise ValueError(f"larger than {MAX_BODY} bytes")
                return response.status_code, await response.aread()
            finally:
                with anyio.CancelScope(shield=True):  # give the connection back, also after the deadline
                    await response.aclose()

    if await registry.discover(target, fetch):
        return await send(_with_header(lib, request, DELEGATED_TOKEN_HEADER, token))

    response = await send(bare)
    if response.status_code != 401 or not _replayable(request):
        return response
    challenge = response.headers.get("www-authenticate")
    if not challenge or challenge_link(target, challenge) is None:
        return response  # as it came, unread
    # Read the 401 before discovery to free its connection: the metadata fetch may need it from a small pool, also
    # while this call waits for another call's fetch. A body too large to hold goes back to the caller without
    # discovery.
    response, complete = await _buffer(lib, response, MAX_BODY, READ_DEADLINE)
    if not complete or not await registry.learn_from_challenge(target, challenge, fetch):
        return response
    await response.aclose()
    return await send(_with_header(lib, request, DELEGATED_TOKEN_HEADER, token))
