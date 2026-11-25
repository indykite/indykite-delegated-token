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

// The Express middleware inside real `@a2a-js/sdk` servers.
//
// The executor records the delegated token it sees and the `X-IK-Token` of its call context. These tests pin the SDK
// behaviour the middleware relies on: each `execute` and `cancelTask` runs in the async context of its request.

import { randomUUID } from "node:crypto";

import {
  AgentCard,
  Message,
  type Part,
  SendMessageRequest,
  type SendMessageResult,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { type Client, ClientFactory, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  InMemoryTaskStore,
  type RequestContext,
  type RequestHeaders,
  STATE_HEADERS_KEY,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import express, { type Express } from "express";
import { describe, expect, it } from "vitest";

import { getDelegatedToken } from "../src/index.js";
import { delegatedToken } from "../src/server/express.js";

import { sendingToken, serveForTest } from "./harness.js";

type Binding = "JSONRPC" | "HTTP+JSON";

/** What an executor saw: `getDelegatedToken()`, and `X-IK-Token` in its call context. */
type Seen = [string | null, string | null];

function textOf(part: Part): string {
  return part.content?.$case === "text" ? part.content.value : "";
}

function statusUpdate(taskId: string, contextId: string, state: string) {
  return AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state } }));
}

function artifactUpdate(context: RequestContext, text: string) {
  const artifact = { artifactId: randomUUID(), parts: [{ text }] };
  const event = { taskId: context.taskId, contextId: context.contextId, artifact };
  return AgentEvent.artifactUpdate(TaskArtifactUpdateEvent.fromJSON(event));
}

/**
 * Records what each call sees, and replies with the token.
 *
 * The message text selects the behaviour: `ask` waits for a follow-up message, `wait` waits for a second concurrent
 * call, `later` waits until the test releases it, `stream` replies with two artifacts, `quiet` replies `ok`.
 */
class Recorder implements AgentExecutor {
  readonly seen: Seen[] = [];
  readonly canceled: (string | null)[] = [];
  readonly release: PromiseWithResolvers<void> = Promise.withResolvers();
  readonly done: PromiseWithResolvers<void> = Promise.withResolvers();
  private readonly bothArrived: PromiseWithResolvers<void> = Promise.withResolvers();
  private waiting = 0;
  private readonly contexts = new Map<string, string>();

  execute = async (context: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const { taskId, contextId } = context;
    this.contexts.set(taskId, contextId);
    bus.publish(AgentEvent.task(context.task ?? Task.fromJSON({ id: taskId, contextId, status: { state: 1 } })));
    const command = context.userMessage.parts.map(textOf).join("");
    await this.waitFor(command);
    const headers = context.context.state.get(STATE_HEADERS_KEY) as RequestHeaders;
    this.seen.push([getDelegatedToken() ?? null, (headers["x-ik-token"] as string | undefined) ?? null]);
    if (command === "ask") {
      bus.publish(statusUpdate(taskId, contextId, "TASK_STATE_INPUT_REQUIRED"));
      return;
    }
    bus.publish(artifactUpdate(context, command === "quiet" ? "ok" : (getDelegatedToken() ?? "-")));
    if (command === "stream") {
      await new Promise((resolve) => setImmediate(resolve));
      bus.publish(artifactUpdate(context, getDelegatedToken() ?? "-"));
    }
    bus.publish(statusUpdate(taskId, contextId, "TASK_STATE_COMPLETED"));
    this.done.resolve();
  };

  cancelTask = (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    this.canceled.push(getDelegatedToken() ?? null);
    bus.publish(statusUpdate(taskId, this.contexts.get(taskId) ?? "", "TASK_STATE_CANCELED"));
    bus.finished();
    return Promise.resolve();
  };

  private async waitFor(command: string): Promise<void> {
    if (command === "wait") {
      this.waiting++;
      if (this.waiting === 2) {
        this.bothArrived.resolve();
      }
      await this.bothArrived.promise;
    }
    if (command === "later") {
      await this.release.promise;
    }
  }
}

interface AgentOptions {
  /** Serve the v0.3 protocol only. */
  legacy?: boolean;
  stripHeader?: boolean;
}

