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

// Mastra: the Mastra server with the Hono middleware, and an `MCPClient` with `delegatedTokenFetch()`. The full
// agent loop runs, as the server could move work out of the request's async context.

import { randomUUID } from "node:crypto";

import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { MastraServer } from "@mastra/hono";
import { MCPClient } from "@mastra/mcp";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { delegatedTokenFetch } from "../../src/client/fetch.js";
import { getDelegatedToken, runWithToken } from "../../src/index.js";
import { delegatedToken } from "../../src/server/hono.js";
import { checkConcurrentRuns, type Run, runOf, serveForTest } from "../harness.js";

import { aiSdkModel, DONE } from "./fake-models.js";

/** Run an agent with the tools of both targets, connected inside the run, and return its text. */
async function generate(run: Run): Promise<string> {
  const server = (url: string) => ({ url: new URL(url), fetch: delegatedTokenFetch() });
  const mcp = new MCPClient({ id: randomUUID(), servers: { good: server(run.announcing), bad: server(run.silent) } });
  try {
    const tools = await mcp.listTools();
    const agent = new Agent({ id: "agent", name: "agent", instructions: "", model: aiSdkModel(run), tools });
    const result = await agent.generate(run.tag);
    return result.text;
  } finally {
    await mcp.disconnect();
  }
}

/** A Mastra server with the package's Hono middleware, whose `/run` route runs the agent for the tag in the body. */
async function mastraServer(runs: Map<string, Run>): Promise<string> {
  const route = registerApiRoute("/run", {
    method: "POST",
    handler: async (c) => c.text(await generate(runOf(runs, await c.req.text()))),
  });
  const mastra = new Mastra({ server: { middleware: delegatedToken(), apiRoutes: [route] } });
  const app = new Hono();
  await new MastraServer({ app, mastra }).init();
  return serveForTest(() => app);
}

describe("Mastra", () => {
  it("sends each request's token through the Mastra server", async () => {
    const runs = new Map<string, Run>();
    const url = await mastraServer(runs);
    await checkConcurrentRuns(async (run) => {
      runs.set(run.tag, run);
      const token = getDelegatedToken() ?? "";
      // Sent from outside the token's async context
      const response = await runWithToken(undefined, () =>
        fetch(`${url}/run`, { method: "POST", headers: { "X-IK-Token": token }, body: run.tag }),
      );
      expect(await response.text()).toBe(DONE);
    });
  });
});
