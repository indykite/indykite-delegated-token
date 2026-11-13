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

import asyncio
from typing import Any

import httpx

from indykite_delegated_token import get_delegated_token
from indykite_delegated_token.server.asgi import DelegatedTokenASGIMiddleware


def app(barrier: asyncio.Barrier | None = None) -> Any:
    async def inner(scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            await send({"type": "lifespan.startup.complete", "token": get_delegated_token()})
            return
        if barrier is not None:
            async with asyncio.timeout(5):
                await barrier.wait()
        body = (get_delegated_token() or "-").encode()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": body})

    return DelegatedTokenASGIMiddleware(inner)


async def test_token_of_each_request() -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app()), base_url="http://agent") as client:
        assert (await client.get("/", headers={"X-IK-Token": "tok"})).text == "tok"
        assert (await client.get("/", headers={"x-ik-token": "other"})).text == "other"
        assert (await client.get("/")).text == "-"
    assert get_delegated_token() is None


async def test_concurrent_requests() -> None:
    transport = httpx.ASGITransport(app(asyncio.Barrier(2)))
    async with httpx.AsyncClient(transport=transport, base_url="http://agent") as client:
        a, b = await asyncio.gather(
            client.get("/", headers={"X-IK-Token": "token-A"}),
            client.get("/", headers={"X-IK-Token": "token-B"}),
        )
    assert (a.text, b.text) == ("token-A", "token-B")


async def test_other_scopes_pass_through() -> None:
    sent: list[Any] = []

    async def send(message: Any) -> None:
        sent.append(message)

    async def receive() -> Any:
        return {"type": "lifespan.startup"}

    await app()({"type": "lifespan"}, receive, send)
    assert sent == [{"type": "lifespan.startup.complete", "token": None}]
