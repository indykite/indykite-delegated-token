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

"""The sample A2A agent behind fake gateways.

User -> gw1 -> sample agent -> gw2 -> A2A agent, and sample agent -> gw3 -> MCP server. Each gateway with a token
service appends its hop to the chain in ``X-IK-Token``, so a target that sees ``user>gw1>gw2`` got the token the sample
agent received. Without gateways, the targets announce nothing and must see no token.
"""

import contextlib
import importlib.util
import json
import sys
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

pytest.importorskip("a2a")

import httpx
from _harness import MCP_MAJOR, a2a_agent, fake_gateway, mcp_target, serve
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.helpers import new_data_part, new_text_part
from a2a.types.a2a_pb2 import ROLE_USER, Message, Part, SendMessageRequest, Task, TaskState

from indykite_delegated_token import A2A_EXTENSION_URI

if MCP_MAJOR < 2:
    pytest.skip("the sample agent uses the mcp 2.x client", allow_module_level=True)

SAMPLE = Path(__file__).parents[1] / "examples" / "sample_a2a_agent" / "agent.py"
ASK = new_text_part("hi")
CALL_TOOL = new_data_part({"mcp_tool": "echo"})
UNREACHABLE = "http://127.0.0.1:1"


def load_sample() -> ModuleType:
    spec = importlib.util.spec_from_file_location("sample_a2a_agent", SAMPLE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look up their module
    spec.loader.exec_module(module)
    return module


sample = load_sample()


@pytest.fixture
async def stack() -> AsyncIterator[contextlib.AsyncExitStack]:
    async with contextlib.AsyncExitStack() as exit_stack:
        yield exit_stack


async def start(stack: contextlib.AsyncExitStack, *, gateways: bool = True, middleware: bool = True) -> str:
    """Serve the targets, the sample agent and gw1, and return gw1's URL.

    With ``gateways``, the sample agent reaches its targets through gw2 and gw3. Otherwise it reaches them directly.
    """
    agent = await stack.enter_async_context(serve(a2a_agent(announce=False)))
    mcp = await stack.enter_async_context(serve(mcp_target(announce=False)))
    if gateways:
        agent = await stack.enter_async_context(serve(fake_gateway(agent, token_service=True, hop="gw2")))
        mcp = await stack.enter_async_context(serve(fake_gateway(mcp, token_service=True, hop="gw3", a2a=False)))

    agent_url = await stack.enter_async_context(serve(sample_app(agent, f"{mcp}/mcp", middleware=middleware)))
    return await stack.enter_async_context(serve(fake_gateway(agent_url, token_service=True, hop="gw1")))


def sample_app(agent: str, mcp: str = UNREACHABLE, *, middleware: bool = True) -> Any:
    """An app factory for the sample agent with the given targets."""

    def factory(base_url: str) -> Any:
        config = sample.Config(public_url=base_url, target_mcp_url=mcp, target_agent_url=agent)
        app = sample.build_app(config)
        if not middleware:
            app.user_middleware.clear()
        return app

    return factory


async def send(gateway: str, part: Part) -> Task:
    """Send a message as the user, with a bearer token and no ``X-IK-Token``, and return the task."""
    async with httpx.AsyncClient(headers={"Authorization": "Bearer user"}, timeout=30) as http:
        card = await A2ACardResolver(http, gateway).get_agent_card()
        client = ClientFactory(ClientConfig(streaming=False, httpx_client=http)).create(card)
        request = SendMessageRequest(message=Message(role=ROLE_USER, message_id=str(uuid.uuid4()), parts=[part]))
        async for response in client.send_message(request):
            return response.task
    raise AssertionError("the agent did not answer")


def reply(task: Task) -> Any:
    assert task.status.state == TaskState.TASK_STATE_COMPLETED, task
    return json.loads(task.artifacts[0].parts[0].text)


async def test_a2a_target_gets_the_chain(stack: contextlib.AsyncExitStack) -> None:
    gateway = await start(stack)
    seen = reply(await send(gateway, ASK))
    assert seen["token"] == "user>gw1>gw2"
    assert A2A_EXTENSION_URI in seen["extensions"]


async def test_mcp_target_gets_the_chain(stack: contextlib.AsyncExitStack) -> None:
    gateway = await start(stack)
    assert reply(await send(gateway, CALL_TOOL)) == "user>gw1>gw3"


@pytest.mark.parametrize("part", [ASK, CALL_TOOL], ids=["a2a", "mcp"])
async def test_silent_targets_get_no_token(stack: contextlib.AsyncExitStack, part: Part) -> None:
    gateway = await start(stack, gateways=False)
    task = await send(gateway, part)
    assert "user" not in task.artifacts[0].parts[0].text  # nor does the sample agent add its own token
    seen = reply(task)
    assert seen in (None, {"token": None, "extensions": None})


@pytest.mark.parametrize("part", [ASK, CALL_TOOL], ids=["a2a", "mcp"])
async def test_gateways_refuse_without_middleware(stack: contextlib.AsyncExitStack, part: Part) -> None:
    gateway = await start(stack, middleware=False)
    task = await send(gateway, part)
    assert task.status.state == TaskState.TASK_STATE_FAILED


async def test_mcp_tool_error_fails_the_task(stack: contextlib.AsyncExitStack) -> None:
    gateway = await start(stack)
    task = await send(gateway, new_data_part({"mcp_tool": "missing"}))
    assert task.status.state == TaskState.TASK_STATE_FAILED


@pytest.mark.parametrize(
    ("reachable", "state"),
    [(True, TaskState.TASK_STATE_COMPLETED), (False, TaskState.TASK_STATE_FAILED)],
    ids=["completed", "failed"],
)
async def test_relay_keeps_the_target_task_state(
    stack: contextlib.AsyncExitStack, reachable: bool, state: TaskState
) -> None:
    """Sample agent -> sample agent -> A2A agent. The inner one fails when its target is unreachable."""
    target = await stack.enter_async_context(serve(a2a_agent(announce=False))) if reachable else UNREACHABLE
    inner = await stack.enter_async_context(serve(sample_app(target)))
    outer = await stack.enter_async_context(serve(sample_app(inner)))
    task = await send(outer, ASK)
    assert task.status.state == state, task
