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

import type { AgentCard } from "@a2a-js/sdk";
import { type BeforeArgs, type CallInterceptor, ClientFactoryOptions, type RequestOptions } from "@a2a-js/sdk/client";
import { describe, expect, it, vi } from "vitest";

import { announcesExtension, delegatedTokenClientOptions, DelegatedTokenInterceptor } from "../src/client/a2a.js";
import { A2A_EXTENSION_URI, A2A_EXTENSIONS_HEADER, DELEGATED_TOKEN_HEADER, runWithToken } from "../src/index.js";

const OTHER_URI = "https://example.com/extensions/other/v1";

function card(...uris: string[]): AgentCard {
  const extensions = uris.map((uri) => ({ uri, description: "", required: false, params: undefined }));
  return { capabilities: { extensions } } as unknown as AgentCard;
}

function args(agentCard: AgentCard, options?: RequestOptions): BeforeArgs {
  const before: BeforeArgs = { input: { method: "sendMessage", value: {} } as BeforeArgs["input"], agentCard };
  if (options) {
    before.options = options;
  }
  return before;
}

async function intercept(before: BeforeArgs, token?: string): Promise<BeforeArgs> {
  await runWithToken(token, () => new DelegatedTokenInterceptor().before(before));
  return before;
}

describe("announcesExtension", () => {
  it("looks for the extension in capabilities.extensions", () => {
    expect(announcesExtension(card(OTHER_URI, A2A_EXTENSION_URI))).toBe(true);
    expect(announcesExtension(card(OTHER_URI))).toBe(false);
    expect(announcesExtension({ capabilities: undefined } as unknown as AgentCard)).toBe(false);
    expect(announcesExtension(null)).toBe(false);
    expect(announcesExtension(undefined)).toBe(false);
  });
});

describe("DelegatedTokenInterceptor", () => {
  it("adds the token and the extension without options", async () => {
    const before = await intercept(args(card(A2A_EXTENSION_URI)), "tok");
    expect(before.options?.serviceParameters).toEqual({
      [DELEGATED_TOKEN_HEADER]: "tok",
      [A2A_EXTENSIONS_HEADER]: A2A_EXTENSION_URI,
    });
  });

  it("merges with the caller's extensions and leaves the caller's options unchanged", async () => {
    const options: RequestOptions = { serviceParameters: { [A2A_EXTENSIONS_HEADER]: OTHER_URI, Other: "x" } };
    const before = await intercept(args(card(A2A_EXTENSION_URI), options), "tok");

    expect(before.options).not.toBe(options);
    expect(options.serviceParameters).toEqual({ [A2A_EXTENSIONS_HEADER]: OTHER_URI, Other: "x" });
    const parameters = before.options?.serviceParameters ?? {};
    expect(parameters[A2A_EXTENSIONS_HEADER]?.split(",").sort()).toEqual([OTHER_URI, A2A_EXTENSION_URI].sort());
    expect(parameters[DELEGATED_TOKEN_HEADER]).toBe("tok");
    expect(parameters.Other).toBe("x");
  });

  it("does not repeat an extension the caller already named", async () => {
    const options: RequestOptions = { serviceParameters: { "a2a-extensions": A2A_EXTENSION_URI } };
    const before = await intercept(args(card(A2A_EXTENSION_URI), options), "tok");
    expect(before.options?.serviceParameters?.[A2A_EXTENSIONS_HEADER]).toBe(A2A_EXTENSION_URI);
  });

  it.each([[DELEGATED_TOKEN_HEADER], ["x-ik-token"]])("keeps the caller's token in %s", async (name) => {
    const options: RequestOptions = { serviceParameters: { [name]: "caller" } };
    const before = await intercept(args(card(A2A_EXTENSION_URI), options), "tok");
    const parameters = Object.entries(before.options?.serviceParameters ?? {});
    expect(parameters.filter(([key]) => key.toLowerCase() === "x-ik-token")).toEqual([[name, "caller"]]);
  });

  it("gives reused options the token of each call", async () => {
    const options: RequestOptions = {};
    const agent = card(A2A_EXTENSION_URI);
    const sent: (string | undefined)[] = [];
    for (const token of ["tok-a", "tok-b", undefined]) {
      const before = await intercept(args(agent, options), token);
      sent.push(before.options?.serviceParameters?.[DELEGATED_TOKEN_HEADER]);
    }
    expect(sent).toEqual(["tok-a", "tok-b", undefined]);
    expect(options).toEqual({});
  });

  it("leaves calls to agents without the extension unchanged", async () => {
    const before = await intercept(args(card(OTHER_URI)), "tok");
    expect(before.options).toBeUndefined();
  });

  it("leaves calls without a token unchanged", async () => {
    const before = await intercept(args(card(A2A_EXTENSION_URI)));
    expect(before.options).toBeUndefined();
  });

  it("does nothing after a call", async () => {
    await expect(new DelegatedTokenInterceptor().after()).resolves.toBeUndefined();
  });
});

describe("delegatedTokenClientOptions", () => {
  it("adds the interceptor and guarded HTTP transports to the base options", () => {
    const other: CallInterceptor = { before: () => Promise.resolve(), after: () => Promise.resolve() };
    const base = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      clientConfig: { interceptors: [other] },
    });
    const options = delegatedTokenClientOptions(base, vi.fn<typeof fetch>());

    const interceptors = options.clientConfig?.interceptors ?? [];
    expect(interceptors[0]).toBe(other);
    expect(interceptors[1]).toBeInstanceOf(DelegatedTokenInterceptor);
    expect(options.transports.map((transport) => transport.protocolName).sort()).toEqual(["HTTP+JSON", "JSONRPC"]);
    expect(options.transports).not.toEqual(base.transports);
  });
});
