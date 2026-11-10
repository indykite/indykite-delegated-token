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

"""IndyKite delegated token propagation for AI agents and MCP servers."""

from indykite_delegated_token.version import __version__

__all__ = ["DELEGATED_TOKEN_HEADER", "__version__"]

# HTTP header that carries the delegated token between the hops of a workflow
DELEGATED_TOKEN_HEADER = "X-IK-Token"  # nosec B105
