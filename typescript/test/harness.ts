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

// In-process servers for the tests: fake MCP targets, fake A2A agents, and MCP and A2A client helpers.

import { randomUUID } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";

import { AgentCard, Message, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions } from "@a2a-js/sdk/client";
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type RequestHeaders,
  STATE_HEADERS_KEY,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { getRequestListener } from "@hono/node-server";
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2 } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as TransportV1 } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/server";
import express, { type Express } from "express";
import { onTestFinished } from "vitest";

import { DelegatedTokenInterceptor, delegatedTokenClientOptions } from "../src/client/a2a.js";
import type { FetchLike } from "../src/client/fetch.js";
import { A2A_EXTENSION_URI, MCP_EXTENSION_ID } from "../src/index.js";

export type SdkVersion = "v1" | "v2";

/** A web request handler, as Hono apps and `mcp-handler` have. */
export interface FetchHandler {
  fetch: (req: Request) => Response | Promise<Response>;
}

export interface Served {
  /** Base URL, without a trailing slash. */
  url: string;
  close: () => Promise<void>;
}

/** Serve the handler that `factory(baseUrl)` builds on a free local port. */
export async function serve(factory: (url: string) => RequestListener | FetchHandler): Promise<Served> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const handler = factory(url);
  server.on("request", typeof handler === "function" ? handler : getRequestListener(handler.fetch));
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Serve the handler for the current test, close it when the test ends, and return its URL. */
export async function serveForTest(factory: Parameters<typeof serve>[0]): Promise<string> {
  const server = await serve(factory);
  onTestFinished(() => server.close());
  return server.url;
}

/** A tool result with one text content. */
export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/**
 * A stateless MCP server at `/mcp` with an `echo` tool that returns the `X-IK-Token` it received.
 *
 * With `announce`, its protected resource metadata lists the extension. Without, the metadata route answers 404.
 * The targets do not use the package.
 */
export function mcpTarget(announce: boolean): (url: string) => Express {
  return (url) => {
    const app = express();
    app.use(express.json());
    app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
      if (!announce) {
        res.sendStatus(404);
        return;
      }
      res.json({ resource: `${url}/mcp`, mcp_extensions: { [MCP_EXTENSION_ID]: {} } });
    });
    app.post("/mcp", async (req, res) => {
      const server = new McpServer({ name: "target", version: "1.0.0" });
      server.registerTool("echo", { description: "Return the X-IK-Token header" }, (ctx) =>
        text(ctx.http?.req?.headers.get("x-ik-token") ?? null),
      );
      const transport = new NodeStreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    app.all("/mcp", (_req, res) => {
      res.sendStatus(405);
    });
    return app;
  };
}

function header(headers: RequestHeaders | undefined, name: string): string | null {
  const value = headers?.[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

const echo: AgentExecutor = {
  execute(context, bus) {
    const headers = context.context.state.get(STATE_HEADERS_KEY) as RequestHeaders | undefined;
    const seen = { token: header(headers, "x-ik-token"), extensions: header(headers, "a2a-extensions") };
    const message = Message.fromJSON({
      messageId: randomUUID(),
      contextId: context.contextId,
      role: "ROLE_AGENT",
      parts: [{ text: JSON.stringify(seen) }],
    });
    bus.publish(AgentEvent.message(message));
    bus.finished();
    return Promise.resolve();
  },
  cancelTask: () => Promise.resolve(),
};

function card(url: string, announce: boolean, version = "1.0"): AgentCard {
  return AgentCard.fromJSON({
    name: "echo",
    description: "Echoes the headers it received",
    version: "1.0.0",
    supportedInterfaces: [{ url: `${url}/`, protocolBinding: "JSONRPC", protocolVersion: version }],
    capabilities: { streaming: false, extensions: announce ? [{ uri: A2A_EXTENSION_URI }] : [] },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "echo", name: "echo", description: "Echoes the headers", tags: ["test"] }],
  });
}

