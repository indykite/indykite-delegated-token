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
import json
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from typing import Any

import pytest

pytest.importorskip("agents")

from _harness import MCP_MAJOR, Run, check_concurrent_runs, sdk
from agents import Agent, Model, ModelResponse, Runner, Usage, set_tracing_disabled
from agents.mcp import MCPServerStreamableHttp
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

# The package's client for the installed MCP SDK
http_client = sdk(f"indykite_delegated_token.client.{'httpx2' if MCP_MAJOR >= 2 else 'httpx'}").http_client


def answer(text: str) -> ResponseOutputMessage:
    content: list[Any] = [ResponseOutputText(type="output_text", text=text, annotations=[])]
    return ResponseOutputMessage(id="msg", type="message", role="assistant", status="completed", content=content)


class FakeModel(Model):
    """Calls every ``echo`` tool with the run's tag once both runs got here, then answers with text."""

    def __init__(self, tag: str, barrier: asyncio.Barrier) -> None:
        self.tag = tag
        self.barrier = barrier

    async def get_response(
        self,
        system_instructions: str | None,
        input: str | list[Any],
        model_settings: Any,
        tools: list[Any],
        *args: Any,
        **kwargs: Any,
    ) -> ModelResponse:
        if any(isinstance(item, dict) and item.get("type") == "function_call_output" for item in input):
            return ModelResponse(output=[answer("done")], usage=Usage(), response_id=None)
        await self.barrier.wait()
        arguments = json.dumps({"tag": self.tag})
        calls: list[Any] = [
            ResponseFunctionToolCall(type="function_call", call_id=f"call-{i}", name=tool.name, arguments=arguments)
            for i, tool in enumerate(tools)
            if "echo" in tool.name
        ]
        return ModelResponse(output=calls, usage=Usage(), response_id=None)

    def stream_response(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        raise NotImplementedError


def server(name: str, url: str) -> MCPServerStreamableHttp:
    return MCPServerStreamableHttp(params={"url": url, "httpx_client_factory": http_client}, name=name)


async def run_agent(run: Run) -> None:
    async with AsyncExitStack() as stack:
        # Entered inside the run, so the sessions belong to it
        targets = [("good", run.announcing), ("bad", run.silent)]
        servers = [await stack.enter_async_context(server(name, url)) for name, url in targets]
        agent = Agent(
            name="agent",
            model=FakeModel(run.tag, run.barrier),
            mcp_servers=servers,
            mcp_config={"include_server_in_tool_names": True},
        )
        result = await Runner.run(agent, run.tag)
    assert result.final_output == "done"


async def test_concurrent_runs() -> None:
    set_tracing_disabled(True)
    await check_concurrent_runs(run_agent)
