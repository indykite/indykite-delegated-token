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

// Sample A2A agent that calls another A2A agent and an MCP server, with the delegated token.
//
// The agent gateway in front of this agent sends the delegated token in `X-IK-Token`. The `delegatedToken()`
// middleware makes it available to the executor, and the package's fetch wrapper and A2A interceptor send it on to
// the targets that announce the extension. The agent's card does not announce the extension: its gateway does.
//
// The executor needs no model. It routes each message:
//   a data part `{ "mcp_tool": "<name>", "arguments": {...} }` calls that tool on TARGET_MCP_URL;
//   any other message is sent as text to the agent at TARGET_AGENT_URL.
//
// Environment:
//   TARGET_MCP_URL    MCP endpoint that the agent calls, through its gateway
//   TARGET_AGENT_URL  base URL of the A2A agent that the agent calls, through its gateway
//   ALLOW_HTTP        set to 1 to also send the token over plain HTTP, such as to a gateway in a private network
//   PUBLIC_URL        base URL of this agent in its card (default http://localhost:<PORT>)
//   HOST, PORT        where this agent listens (default 0.0.0.0:8000)

import { randomUUID } from "node:crypto";

import {
  AgentCard,
  type Message,
  type Part,
  SendMessageRequest,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
  taskStateToJSON,
} from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  InMemoryTaskStore,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { delegatedTokenClientOptions } from "@indykite/delegated-token/a2a";
import { delegatedToken } from "@indykite/delegated-token/express";
import { delegatedTokenFetch, ExtensionRegistry } from "@indykite/delegated-token/fetch";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import express, { type Express } from "express";

/** Where the agent is reachable, and the targets it calls. Targets come only from the operator. */
export interface Config {
  publicUrl: string;
  targetMcpUrl: string;
  targetAgentUrl: string;
  /** Send the token over plain HTTP too. */
  allowHttp: boolean;
}

/** A data part that names an MCP tool. */
interface McpCall {
  mcp_tool: string;
  arguments?: Record<string, unknown>;
}

/** An error the agent raises itself. Its message holds no data from the target, and quotes data from the caller. */
class RelayError extends Error {}

/** What to log for a failed call. SDK errors can quote the target's response, which may echo the token. */
function describe(error: unknown): string {
  if (error instanceof RelayError) {
    return error.message;
  }
  return error instanceof Error ? error.name : typeof error;
}

/** The value of the environment variable `name`, or `fallback`. An empty value counts as unset. Throw if neither. */
export function env(name: string, fallback?: string): string {
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
export function port(): number {
  const value = env("PORT", "8000");
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error(`PORT is not a port number: ${value}`);
  }
  return number;
}

/** The configuration from the environment. */
export function configFromEnv(): Config {
  return {
    publicUrl: env("PUBLIC_URL", `http://localhost:${String(port())}`).replace(/\/+$/, ""),
    targetMcpUrl: env("TARGET_MCP_URL"),
    targetAgentUrl: env("TARGET_AGENT_URL"),
    allowHttp: process.env.ALLOW_HTTP === "1",
  };
}

/** The text of the parts, joined by newlines. */
function textOf(parts: Part[]): string {
  return parts
    .map((part) => part.content)
    .filter((content) => content?.$case === "text")
    .map((content) => content.value)
    .join("\n");
}

/** The first data part that names an MCP tool, if any. */
function mcpCall(message: Message): McpCall | undefined {
  for (const part of message.parts) {
    const data: unknown = part.content?.$case === "data" ? part.content.value : undefined;
    if (typeof data === "object" && data !== null && "mcp_tool" in data && typeof data.mcp_tool === "string") {
      return data as McpCall;
    }
  }
  return undefined;
}

/** Call a tool of the MCP server at `url` and return its text output. */
async function callMcpTool(url: string, registry: ExtensionRegistry, call: McpCall): Promise<string> {
  const client = new Client({ name: "sample-a2a-agent", version: "1.0.0" });
  // Adds X-IK-Token if the target announces the extension
  const fetch = delegatedTokenFetch({ registry });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch }));
  try {
    const result = await client.callTool({ name: call.mcp_tool, arguments: call.arguments ?? {} });
    // A tool error comes back as a result, not as a rejection
    if (result.isError) {
      // Quoted: the name comes from the caller, and must not add lines to the log
      throw new RelayError(`tool ${JSON.stringify(call.mcp_tool)} failed`);
    }
    return result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  } finally {
    await client.close();
  }
}

