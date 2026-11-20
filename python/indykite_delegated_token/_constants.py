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

"""Names shared with the IndyKite Agent Gateway."""

# HTTP header that carries the delegated token between the hops of a workflow
DELEGATED_TOKEN_HEADER = "X-IK-Token"  # nosec B105

# Id of the MCP extension, announced in the protected resource metadata under `mcp_extensions`
MCP_EXTENSION_ID = "com.indykite/delegated-token"

# URI of the A2A extension, announced in the agent card under `capabilities.extensions`
A2A_EXTENSION_URI = "https://indykite.com/extensions/delegated-token/v1"

# HTTP header in which an A2A client names the extensions it uses
A2A_EXTENSIONS_HEADER = "A2A-Extensions"
