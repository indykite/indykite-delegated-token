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

import { describe, expect, it, vi } from "vitest";

import {
  challengeLink,
  ExtensionRegistry,
  type MetadataFetch,
  type MetadataResponse,
  metadataUrl,
  resourceMetadataLink,
  sameOrigin,
  targetKey,
} from "../src/client/discovery.js";
import { MCP_EXTENSION_ID } from "../src/index.js";

const TARGET = "https://mcp.example.com/tools/mcp";
const METADATA = "https://mcp.example.com/.well-known/oauth-protected-resource/tools/mcp";
const LINK = "https://mcp.example.com/prm";
const CHALLENGE = `Bearer resource_metadata="${LINK}"`;

function prm(resource = TARGET, announced = true): MetadataResponse {
  const body: Record<string, unknown> = { resource };
  if (announced) {
    body.mcp_extensions = { [MCP_EXTENSION_ID]: {} };
  }
  return { status: 200, body: JSON.stringify(body) };
}

function answers(...responses: (MetadataResponse | Error)[]) {
  const fetch = vi.fn<MetadataFetch>();
  for (const response of responses) {
    if (response instanceof Error) {
      fetch.mockRejectedValueOnce(response);
      continue;
    }
    fetch.mockResolvedValueOnce(response);
  }
  return fetch;
}

function urls(fetch: ReturnType<typeof answers>): string[] {
  return fetch.mock.calls.map(([url]) => url);
}

describe("targetKey", () => {
  it.each([
    ["https://Example.com:443/mcp?q=1#f", "https://example.com/mcp?q=1"],
    ["http://example.com:8080/mcp", "http://example.com:8080/mcp"],
    ["http://user:pw@example.com/", "http://example.com/"],
    ["https://example.com", "https://example.com/"],
    ["http://[::1]:8080/mcp", "http://[::1]:8080/mcp"],
  ])("%s -> %s", (url, expected) => {
    expect(targetKey(url)).toBe(expected);
  });
});

describe("metadataUrl", () => {
  it.each([
    [TARGET, METADATA],
    ["https://mcp.example.com", "https://mcp.example.com/.well-known/oauth-protected-resource"],
    ["https://mcp.example.com/", "https://mcp.example.com/.well-known/oauth-protected-resource"],
    ["https://mcp.example.com/mcp/", "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/"],
    ["https://mcp.example.com/mcp?t=a", "https://mcp.example.com/.well-known/oauth-protected-resource/mcp?t=a"],
    ["https://mcp.example.com/?t=a", "https://mcp.example.com/.well-known/oauth-protected-resource?t=a"],
  ])("%s -> %s", (url, expected) => {
    expect(metadataUrl(url)).toBe(expected);
  });
});

describe("sameOrigin", () => {
  it("compares scheme, host and port", () => {
    expect(sameOrigin("https://a.com/x", "https://a.com:443/y")).toBe(true);
    expect(sameOrigin("https://a.com/x", "http://a.com/x")).toBe(false);
    expect(sameOrigin("https://a.com/x", "https://b.com/x")).toBe(false);
    expect(sameOrigin("https://a.com:bad/x", "https://a.com/x")).toBe(false);
  });
});

describe("resourceMetadataLink", () => {
  it.each([
    ['Bearer realm="x", resource_metadata="https://a/b"', "https://a/b"],
    ["Bearer resource_metadata=https://a/b, error=x", "https://a/b"],
    ['Bearer RESOURCE_METADATA = "https://a/b"', "https://a/b"],
    ['Bearer resource_metadata=""', undefined],
    ['Bearer realm="x"', undefined],
  ])("%s -> %s", (header, expected) => {
    expect(resourceMetadataLink(header)).toBe(expected);
  });
});

describe("challengeLink", () => {
  it.each([
    [CHALLENGE, LINK],
    ['Bearer resource_metadata="https://evil.example.com/prm"', undefined],
    ['Bearer resource_metadata="https://mcp.example.com:bad/prm"', undefined],
    ['Bearer resource_metadata="/prm"', undefined],
    ['Bearer realm="x"', undefined],
  ])("%s -> %s", (header, expected) => {
    expect(challengeLink(TARGET, header)).toBe(expected);
  });
});