export interface AgentOptions {
  /** Speak A2A v0.3 rather than v1.0. */
  legacy?: boolean;
  /** Serve the card through `AgentCard.toJSON`, which leaves out empty lists. */
  protoJson?: boolean;
}

/** An A2A agent that answers each message with the `X-IK-Token` and `A2A-Extensions` it received. */
export function a2aAgent(announce: boolean, options: AgentOptions = {}): (url: string) => Express {
  return (url) => {
    const agentCard = card(url, announce, options.legacy ? "0.3" : "1.0");
    const handler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), echo);
    const app = express();
    app.use(
      "/.well-known/agent-card.json",
      options.protoJson
        ? (_req, res) => {
            res.json(AgentCard.toJSON(agentCard));
          }
        : agentCardHandler({ agentCardProvider: () => Promise.resolve(agentCard) }),
    );
    const legacyCompat = { enabled: options.legacy ?? false };
    app.use("/", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication, legacyCompat }));
    return app;
  };
}

/** Client options with the package's interceptor only, whose transports use the plain `fetch`. */
export function interceptorOnly(): ClientFactoryOptions {
  return ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    clientConfig: { interceptors: [new DelegatedTokenInterceptor()] },
  });
}

/**
 * An agent card that announces the extension, at an agent that answers each message with a 307 to `target`.
 *
 * It stands for an agent that sends its callers to another origin.
 */
export function redirectingAgent(target: string): (url: string) => Express {
  return (url) => {
    const app = express();
    app.get("/.well-known/agent-card.json", (_req, res) => {
      res.json(AgentCard.toJSON(card(url, true)));
    });
    app.post("/", (_req, res) => {
      res.redirect(307, `${target}/`);
    });
    return app;
  };
}

/** Send a message to the agent with the given client options, and return what the agent saw. */
export async function askAgent(url: string, options = delegatedTokenClientOptions()): Promise<unknown> {
  const client = await new ClientFactory(options).createFromUrl(url);
  const request = SendMessageRequest.fromJSON({
    message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "hi" }] },
  });
  const result = await client.sendMessage(request);
  const content = "parts" in result ? result.parts[0]?.content : undefined;
  if (content?.$case !== "text") {
    throw new Error("the agent did not answer with a text message");
  }
  return JSON.parse(content.value);
}

/** An initialized MCP client session. */
export interface Session {
  /** Call a tool and return its text result, decoded from JSON. */
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

interface ToolResult {
  content?: unknown;
  // `exactOptionalPropertyTypes`: matches the SDK types
  isError?: boolean | undefined; // skipcq
}

function decode(result: ToolResult): unknown {
  const [first] = (result.content ?? []) as { type: string; text?: string }[];
  if (result.isError || first?.type !== "text" || first.text === undefined) {
    throw new Error(`tool call failed: ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text);
}

/** Open an MCP session to `url` with the client of SDK `version`, sending its requests through `fetch`. */
export async function mcpSession(version: SdkVersion, url: string, fetch?: FetchLike): Promise<Session> {
  const info = { name: "test", version: "1.0.0" };
  if (version === "v1") {
    const client = new ClientV1(info);
    await client.connect(new TransportV1(new URL(url), fetch ? { fetch } : {}));
    return {
      call: async (name, args = {}) => decode((await client.callTool({ name, arguments: args })) as ToolResult),
      close: () => client.close(),
    };
  }
  const client = new ClientV2(info);
  await client.connect(new TransportV2(new URL(url), fetch ? { fetch } : {}));
  return {
    call: async (name, args = {}) => decode(await client.callTool({ name, arguments: args })),
    close: () => client.close(),
  };
}

/** A `fetch` that sets `X-IK-Token` to the current value of `token()` on each request. */
export function sendingToken(token: () => string): FetchLike {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-IK-Token", token());
    return fetch(input, { ...init, headers });
  };
}
