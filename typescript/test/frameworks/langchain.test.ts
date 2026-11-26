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

// LangChain.js and LangGraph.js: the application builds the MCP client with `delegatedTokenFetch()` and hands it to
// `loadMcpTools`. The tools run in the caller's async context, so a direct tool call shows the same as a graph run.

import type { StructuredToolInterface } from "@langchain/core/tools";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, it } from "vitest";

import { delegatedTokenFetch } from "../../src/client/fetch.js";
import { checkConcurrentRuns } from "../harness.js";

/** Connect a client to `url`, and load its `echo` tool. */
async function connect(url: string): Promise<{ echo: StructuredToolInterface; close: () => Promise<void> }> {
  const client = new Client({ name: "agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: delegatedTokenFetch() }));
  const [echo] = await loadMcpTools("target", client);
  if (!echo) {
    throw new Error("no echo tool");
  }
  return { echo, close: () => client.close() };
}

describe("LangChain.js", () => {
  it("sends each run's token to the announcing server only", () =>
    checkConcurrentRuns(async (run) => {
      const loaded = await Promise.all([connect(run.announcing), connect(run.silent)]);
      try {
        await run.barrier();
        await Promise.all(loaded.map(({ echo }) => echo.invoke({ tag: run.tag })));
      } finally {
        await Promise.all(loaded.map((one) => one.close()));
      }
    }));
});
