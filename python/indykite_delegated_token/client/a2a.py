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

"""Client interceptor that propagates the delegated token to A2A agents."""

from __future__ import annotations

from a2a.client.client import ClientCallContext
from a2a.client.interceptors import AfterArgs, BeforeArgs, ClientCallInterceptor
from a2a.client.service_parameters import ServiceParametersFactory, with_a2a_extensions

from indykite_delegated_token._constants import A2A_EXTENSION_URI, DELEGATED_TOKEN_HEADER
from indykite_delegated_token._context import get_delegated_token

__all__ = ["DelegatedTokenInterceptor", "announces_extension"]


def announces_extension(agent_card: object) -> bool:
    """Whether the agent card lists the delegated token extension in ``capabilities.extensions``."""
    capabilities = getattr(agent_card, "capabilities", None)
    extensions = getattr(capabilities, "extensions", None) or ()
    return any(getattr(extension, "uri", None) == A2A_EXTENSION_URI for extension in extensions)


class DelegatedTokenInterceptor(ClientCallInterceptor):
    """Adds ``X-IK-Token`` and the extension URI in ``A2A-Extensions`` to calls to agents that announce it.

    Works with every A2A transport, because it sets service parameters rather than HTTP headers. Calls without a
    delegated token, and calls to agents whose card does not list the extension, are left unchanged. A token the
    caller already set is kept.

    Pass it to ``ClientFactory.create(card, interceptors=[DelegatedTokenInterceptor()])``.
    """

    async def before(self, args: BeforeArgs) -> None:  # skipcq: PYL-R0201 - overrides ClientCallInterceptor.before
        token = get_delegated_token()
        if token is None or not announces_extension(args.agent_card):
            return
        context = args.context if args.context is not None else ClientCallContext()
        updates = [with_a2a_extensions([A2A_EXTENSION_URI])]
        wanted = DELEGATED_TOKEN_HEADER.lower()  # service parameters become HTTP headers, whose names ignore case
        if not any(name.lower() == wanted for name in context.service_parameters or {}):
            updates.append(lambda parameters: parameters.__setitem__(DELEGATED_TOKEN_HEADER, token))
        parameters = ServiceParametersFactory.create_from(context.service_parameters, updates)
        # A copy, never the caller's context: a context reused for a later call would keep this call's token
        args.context = context.model_copy(update={"service_parameters": parameters})

    async def after(self, args: AfterArgs) -> None:  # skipcq: PYL-R0201 - overrides ClientCallInterceptor.after
        return None
