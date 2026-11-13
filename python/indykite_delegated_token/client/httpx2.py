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

"""Outbound transport for clients built on ``httpx2``: the mcp 2.x client and FastMCP 4.

Pass :func:`http_client()` to mcp 2.x's ``streamable_http_client(url, http_client=...)``, use it as the
``httpx_client_factory`` of FastMCP's ``StreamableHttpTransport``, or wrap your own
transport with :class:`DelegatedTokenTransport`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import TracebackType

import anyio
import httpx2

from indykite_delegated_token.client._discovery import DEFAULT_REGISTRY, ExtensionRegistry
from indykite_delegated_token.client._transport_core import handle

__all__ = ["DelegatedTokenTransport", "http_client", "httpx_client_factory"]

# The MCP SDK's defaults: a server may hold a response stream open for a long time
_DEFAULT_TIMEOUT = httpx2.Timeout(30.0, read=300.0)


# The metadata fetch's timeouts that the request leaves unset, so a stalled endpoint cannot block the call forever
_METADATA_TIMEOUT = httpx2.Timeout(10.0)


def _plain_get(url: str, request: httpx2.Request) -> httpx2.Request:
    # Only the timeout is taken from the request, never its headers, credentials included. The metadata fetch is the
    # package's own request, so it is bounded even when the client has no timeout.
    timeout = _METADATA_TIMEOUT.as_dict()
    timeout.update((key, value) for key, value in request.extensions.get("timeout", {}).items() if value is not None)
    # Uncompressed only, so the size limit on the body holds for what is decoded too
    headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
    return httpx2.Request("GET", url, headers=headers, extensions={"timeout": timeout})


class _Replay(httpx2.AsyncByteStream):
    """The raw body chunks already read from a response, then the rest of it, if any."""

    def __init__(self, read: list[bytes], rest: AsyncIterator[bytes] | None, response: httpx2.Response) -> None:
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


async def _buffer(response: httpx2.Response, limit: int, deadline: float) -> tuple[httpx2.Response, bool]:
    if response.is_stream_consumed:  # a body given in memory, as by a mock transport, is read already
        return response, len(response.content) <= limit
    # Raw bytes, before any decompression, so the limit holds; the client decodes the replayed body as usual
    read: list[bytes] = []
    size = 0
    raw = response.aiter_raw()
    complete = True
    try:
        # In all, not per read: a body that trickles in must not hold up the call
        with anyio.fail_after(deadline):
            async for chunk in raw:
                read.append(chunk)
                size += len(chunk)
                if size > limit:
                    complete = False
                    break
    except BaseException as exc:  # a body read in part cannot be returned: give the connection back
        with anyio.CancelScope(shield=True):
            await response.aclose()
        if isinstance(exc, TimeoutError):
            raise httpx2.ReadTimeout(f"response body not read within {deadline} seconds") from exc
        raise
    stream = _Replay(read, None if complete else raw, response)
    copy = httpx2.Response(
        response.status_code, headers=response.headers, stream=stream, extensions=response.extensions
    )
    return copy, complete


def _with_header(request: httpx2.Request, name: str, value: str) -> httpx2.Request:
    headers = request.headers.copy()
    headers[name] = value
    return httpx2.Request(
        request.method, request.url, headers=headers, stream=request.stream, extensions=request.extensions
    )


class DelegatedTokenTransport(httpx2.AsyncBaseTransport):
    """Adds ``X-IK-Token`` to the requests for targets that announce the delegated token extension.

    The token is the one of the request being handled (:func:`get_delegated_token`). Requests without a token, and
    requests to targets that do not announce, go out unchanged. A header the caller set is never replaced.
    """

    def __init__(
        self,
        transport: httpx2.AsyncBaseTransport | None = None,
        *,
        registry: ExtensionRegistry | None = None,
    ) -> None:
        self._transport = transport if transport is not None else httpx2.AsyncHTTPTransport()
        self._registry = registry if registry is not None else DEFAULT_REGISTRY

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        return await handle(
            request,
            send=self._transport.handle_async_request,
            make_get=_plain_get,
            with_header=_with_header,
            buffer=_buffer,
            registry=self._registry,
        )

    async def __aenter__(self) -> DelegatedTokenTransport:
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


def http_client(
    headers: dict[str, str] | None = None,
    timeout: httpx2.Timeout | None = None,
    auth: httpx2.Auth | None = None,
    follow_redirects: bool = False,
    *,
    transport: httpx2.AsyncBaseTransport | None = None,
    registry: ExtensionRegistry | None = None,
) -> httpx2.AsyncClient:
    """An ``httpx2.AsyncClient`` that propagates the delegated token, with the MCP SDK's default timeouts.

    The signature matches the MCP SDK's ``McpHttpClientFactory``, and FastMCP's use of it, so it can be passed as
    ``httpx_client_factory``. Pass ``transport`` to configure TLS, proxies or limits of the underlying transport.
    """
    return httpx2.AsyncClient(
        headers=headers,
        timeout=timeout if timeout is not None else _DEFAULT_TIMEOUT,
        auth=auth,
        follow_redirects=follow_redirects,
        transport=DelegatedTokenTransport(transport, registry=registry),
    )


# Alias of `http_client` for the `httpx_client_factory` parameters of the MCP SDK and FastMCP
httpx_client_factory = http_client
