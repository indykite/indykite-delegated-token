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

from collections.abc import Sequence

import httpx

from indykite_delegated_token.client._discovery import DEFAULT_REGISTRY, ExtensionRegistry, same_origin
from indykite_delegated_token.client._transport_core import (
    METADATA_HEADERS,
    Replay,
    WrappingTransport,
    handle,
    in_chain,
    metadata_timeout,
    read_raw,
    sending,
)

__all__ = [
    "DelegatedTokenTransport",
    "http_client",
    "httpx_client_factory",
    "install_globally",
    "uninstall_globally",
]

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


def _with_header(request: httpx.Request, name: str, value: str | None) -> httpx.Request:
    headers = request.headers.copy()
    headers.pop(name, None)
    if value is not None:
        headers[name] = value
    return httpx.Request(
        request.method, request.url, headers=headers, stream=request.stream, extensions=request.extensions
    )


class DelegatedTokenTransport(WrappingTransport, httpx.AsyncBaseTransport):
    """Adds ``X-IK-Token`` to the requests for targets that announce the delegated token extension.

    The token is the one the caller set in ``X-IK-Token``, or else the one of the request being handled
    (:func:`get_delegated_token`). Requests to targets that do not announce go out without ``X-IK-Token``, also when
    the caller set it.
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
    ``httpx_client_factory``. Pass ``transport`` to configure TLS, proxies or limits of the underlying transport.
    """
    return httpx.AsyncClient(
        headers=headers,
        timeout=timeout if timeout is not None else _DEFAULT_TIMEOUT,
        auth=auth,
        follow_redirects=follow_redirects,
        transport=DelegatedTokenTransport(transport, registry=registry),
    )


# Alias of `http_client` for the `httpx_client_factory` parameters of the MCP SDK and FastMCP
httpx_client_factory = http_client


# The method that install_globally() wraps
_ORIGINAL_HANDLE = httpx.AsyncHTTPTransport.handle_async_request
# Request extension that marks a redirect chain started at an unlisted origin. The client copies it into redirects.
_UNLISTED = "indykite_delegated_token.unlisted"


class _GlobalHook:
    """What install_globally() was given."""

    def __init__(self) -> None:
        self.gateways: tuple[str, ...] = ()
        self.registry: ExtensionRegistry = DEFAULT_REGISTRY

    def listed(self, url: str) -> bool:
        return any(same_origin(gateway, url) for gateway in self.gateways)


_hook = _GlobalHook()


def _skipped(request: httpx.Request) -> bool:
    if sending():
        return True
    # Redirects of a handled chain come back here too: the token must not follow them to another origin
    if in_chain(request):
        return False
    # A chain started at an unlisted origin stays untouched, also after a redirect to a listed one
    if request.extensions.get(_UNLISTED) or not _hook.listed(str(request.url)):
        request.extensions[_UNLISTED] = True
        return True
    return False


async def _global_handle(self: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
    if _skipped(request):
        return await _ORIGINAL_HANDLE(self, request)

    async def send(outgoing: httpx.Request) -> httpx.Response:
        return await _ORIGINAL_HANDLE(self, outgoing)

    return await handle(
        request,
        send=send,
        make_get=_plain_get,
        with_header=_with_header,
        buffer=_buffer,
        registry=_hook.registry,
    )


def install_globally(gateways: Sequence[str], *, registry: ExtensionRegistry | None = None) -> None:
    """Add the delegated token to requests of every ``httpx.AsyncClient`` of the process to the listed gateways.

    For frameworks that do not let code hand over an HTTP client, such as CrewAI. ``gateways`` are origins
    (scheme, host, port). A request to any other origin is left untouched, with no discovery fetch, so the token
    never reaches the LLM provider. Its redirects stay untouched too, also to a listed origin. Requests to a listed
    origin go through the same logic as :class:`DelegatedTokenTransport`: the token goes only to targets that
    announce the extension. Calling it again replaces the list. :func:`uninstall_globally` undoes it.
    """
    _hook.gateways = tuple(gateways)
    _hook.registry = registry if registry is not None else DEFAULT_REGISTRY
    httpx.AsyncHTTPTransport.handle_async_request = _global_handle  # type: ignore[method-assign]


def uninstall_globally() -> None:
    """Undo :func:`install_globally`."""
    _hook.gateways = ()
    _hook.registry = DEFAULT_REGISTRY
    httpx.AsyncHTTPTransport.handle_async_request = _ORIGINAL_HANDLE  # type: ignore[method-assign]
