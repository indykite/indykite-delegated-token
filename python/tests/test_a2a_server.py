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

"""``DelegatedTokenASGIMiddleware`` inside real a2a-sdk servers.

The executor records the delegated token it sees and the ``X-IK-Token`` of its call context. These tests pin the
a2a-sdk behaviour the middleware relies on: each ``execute`` runs in the context of the request that sent its message.
"""

import asyncio
import logging
import uuid
from typing import Any

import pytest

pytest.importorskip("a2a")

import httpx
from _harness import serve
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.helpers import get_message_text, new_task, new_text_part
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler, LegacyRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes, create_rest_routes
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types.a2a_pb2 import (
    ROLE_USER,
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
    Message,
    Part,
    SendMessageConfiguration,
    SendMessageRequest,
    StreamResponse,
    Task,
    TaskState,
)
from starlette.applications import Starlette
from starlette.middleware import Middleware

from indykite_delegated_token import get_delegated_token
from indykite_delegated_token.server.asgi import DelegatedTokenASGIMiddleware

JSONRPC = "JSONRPC"
REST = "HTTP+JSON"
HANDLERS = {"v2": DefaultRequestHandler, "legacy": LegacyRequestHandler}

Seen = tuple[str | None, str | None]


class Recorder(AgentExecutor):
    """Records ``(get_delegated_token(), X-IK-Token of the call context)`` and replies with the token.

    The message text selects the behaviour: ``ask`` waits for a follow-up message, ``wait`` waits for the other
    concurrent call, ``later`` waits until the test releases it, ``stream`` replies with two artifacts, ``quiet``
    replies ``ok``, so the token is not in the task that a2a-sdk logs.
    """

    def __init__(self) -> None:
        self.seen: list[Seen] = []
        self.barrier = asyncio.Barrier(2)
        self.release = asyncio.Event()
        self.done = asyncio.Event()

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        if context.current_task is None:
            task = new_task(context.task_id or "", context.context_id or "", TaskState.TASK_STATE_SUBMITTED)
            await event_queue.enqueue_event(task)
        command = get_message_text(context.message) if context.message else ""
        await self.wait_for(command)
        self.seen.append((get_delegated_token(), context.call_context.state["headers"].get("x-ik-token")))
        updater = TaskUpdater(event_queue, context.task_id or "", context.context_id or "")
        if command == "ask":
            await updater.requires_input()
            return
        reply = "ok" if command == "quiet" else get_delegated_token() or "-"
        await updater.add_artifact([new_text_part(reply)])
        if command == "stream":
            await asyncio.sleep(0)
            await updater.add_artifact([new_text_part(get_delegated_token() or "-")])
        await updater.complete()
        self.done.set()

    async def wait_for(self, command: str) -> None:
        async with asyncio.timeout(5):
            if command == "wait":
                await self.barrier.wait()
            if command == "later":
                await self.release.wait()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise NotImplementedError


def agent(executor: Recorder, handler: str = "v2", *, strip_header: bool = False) -> Any:
    """An app factory: an a2a-sdk agent with JSON-RPC at ``/`` and REST at ``/rest``, behind the middleware."""

    def factory(base_url: str) -> Any:
        card = AgentCard(
            name="recorder",
            description="records the delegated token",
            version="1.0.0",
            capabilities=AgentCapabilities(streaming=True),
            supported_interfaces=[
                AgentInterface(url=f"{base_url}/", protocol_binding=JSONRPC, protocol_version="1.0"),
                AgentInterface(url=f"{base_url}/rest", protocol_binding=REST, protocol_version="1.0"),
            ],
            skills=[AgentSkill(id="record", name="record", description="records the token", tags=["test"])],
            default_input_modes=["text/plain"],
            default_output_modes=["text/plain"],
        )
        request_handler = HANDLERS[handler](agent_executor=executor, task_store=InMemoryTaskStore(), agent_card=card)
        routes = [
            *create_agent_card_routes(card),
            *create_jsonrpc_routes(request_handler, "/"),
            *create_rest_routes(request_handler, path_prefix="/rest"),
        ]
        return Starlette(
            routes=routes, middleware=[Middleware(DelegatedTokenASGIMiddleware, strip_header=strip_header)]
        )

    return factory


