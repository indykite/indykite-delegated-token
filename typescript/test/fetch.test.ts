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

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REGISTRY,
  delegatedTokenFetch,
  ExtensionRegistry,
  type FetchLike,
  MAX_BODY,
  MAX_REDIRECTS,
  READ_DEADLINE,
  redirectGuard,
} from "../src/client/fetch.js";
import { MCP_EXTENSION_ID, runWithToken } from "../src/index.js";

import { serve } from "./harness.js";

const TARGET = "https://mcp.example.com/mcp";
const METADATA = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const LINK = "https://mcp.example.com/prm";
const CHALLENGE = `Bearer resource_metadata="${LINK}"`;

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function announced(resource = TARGET): Response {
  return Response.json({ resource, mcp_extensions: { [MCP_EXTENSION_ID]: {} } });
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { Location: location } });
}

function unauthorized(body = "denied", challenge = CHALLENGE): Response {
  return new Response(body, { status: 401, headers: { "WWW-Authenticate": challenge } });
}

function ok(): Response {
  return new Response("ok");
}

function urlOf(input: string | URL | Request | undefined): string {
  if (input instanceof Request) {
    return input.url;
  }
  return input?.toString() ?? "";
}

/** A fake network: answers each URL with its handler, and records every call. */
function network(routes: Record<string, Handler>) {
  return vi.fn<FetchLike>((input, init = {}) => {
    const url = urlOf(input);
    const handler = routes[url];
    if (!handler) {
      return Promise.reject(new TypeError(`fetch failed: ${url}`));
    }
    return Promise.resolve(handler(url, init));
  });
}

function setup(routes: Record<string, Handler>) {
  const send = network(routes);
  const registry = new ExtensionRegistry();
  return { send, registry, fetch: delegatedTokenFetch({ fetch: send, registry }) };
}

function urls(send: ReturnType<typeof network>): string[] {
  return send.mock.calls.map(([input]) => urlOf(input));
}

function tokens(send: ReturnType<typeof network>, url = TARGET): (string | null)[] {
  return send.mock.calls
    .filter(([input]) => urlOf(input) === url)
    .map(([input, init]) => headersOf(input, init).get("x-ik-token"));
}

function headersOf(input: string | URL | Request | undefined, init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

function withToken<R>(fn: () => R): R {
  return runWithToken("tok", fn);
}

function slowStream(first?: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (first) {
        controller.enqueue(first);
      }
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("delegatedTokenFetch", () => {
  it("sends calls without a token unchanged and without discovery", async () => {
    const { send, fetch } = setup({ [TARGET]: ok });
    const init = { method: "POST", body: "{}" };
    await fetch(TARGET, init);
    expect(send.mock.calls).toEqual([[TARGET, init]]);
  });

  it("sends the token to a target that announces, and caches the answer", async () => {
    const { send, registry, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: ok });
    await withToken(() => fetch(TARGET, { method: "POST", body: "{}" }));
    await withToken(() => fetch(TARGET, { method: "POST", body: "{}" }));
    expect(urls(send)).toEqual([METADATA, TARGET, TARGET]);
    expect(tokens(send)).toEqual(["tok", "tok"]);
    expect(registry.known(TARGET)).toBe(true);
  });

  it.each([
    ["404", notFound],
    ["not announced", () => Response.json({ resource: TARGET })],
  ])("sends nothing to a target that does not announce: %s", async (_name, metadata) => {
    const { send, fetch } = setup({ [METADATA]: metadata, [TARGET]: ok });
    const response = await withToken(() => fetch(TARGET));
    expect(await response.text()).toBe("ok");
    expect(tokens(send)).toEqual([null]);
  });

  it("keeps a token the caller set, without discovery", async () => {
    const { send, fetch } = setup({ [TARGET]: ok });
    await withToken(() => fetch(TARGET, { headers: { "x-ik-token": "caller" } }));
    expect(urls(send)).toEqual([TARGET]);
    expect(tokens(send)).toEqual(["caller"]);
  });

  it("does not change the caller's init", async () => {
    const { fetch } = setup({ [METADATA]: () => announced(), [TARGET]: ok });
    const init = { method: "POST", headers: { Accept: "application/json" }, body: "{}" };
    await withToken(() => fetch(TARGET, init));
    expect(init).toEqual({ method: "POST", headers: { Accept: "application/json" }, body: "{}" });
  });

  it("uses the global fetch and the default registry", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(url === TARGET ? ok() : notFound());
    });
    DEFAULT_REGISTRY.clear();
    await withToken(() => delegatedTokenFetch()(TARGET));
    expect(send).toHaveBeenCalledTimes(2);
    expect(DEFAULT_REGISTRY.known(TARGET)).toBe(false);
    DEFAULT_REGISTRY.clear();
  });
});

