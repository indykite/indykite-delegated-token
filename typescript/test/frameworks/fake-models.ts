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

// A scripted AI SDK model, for the tests that run a full agent loop. It calls `echo({ tag })` on every toolset once
// both runs reached the barrier, then answers "done".

import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { Run } from "../harness.js";

/** What a fake model needs of a run. */
export type Script = Pick<Run, "tag" | "barrier">;

export const DONE = "done";

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** The names of the `echo` tools among `names`. */
function echoTools(names: string[]): string[] {
  return names.filter((name) => name.includes("echo"));
}

function aiSdkToolCalls(options: LanguageModelV4CallOptions, tag: string) {
  const names = echoTools((options.tools ?? []).map((tool) => tool.name));
  const input = JSON.stringify({ tag });
  return names.map((toolName, i) => ({ type: "tool-call" as const, toolCallId: `call-${String(i)}`, toolName, input }));
}

function aiSdkAnswered(options: LanguageModelV4CallOptions): boolean {
  return options.prompt.some((message) => message.role === "tool");
}

/** A model for `generateText` and `streamText`. A streamed tool call comes after `delay` ms. */
export function aiSdkModel(script: Script, delay = 0): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      if (aiSdkAnswered(options)) {
        return {
          content: [{ type: "text", text: DONE }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }
      await script.barrier();
      const content = aiSdkToolCalls(options, script.tag);
      return { content, finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE, warnings: [] };
    },
    doStream: async (options) => {
      const chunks: LanguageModelV4StreamPart[] = aiSdkAnswered(options)
        ? [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: DONE },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
          ]
        : [
            ...aiSdkToolCalls(options, script.tag),
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
          ];
      if (!aiSdkAnswered(options)) {
        await script.barrier();
      }
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: delay, chunkDelayInMs: delay }) };
    },
  });
}
