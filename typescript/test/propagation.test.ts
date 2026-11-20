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

// End-to-end propagation through each kind of server, with concurrent requests.
//
// A sample MCP server with the package's middleware has a `relay` tool. Two clients call it at the same time, twice
// in the same session, each call with its own token. The tool waits until both calls run, then calls an MCP target
// and an A2A agent that announce the extension, and an MCP target and an A2A agent that do not. Each must see the
// token of the call it belongs to, or none.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport as NodeTransportV1 } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport as WebTransportV1 } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer as McpServerV2, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import express from "express";
import { Hono } from "hono";
import { createMcpHandler as createMcpHandlerV2 } from "mcp-handler";
import { createMcpHandler as createMcpHandlerV1 } from "mcp-handler-v1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { delegatedTokenFetch, ExtensionRegistry } from "../src/client/fetch.js";
import { A2A_EXTENSION_URI, getDelegatedToken, runWithToken } from "../src/index.js";
import { delegatedToken as expressDelegatedToken } from "../src/server/express.js";
import { delegatedToken as honoDelegatedToken } from "../src/server/hono.js";
import { withDelegatedToken } from "../src/server/mcp-handler.js";

import {
  a2aAgent,
  askAgent,
  interceptorOnly,
  type FetchHandler,
  mcpSession,
  mcpTarget,
  redirectingAgent,
  type SdkVersion,
  sendingToken,
  serve,
  type Served,
  text,
} from "./harness.js";

interface Targets {
  mcp: string;
  mcpSilent: string;
  agent: string;
  agentSilent: string;
}

type Relay = () => Promise<unknown>;

/** A sample server, and the number of sessions it keeps. */
interface Built {
  handler: RequestListenerOrHandler;
  sessions: () => number;
}

/** Build a sample server whose `relay` tool runs `relay`. */
type Sample = (relay: Relay, stateful: boolean) => Built;

type RequestListenerOrHandler = ((req: IncomingMessage, res: ServerResponse) => void) | FetchHandler;

interface NodeTransport {
  // `exactOptionalPropertyTypes`: matches the SDK types
  sessionId?: string | undefined; // skipcq
  handleRequest: (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>;
}

interface WebTransport {
  // `exactOptionalPropertyTypes`: matches the SDK types
  sessionId?: string | undefined; // skipcq
  handleRequest: (req: Request) => Promise<Response>;
}

const VERSIONS: SdkVersion[] = ["v1", "v2"];

let servers: Served[] = [];
let targets: Targets;

beforeAll(async () => {
  const [mcp, mcpSilent, agent, agentSilent] = await Promise.all([
    serve(mcpTarget(true)),
    serve(mcpTarget(false)),
    serve(a2aAgent(true)),
    serve(a2aAgent(false)),
  ]);
  servers = [mcp, mcpSilent, agent, agentSilent];
  targets = {
    mcp: `${mcp.url}/mcp`,
    mcpSilent: `${mcpSilent.url}/mcp`,
    agent: agent.url,
    agentSilent: agentSilent.url,
  };
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** A barrier for `parties` callers, reusable after each release. */
function barrier(parties: number): () => Promise<void> {
  let waiting: (() => void)[] = [];
  return () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length < parties) {
        return;
      }
      for (const release of waiting) {
        release();
      }
      waiting = [];
    });
}

async function echo(version: SdkVersion, url: string, registry: ExtensionRegistry): Promise<unknown> {
  const session = await mcpSession(version, url, delegatedTokenFetch({ registry }));
  try {
    return await session.call("echo");
  } finally {
    await session.close();
  }
}

/** The body of the sample server's tool. */
function relay(version: SdkVersion): Relay {
  const wait = barrier(2);
  const registry = new ExtensionRegistry();
  return async () => {
    await wait();
    return {
      server: getDelegatedToken() ?? null,
      mcp: await echo(version, targets.mcp, registry),
      mcp_silent: await echo(version, targets.mcpSilent, registry),
      agent: await askAgent(targets.agent),
      agent_silent: await askAgent(targets.agentSilent),
    };
  };
}

function serverV1(body: Relay): McpServerV1 {
  const server = new McpServerV1({ name: "sample", version: "1.0.0" });
  server.registerTool("relay", { description: "Call the targets" }, async () => text(await body()));
  return server;
}

function serverV2(body: Relay): McpServerV2 {
  const server = new McpServerV2({ name: "sample", version: "1.0.0" });
  server.registerTool("relay", { description: "Call the targets" }, async () => text(await body()));
  return server;
}

function sessionId(stateful: boolean) {
  return stateful ? { sessionIdGenerator: () => randomUUID() } : {};
}

/** Routes each request to the transport of its session, or to a new one. */
function sessions<T extends { sessionId?: string | undefined }>(make: () => Promise<T>) {
  const known = new Map<string, T>();
  return {
    // skipcq: JS-0116 - async, so it returns a promise for a known session too
    find: async (id: string | null | undefined) => (id ? known.get(id) : undefined) ?? make(),
    remember: (transport: T) => {
      if (transport.sessionId) {
        known.set(transport.sessionId, transport);
      }
    },
    size: () => known.size,
  };
}

async function connect<T>(server: { connect: (transport: T) => Promise<void> }, transport: T): Promise<T> {
  await server.connect(transport);
  return transport;
}

