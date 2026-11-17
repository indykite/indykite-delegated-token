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

// An agent card that announces the extension at the given interfaces, as `url binding`
function servedAt(...interfaces: string[]): AgentCard {
  const supportedInterfaces = interfaces.map((served) => {
    const [url, protocolBinding = "JSONRPC"] = served.split(" ");
    return { url, protocolBinding, protocolVersion: "1.0" };
  });
  return { ...card(A2A_EXTENSION_URI), supportedInterfaces } as AgentCard;
}

function args(agentCard: AgentCard, options?: RequestOptions): BeforeArgs {
  const before: BeforeArgs = { input: { method: "sendMessage", value: {} } as BeforeArgs["input"], agentCard };
  if (options) {
    before.options = options;
  }
  return before;
}

async function intercept(before: BeforeArgs, token?: string, allowHttp?: boolean): Promise<BeforeArgs> {
  await runWithToken(token, () => new DelegatedTokenInterceptor({ allowHttp }).before(before));
  return before;
}

describe("announcesExtension", () => {
  it("looks for the extension in capabilities.extensions", () => {
    expect(announcesExtension(card(OTHER_URI, A2A_EXTENSION_URI))).toBe(true);
    expect(announcesExtension(card(OTHER_URI))).toBe(false);
    expect(announcesExtension({ capabilities: undefined } as unknown as AgentCard)).toBe(false);
    // Proto3 JSON leaves out an empty list
    expect(announcesExtension({ capabilities: {} } as unknown as AgentCard)).toBe(false);
    expect(announcesExtension(null)).toBe(false);
    // An explicit `undefined`, not a missing argument
    expect(announcesExtension(undefined)).toBe(false); // skipcq
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

  it.each([[A2A_EXTENSION_URI], [`${OTHER_URI},${A2A_EXTENSION_URI}`]])(
    "does not repeat the extensions the caller named in lowercase: %s",
    async (named) => {
      const options: RequestOptions = { serviceParameters: { "a2a-extensions": named } };
      const before = await intercept(args(card(A2A_EXTENSION_URI), options), "tok");
      const headers = new Headers(before.options?.serviceParameters);
      expect(headers.get(A2A_EXTENSIONS_HEADER)?.split(",").sort()).toEqual(named.split(",").sort());
    },
  );

  it("merges the caller's extensions from every case of the name", async () => {
    const third = "https://example.com/extensions/third/v1";
    const options: RequestOptions = {
      serviceParameters: { [A2A_EXTENSIONS_HEADER]: OTHER_URI, "a2a-extensions": third },
    };
    const before = await intercept(args(card(A2A_EXTENSION_URI), options), "tok");
    const headers = new Headers(before.options?.serviceParameters);
    expect(headers.get(A2A_EXTENSIONS_HEADER)?.split(",").sort()).toEqual([OTHER_URI, third, A2A_EXTENSION_URI].sort());
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

  it.each([
    [["https://agent.example.com/"]],
    [["http://localhost:8080/", "http://127.0.0.1/", "http://[::1]/"]],
    [["https://agent.example.com/", "agent.example.com:443 GRPC"]],
  ])("adds the token for an agent served at %j", async (interfaces) => {
    const before = await intercept(args(servedAt(...interfaces)), "tok");
    expect(before.options?.serviceParameters?.[DELEGATED_TOKEN_HEADER]).toBe("tok");
  });

  it.each([[["http://agent.example.com/"]], [["https://agent.example.com/", "http://agent.example.com/ HTTP+JSON"]]])(
    "adds the token for an agent served at %j only with allowHttp",
    async (interfaces) => {
      const blocked = await intercept(args(servedAt(...interfaces)), "tok");
      expect(blocked.options).toBeUndefined();
      const allowed = await intercept(args(servedAt(...interfaces)), "tok", true);
      expect(allowed.options?.serviceParameters?.[DELEGATED_TOKEN_HEADER]).toBe("tok");
    },
  );

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
    const options = delegatedTokenClientOptions(base, { fetch: vi.fn<typeof fetch>() });

    const interceptors = options.clientConfig?.interceptors ?? [];
    expect(interceptors[0]).toBe(other);
    expect(interceptors[1]).toBeInstanceOf(DelegatedTokenInterceptor);
    expect(options.transports.map((transport) => transport.protocolName).sort()).toEqual(["HTTP+JSON", "JSONRPC"]);
    expect(options.transports).not.toEqual(base.transports);
  });

  it("gives the transports the legacyCompat setting", () => {
    const settings = (options: ClientFactoryOptions) =>
      options.transports.map(
        (transport) => (transport as unknown as { options: { legacyCompat?: unknown } }).options.legacyCompat,
      );
    const legacyCompat = { enabled: true };
    expect(settings(delegatedTokenClientOptions(undefined, { legacyCompat }))).toEqual([legacyCompat, legacyCompat]);
    expect(settings(delegatedTokenClientOptions())).toEqual([undefined, undefined]);
  });
});
