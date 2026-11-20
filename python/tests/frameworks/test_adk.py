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
from collections.abc import AsyncGenerator
from typing import Any

import pytest

pytest.importorskip("google.adk")

from _harness import MCP_MAJOR, Run, check_concurrent_runs, mcp_target, sdk, serve
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from google.genai import types

from indykite_delegated_token import use_token
from indykite_delegated_token.integrations.adk import header_provider

# The package's client for the installed MCP SDK
http_client = sdk(f"indykite_delegated_token.client.{'httpx2' if MCP_MAJOR >= 2 else 'httpx'}").http_client


# The echo tool of each toolset, by its prefix
NAMES = ["good_echo", "bad_echo"]


class FakeLlm(BaseLlm):
    """Calls ``echo(tag)`` on both toolsets once both runs got here, then answers with text."""

    barrier: Any = None

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        contents = llm_request.contents
        if any(part.function_response for part in contents[-1].parts or ()):
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="done")]))
            return
        tag = contents[0].parts[0].text if contents[0].parts else ""
        await self.barrier.wait()
        calls = [types.Part(function_call=types.FunctionCall(name=name, args={"tag": tag})) for name in NAMES]
        yield LlmResponse(content=types.Content(role="model", parts=calls))


def toolset(url: str, prefix: str, factory: Any = http_client) -> McpToolset:
    params = StreamableHTTPConnectionParams(url=url, httpx_client_factory=factory)
    return McpToolset(connection_params=params, header_provider=header_provider, tool_name_prefix=prefix)


async def run_agent(run: Run, factory: Any = http_client) -> None:
    toolsets = [toolset(run.announcing, "good", factory), toolset(run.silent, "bad", factory)]
    agent = LlmAgent(name="agent", model=FakeLlm(model="fake", barrier=run.barrier), tools=list(toolsets))
    runner = InMemoryRunner(agent=agent, app_name="test")
    session = await runner.session_service.create_session(app_name="test", user_id="user")
    message = types.Content(role="user", parts=[types.Part(text=run.tag)])
    try:
        async for _ in runner.run_async(user_id="user", session_id=session.id, new_message=message):
            pass
    finally:
        for each in toolsets:
            await each.close()
        await runner.close()


async def test_concurrent_runs() -> None:
    await check_concurrent_runs(run_agent)


async def test_without_package_client_silent_target_gets_the_token() -> None:
    # Why the package's client factory is required: the header provider alone sends the token everywhere
    default_factory = sdk("mcp.shared._httpx_utils").create_mcp_http_client
    announced: dict[str, str | None] = {}
    silent: dict[str, str | None] = {}
    async with serve(mcp_target(True, announced)) as good, serve(mcp_target(False, silent)) as bad:
        with use_token("token-A"):
            await run_agent(Run("A", f"{good}/mcp", f"{bad}/mcp", asyncio.Barrier(1)), default_factory)
    assert silent == {"A": "token-A"}


def test_header_provider() -> None:
    context: Any = None
    assert header_provider(context) == {}
    with use_token("tok"):
        assert header_provider(context) == {"X-IK-Token": "tok"}
