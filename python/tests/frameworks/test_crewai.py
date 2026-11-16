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

"""CrewAI with native ``mcps=``: the package's global ``httpx`` hook sends the token on.

CrewAI opens its MCP clients itself and takes no HTTP client, so ``install_globally`` hooks every ``httpx`` client
of the process. CrewAI lists the tools and calls each one in a worker thread with a copy of the caller's context, so
the token of the run reaches them.
"""

import asyncio
import json
import os
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlsplit

import pytest

# Keep CrewAI off the network: no telemetry, no tracing
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_DISABLE_TRACKING", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

pytest.importorskip("crewai")

from _harness import Run, check_concurrent_runs
from crewai import Agent
from crewai.llms.base_llm import BaseLLM
from crewai.mcp import MCPServerHTTP

from indykite_delegated_token.client.httpx import install_globally, uninstall_globally


def origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


class FakeLLM(BaseLLM):
    """Calls ``echo(tag)`` on every MCP server once, after both runs got there, then answers ``done``."""

    tag: str
    barrier: Any  # the asyncio.Barrier of the test's event loop
    loop: Any  # the test's event loop

    def supports_function_calling(self) -> bool:
        return True

    def _wait_for_the_other_run(self) -> None:
        # The run has its own event loop in a worker thread; the barrier belongs to the test's loop
        asyncio.run_coroutine_threadsafe(self.barrier.wait(), self.loop).result(timeout=30)

    def _answer(self, messages: Any, tools: Any) -> Any:
        if any(isinstance(message, dict) and message.get("role") == "tool" for message in messages):
            return "done"
        self._wait_for_the_other_run()
        names = [tool["function"]["name"] for tool in tools or [] if tool["function"]["name"].endswith("echo")]
        arguments = json.dumps({"tag": self.tag})
        return [
            {"id": f"call-{index}", "type": "function", "function": {"name": name, "arguments": arguments}}
            for index, name in enumerate(names)
        ]

    def call(self, messages: Any, tools: Any = None, *args: Any, **kwargs: Any) -> Any:
        return self._answer(messages, tools)

    async def acall(self, messages: Any, tools: Any = None, *args: Any, **kwargs: Any) -> Any:
        return self._answer(messages, tools)


@pytest.fixture(autouse=True)
def restore() -> Iterator[None]:
    yield
    uninstall_globally()


@pytest.mark.parametrize("silent_listed", [True, False], ids=["silent-listed", "silent-not-listed"])
async def test_concurrent_runs(silent_listed: bool) -> None:
    loop = asyncio.get_running_loop()

    async def run(run: Run) -> None:
        gateways = [origin(run.announcing), origin(run.silent)] if silent_listed else [origin(run.announcing)]
        install_globally(gateways)
        agent = Agent(
            role="caller",
            goal="call the echo tools",
            backstory="a test agent",
            llm=FakeLLM(model="fake", tag=run.tag, barrier=run.barrier, loop=loop),
            mcps=[MCPServerHTTP(url=run.announcing), MCPServerHTTP(url=run.silent)],
        )
        # CrewAI lists the tools while blocking its event loop, and the targets are served by this one: run the agent
        # in a thread with its own loop. asyncio.to_thread copies the context, so the run keeps its token.
        await asyncio.to_thread(asyncio.run, agent.kickoff_async("call echo"))

    await check_concurrent_runs(run)
