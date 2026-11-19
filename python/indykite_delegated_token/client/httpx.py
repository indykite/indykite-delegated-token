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

"""Outbound transport for clients built on ``httpx``: the mcp 1.x client and a2a-sdk.

Use :func:`http_client` as the ``httpx_client_factory`` of mcp 1.x's ``streamablehttp_client``, or wrap your own
transport with :class:`DelegatedTokenTransport`.
"""

from __future__ import annotations

import httpx

from indykite_delegated_token.client._discovery import DEFAULT_REGISTRY, ExtensionRegistry
from indykite_delegated_token.client._transport_core import (
    METADATA_HEADERS,
    Replay,
    WrappingTransport,
    environment_proxies,
    handle,
    metadata_timeout,
    read_raw,
)

__all__ = ["DelegatedTokenTransport", "http_client", "httpx_client_factory"]

# The MCP SDK's defaults: a server may hold a response stream open for a long time
_DEFAULT_TIMEOUT = httpx.Timeout(30.0, read=300.0)


def _plain_get(url: str, request: httpx.Request) -> httpx.Request:
    return httpx.Request("GET", url, headers=METADATA_HEADERS, extensions={"timeout": metadata_timeout(request)})


class _Replay(Replay, httpx.AsyncByteStream):
    """:class:`Replay` as an ``httpx`` stream."""


async def _buffer(response: httpx.Response, limit: int, deadline: float) -> tuple[httpx.Response, bool]:
    if response.is_stream_consumed:  # a body given in memory, as by a mock transport, is read already
        return response, len(response.content) <= limit
    # Raw bytes, before any decompression, so the limit holds; the client decodes the replayed body as usual
    raw = response.aiter_raw()
    try:
        read, complete = await read_raw(response, raw, limit, deadline)
    except TimeoutError as exc:
        raise httpx.ReadTimeout(f"response body not read within {deadline} seconds") from exc
    stream = _Replay(read, None if complete else raw, response)
    copy = httpx.Response(response.status_code, headers=response.headers, stream=stream, extensions=response.extensions)
    return copy, complete


def _with_header(request: httpx.Request, name: str, value: str) -> httpx.Request:
    headers = request.headers.copy()
    headers[name] = value
    return httpx.Request(
        request.method, request.url, headers=headers, stream=request.stream, extensions=request.extensions
    )


class DelegatedTokenTransport(WrappingTransport, httpx.AsyncBaseTransport):
    """Adds ``X-IK-Token`` to the requests for targets that announce the delegated token extension.

    The token is the one of the request being handled (:func:`get_delegated_token`). Requests without a token, and
    requests to targets that do not announce, go out unchanged. A header the caller set is never replaced.
    """

    _transport: httpx.AsyncBaseTransport

    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | None = None,
        *,
        registry: ExtensionRegistry | None = None,
    ) -> None:
        self._transport = transport if transport is not None else httpx.AsyncHTTPTransport()
        self._registry = registry if registry is not None else DEFAULT_REGISTRY

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return await handle(
            request,
            send=self._transport.handle_async_request,
            make_get=_plain_get,
            with_header=_with_header,
            buffer=_buffer,
            registry=self._registry,
        )


def http_client(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
    follow_redirects: bool = False,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    registry: ExtensionRegistry | None = None,
) -> httpx.AsyncClient:
    """An ``httpx.AsyncClient`` that propagates the delegated token, with the MCP SDK's default timeouts.

    The signature matches the MCP SDK's ``McpHttpClientFactory``, and FastMCP's use of it, so it can be passed as
    ``httpx_client_factory``. Without ``transport``, requests go through the proxies of ``HTTP_PROXY``,
    ``HTTPS_PROXY``, ``ALL_PROXY`` and ``NO_PROXY``, as with the SDK's own client. Pass ``transport`` to configure
    TLS, proxies or limits of the underlying transport: then the environment's proxies are not used.
    """
    mounts: dict[str, httpx.AsyncBaseTransport | None] = {}
    if transport is None:
        mounts = {
            pattern: None
            if proxy is None
            else DelegatedTokenTransport(httpx.AsyncHTTPTransport(proxy=proxy), registry=registry)
            for pattern, proxy in environment_proxies().items()
        }
    return httpx.AsyncClient(
        headers=headers,
        timeout=timeout if timeout is not None else _DEFAULT_TIMEOUT,
        auth=auth,
        follow_redirects=follow_redirects,
        transport=DelegatedTokenTransport(transport, registry=registry),
        mounts=mounts,
    )


# Alias of `http_client` for the `httpx_client_factory` parameters of the MCP SDK and FastMCP
httpx_client_factory = http_client
