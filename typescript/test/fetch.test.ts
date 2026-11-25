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

import { createHash } from "node:crypto";

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
import { metadataUrl } from "../src/client/discovery.js";
import { MCP_EXTENSION_ID, runWithToken } from "../src/index.js";

import { serveForTest } from "./harness.js";

const TARGET = "https://mcp.example.com/mcp";
const METADATA = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const LINK = "https://mcp.example.com/prm";
const CHALLENGE = `Bearer resource_metadata="${LINK}"`;
const SHA256_FINAL = createHash("sha256").update("final").digest("base64");
const SHA512_FINAL_URL = createHash("sha512").update("final").digest("base64url");

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

/** A form with one field. */
function form(name: string, value: string): FormData {
  const data = new FormData();
  data.set(name, value);
  return data;
}

/** The content of a body, comparable across copies: the entries of a form, the text of anything else. */
function payload(body: RequestInit["body"]): Promise<unknown> {
  return body instanceof FormData ? Promise.resolve([...body]) : new Response(body).text();
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
    const response = await withToken(() => fetch(TARGET, { method: "POST", body: "{}" }));
    expect(response.redirected).toBe(false);
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

  it("asks again after a metadata error only once errorTtl has passed", async () => {
    const { send, fetch } = setup({ [METADATA]: () => new Response(null, { status: 500 }), [TARGET]: ok });
    for (let call = 0; call < 5; call++) {
      await withToken(() => fetch(TARGET));
    }
    expect(urls(send).filter((url) => url === METADATA)).toHaveLength(1);
  });

  it.each([
    ["URL", (url: string) => url],
    ["Request", (url: string) => new Request(url)],
  ])("sends neither the token nor a metadata request over plain HTTP, to a %s", async (_name, input) => {
    const http = "http://gateway.example.com/mcp";
    const { send, fetch } = setup({ [metadataUrl(http)]: () => announced(http), [http]: ok });
    await withToken(() => fetch(input(http)));
    expect(urls(send)).toEqual([http]);
    expect(tokens(send, http)).toEqual([null]);
  });

  it.each([
    ["to a loopback host", "http://localhost:8080/mcp", false],
    ["with allowHttp", "http://gateway.example.com/mcp", true],
  ])("sends the token over plain HTTP %s", async (_name, http, allowHttp) => {
    const send = network({ [metadataUrl(http)]: () => announced(http), [http]: ok });
    const fetch = delegatedTokenFetch({ fetch: send, registry: new ExtensionRegistry({ allowHttp }) });
    await withToken(() => fetch(http));
    expect(tokens(send, http)).toEqual(["tok"]);
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
  it("sends a copy of the request, with the token", async () => {
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: ok });
    const request = new Request(TARGET, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" });
    await withToken(() => fetch(request));
    const [input, init] = send.mock.calls[1] ?? [];
    const headers = new Headers(init?.headers);
    expect(input).toBeInstanceOf(Request);
    expect((input as Request).method).toBe("POST");
    expect(await (input as Request).text()).toBe("hi");
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
    const request = new Request(TARGET, { cache: "no-store", credentials: "omit" } as RequestInit);
    await withToken(() => fetch(request));
    expect(send.mock.calls[1]?.[0]).toMatchObject({ cache: "no-store", credentials: "omit" });
  });

  it("sends a keepalive request with a body through the native fetch", async () => {
    const target = await serveForTest(() => (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => res.end(`${body} ${req.headers["x-ik-token"]?.toString() ?? ""}`));
    });
    const request = new Request(target, { method: "POST", body: "hi", keepalive: true });
    const response = await delegatedTokenFetch()(request, { headers: { "X-IK-Token": "caller" } });
    expect(await response.text()).toBe("hi caller");
  });

  it.each([
    ["the hash of the final body", `sha256-${SHA256_FINAL}`, "final"],
    ["the hash in base64url, among weaker ones", `sha256-x sha512-${SHA512_FINAL_URL}?opt`, "final"],
    ["an unknown algorithm only", "md5-abc", "final"],
    ["a wrong hash", "sha256-abc", "integrity mismatch"],
  ])("checks the integrity of the final response, through the native fetch: %s", async (_name, integrity, outcome) => {
    const target = await serveForTest(() => (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/end" }).end();
        return;
      }
      res.end("final");
    });
    const guarded = redirectGuard();
    const init = { headers: { "X-IK-Token": "caller" }, integrity };
    for (const call of [() => guarded(`${target}/start`, init), () => guarded(new Request(`${target}/start`, init))]) {
      if (outcome === "integrity mismatch") {
        await expect(call()).rejects.toThrow(outcome);
        continue;
      }
      expect(await (await call()).text()).toBe(outcome);
    }
  });

  it("keeps the request's options on a redirect", async () => {
    const next = "https://mcp.example.com/next";
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => redirect(302, next), [next]: ok });
    const init = { cache: "no-store", headers: { Accept: "text/plain" } } as RequestInit;
    const request = new Request(TARGET, init);
    await withToken(() => fetch(request));
    const [, hop] = send.mock.calls[2] ?? [];
    expect(hop).toMatchObject({ method: "GET", cache: "no-store", body: null });
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

  it.each([["a URL"], ["a Request"]])("sends the headers of %s as they were at the call", async (form) => {
    const metadata = Promise.withResolvers<Response>();
    const { send, fetch } = setup({ [METADATA]: () => metadata.promise, [TARGET]: ok });
    const headers = new Headers({ Authorization: "A" });
    const request = new Request(TARGET, { headers });
    const call = withToken(() => (form === "a URL" ? fetch(TARGET, { headers }) : fetch(request)));
    headers.set("Authorization", "B");
    request.headers.set("Authorization", "B");
    metadata.resolve(announced());
    await call;
    const [input, init] = send.mock.calls[1] ?? [];
    expect(headersOf(input, init).get("authorization")).toBe("A");
  });

  it.each([
    ["Uint8Array", (text: string) => new TextEncoder().encode(text), (body: Uint8Array) => body.fill(0)],
    [
      "ArrayBuffer",
      (text: string) => new TextEncoder().encode(text).buffer,
      (body: ArrayBuffer) => new Uint8Array(body).fill(0),
    ],
    [
      "URLSearchParams",
      (text: string) => new URLSearchParams({ a: text }),
      (body: URLSearchParams) => {
        body.set("a", "B");
      },
    ],
    [
      "FormData",
      (text: string) => form("a", text),
      (body: FormData) => {
        body.set("a", "B");
      },
    ],
  ] as const)("sends a %s body as it was at the call", async (_name, make, change) => {
    const metadata = Promise.withResolvers<Response>();
    const { send, fetch } = setup({ [METADATA]: () => metadata.promise, [TARGET]: ok });
    const body = make("A");
    const call = withToken(() => fetch(TARGET, { method: "POST", body }));
    (change as (body: RequestInit["body"]) => void)(body);
    metadata.resolve(announced());
    await call;
    expect(await payload(send.mock.calls[1]?.[1]?.body)).toEqual(await payload(make("A")));
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

  it("does not follow the link again on every 401", async () => {
    const { send, fetch } = setup({
      [METADATA]: notFound,
      [LINK]: () => Response.json({ resource: TARGET }),
      [TARGET]: () => unauthorized(),
    });
    for (let call = 0; call < 3; call++) {
      await withToken(() => fetch(TARGET));
    }
    expect(urls(send)).toEqual([METADATA, TARGET, LINK, TARGET, TARGET]);
  });

  it("returns the 401 when the link does not announce", async () => {
    const answer = unauthorized("denied");
    const { send, fetch } = setup({
      [METADATA]: notFound,
      [LINK]: () => Response.json({ resource: TARGET }),
      [TARGET]: () => answer,
    });
    const response = await withToken(() => fetch(TARGET));
    expect(response).toBe(answer);
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
    expect(response).toBe(answer);
    expect(await response.text()).toBe(`${head}tail`);
    expect(urls(send)).toEqual([METADATA, TARGET]);
  });

  it("keeps the URL and type of a fetched 401", async () => {
    const served = await serveForTest((url) => (req, res) => {
      const challenge = `Bearer resource_metadata="${url}/prm"`;
      res.writeHead(req.url === "/mcp" ? 401 : 404, { "WWW-Authenticate": challenge }).end("denied");
    });
    const fetch = delegatedTokenFetch({ registry: new ExtensionRegistry() });
    const response = await withToken(() => fetch(`${served}/mcp`));
    expect(response.status).toBe(401);
    expect(response.url).toBe(`${served}/mcp`);
    expect(response.clone().type).toBe("basic");
    expect(await response.text()).toBe("denied");
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

  it("times out a 401 whose tee'd body does not arrive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Cancelling one branch of a tee waits for the other
    const [body, other] = slowStream().tee();
    const answer = new Response(body, { status: 401, headers: { "WWW-Authenticate": CHALLENGE } });
    const { fetch } = setup({ [METADATA]: notFound, [TARGET]: () => answer });
    const pending = withToken(() => fetch(TARGET));
    const outcome = expect(pending).rejects.toThrow(`response body not read within ${String(READ_DEADLINE)} ms`);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE);
    await outcome;
    await other.cancel();
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

    expect(response.clone().clone().redirected).toBe(true);
    expect(await response.text()).toBe("ok");
    expect(response.redirected).toBe(true);
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

  it.each([
    ["follows", 2],
    ["stops after the limit", MAX_REDIRECTS + 1],
  ])("%s without waiting for the cancel of tee'd redirect bodies", async (_name, hops) => {
    let sent = 0;
    // Cancelling one branch of a tee waits for the other, which nobody reads
    const teed = () => new Response(slowStream().tee()[0], { status: 302, headers: { Location: TARGET } });
    const { fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => (++sent > hops ? ok() : teed()) });
    const response = withToken(() => fetch(TARGET));
    if (hops > MAX_REDIRECTS) {
      await expect(response).rejects.toThrow("redirect count exceeded");
      return;
    }
    expect(await (await response).text()).toBe("ok");
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

  it.each([
    ["Blob", () => new Blob(["{}"])],
    ["ArrayBuffer", () => new TextEncoder().encode("{}").buffer],
    ["FormData", () => form("a", "1")],
  ])("follow a redirect that resends a %s body", async (_name, body) => {
    const next = "https://mcp.example.com/next";
    const sent = body();
    const { send, fetch } = setup({ [METADATA]: () => announced(), [TARGET]: () => redirect(307, next), [next]: ok });
    const response = await withToken(() => fetch(TARGET, { method: "POST", body: sent }));
    expect(await response.text()).toBe("ok");
    expect(await payload(send.mock.calls[2]?.[1]?.body)).toEqual(await payload(sent));
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

  it("is not aborted with the caller's signal", async () => {
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: ok });
    const controller = new AbortController();
    await withToken(() => fetch(TARGET, { signal: controller.signal }));
    controller.abort();
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it.each([
    ["first", 0],
    ["later", 1],
  ])("lets the %s caller stop waiting, and gives the others the shared answer", async (_name, aborting) => {
    const metadata = Promise.withResolvers<Response>();
    const { send, fetch } = setup({ [METADATA]: () => metadata.promise, [TARGET]: ok });
    const controllers = [new AbortController(), new AbortController()];
    const calls = controllers.map((controller) => withToken(() => fetch(TARGET, { signal: controller.signal })));
    await vi.waitFor(() => {
      expect(urls(send)).toEqual([METADATA]);
    });

    controllers[aborting]?.abort(new Error("stop"));
    await expect(calls[aborting]).rejects.toThrow("stop");
    metadata.resolve(announced());
    await expect(calls[1 - aborting]).resolves.toBeInstanceOf(Response);
    expect(tokens(send)).toEqual(["tok"]);
  });

  it("rejects a call whose signal aborted before discovery", async () => {
    const { send, fetch } = setup({ [METADATA]: notFound, [TARGET]: ok });
    const call = withToken(() => fetch(TARGET, { signal: AbortSignal.abort(new Error("stop")) }));
    await expect(call).rejects.toThrow("stop");
    expect(urls(send)).toEqual([METADATA]);
  });

  it("does not leave a failed discovery unhandled when the signal aborted before", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // `allowHttp`, so the URL reaches the discovery
      const fetch = delegatedTokenFetch({ fetch: network({}), registry: new ExtensionRegistry({ allowHttp: true }) });
      const call = withToken(() => fetch("not a url", { signal: AbortSignal.abort(new Error("stop")) }));
      await expect(call).rejects.toThrow("stop");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("lets a caller stop waiting for the link of a 401", async () => {
    const link = Promise.withResolvers<Response>();
    const { send, fetch } = setup({ [METADATA]: notFound, [LINK]: () => link.promise, [TARGET]: () => unauthorized() });
    const controller = new AbortController();
    const call = withToken(() => fetch(TARGET, { signal: controller.signal }));
    await vi.waitFor(() => {
      expect(urls(send)).toEqual([METADATA, TARGET, LINK]);
    });

    controller.abort(new Error("stop"));
    await expect(call).rejects.toThrow("stop");
    link.resolve(notFound());
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
