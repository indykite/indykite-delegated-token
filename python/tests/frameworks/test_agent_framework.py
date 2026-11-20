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

import importlib
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

pytest.importorskip("agent_framework")

from _harness import MCP_MAJOR, Run, check_concurrent_runs
from agent_framework import (
    Agent,
    BaseChatClient,
    ChatResponse,
    Content,
    FunctionInvocationLayer,
    MCPStreamableHTTPTool,
    Message,
)

# MAF up to 1.22 uses mcp 1.x and httpx, from 1.23 mcp 2.x and httpx2
client = importlib.import_module(f"indykite_delegated_token.client.{'httpx2' if MCP_MAJOR >= 2 else 'httpx'}")


class FakeClient(FunctionInvocationLayer[Any], BaseChatClient[Any]):
    """Calls echo on both targets once, then answers."""

    def __init__(self, run: Run) -> None:
        super().__init__()
        self.run = run

    def _inner_get_response(
        self, *, messages: Sequence[Message], stream: bool, options: Mapping[str, Any], **kwargs: Any
    ) -> Any:
        return self._respond(messages)

    async def _respond(self, messages: Sequence[Message]) -> ChatResponse:
        if any(content.type == "function_result" for message in messages for content in message.contents):
            return ChatResponse(messages=[Message(role="assistant", contents=[Content.from_text("done")])])
        await self.run.barrier.wait()
        calls = [
            Content.from_function_call(f"{name}-{self.run.tag}", name, arguments={"tag": self.run.tag})
            for name in ("good_echo", "bad_echo")
        ]
        return ChatResponse(messages=[Message(role="assistant", contents=calls)])


async def run_agent(run: Run) -> None:
    # Tools entered inside the run, with the package's HTTP client
    async with (
        client.http_client() as http,
        MCPStreamableHTTPTool("good", url=run.announcing, tool_name_prefix="good", http_client=http) as good,
        MCPStreamableHTTPTool("bad", url=run.silent, tool_name_prefix="bad", http_client=http) as bad,
    ):
        response = await Agent(FakeClient(run), tools=[good, bad]).run("call the tools")
    assert response.text == "done"


async def test_concurrent_runs() -> None:
    await check_concurrent_runs(run_agent)
