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

from collections.abc import Sequence
from typing import Any

import pytest

pytest.importorskip("llama_index.tools.mcp")
pytest.importorskip("httpx2")

from _harness import Run, check_concurrent_runs
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.base.llms.types import ChatMessage, MessageRole, ToolCallBlock
from llama_index.core.llms.mock import MockFunctionCallingLLM
from llama_index.core.tools import FunctionTool
from llama_index.tools.mcp import BasicMCPClient, aget_tools_from_mcp_url

from indykite_delegated_token.client import httpx2


def fake_llm(run: Run) -> MockFunctionCallingLLM:
    """Calls echo on both targets once, then answers."""

    def respond(messages: Sequence[ChatMessage], **_: Any) -> ChatMessage:
        if any(message.role == MessageRole.TOOL for message in messages):
            return ChatMessage(role=MessageRole.ASSISTANT, content="done")
        blocks = [
            ToolCallBlock(tool_call_id=f"{name}-{run.tag}", tool_name=name, tool_kwargs={"tag": run.tag})
            for name in ("good_echo", "bad_echo")
        ]
        return ChatMessage(role=MessageRole.ASSISTANT, blocks=blocks)

    waited: list[bool] = []  # wait once, before the tool calls

    class Llm(MockFunctionCallingLLM):
        async def astream_chat_with_tools(self, *args: Any, **kwargs: Any) -> Any:
            if not waited:
                waited.append(True)
                await run.barrier.wait()
            return await super().astream_chat_with_tools(*args, **kwargs)

    llm = Llm()
    llm.response_generator = respond
    return llm


async def echo_tool(url: str, name: str, http: Any) -> FunctionTool:
    tools = await aget_tools_from_mcp_url(url, client=BasicMCPClient(url, http_client=http), allowed_tools=["echo"])
    tool: FunctionTool = tools[0]
    tool.metadata.name = name  # both targets have an echo tool
    return tool


async def run_agent(run: Run) -> None:
    # Clients created inside the run, with the package's HTTP client
    async with httpx2.http_client() as http:
        good = await echo_tool(run.announcing, "good_echo", http)
        bad = await echo_tool(run.silent, "bad_echo", http)
        agent = FunctionAgent(tools=[good, bad], llm=fake_llm(run))
        response = await agent.run("call the tools")
    assert str(response) == "done"


async def test_concurrent_runs() -> None:
    await check_concurrent_runs(run_agent)
