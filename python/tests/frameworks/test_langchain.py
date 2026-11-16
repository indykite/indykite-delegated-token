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

"""LangChain MCP adapters with a LangGraph agent, on mcp 1.x."""

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest

pytest.importorskip("langchain_mcp_adapters")
pytest.importorskip("langgraph")

from _harness import Run, check_concurrent_runs, mcp_target, serve
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableConfig
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.interceptors import MCPToolCallRequest
from langgraph.prebuilt import create_react_agent

from indykite_delegated_token import get_delegated_token, use_token
from indykite_delegated_token.client.httpx import http_client
from indykite_delegated_token.integrations.langchain import run_config_token, token_from_run_config

# create_react_agent moved to the `langchain` package, which these tests do not need
pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


class FakeModel(GenericFakeChatModel):
    """Calls ``echo(tag)`` on both servers once, then answers with text."""

    tag: str
    barrier: asyncio.Barrier | None = None
    calls: int = 0

    def bind_tools(self, tools: Any, **kwargs: Any) -> "FakeModel":
        return self

    async def _agenerate(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> ChatResult:
        self.calls += 1
        if self.calls > 1:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="done"))])
        if self.barrier is not None:
            await self.barrier.wait()  # both runs are mid-run before the tool calls
        tool_calls = [
            {"name": f"{server}_echo", "args": {"tag": self.tag}, "id": f"{server}-{self.tag}"}
            for server in ("good", "silent")
        ]
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=tool_calls))])


def mcp_client(good: str, silent: str, **kwargs: Any) -> MultiServerMCPClient:
    def connection(url: str) -> Any:
        return {"url": url, "transport": "streamable_http", "httpx_client_factory": http_client}

    return MultiServerMCPClient(
        {"good": connection(good), "silent": connection(silent)}, tool_name_prefix=True, **kwargs
    )


async def run_agent(client: MultiServerMCPClient, model: FakeModel, config: Any = None) -> None:
    agent = create_react_agent(model, await client.get_tools())
    await agent.ainvoke({"messages": [("user", "hi")]}, config=config)


async def test_concurrent_runs() -> None:
    async def run(r: Run) -> None:
        # The client and its tools are made inside the run, as the docs say
        await run_agent(mcp_client(r.announcing, r.silent), FakeModel(messages=iter([]), tag=r.tag, barrier=r.barrier))

    await check_concurrent_runs(run)


async def test_token_from_run_config() -> None:
    announced: dict[str, str | None] = {}
    silent: dict[str, str | None] = {}
    target = mcp_target(True, announced, require_token=True)  # as a gateway, lists tools only with a token
    async with serve(target) as good, serve(mcp_target(False, silent)) as bad:
        client = mcp_client(f"{good}/mcp", f"{bad}/mcp", tool_interceptors=[token_from_run_config])
        config: RunnableConfig = {"configurable": {"x-ik-token": "token-A"}}
        # The graph is built for the run: the token of the run configuration lists the tools
        with use_token(run_config_token(config)):
            tools = await client.get_tools()
        # The tool calls run outside that block: the interceptor sets the token for each
        agent = create_react_agent(FakeModel(messages=iter([]), tag="A"), tools)
        await agent.ainvoke({"messages": [("user", "hi")]}, config=config)
    assert get_delegated_token() is None
    assert announced == {"A": "token-A"}
    assert silent == {"A": None}


async def test_discovery_needs_the_run_config_token() -> None:
    async with serve(mcp_target(True, require_token=True)) as good, serve(mcp_target(False)) as bad:
        client = mcp_client(f"{good}/mcp", f"{bad}/mcp", tool_interceptors=[token_from_run_config])
        with pytest.raises(ExceptionGroup) as raised:
            await client.get_tools()
    assert "401 Unauthorized" in repr(raised.value)


@pytest.mark.parametrize(
    ("config", "expected"),
    [(None, None), ({}, None), ({"configurable": {"X-IK-Token": "run"}}, "run")],
    ids=["not-mapping", "no-configurable", "token"],
)
def test_run_config_token(config: object, expected: str | None) -> None:
    assert run_config_token(config) == expected


def request(runtime: object) -> MCPToolCallRequest:
    return MCPToolCallRequest(name="echo", args={}, server_name="good", runtime=runtime)


@pytest.mark.parametrize(
    ("runtime", "expected"),
    [
        (None, "outer"),
        (SimpleNamespace(config=None), "outer"),
        (SimpleNamespace(config={}), "outer"),
        (SimpleNamespace(config={"configurable": {"other": "x"}}), "outer"),
        (SimpleNamespace(config={"configurable": {"X-IK-Token": "run"}}), "run"),
        (SimpleNamespace(config={"configurable": {"x-ik-token": "run"}}), "run"),
    ],
    ids=["no-runtime", "config-not-mapping", "no-configurable", "no-token", "token", "lower-case"],
)
async def test_interceptor(runtime: object, expected: str) -> None:
    async def handler(_: MCPToolCallRequest) -> str:
        return json.dumps(get_delegated_token())

    with use_token("outer"):
        result = await token_from_run_config(request(runtime), handler)
        assert get_delegated_token() == "outer"
    assert json.loads(result) == expected