/** Send a message to the A2A agent at `url` and return its text reply. */
async function askAgent(url: string, allowHttp: boolean, text: string): Promise<string> {
  // Adds X-IK-Token if the agent card lists the extension, and never sends it to the origin of a redirect
  const client = await new ClientFactory(delegatedTokenClientOptions(undefined, { allowHttp })).createFromUrl(url);
  const request = SendMessageRequest.fromJSON({
    message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] },
  });
  const result = await client.sendMessage(request);
  if ("parts" in result) {
    return textOf(result.parts);
  }
  // A failed, rejected or interrupted task comes back as a result, not as a rejection. Follow-ups are not supported.
  const state = result.status?.state;
  if (state !== TaskState.TASK_STATE_COMPLETED) {
    throw new RelayError(
      `the agent ended the task in state ${taskStateToJSON(state ?? TaskState.TASK_STATE_UNSPECIFIED)}`,
    );
  }
  return textOf(result.artifacts.flatMap((artifact) => artifact.parts));
}

/** A status update of the task, with an agent message if `text` is set. */
function status(context: RequestContext, state: string, text?: string) {
  const { taskId, contextId } = context;
  const message =
    text === undefined
      ? undefined
      : { messageId: randomUUID(), role: "ROLE_AGENT", taskId, contextId, parts: [{ text }] };
  return AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state, message } }));
}

/** Relays each message to the configured MCP server or A2A agent, and replies with one text artifact. */
class RelayExecutor implements AgentExecutor {
  private readonly config: Config;
  // One for the executor, so the targets' answers are cached
  private readonly registry: ExtensionRegistry;

  constructor(config: Config) {
    this.config = config;
    this.registry = new ExtensionRegistry({ allowHttp: config.allowHttp });
  }

  execute = async (context: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const { taskId, contextId } = context;
    const submitted = { id: taskId, contextId, status: { state: "TASK_STATE_SUBMITTED" } };
    bus.publish(AgentEvent.task(context.task ?? Task.fromJSON(submitted)));
    let reply: string;
    try {
      reply = await this.relay(context.userMessage);
    } catch (error) {
      console.error("call to the target failed:", describe(error));
      bus.publish(status(context, "TASK_STATE_FAILED", "the call to the target failed"));
      return;
    }
    const artifact = { artifactId: randomUUID(), parts: [{ text: reply }] };
    bus.publish(AgentEvent.artifactUpdate(TaskArtifactUpdateEvent.fromJSON({ taskId, contextId, artifact })));
    bus.publish(status(context, "TASK_STATE_COMPLETED"));
  };

  // skipcq: JS-0105 - implements AgentExecutor.cancelTask
  cancelTask = (): Promise<void> => Promise.reject(new Error("canceling is not supported"));

  /** Call the MCP tool that the message names, or else send its text to the agent. Return the reply text. */
  private relay(message: Message): Promise<string> {
    const call = mcpCall(message);
    if (call) {
      return callMcpTool(this.config.targetMcpUrl, this.registry, call);
    }
    return askAgent(this.config.targetAgentUrl, this.config.allowHttp, textOf(message.parts));
  }
}

/** The agent's card. It does not list the delegated token extension: its gateway does. */
function agentCard(config: Config): AgentCard {
  return AgentCard.fromJSON({
    name: "sample-a2a-agent",
    description: "Calls an MCP server and an A2A agent with the delegated token",
    version: "1.0.0",
    supportedInterfaces: [
      { url: `${config.publicUrl}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: `${config.publicUrl}/rest`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "call_mcp_tool",
        name: "call_mcp_tool",
        description: 'Calls a tool on the MCP server. Send a data part {"mcp_tool": ..., "arguments": ...}',
        tags: ["mcp"],
      },
      {
        id: "ask_agent",
        name: "ask_agent",
        description: "Sends the text of the message to the A2A agent and returns its reply",
        tags: ["a2a"],
      },
    ],
  });
}

/** The agent as an Express app, with JSON-RPC at `/` and REST at `/rest`. */
export function buildApp(config: Config): Express {
  const card = agentCard(config);
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new RelayExecutor(config));
  const userBuilder = UserBuilder.noAuthentication;
  const app = express();
  // First, and with stripHeader: only getDelegatedToken() reaches the token, never the SDK's call context
  app.use(delegatedToken({ stripHeader: true }));
  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: () => Promise.resolve(card) }));
  // Liveness probe for the container's health check
  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });
  app.use("/rest", restHandler({ requestHandler, userBuilder }));
  app.use("/", jsonRpcHandler({ requestHandler, userBuilder }));
  return app;
}