@pytest.fixture
def executor() -> Recorder:
    return Recorder()


async def send(
    base_url: str,
    token: str | None,
    text: str,
    *,
    binding: str = JSONRPC,
    streaming: bool = False,
    task: Task | None = None,
    return_immediately: bool = False,
) -> list[StreamResponse]:
    """Send one message with ``token`` in ``X-IK-Token`` and return every response."""
    headers = {"X-IK-Token": token} if token is not None else {}
    message = Message(role=ROLE_USER, message_id=str(uuid.uuid4()), parts=[Part(text=text)])
    if task is not None:
        message.task_id = task.id
        message.context_id = task.context_id
    request = SendMessageRequest(
        message=message, configuration=SendMessageConfiguration(return_immediately=return_immediately)
    )
    async with httpx.AsyncClient(headers=headers) as http:
        card = await A2ACardResolver(http, base_url).get_agent_card()
        config = ClientConfig(streaming=streaming, httpx_client=http, supported_protocol_bindings=[binding])
        client = ClientFactory(config).create(card)
        return [response async for response in client.send_message(request)]


def replies(responses: list[StreamResponse]) -> list[str]:
    """The text of every artifact in the responses."""
    texts: list[str] = []
    for response in responses:
        if response.HasField("task"):
            texts.extend(part.text for artifact in response.task.artifacts for part in artifact.parts)
        if response.HasField("artifact_update"):
            texts.extend(part.text for part in response.artifact_update.artifact.parts)
    return texts


@pytest.mark.parametrize("handler", list(HANDLERS))
@pytest.mark.parametrize("binding", [JSONRPC, REST])
async def test_send_message(executor: Recorder, handler: str, binding: str) -> None:
    async with serve(agent(executor, handler)) as base:
        responses = await send(base, "tok", "hi", binding=binding)
    assert replies(responses) == ["tok"]
    assert executor.seen == [("tok", "tok")]


async def test_streaming(executor: Recorder) -> None:
    async with serve(agent(executor)) as base:
        responses = await send(base, "tok", "stream", streaming=True)
    assert replies(responses) == ["tok", "tok"]


async def test_follow_up_with_other_token(executor: Recorder) -> None:
    async with serve(agent(executor)) as base:
        [first] = await send(base, "first", "ask")
        assert first.task.status.state == TaskState.TASK_STATE_INPUT_REQUIRED
        responses = await send(base, "second", "go", task=first.task)
    assert replies(responses) == ["second"]
    assert executor.seen == [("first", "first"), ("second", "second")]


@pytest.mark.parametrize("handler", list(HANDLERS))
async def test_concurrent_requests(executor: Recorder, handler: str) -> None:
    async with serve(agent(executor, handler)) as base:
        a, b = await asyncio.gather(send(base, "token-A", "wait"), send(base, "token-B", "wait"))
    assert (replies(a), replies(b)) == (["token-A"], ["token-B"])


@pytest.mark.parametrize("token", [None, ""])
async def test_no_token(executor: Recorder, token: str | None) -> None:
    async with serve(agent(executor)) as base:
        responses = await send(base, token, "hi")
    assert replies(responses) == ["-"]
    assert executor.seen[0][0] is None


async def test_return_immediately(executor: Recorder) -> None:
    async with serve(agent(executor)) as base:
        [response] = await send(base, "tok", "later", return_immediately=True)
        assert response.task.status.state == TaskState.TASK_STATE_SUBMITTED
        executor.release.set()
        async with asyncio.timeout(5):
            await executor.done.wait()
    assert executor.seen == [("tok", "tok")]


@pytest.fixture
def a2a_logs(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG, logger="a2a")
    return caplog


@pytest.mark.parametrize("strip_header", [True, False])
async def test_strip_header(executor: Recorder, a2a_logs: pytest.LogCaptureFixture, strip_header: bool) -> None:
    token = f"secret-{uuid.uuid4()}"  # nosec B105
    async with serve(agent(executor, strip_header=strip_header)) as base:
        responses = await send(base, token, "quiet")
    assert replies(responses) == ["ok"]
    header = None if strip_header else token
    assert executor.seen == [(token, header)]
    assert (token in a2a_logs.text) is not strip_header
