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

from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
from _harness import serve
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from indykite_delegated_token import MCP_EXTENSION_ID, use_token
from indykite_delegated_token.client import ExtensionRegistry
from indykite_delegated_token.client.httpx import http_client, install_globally, uninstall_globally


def app(announce: bool, redirect_to: str = "") -> Any:
    def factory(base_url: str) -> Starlette:
        async def metadata(request: Request) -> Response:
            if not announce:
                return Response(status_code=404)
            resource = f"{base_url}/{request.path_params['path']}"
            return JSONResponse({"resource": resource, "mcp_extensions": {MCP_EXTENSION_ID: {}}})

        async def mcp(request: Request) -> Response:
            return JSONResponse({"seen": request.headers.get("x-ik-token")})

        async def redirect(_: Request) -> Response:
            return RedirectResponse(redirect_to, status_code=307)

        return Starlette(
            routes=[
                Route("/.well-known/oauth-protected-resource/{path:path}", metadata),
                Route("/mcp", mcp, methods=["POST"]),
                Route("/redirect", redirect, methods=["POST"]),
            ]
        )

    return factory


@pytest.fixture(autouse=True)
def restore() -> Iterator[None]:
    yield
    uninstall_globally()


@pytest.fixture
async def servers() -> AsyncIterator[tuple[str, str]]:
    async with serve(app(True)) as announcing, serve(app(False)) as silent:
        yield announcing, silent


async def post(url: str, headers: dict[str, str] | None = None, *, follow: bool = False) -> Any:
    async with httpx.AsyncClient(follow_redirects=follow) as client:
        response = await client.post(url, content=b"{}", headers=headers)
    return response.json()["seen"]


async def test_listed_gateways(servers: tuple[str, str]) -> None:
    announcing, silent = servers
    registry = ExtensionRegistry()
    install_globally([announcing, silent], registry=registry)
    with use_token("tok"):
        assert await post(f"{announcing}/mcp") == "tok"
        assert await post(f"{silent}/mcp") is None
        assert await post(f"{silent}/mcp", {"X-IK-Token": "caller"}) is None
    assert await post(f"{announcing}/mcp", {"X-IK-Token": "caller"}) == "caller"
    assert registry.known(f"{announcing}/mcp") is True
    assert registry.known(f"{silent}/mcp") is False


async def test_unlisted_origin_is_untouched(servers: tuple[str, str]) -> None:
    announcing, _ = servers
    registry = ExtensionRegistry()
    install_globally(["https://gateway.example.com"], registry=registry)
    with use_token("tok"):
        assert await post(f"{announcing}/mcp") is None
        assert await post(f"{announcing}/mcp", {"X-IK-Token": "caller"}) == "caller"
    assert registry.known(f"{announcing}/mcp") is None


async def test_install_again_replaces_the_list(servers: tuple[str, str]) -> None:
    announcing, _ = servers
    install_globally([announcing], registry=ExtensionRegistry())
    install_globally(["https://gateway.example.com"], registry=ExtensionRegistry())
    with use_token("tok"):
        assert await post(f"{announcing}/mcp") is None


async def test_uninstall(servers: tuple[str, str]) -> None:
    announcing, _ = servers
    install_globally([announcing])
    uninstall_globally()
    with use_token("tok"):
        assert await post(f"{announcing}/mcp") is None


async def test_package_client_is_not_handled_twice(servers: tuple[str, str]) -> None:
    announcing, _ = servers
    global_registry = ExtensionRegistry()
    install_globally([announcing], registry=global_registry)
    async with http_client(registry=ExtensionRegistry()) as client:
        with use_token("tok"):
            response = await client.post(f"{announcing}/mcp", content=b"{}")
    assert response.json()["seen"] == "tok"
    assert global_registry.known(f"{announcing}/mcp") is None


async def test_redirect_to_unlisted_origin_drops_caller_token(servers: tuple[str, str]) -> None:
    _, silent = servers
    async with serve(app(True, redirect_to=f"{silent}/mcp")) as gateway:
        install_globally([gateway], registry=ExtensionRegistry())
        seen = await post(f"{gateway}/redirect", {"X-IK-Token": "caller"}, follow=True)
    assert seen is None


async def test_redirect_from_unlisted_origin_gets_no_token(servers: tuple[str, str]) -> None:
    announcing, _ = servers
    async with serve(app(False, redirect_to=f"{announcing}/mcp")) as unlisted:
        install_globally([announcing], registry=ExtensionRegistry())
        with use_token("tok"):
            seen = await post(f"{unlisted}/redirect", follow=True)
    assert seen is None
