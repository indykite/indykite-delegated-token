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

"""Google ADK: the delegated token as a header of ``McpToolset``."""

from __future__ import annotations

from typing import TYPE_CHECKING

from indykite_delegated_token._constants import DELEGATED_TOKEN_HEADER
from indykite_delegated_token._context import get_delegated_token

if TYPE_CHECKING:
    from google.adk.agents.readonly_context import ReadonlyContext

__all__ = ["header_provider"]


def header_provider(context: ReadonlyContext) -> dict[str, str]:  # skipcq: PYL-W0613 - the signature ADK calls
    """``McpToolset(header_provider=...)``: ``{"X-IK-Token": <token of the request>}``, or ``{}`` without one.

    Use it with the package's client factory in the connection parameters: the factory removes the header for servers
    that do not announce the extension.
    """
    token = get_delegated_token()
    return {} if token is None else {DELEGATED_TOKEN_HEADER: token}