describe("Request input", () => {
  it("sends the request itself, with the token", async () => {
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: ok });
    const request = new Request(TARGET, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" });
    await withToken(() => fetch(request));
    const [input, init] = send.mock.calls[1] ?? [];
    const headers = new Headers(init?.headers);
    expect(input).toBe(request);
    expect(headers.get("x-ik-token")).toBe("tok");
    expect(headers.get("content-type")).toBe("text/plain");
    expect(init?.redirect).toBe("manual");
  });

  it("applies the caller's init to the request", async () => {
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: ok });
    await withToken(() => fetch(new Request(TARGET), { method: "PUT", body: "hi" }));
    const input = send.mock.calls[1]?.[0] as Request;
    expect(input.method).toBe("PUT");
    expect(await input.text()).toBe("hi");
  });

  it("keeps the request's options", async () => {
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: ok });
    const request = new Request(TARGET, {
      integrity: "sha256-abc",
      cache: "no-store",
      credentials: "omit",
    } as RequestInit);
    await withToken(() => fetch(request));
    expect(send.mock.calls[1]?.[0]).toMatchObject({ integrity: "sha256-abc", cache: "no-store", credentials: "omit" });
  });

  it("sends a keepalive request with a body through the native fetch", async () => {
    const target = await serve(() => (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => res.end(`${body} ${req.headers["x-ik-token"]?.toString() ?? ""}`));
    });
    try {
      const request = new Request(target.url, { method: "POST", body: "hi", keepalive: true });
      const response = await delegatedTokenFetch()(request, { headers: { "X-IK-Token": "caller" } });
      expect(await response.text()).toBe("hi caller");
    } finally {
      await target.close();
    }
  });

  it("keeps the request's options on a redirect", async () => {
    const next = "https://mcp.example.com/next";
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => redirect(302, next), [next]: ok });
    const init = { cache: "no-store", integrity: "sha256-abc", headers: { Accept: "text/plain" } } as RequestInit;
    const request = new Request(TARGET, init);
    await withToken(() => fetch(request));
    const [, hop] = send.mock.calls[2] ?? [];
    expect(hop).toMatchObject({ method: "GET", cache: "no-store", integrity: "sha256-abc", body: null });
    expect(Object.fromEntries(new Headers(hop?.headers))).toEqual({ accept: "text/plain", "x-ik-token": "tok" });
  });

  it("turns a request with a body into a GET on a 303", async () => {
    const next = "https://mcp.example.com/next";
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => redirect(303, next), [next]: ok });
    await withToken(() => fetch(new Request(TARGET, { method: "POST", body: "{}" })));
    expect(send.mock.calls[2]?.[1]).toMatchObject({ method: "GET", body: null });
  });

  it("returns a 307 that would resend the body of a request", async () => {
    const answer = redirect(307, "https://mcp.example.com/next");
    const { fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => answer });
    expect(await withToken(() => fetch(new Request(TARGET, { method: "POST", body: "{}" })))).toBe(answer);
  });

  it("does not retry a request with a body after a 401", async () => {
    const answer = unauthorized();
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    const request = new Request(TARGET, { method: "POST", body: "{}" });
    expect(await withToken(() => fetch(request))).toBe(answer);
    expect(urls(send)).toEqual([METADATA, TARGET]);
  });

  it("retries a request without a body after a 401", async () => {
    const target = vi.fn<Handler>((_url, init) =>
      new Headers(init.headers).has("x-ik-token") ? ok() : unauthorized(),
    );
    const { send, fetch } = setup({ [METADATA]: notFound, [LINK]: () => announced(), [TARGET]: target });
    await withToken(() => fetch(new Request(TARGET)));
    expect(tokens(send)).toEqual([null, "tok"]);
  });

  it("keeps a token set in the request's headers", async () => {
    const { send, fetch } = setup({ [TARGET]: ok });
    const request = new Request(TARGET, { headers: { "X-IK-Token": "caller" } });
    await withToken(() => fetch(request));
    expect(urls(send)).toEqual([TARGET]);
    expect(tokens(send)).toEqual(["caller"]);
  });
});

