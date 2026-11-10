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

pytest.importorskip("a2a")

from a2a.client.client import ClientCallContext
from a2a.client.interceptors import AfterArgs, BeforeArgs
from a2a.types.a2a_pb2 import AgentCapabilities, AgentCard, AgentExtension

from indykite_delegated_token import A2A_EXTENSION_URI, A2A_EXTENSIONS_HEADER, DELEGATED_TOKEN_HEADER, use_token
from indykite_delegated_token.client.a2a import DelegatedTokenInterceptor, announces_extension

OTHER_URI = "https://example.com/extensions/other/v1"


def card(*uris: str) -> AgentCard:
    return AgentCard(
        name="agent",
        capabilities=AgentCapabilities(extensions=[AgentExtension(uri=uri) for uri in uris]),
    )


def args(agent_card: AgentCard, context: ClientCallContext | None = None) -> BeforeArgs:
    return BeforeArgs(input=None, method="send_message", agent_card=agent_card, context=context)


def test_announces_extension() -> None:
    assert announces_extension(card(OTHER_URI, A2A_EXTENSION_URI))
    assert not announces_extension(card(OTHER_URI))
    assert not announces_extension(AgentCard(name="agent"))
    assert not announces_extension(None)


async def test_adds_token_and_extension_without_context() -> None:
    before = args(card(A2A_EXTENSION_URI))
    with use_token("tok"):
        await DelegatedTokenInterceptor().before(before)
    assert before.context is not None
    assert before.context.service_parameters == {
        DELEGATED_TOKEN_HEADER: "tok",
        A2A_EXTENSIONS_HEADER: A2A_EXTENSION_URI,
    }


async def test_merges_with_existing_extensions() -> None:
    context = ClientCallContext(service_parameters={A2A_EXTENSIONS_HEADER: OTHER_URI, "Other": "x"})
    before = args(card(A2A_EXTENSION_URI), context)
    with use_token("tok"):
        await DelegatedTokenInterceptor().before(before)
    assert before.context is not None
    assert before.context is not context
    assert context.service_parameters == {A2A_EXTENSIONS_HEADER: OTHER_URI, "Other": "x"}  # the caller's is unchanged
    parameters = before.context.service_parameters or {}
    assert sorted(parameters[A2A_EXTENSIONS_HEADER].split(",")) == sorted([OTHER_URI, A2A_EXTENSION_URI])
    assert parameters[DELEGATED_TOKEN_HEADER] == "tok"
    assert parameters["Other"] == "x"


async def test_keeps_caller_token() -> None:
    context = ClientCallContext(service_parameters={DELEGATED_TOKEN_HEADER: "caller"})
    before = args(card(A2A_EXTENSION_URI), context)
    with use_token("tok"):
        await DelegatedTokenInterceptor().before(before)
    assert before.context is not None
    assert (before.context.service_parameters or {})[DELEGATED_TOKEN_HEADER] == "caller"


async def test_keeps_caller_token_in_any_case() -> None:
    context = ClientCallContext(service_parameters={"x-ik-token": "caller"})
    before = args(card(A2A_EXTENSION_URI), context)
    with use_token("tok"):
        await DelegatedTokenInterceptor().before(before)
    assert before.context is not None
    parameters = before.context.service_parameters or {}
    assert [value for name, value in parameters.items() if name.lower() == "x-ik-token"] == ["caller"]


async def test_reused_context_gets_the_token_of_each_call() -> None:
    context = ClientCallContext()
    interceptor, agent = DelegatedTokenInterceptor(), card(A2A_EXTENSION_URI)
    sent = []
    for token in ("tok-a", "tok-b", None):
        before = args(agent, context)
        with use_token(token):
            await interceptor.before(before)
        sent.append((before.context.service_parameters or {}).get(DELEGATED_TOKEN_HEADER) if before.context else None)
    assert sent == ["tok-a", "tok-b", None]
    assert not context.service_parameters


async def test_agent_without_extension_gets_nothing() -> None:
    before = args(card(OTHER_URI))
    with use_token("tok"):
        await DelegatedTokenInterceptor().before(before)
    assert before.context is None


async def test_no_token_adds_nothing() -> None:
    before = args(card(A2A_EXTENSION_URI))
    await DelegatedTokenInterceptor().before(before)
    assert before.context is None


async def test_after_does_nothing() -> None:
    after = AfterArgs(result="r", method="send_message", agent_card=card())
    await DelegatedTokenInterceptor().after(after)
    assert after.result == "r"
