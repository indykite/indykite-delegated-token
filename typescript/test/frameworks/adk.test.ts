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

// Google ADK (MCP SDK 1.x): `MCPToolset` with `delegatedTokenFetch()` in its `transportOptions`. ADK calls tools in
// the caller's async context, so a direct tool call shows the same as an agent run.

import { type BaseTool, type Context, MCPToolset } from "@google/adk";
import { describe, it } from "vitest";

import { delegatedTokenFetch } from "../../src/client/fetch.js";
import { checkConcurrentRuns } from "../harness.js";

function toolset(url: string): MCPToolset {
  return new MCPToolset({
    type: "StreamableHTTPConnectionParams",
    url,
    transportOptions: { fetch: delegatedTokenFetch() },
  });
}

async function echoTool(set: MCPToolset): Promise<BaseTool> {
  const [echo] = await set.getTools();
  if (!echo) {
    throw new Error("no echo tool");
  }
  return echo;
}

// `MCPTool.runAsync` reads only `abortSignal` of the context
const TOOL_CONTEXT = {} as Context;

describe("Google ADK", () => {
  it("sends each run's token to the announcing server only", () =>
    checkConcurrentRuns(async (run) => {
      const sets = [toolset(run.announcing), toolset(run.silent)];
      try {
        const tools = await Promise.all(sets.map(echoTool));
        await run.barrier();
        // ADK opens a session per tool call, inside the call
        await Promise.all(tools.map((tool) => tool.runAsync({ args: { tag: run.tag }, toolContext: TOOL_CONTEXT })));
      } finally {
        await Promise.all(sets.map((set) => set.close()));
      }
    }));
});