function expressSample(make: (relay: Relay, stateful: boolean) => Promise<NodeTransport>): Sample {
  return (relay, stateful) => {
    const router = sessions(() => make(relay, stateful));
    const app = express();
    app.use(express.json());
    app.use(expressDelegatedToken());
    app.all("/mcp", async (req, res) => {
      const transport = await router.find(req.header("mcp-session-id"));
      await transport.handleRequest(req, res, req.body);
      router.remember(transport);
    });
    return { handler: app, sessions: router.size };
  };
}

function honoSample(make: (relay: Relay, stateful: boolean) => Promise<WebTransport>): Sample {
  return (relay, stateful) => {
    const router = sessions(() => make(relay, stateful));
    const app = new Hono();
    app.use(honoDelegatedToken());
    app.all("/mcp", async (c) => {
      const transport = await router.find(c.req.header("mcp-session-id"));
      const response = await transport.handleRequest(c.req.raw);
      router.remember(transport);
      return response;
    });
    return { handler: app, sessions: router.size };
  };
}

const SAMPLES: [string, SdkVersion, Sample][] = [
  ["v1 express", "v1", expressSample((r, s) => connect(serverV1(r), new NodeTransportV1(sessionId(s))))],
  ["v1 hono", "v1", honoSample((r, s) => connect(serverV1(r), new WebTransportV1(sessionId(s))))],
  [
    "v2 express",
    "v2",
    expressSample((r, s) => connect(serverV2(r), new NodeStreamableHTTPServerTransport(sessionId(s)))),
  ],
  [
    "v2 hono",
    "v2",
    honoSample((r, s) => connect(serverV2(r), new WebStandardStreamableHTTPServerTransport(sessionId(s)))),
  ],
];

const EXPECTED = (token: string) => ({
  server: token,
  mcp: token,
  mcp_silent: null,
  agent: { token, extensions: A2A_EXTENSION_URI },
  agent_silent: { token: null, extensions: null },
});

/** Two users call the sample's relay at the same time, twice each, and the token changes between their calls. */
async function concurrentUsers(version: SdkVersion, url: string): Promise<void> {
  const users = [
    ["token-A1", "token-A2"],
    ["token-B1", "token-B2"],
  ];
  const results = await Promise.all(
    users.map(async (tokens) => {
      let current = tokens[0] ?? "";
      const session = await mcpSession(
        version,
        url,
        sendingToken(() => current),
      );
      const calls: unknown[] = [];
      for (const token of tokens) {
        current = token;
        calls.push(await session.call("relay"));
      }
      await session.close();
      return calls;
    }),
  );
  expect(results).toEqual(users.map((tokens) => tokens.map(EXPECTED)));
}

describe.each(SAMPLES)("%s", (_name, version, sample) => {
  it.each([
    ["stateless", false],
    ["stateful", true],
  ])("keeps the token of each request: %s", async (_mode, stateful) => {
    const built = sample(relay(version), stateful);
    const served = await serve(() => built.handler);
    try {
      await concurrentUsers(version, `${served.url}/mcp`);
    } finally {
      await served.close();
    }
    expect(built.sessions()).toBe(stateful ? 2 : 0);
  });
});

function mcpHandler(version: SdkVersion, body: Relay): (req: Request) => Promise<Response> {
  if (version === "v1") {
    return createMcpHandlerV1(
      (server) => {
        server.registerTool("relay", { description: "Call the targets" }, async () => text(await body()));
      },
      {},
      { basePath: "", disableSse: true },
    );
  }
  return createMcpHandlerV2(
    (server) => {
      server.registerTool("relay", { description: "Call the targets" }, async () => text(await body()));
    },
    { telemetry: false },
  );
}

describe.each(VERSIONS)("mcp-handler with SDK %s", (version) => {
  it("keeps the token of each request", async () => {
    const handler = withDelegatedToken(mcpHandler(version, relay(version)));
    const served = await serve(() => ({ fetch: handler }));
    try {
      await concurrentUsers(version, `${served.url}/mcp`);
    } finally {
      await served.close();
    }
  });
});

describe("targets", () => {
  it("an agent that announces gets the token and the extension", async () => {
    expect(await runWithToken("tok", () => askAgent(targets.agent))).toEqual({
      token: "tok",
      extensions: A2A_EXTENSION_URI,
    });
  });

  it("an agent that redirects to another origin does not pass the token on", async () => {
    const redirecting = await serve(redirectingAgent(targets.agent));
    try {
      const leaked = await runWithToken("tok", () => askAgent(redirecting.url, interceptorOnly()));
      expect(leaked).toEqual({ token: "tok", extensions: A2A_EXTENSION_URI });
      const guarded = await runWithToken("tok", () => askAgent(redirecting.url));
      expect(guarded).toEqual({ token: null, extensions: A2A_EXTENSION_URI });
    } finally {
      await redirecting.close();
    }
  });

  it("an agent that does not announce gets nothing", async () => {
    expect(await runWithToken("tok", () => askAgent(targets.agentSilent))).toEqual({ token: null, extensions: null });
  });

  it.each(VERSIONS)("a long-lived %s client sends the token of each call", async (version) => {
    const session = await mcpSession(version, targets.mcp, delegatedTokenFetch({ registry: new ExtensionRegistry() }));
    const seen: unknown[] = [];
    for (const token of ["token-A", "token-B"]) {
      seen.push(await runWithToken(token, () => session.call("echo")));
    }
    seen.push(await session.call("echo"));
    await session.close();
    expect(seen).toEqual(["token-A", "token-B", null]);
  });
});