function card(url: string, legacy: boolean): AgentCard {
  const interfaces = legacy
    ? [{ url: `${url}/`, protocolBinding: "JSONRPC", protocolVersion: "0.3" }]
    : [
        { url: `${url}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: `${url}/rest`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
      ];
  return AgentCard.fromJSON({
    name: "recorder",
    description: "Records the delegated token",
    version: "1.0.0",
    supportedInterfaces: interfaces,
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "record", name: "record", description: "Records the token", tags: ["test"] }],
  });
}

/** An agent with JSON-RPC at `/` and REST at `/rest`, behind the middleware. */
function agent(executor: Recorder, options: AgentOptions = {}): (url: string) => Express {
  return (url) => {
    const agentCard = card(url, options.legacy ?? false);
    const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor);
    const userBuilder = UserBuilder.noAuthentication;
    const legacyCompat = { enabled: options.legacy ?? false };
    const app = express();
    app.use(delegatedToken({ stripHeader: options.stripHeader }));
    app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: () => Promise.resolve(agentCard) }));
    app.use("/rest", restHandler({ requestHandler, userBuilder }));
    app.use("/", jsonRpcHandler({ requestHandler, userBuilder, legacyCompat }));
    return app;
  };
}

/** Serve the agent for the current test, and return its URL. */
function start(executor: Recorder, options: AgentOptions = {}): Promise<string> {
  return serveForTest(agent(executor, options));
}

interface ConnectOptions {
  binding?: Binding;
  legacy?: boolean;
}

/** A client that sends `token` in `X-IK-Token`, or no header if it is `undefined`. */
function connect(url: string, token: string | undefined, options: ConnectOptions = {}): Promise<Client> {
  const fetchImpl = token === undefined ? fetch : sendingToken(() => token);
  const legacyCompat = { enabled: options.legacy ?? false };
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl, legacyCompat }), new RestTransportFactory({ fetchImpl })],
    preferredTransports: [options.binding ?? "JSONRPC"],
  });
  return factory.createFromUrl(url);
}

function request(text: string, task?: Task, returnImmediately = false): SendMessageRequest {
  return SendMessageRequest.fromJSON({
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text }],
      taskId: task?.id,
      contextId: task?.contextId,
    },
    configuration: { returnImmediately },
  });
}

function asTask(result: SendMessageResult): Task {
  if (!("artifacts" in result)) {
    throw new Error(`expected a task: ${JSON.stringify(Message.toJSON(result))}`);
  }
  return result;
}

/** The text of every artifact of the task. */
function replies(task: Task): string[] {
  return task.artifacts.flatMap((artifact) => artifact.parts.map(textOf));
}

async function send(url: string, token: string | undefined, text: string, options: ConnectOptions = {}) {
  const client = await connect(url, token, options);
  return asTask(await client.sendMessage(request(text)));
}

describe("A2A server", () => {
  it.each<Binding>(["JSONRPC", "HTTP+JSON"])("sendMessage over %s sees the token", async (binding) => {
    const executor = new Recorder();
    const url = await start(executor);

    expect(replies(await send(url, "tok", "hi", { binding }))).toEqual(["tok"]);
    expect(executor.seen).toEqual([["tok", "tok"]]);
  });

  it("sendMessageStream sees the token", async () => {
    const executor = new Recorder();
    const client = await connect(await start(executor), "tok");

    const texts: string[] = [];
    for await (const response of client.sendMessageStream(request("stream"))) {
      if (response.payload?.$case === "artifactUpdate") {
        texts.push(...(response.payload.value.artifact?.parts.map(textOf) ?? []));
      }
    }
    expect(texts).toEqual(["tok", "tok"]);
  });

  it("a follow-up message sees its own token", async () => {
    const executor = new Recorder();
    const url = await start(executor);

    const first = await send(url, "first", "ask");
    expect(first.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const second = asTask(await (await connect(url, "second")).sendMessage(request("go", first)));
    expect(replies(second)).toEqual(["second"]);
    expect(executor.seen).toEqual([
      ["first", "first"],
      ["second", "second"],
    ]);
  });

  it("concurrent requests see their own token", async () => {
    const executor = new Recorder();
    const url = await start(executor);

    const [a, b] = await Promise.all([send(url, "token-A", "wait"), send(url, "token-B", "wait")]);
    expect([replies(a), replies(b)]).toEqual([["token-A"], ["token-B"]]);
  });

  it.each([undefined, ""])("a request with token %j sees none", async (token) => {
    const executor = new Recorder();

    expect(replies(await send(await start(executor), token, "hi"))).toEqual(["-"]);
    expect(executor.seen[0]?.[0]).toBeNull();
  });

  it("returnImmediately keeps the token after the response", async () => {
    const executor = new Recorder();
    const client = await connect(await start(executor), "tok");

    const task = asTask(await client.sendMessage(request("later", undefined, true)));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    executor.release.resolve();
    await executor.done.promise;
    expect(executor.seen).toEqual([["tok", "tok"]]);
  });

  it("cancelTask sees the token of the cancel request", async () => {
    const executor = new Recorder();
    const url = await start(executor);

    const task = await send(url, "first", "ask");
    const canceled = await (await connect(url, "second")).cancelTask({ id: task.id, metadata: undefined, tenant: "" });
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(executor.canceled).toEqual(["second"]);
  });

  it("the v0.3 compat layer sees the token", async () => {
    const executor = new Recorder();
    const url = await start(executor, { legacy: true });

    expect(replies(await send(url, "tok", "hi", { legacy: true }))).toEqual(["tok"]);
    expect(executor.seen).toEqual([["tok", "tok"]]);
  });

  it.each([
    [true, null],
    [false, "secret"],
  ])("stripHeader %s leaves %j in the call context", async (stripHeader, header) => {
    const executor = new Recorder();

    expect(replies(await send(await start(executor, { stripHeader }), "secret", "quiet"))).toEqual(["ok"]);
    expect(executor.seen).toEqual([["secret", header]]);
  });
});
