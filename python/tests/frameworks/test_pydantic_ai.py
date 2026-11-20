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

import pytest

pytest.importorskip("pydantic_ai")
pytest.importorskip("httpx2")

from _harness import Run, check_concurrent_runs
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from indykite_delegated_token.client import httpx2


def fake_model(run: Run) -> FunctionModel:
    """Calls echo on both targets once, then answers."""

    async def respond(messages: list[ModelMessage], _: AgentInfo) -> ModelResponse:
        returned = any(isinstance(part, ToolReturnPart) for message in messages for part in message.parts)
        if returned:
            return ModelResponse(parts=[TextPart("done")])
        await run.barrier.wait()
        return ModelResponse(
            parts=[
                ToolCallPart("good_echo", {"tag": run.tag}),
                ToolCallPart("bad_echo", {"tag": run.tag}),
            ]
        )

    return FunctionModel(respond)


async def run_agent(run: Run) -> None:
    # Toolsets created inside the run, each with the package's HTTP client
    async with httpx2.http_client() as http:
        good = MCPToolset(run.announcing, http_client=http).prefixed("good")
        bad = MCPToolset(run.silent, http_client=http).prefixed("bad")
        agent = Agent(fake_model(run), toolsets=[good, bad])
        async with agent:
            result = await agent.run("call the tools")
    assert result.output == "done"


async def test_concurrent_runs() -> None:
    await check_concurrent_runs(run_agent)
