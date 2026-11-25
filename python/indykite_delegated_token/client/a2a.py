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
from a2a.client.service_parameters import ServiceParametersFactory, ServiceParametersUpdate, with_a2a_extensions

from indykite_delegated_token._constants import A2A_EXTENSION_URI, DELEGATED_TOKEN_HEADER
from indykite_delegated_token._context import get_delegated_token
from indykite_delegated_token.client._discovery import secure_transport

__all__ = ["DelegatedTokenInterceptor", "announces_extension"]

# A gRPC interface is a target such as `host:port`, not an http URL: its security is that of the channel the caller
# creates. Interfaces of every other binding, also unknown ones, are checked as URLs.
_GRPC_BINDING = "GRPC"


def announces_extension(agent_card: object) -> bool:
    """Whether the agent card lists the delegated token extension in ``capabilities.extensions``."""
    capabilities = getattr(agent_card, "capabilities", None)
    extensions = getattr(capabilities, "extensions", None) or ()
    return any(getattr(extension, "uri", None) == A2A_EXTENSION_URI for extension in extensions)


_WANTED = DELEGATED_TOKEN_HEADER.lower()  # service parameters become HTTP headers, whose names ignore case


def _caller_token(parameters: dict[str, str]) -> str | None:
    return next((value for name, value in parameters.items() if name.lower() == _WANTED and value), None)


def _drop_token(parameters: dict[str, str]) -> None:
    for name in [name for name in parameters if name.lower() == _WANTED]:
        del parameters[name]


def _updated(context: ClientCallContext, updates: list[ServiceParametersUpdate]) -> ClientCallContext:
    # A copy, never the caller's context: a context reused for a later call would keep this call's token
    parameters = ServiceParametersFactory.create_from(context.service_parameters, updates)
    return context.model_copy(update={"service_parameters": parameters})


class DelegatedTokenInterceptor(ClientCallInterceptor):
    """Adds ``X-IK-Token`` and the extension URI in ``A2A-Extensions`` to calls to agents that announce it.

    Works with every A2A transport, because it sets service parameters rather than HTTP headers. The token is the one
    the caller set in ``X-IK-Token``, or else the one of the request being handled. Calls to agents whose card does
    not list the extension, or that fail the check below, go out without ``X-IK-Token``, also when the caller set it.

    The card is trusted as given: a2a-sdk tells the interceptor neither where it came from nor which of its interfaces
    the call uses. The token only goes to agents whose interfaces all pass :func:`secure_transport`, unless
    ``allow_http``. gRPC interfaces, ``host:port`` targets rather than URLs, are left out: over gRPC the token is as
    protected as the channel, so create it with TLS credentials.

    The token goes out as an HTTP header of the httpx client given to a2a-sdk. Keep that client's
    ``follow_redirects=False``, a2a-sdk's and httpx's default: httpx copies the header onto every redirect, also to
    another origin or from ``https`` to ``http``.

    Pass it to ``ClientFactory.create(card, interceptors=[DelegatedTokenInterceptor()])``.
    """

    def __init__(self, *, allow_http: bool = False) -> None:
        self._allow_http = allow_http

    def _trusted(self, agent_card: object) -> bool:
        interfaces = getattr(agent_card, "supported_interfaces", None) or ()
        secure = self._allow_http or all(
            secure_transport(getattr(i, "url", ""))
            for i in interfaces
            if str(getattr(i, "protocol_binding", "")).upper() != _GRPC_BINDING
        )
        return secure and announces_extension(agent_card)

    async def before(self, args: BeforeArgs) -> None:
        context = args.context if args.context is not None else ClientCallContext()
        caller = _caller_token(context.service_parameters or {})
        token = caller or get_delegated_token()
        if token is None:
            return
        if not self._trusted(args.agent_card):
            if caller is not None:
                args.context = _updated(context, [_drop_token])
            return
        updates = [with_a2a_extensions([A2A_EXTENSION_URI])]
        if caller is None:
            updates += [_drop_token, lambda parameters: parameters.__setitem__(DELEGATED_TOKEN_HEADER, token)]
        args.context = _updated(context, updates)

    async def after(self, args: AfterArgs) -> None:  # skipcq: PYL-R0201 - overrides ClientCallInterceptor.after
        return None
