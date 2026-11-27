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

// OpenAI Agents SDK: `MCPServerStreamableHttp` with `delegatedTokenFetch()` as its `fetch`. The SDK calls tools in
// the caller's async context, so a direct tool call shows the same as an agent run.

import { MCPServerStreamableHttp } from "@openai/agents";
import { describe, it } from "vitest";

import { delegatedTokenFetch } from "../../src/client/fetch.js";
import { checkConcurrentRuns } from "../harness.js";

describe("OpenAI Agents SDK", () => {
  it("sends each run's token to the announcing server only", () =>
    checkConcurrentRuns(async (run) => {
      // Connected inside the run, so the sessions belong to it
      const servers = [run.announcing, run.silent].map(
        (url) => new MCPServerStreamableHttp({ url, fetch: delegatedTokenFetch() }),
      );
      try {
        await Promise.all(servers.map((server) => server.connect()));
        await run.barrier();
        await Promise.all(servers.map((server) => server.callTool("echo", { tag: run.tag })));
      } finally {
        await Promise.all(servers.map((server) => server.close()));
      }
    }));
});