describe("redirectGuard", () => {
  it("sends requests without the header unchanged", async () => {
    const send = network({ [TARGET]: ok });
    const init = { method: "POST", body: "{}" };
    await runWithToken("tok", () => redirectGuard(send)(TARGET, init));
    expect(send.mock.calls).toEqual([[TARGET, init]]);
  });

  it("does not carry the header to another origin, without discovery", async () => {
    const other = "https://other.example.com/";
    const send = network({ [TARGET]: () => redirect(307, other), [other]: ok });
    await redirectGuard(send)(TARGET, { method: "POST", headers: { "X-IK-Token": "tok" }, body: "{}" });
    expect(urls(send)).toEqual([TARGET, other]);
    expect(tokens(send, other)).toEqual([null]);
  });

  it("uses the global fetch by default", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    await redirectGuard()(TARGET);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("401 challenge", () => {
  it("follows a link on the target's origin and retries once with the token", async () => {
    const target = vi.fn<Handler>((_url, init) =>
      new Headers(init.headers).has("x-ik-token") ? ok() : unauthorized(),
    );
    const { send, registry, fetch } = setup({ [METADATA]: notFound, [LINK]: () => announced(), [TARGET]: target });
    const response = await withToken(() => fetch(TARGET, { method: "POST", body: "{}" }));

    expect(await response.text()).toBe("ok");
    expect(urls(send)).toEqual([METADATA, TARGET, LINK, TARGET]);
    expect(tokens(send)).toEqual([null, "tok"]);
    expect(send.mock.calls[3]?.[1]?.body).toBe("{}");
    expect(registry.known(TARGET)).toBe(true);
  });

  it("returns the 401 when the link does not announce", async () => {
    const { send, fetch } = setup({
      [METADATA]: notFound,
      [LINK]: () => Response.json({ resource: TARGET }),
      [TARGET]: () => unauthorized("denied"),
    });
    const response = await withToken(() => fetch(TARGET));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await response.text()).toBe("denied");
    expect(urls(send)).toEqual([METADATA, TARGET, LINK]);
  });

  it("follows the link of a 401 without a body", async () => {
    const target = vi.fn<Handler>((_url, init) =>
      new Headers(init.headers).has("x-ik-token") ? ok() : unauthorized(),
    );
    target.mockReturnValueOnce(new Response(null, { status: 401, headers: { "WWW-Authenticate": CHALLENGE } }));
    const { send, fetch } = setup({ [METADATA]: notFound, [LINK]: () => announced(), [TARGET]: target });
    await withToken(() => fetch(TARGET));
    expect(tokens(send)).toEqual([null, "tok"]);
  });

  it.each([
    ["cross-origin link", 'Bearer resource_metadata="https://evil.example.com/prm"'],
    ["no link", 'Bearer realm="x"'],
    ["no challenge", ""],
  ])("returns the 401 unread: %s", async (_name, challenge) => {
    const answer = challenge ? unauthorized("denied", challenge) : new Response("denied", { status: 401 });
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    const response = await withToken(() => fetch(TARGET));
    expect(response).toBe(answer);
    expect(response.bodyUsed).toBe(false);
    expect(urls(send)).toEqual([METADATA, TARGET]);
  });

  it("returns a 401 that came after a redirect", async () => {
    const answer = unauthorized();
    Object.defineProperty(answer, "redirected", { value: true });
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    expect(await withToken(() => fetch(TARGET))).toBe(answer);
    expect(urls(send)).toEqual([METADATA, TARGET]);
  });

  it("does not retry a streamed body", async () => {
    const answer = unauthorized();
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    expect(await withToken(() => fetch(TARGET, { method: "POST", body, duplex: "half" }))).toBe(answer);
    expect(urls(send)).toEqual([METADATA, TARGET]);
  });

  it("returns a 401 larger than the limit intact, without discovery", async () => {
    const head = "x".repeat(MAX_BODY + 10);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(head));
        controller.enqueue(new TextEncoder().encode("tail"));
        controller.close();
      },
    });
    const answer = new Response(body, { status: 401, headers: { "WWW-Authenticate": CHALLENGE } });
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    const response = await withToken(() => fetch(TARGET));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(`${head}tail`);
    expect(urls(send)).toEqual([METADATA, TARGET]);
  });

  it("passes on the cancel of a 401 larger than the limit", async () => {
    const big = new Uint8Array(MAX_BODY + 1);
    const answer = new Response(slowStream(big), { status: 401, headers: { "WWW-Authenticate": CHALLENGE } });
    const { fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    const response = await withToken(() => fetch(TARGET));
    await expect(response.body?.cancel()).resolves.toBeUndefined();
  });

  it("passes on an error while reading a 401", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const answer = new Response(body, { status: 401, headers: { "WWW-Authenticate": CHALLENGE } });
    const { fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    await expect(withToken(() => fetch(TARGET))).rejects.toThrow("connection reset");
  });

  it("times out a 401 whose body does not arrive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const answer = new Response(slowStream(), { status: 401, headers: { "WWW-Authenticate": CHALLENGE } });
    const { fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    const pending = withToken(() => fetch(TARGET));
    const outcome = expect(pending).rejects.toThrow(`response body not read within ${String(READ_DEADLINE)} ms`);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE);
    await outcome;
  });
});

