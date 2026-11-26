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

// Vercel AI SDK: `createMCPClient` with `delegatedTokenFetch()` as the transport's `fetch`.

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import {
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type ToolSet,
} from "ai";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { delegatedTokenFetch } from "../../src/client/fetch.js";
import { getDelegatedToken, runWithToken } from "../../src/index.js";
import { delegatedToken } from "../../src/server/hono.js";
import { checkConcurrentRuns, type Run, runOf, serveForTest } from "../harness.js";

import { aiSdkModel, DONE } from "./fake-models.js";

function connect(url: string): Promise<MCPClient> {
  return createMCPClient({ transport: { type: "http", url, fetch: delegatedTokenFetch() } });
}

/** The tools of `client`, with names prefixed by `prefix`. */
async function prefixed(prefix: string, client: MCPClient): Promise<ToolSet> {
  const tools = await client.tools();
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [`${prefix}_${name}`, tool]));
}

/** Connect to both targets inside the run, and return the clients and their tools. */
async function toolsOf(run: Run): Promise<{ clients: MCPClient[]; tools: ToolSet }> {
  const [good, bad] = await Promise.all([connect(run.announcing), connect(run.silent)]);
  const tools = await Promise.all([prefixed("good", good), prefixed("bad", bad)]);
  return { clients: [good, bad], tools: { ...tools[0], ...tools[1] } };
}

async function closeAll(clients: MCPClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.close()));
}

describe("Vercel AI SDK", () => {
  it("sends each run's token to the announcing server only", () =>
    checkConcurrentRuns(async (run) => {
      const { clients, tools } = await toolsOf(run);
      try {
        const result = await generateText({ model: aiSdkModel(run), tools, stopWhen: stepCountIs(3), prompt: run.tag });
        expect(result.text).toBe(DONE);
      } finally {
        await closeAll(clients);
      }
    }));

  it("keeps the token of each request in a streamed answer", async () => {
    // The tool call comes after the handler returned, while the response body is read
    const runs = new Map<string, Run>();
    const app = new Hono();
    app.use(delegatedToken());
    app.post("/chat", async (c) => {
      const run = runOf(runs, await c.req.text());
      const { clients, tools } = await toolsOf(run);
      const close = () => closeAll(clients);
      const result = streamText({
        model: aiSdkModel(run, 20),
        tools,
        stopWhen: stepCountIs(3),
        prompt: run.tag,
        onEnd: close,
        onError: close,
        onAbort: close,
      });
      return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
    });
    const url = await serveForTest(() => app);

    await checkConcurrentRuns(async (run) => {
      runs.set(run.tag, run);
      const token = getDelegatedToken() ?? "";
      // Sent from outside the token's async context
      const response = await runWithToken(undefined, () =>
        fetch(`${url}/chat`, { method: "POST", headers: { "X-IK-Token": token }, body: run.tag }),
      );
      expect(await response.text()).toContain(DONE);
    });
  });
});
