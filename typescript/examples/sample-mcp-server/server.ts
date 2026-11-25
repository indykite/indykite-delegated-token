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

// Sample MCP server whose tools call another MCP server and an A2A agent, with the delegated token.
//
// The agent gateway in front of this server sends the delegated token in `X-IK-Token`. The `delegatedToken()`
// middleware makes it available to the tools, and the package's fetch wrapper and A2A interceptor send it on to the
// targets that announce the extension.
//
// Environment:
//   TARGET_MCP_URL    MCP endpoint that `call_mcp_tool` calls, through its gateway
//   TARGET_AGENT_URL  base URL of the A2A agent that `ask_agent` calls, through its gateway
//   ALLOW_HTTP        set to 1 to also send the token over plain HTTP, such as to a gateway in a private network
//   HOST, PORT        where this server listens (default 0.0.0.0:8000)

import { randomUUID } from "node:crypto";

import { SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { delegatedTokenClientOptions } from "@indykite/delegated-token/a2a";
import { delegatedToken } from "@indykite/delegated-token/express";
import { delegatedTokenFetch, ExtensionRegistry } from "@indykite/delegated-token/fetch";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const HOST = env("HOST", "0.0.0.0");
const PORT = port();
const ALLOW_HTTP = process.env.ALLOW_HTTP === "1";
// One for the process, so the targets' answers are cached
const REGISTRY = new ExtensionRegistry({ allowHttp: ALLOW_HTTP });

/** The value of the environment variable `name`, or `fallback`. An empty value counts as unset. Throw if neither. */
function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value) {
    return value;
  }
  if (fallback === undefined) {
    throw new Error(`${name} is not set`);
  }
  return fallback;
}

/** The port in `PORT` (default 8000). Throw if it is not a port number. */
function port(): number {
  const value = env("PORT", "8000");
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error(`PORT is not a port number: ${value}`);
  }
  return number;
}

/** The text blocks of an MCP tool result, joined by newlines. */
function textOf(content: unknown): string {
  const blocks = Array.isArray(content) ? (content as { type?: string; text?: string }[]) : [];
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** An MCP tool result with one text block. */
function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Call a tool of the MCP server at TARGET_MCP_URL and return its text output.
 *
 * The target comes from the configuration, never from the caller: every server that announces the extension gets
 * the token, so a URL chosen by the caller could send it anywhere.
 */
async function callMcpTool(tool: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: "sample-mcp-server", version: "1.0.0" });
  // Adds X-IK-Token if the target announces the extension
  const transport = new StreamableHTTPClientTransport(new URL(env("TARGET_MCP_URL")), {
    fetch: delegatedTokenFetch({ registry: REGISTRY }),
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    return textOf(result.content);
  } finally {
    await client.close();
  }
}

/** Send a message to the A2A agent at TARGET_AGENT_URL and return its text reply. */
async function askAgent(text: string): Promise<string> {
  // Adds X-IK-Token if the agent card lists the extension, and never sends it to the origin of a redirect
  const client = await new ClientFactory(
    delegatedTokenClientOptions(undefined, { allowHttp: ALLOW_HTTP }),
  ).createFromUrl(env("TARGET_AGENT_URL"));
  const request = SendMessageRequest.fromJSON({
    message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] },
  });
  const result = await client.sendMessage(request);
  const parts = "parts" in result ? result.parts : result.artifacts.flatMap((artifact) => artifact.parts);
  return parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .filter(Boolean)
    .join("\n");
}

/** An MCP server with the `call_mcp_tool` and `ask_agent` tools. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "sample-mcp-server", version: "1.0.0" });
  server.registerTool(
    "call_mcp_tool",
    {
      description: "Call a tool of the MCP server at TARGET_MCP_URL and return its text output.",
      inputSchema: z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }),
    },
    async ({ tool, arguments: args }) => reply(await callMcpTool(tool, args ?? {})),
  );
  server.registerTool(
    "ask_agent",
    {
      description: "Send a message to the A2A agent at TARGET_AGENT_URL and return its text reply.",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }) => reply(await askAgent(text)),
  );
  return server;
}

const app = createMcpExpressApp({ host: HOST });
app.use(delegatedToken()); // the tools see the delegated token of the request they handle

// Liveness probe for the container's health check
app.get("/healthz", (_req, res) => {
  res.type("text/plain").send("ok");
});

// Stateless: a server and a transport per request
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new NodeStreamableHTTPServerTransport();
  res.on("close", () => {
    server.close().catch(console.error);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.all("/mcp", (_req, res) => {
  res.sendStatus(405);
});

app.listen(PORT, HOST, () => {
  console.log(`sample MCP server listening on ${HOST}:${String(PORT)}`);
});