describe("redirects", () => {
  it.each([
    ["another host", "https://other.example.com/mcp"],
    ["http", "http://mcp.example.com/mcp"],
  ])("do not carry the token or credentials to %s", async (_name, location) => {
    const { send, fetch } = setup({
      [METADATA]: () => announced(),
      [TARGET]: () => redirect(307, location),
      [location]: ok,
    });
    const init = { method: "POST", headers: { Authorization: "Bearer a", Cookie: "c=1" }, body: "{}" };
    const response = await withToken(() => fetch(TARGET, init));

    expect(await response.text()).toBe("ok");
    const [, hop] = send.mock.calls[2] ?? [];
    const headers = new Headers(hop?.headers);
    expect(urlOf(send.mock.calls[2]?.[0])).toBe(location);
    expect([...headers.keys()]).toEqual([]);
    expect(hop?.method).toBe("POST");
    expect(hop?.body).toBe("{}");
  });

  it.each([
    ["with", withToken],
    ["without", <R>(fn: () => R) => fn()],
  ])("do not carry a token the caller set to another origin, %s a delegated token", async (_name, run) => {
    const other = "https://other.example.com/mcp";
    const { send, fetch } = setup({ [TARGET]: () => redirect(302, other), [other]: ok });
    await run(() => fetch(TARGET, { headers: { "X-IK-Token": "caller" } }));
    expect(urls(send)).toEqual([TARGET, other]);
    expect(tokens(send)).toEqual(["caller"]);
    expect(tokens(send, other)).toEqual([null]);
  });

  it("leave a caller's token with redirect: manual to the caller", async () => {
    const answer = redirect(302, "https://other.example.com/mcp");
    const { send, fetch } = setup({ [TARGET]: () => answer });
    const response = await fetch(TARGET, { headers: { "X-IK-Token": "caller" }, redirect: "manual" });
    expect(response).toBe(answer);
    expect(send).toHaveBeenCalledOnce();
  });

  it("carry the token on the same origin", async () => {
    const next = "https://mcp.example.com/next";
    const { send, fetch } = setup({
      [METADATA]: () => announced(),
      [TARGET]: () => redirect(308, "/next"),
      [next]: ok,
    });
    await withToken(() => fetch(TARGET));
    expect(urls(send)).toEqual([METADATA, TARGET, next]);
    expect(tokens(send, next)).toEqual(["tok"]);
    expect(send.mock.calls[1]?.[1]?.redirect).toBe("manual");
  });

  it.each([
    [303, "POST", "GET"],
    [303, "PUT", "GET"],
    [303, "HEAD", "HEAD"],
    [303, "GET", "GET"],
    [301, "POST", "GET"],
    [302, "POST", "GET"],
    [302, "PUT", "PUT"],
    [307, "POST", "POST"],
  ])("%d turns %s into %s", async (status, method, expected) => {
    const next = "https://mcp.example.com/next";
    const { send, fetch } = setup({
      [METADATA]: () => announced(),
      [TARGET]: () => redirect(status, next),
      [next]: ok,
    });
    const init = { method, headers: { "Content-Type": "application/json" }, body: "{}" };
    await withToken(() => fetch(TARGET, init));
    const [, hop] = send.mock.calls[2] ?? [];
    expect(hop?.method).toBe(expected);
    if (expected === method) {
      expect(hop?.body).toBe("{}");
      return;
    }
    expect(hop?.body).toBeNull();
    expect(new Headers(hop?.headers).has("content-type")).toBe(false);
  });

  it("follows a redirect of a request without a method", async () => {
    const next = "https://mcp.example.com/next";
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => redirect(303, next), [next]: ok });
    await withToken(() => fetch(TARGET));
    expect(send.mock.calls[2]?.[1]?.method).toBeUndefined();
  });

  it("stop after the limit", async () => {
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => redirect(302, TARGET) });
    await expect(withToken(() => fetch(TARGET))).rejects.toThrow("redirect count exceeded");
    expect(send).toHaveBeenCalledTimes(MAX_REDIRECTS + 2);
  });

  it("return a redirect without a location", async () => {
    const answer = new Response(null, { status: 302 });
    const { fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => answer });
    expect(await withToken(() => fetch(TARGET))).toBe(answer);
  });

  it("return a redirect that would resend a streamed body", async () => {
    const answer = redirect(307, "https://mcp.example.com/next");
    const { fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => answer });
    const body = new ReadableStream();
    const init: RequestInit = { method: "POST", body, duplex: "half" };
    expect(await withToken(() => fetch(TARGET, init))).toBe(answer);
  });

  it("are left to the caller when it asks for them", async () => {
    const answer = redirect(302, "https://other.example.com/");
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => answer });
    expect(await withToken(() => fetch(TARGET, { redirect: "manual" }))).toBe(answer);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("metadata fetch", () => {
  it("is a plain GET without the caller's headers", async () => {
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: ok });
    await withToken(() => fetch(TARGET, { headers: { Authorization: "Bearer a" } }));
    const [, init] = send.mock.calls[0] ?? [];
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      accept: "application/json",
      "accept-encoding": "identity",
    });
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("is aborted with the caller's signal", async () => {
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: ok });
    const controller = new AbortController();
    await withToken(() => fetch(TARGET, { signal: controller.signal }));
    const signal = send.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it.each([
    ["larger than the limit", () => new Response("x".repeat(MAX_BODY + 1))],
    ["compressed", () => new Response("{}", { headers: { "Content-Encoding": "gzip" } })],
  ])("refuses an answer %s, and does not cache it", async (_name, metadata) => {
    const { registry, fetch } = setup({ [METADATA]: metadata, [TARGET]: ok });
    await withToken(() => fetch(TARGET));
    expect(registry.known(TARGET)).toBeUndefined();
  });

  it("accepts an answer marked identity", async () => {
    const answer = () =>
      new Response(JSON.stringify({ resource: TARGET, mcp_extensions: { [MCP_EXTENSION_ID]: {} } }), {
        headers: { "Content-Encoding": "Identity" },
      });
    const { registry, fetch } = setup({ [METADATA]: answer, [TARGET]: ok });
    await withToken(() => fetch(TARGET));
    expect(registry.known(TARGET)).toBe(true);
  });
});
