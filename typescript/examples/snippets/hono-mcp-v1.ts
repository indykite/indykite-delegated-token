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

// Hono and the MCP TypeScript SDK 1.x: a tool that calls another MCP server with the delegated token.

import { serve } from "@hono/node-server";
import { delegatedTokenFetch } from "@indykite/delegated-token/fetch";
import { delegatedToken } from "@indykite/delegated-token/hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";

/** An MCP server with the `call_target` tool. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "sample", version: "1.0.0" });
  server.registerTool(
    "call_target",
    { description: "Call a tool of the MCP server at TARGET_MCP_URL", inputSchema: { tool: z.string() } },
    async ({ tool }) => {
      // The target comes from the configuration, never from the caller
      const url = new URL(process.env.TARGET_MCP_URL ?? "http://localhost:9000/mcp");
      const client = new Client({ name: "sample", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url, { fetch: delegatedTokenFetch() }));
      try {
        const result = await client.callTool({ name: tool, arguments: {} });
        return { content: result.content as { type: "text"; text: string }[] };
      } finally {
        await client.close();
      }
    },
  );
  return server;
}

const app = new Hono();
app.use(delegatedToken()); // the tools see the delegated token of the request they handle
app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport();
  await buildServer().connect(transport);
  return transport.handleRequest(c.req.raw);
});

serve({ fetch: app.fetch, port: 8000 });
