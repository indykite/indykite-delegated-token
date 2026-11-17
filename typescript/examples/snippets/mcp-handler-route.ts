// Copyright (c) 2026 IndyKite
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Vercel `mcp-handler` in a Next.js route (`app/[transport]/route.ts`): a tool that calls another MCP server with
// the delegated token.

import { delegatedTokenFetch } from "@indykite/delegated-token/fetch";
import { withDelegatedToken } from "@indykite/delegated-token/mcp-handler";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "mcp-handler";
import * as z from "zod";

const handler = createMcpHandler((server) => {
  server.registerTool(
    "call_target",
    { description: "Call a tool of the MCP server at TARGET_MCP_URL", inputSchema: z.object({ tool: z.string() }) },
    async ({ tool }) => {
      // The target comes from the configuration, never from the caller
      const url = new URL(process.env.TARGET_MCP_URL ?? "http://localhost:9000/mcp");
      const client = new Client({ name: "sample", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url, { fetch: delegatedTokenFetch() }));
      try {
        const result = await client.callTool({ name: tool, arguments: {} });
        return { content: result.content };
      } finally {
        await client.close();
      }
    },
  );
});

// Each request runs with its X-IK-Token header as the delegated token
const route = withDelegatedToken(handler);

export { route as DELETE, route as GET, route as POST };