describe("ExtensionRegistry.discover", () => {
  it("caches a target that announces", async () => {
    const registry = new ExtensionRegistry();
    const fetch = answers(prm());
    expect(await registry.discover(TARGET, fetch)).toBe(true);
    expect(await registry.discover(TARGET, fetch)).toBe(true);
    expect(urls(fetch)).toEqual([METADATA]);
    expect(registry.known(TARGET)).toBe(true);
  });

  it("treats another query as another resource", async () => {
    const registry = new ExtensionRegistry();
    const fetch = answers(prm(`${TARGET}?tenant=a`), prm(`${TARGET}?tenant=a`));
    expect(await registry.discover(`${TARGET}?tenant=a`, fetch)).toBe(true);
    expect(await registry.discover(`${TARGET}?tenant=b`, fetch)).toBe(false);
    expect(urls(fetch)).toEqual([`${METADATA}?tenant=a`, `${METADATA}?tenant=b`]);
  });

  it.each<[string, MetadataResponse]>([
    ["not announced", prm(TARGET, false)],
    ["wrong resource", prm("https://other.example.com/tools/mcp")],
    ["bad port", prm("https://mcp.example.com:bad/tools/mcp")],
    ["bad IPv6", prm("https://[mcp.example.com/tools/mcp")],
    ["not JSON", { status: 200, body: "not json" }],
    ["not an object", { status: 200, body: "[]" }],
    ["extensions not an object", { status: 200, body: JSON.stringify({ resource: TARGET, mcp_extensions: [] }) }],
    ["resource not a string", { status: 200, body: JSON.stringify({ mcp_extensions: { [MCP_EXTENSION_ID]: {} } }) }],
    ["404", { status: 404, body: "" }],
  ])("caches a target that does not announce: %s", async (_name, response) => {
    const registry = new ExtensionRegistry();
    const fetch = answers(response);
    expect(await registry.discover(TARGET, fetch)).toBe(false);
    expect(await registry.discover(TARGET, fetch)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(registry.known(TARGET)).toBe(false);
  });

  it.each<[string, MetadataResponse | Error]>([
    ["5xx", { status: 503, body: "" }],
    ["401", { status: 401, body: "" }],
    ["network", new Error("refused")],
  ])("does not cache a failure: %s", async (_name, failure) => {
    const registry = new ExtensionRegistry();
    const fetch = answers(failure, prm());
    expect(await registry.discover(TARGET, fetch)).toBe(false);
    expect(registry.known(TARGET)).toBeUndefined();
    expect(await registry.discover(TARGET, fetch)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one fetch among concurrent first calls", async () => {
    const registry = new ExtensionRegistry();
    const fetch = answers(prm());
    const results = await Promise.all(Array.from({ length: 10 }, () => registry.discover(TARGET, fetch)));
    expect(results.every(Boolean)).toBe(true);
    expect(urls(fetch)).toEqual([METADATA]);
  });

  it("shares a failure among concurrent calls only", async () => {
    const registry = new ExtensionRegistry();
    const fetch = answers(new Error("timeout"), prm());
    const results = await Promise.all(Array.from({ length: 10 }, () => registry.discover(TARGET, fetch)));
    expect(results.some(Boolean)).toBe(false);
    expect(urls(fetch)).toEqual([METADATA]);
    expect(await registry.discover(TARGET, fetch)).toBe(true);
    expect(urls(fetch)).toEqual([METADATA, METADATA]);
  });

  it("keeps targets apart", async () => {
    const registry = new ExtensionRegistry();
    expect(await registry.discover(TARGET, answers(prm()))).toBe(true);
    expect(registry.known("https://mcp.example.com/other")).toBeUndefined();
  });

  it("forgets every target on clear", async () => {
    const registry = new ExtensionRegistry();
    await registry.discover(TARGET, answers(prm()));
    registry.clear();
    expect(registry.known(TARGET)).toBeUndefined();
  });
});

describe("ExtensionRegistry.learnFromChallenge", () => {
  it("follows a link on the target's origin", async () => {
    const registry = new ExtensionRegistry();
    const fetch = answers({ status: 404, body: "" }, prm());
    expect(await registry.discover(TARGET, fetch)).toBe(false);
    expect(await registry.learnFromChallenge(TARGET, CHALLENGE, fetch)).toBe(true);
    expect(urls(fetch)).toEqual([METADATA, LINK]);
    expect(registry.known(TARGET)).toBe(true);
  });

  it("does not fetch again for a target that announces", async () => {
    const registry = new ExtensionRegistry();
    const fetch = answers(prm());
    await registry.discover(TARGET, fetch);
    expect(await registry.learnFromChallenge(TARGET, CHALLENGE, fetch)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("shares one fetch among concurrent challenges", async () => {
    const registry = new ExtensionRegistry();
    const fetch = answers(prm(TARGET, false));
    const calls = Array.from({ length: 10 }, () => registry.learnFromChallenge(TARGET, CHALLENGE, fetch));
    expect((await Promise.all(calls)).some(Boolean)).toBe(false);
    expect(urls(fetch)).toEqual([LINK]);
  });

  it.each([
    ['Bearer resource_metadata="https://evil.example.com/.well-known/oauth-protected-resource"'],
    ['Bearer resource_metadata="https://mcp.example.com:bad/prm"'],
    ['Bearer resource_metadata="https://[mcp.example.com/prm"'],
    ['Bearer realm="x"'],
  ])("ignores %s", async (challenge) => {
    const registry = new ExtensionRegistry();
    const fetch = answers(prm());
    expect(await registry.learnFromChallenge(TARGET, challenge, fetch)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is not downgraded by a slower well-known fetch", async () => {
    const registry = new ExtensionRegistry();
    let resolve!: (response: MetadataResponse) => void;
    const slow = new Promise<MetadataResponse>((done) => {
      resolve = done;
    });
    const wellKnown = vi.fn<MetadataFetch>(() => slow);
    const discovery = registry.discover(TARGET, wellKnown);

    expect(await registry.learnFromChallenge(TARGET, CHALLENGE, answers(prm()))).toBe(true);
    resolve({ status: 404, body: "" });
    expect(await discovery).toBe(false);
    expect(registry.known(TARGET)).toBe(true);
  });
});
