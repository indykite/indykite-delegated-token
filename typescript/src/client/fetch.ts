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

/**
 * A `fetch` wrapper that sends the delegated token to the MCP servers that announce the extension.
 *
 * @packageDocumentation
 */

import { DELEGATED_TOKEN_HEADER } from "../constants.js";
import { getDelegatedToken } from "../context.js";
import {
  challengeLink,
  DEFAULT_REGISTRY,
  type ExtensionRegistry,
  type MetadataFetch,
  sameOrigin,
} from "./discovery.js";

export { DEFAULT_REGISTRY, ExtensionRegistry, type MetadataFetch, type MetadataResponse } from "./discovery.js";

/** The `fetch` signature that the MCP client transports accept. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DelegatedTokenFetchOptions {
  /** The `fetch` to wrap. Default: the global `fetch`. */
  fetch?: FetchLike | undefined;
  /** Where to remember which targets announce the extension. Default: {@link DEFAULT_REGISTRY}. */
  registry?: ExtensionRegistry | undefined;
}

/** The most bytes read from a metadata answer or from a 401 body. */
export const MAX_BODY = 64 * 1024;
/** Milliseconds that reading a 401 body may take. */
export const READ_DEADLINE = 30_000;
/** Milliseconds that a metadata fetch may take. */
export const METADATA_TIMEOUT = 10_000;
/** The most redirects followed for a request that carries the token. */
export const MAX_REDIRECTS = 20;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Headers that must not reach another origin
const CREDENTIAL_HEADERS = [DELEGATED_TOKEN_HEADER, "authorization", "cookie", "proxy-authorization"];
// Headers that describe a body, dropped when a redirect turns the request into a GET
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];

interface Call {
  url: string;
  /** The init to send, or the overrides of `request`. */
  init: RequestInit;
  /** The caller's `Request`, sent as it is so it keeps its body and options. */
  request?: Request | undefined;
}

interface Propagation {
  send: FetchLike;
  registry: ExtensionRegistry;
  token: string;
}

interface Read {
  chunks: Uint8Array[];
  complete: boolean;
}

/**
 * Wrap `fetch` so it adds `X-IK-Token` to the requests for targets that announce the delegated token extension.
 *
 * The token is the one of the request being handled ({@link getDelegatedToken}). Requests without a token, and
 * requests to targets that do not announce, go out unchanged. A header the caller set is never replaced. The token,
 * also one the caller set, goes only to the origin of the request, never to the origin of a redirect.
 */
export function delegatedTokenFetch(options: DelegatedTokenFetchOptions = {}): FetchLike {
  const send = options.fetch ?? globalFetch;
  const registry = options.registry ?? DEFAULT_REGISTRY;
  return async (input, init) => {
    if (headersOf(input, init).has(DELEGATED_TOKEN_HEADER)) {
      return guard(send, normalize(input, init));
    }
    const token = getDelegatedToken();
    if (token === undefined) {
      return send(input, init);
    }
    return propagate({ send, registry, token }, normalize(input, init));
  };
}

/**
 * Wrap `fetch` so a request that carries `X-IK-Token` never sends it to the origin of a redirect.
 *
 * It adds no token and fetches no metadata. Use it where another component sets the header, such as the A2A
 * transports with `DelegatedTokenInterceptor`.
 */
export function redirectGuard(fetch: FetchLike = globalFetch): FetchLike {
  return async (input, init) => {
    if (!headersOf(input, init).has(DELEGATED_TOKEN_HEADER)) {
      return fetch(input, init);
    }
    return guard(fetch, normalize(input, init));
  };
}

function globalFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function headersOf(input: string | URL | Request, init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

// A `Request` is kept as it is, with the caller's init applied, and sent with the overrides only
function normalize(input: string | URL | Request, init: RequestInit | undefined): Call {
  if (!(input instanceof Request)) {
    return { url: input.toString(), init: { ...init } };
  }
  const request = init ? new Request(input, init) : input;
  return { url: request.url, init: {}, request };
}

function send(fetch: FetchLike, call: Call): Promise<Response> {
  return fetch(call.request ?? call.url, call.init);
}

// Whether the request can be sent again: a `Request` only without a body, whose body is a stream
function replayable(call: Call): boolean {
  if (call.request) {
    return call.request.body === null;
  }
  const body = call.init.body;
  return body == null || typeof body === "string" || ArrayBuffer.isView(body) || body instanceof URLSearchParams;
}

async function propagate(propagation: Propagation, call: Call): Promise<Response> {
  const { registry } = propagation;
  const metadata = metadataFetch(propagation.send, call.init.signal ?? call.request?.signal);
  if (await registry.discover(call.url, metadata)) {
    return sendWithToken(propagation, call);
  }
  const response = await send(propagation.send, call);
  if (response.status !== 401 || response.redirected || !replayable(call)) {
    return response;
  }
  const challenge = response.headers.get("www-authenticate");
  if (!challenge || challengeLink(call.url, challenge) === undefined) {
    return response;
  }
  // Read the 401 before discovery, so its connection is free for the metadata fetch
  const buffered = await buffer(response);
  if (!buffered.complete || !(await registry.learnFromChallenge(call.url, challenge, metadata))) {
    return buffered.response;
  }
  return sendWithToken(propagation, call);
}

function sendWithToken(propagation: Propagation, call: Call): Promise<Response> {
  const headers = new Headers(call.init.headers ?? call.request?.headers);
  headers.set(DELEGATED_TOKEN_HEADER, propagation.token);
  return guard(propagation.send, { ...call, init: { ...call.init, headers } });
}

// Send a request that carries the token. fetch keeps custom headers across a cross-origin redirect, so the redirects
// are followed here.
function guard(fetch: FetchLike, call: Call): Promise<Response> {
  if ((call.init.redirect ?? call.request?.redirect ?? "follow") !== "follow") {
    return send(fetch, call);
  }
  return follow(fetch, { ...call, init: { ...call.init, redirect: "manual" } });
}

async function follow(fetch: FetchLike, first: Call): Promise<Response> {
  let hop = first;
  for (let hops = 0; ; hops++) {
    const response = await send(fetch, hop);
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || location === null) {
      return response;
    }
    const toGet = becomesGet(response.status, hop.init.method ?? hop.request?.method);
    if (!toGet && !replayable(hop)) {
      return response;
    }
    if (hops === MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new TypeError("redirect count exceeded");
    }
    await response.body?.cancel();
    const next = new URL(location, hop.url).href;
    hop = { url: next, init: redirected(plain(hop), toGet, sameOrigin(first.url, next)) };
  }
}

// The init of a redirect: the options of the caller's `Request`, if any, without its body. A `Request` with a body
// reaches here only when the redirect turns it into a GET.
function plain(call: Call): RequestInit {
  const { request } = call;
  if (!request) {
    return call.init;
  }
  return {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    // Not in the types of Node's fetch, but frameworks such as Next.js read it
    ...({ cache: request.cache } as RequestInit),
    ...call.init,
    body: null,
  };
}

// Fetch standard, HTTP-redirect fetch, step 12
function becomesGet(status: number, method = "GET"): boolean {
  const upper = method.toUpperCase();
  if (status === 303) {
    return upper !== "GET" && upper !== "HEAD";
  }
  return (status === 301 || status === 302) && upper === "POST";
}

function redirected(init: RequestInit, toGet: boolean, keepCredentials: boolean): RequestInit {
  const headers = new Headers(init.headers);
  const drop = [...(keepCredentials ? [] : CREDENTIAL_HEADERS), ...(toGet ? BODY_HEADERS : [])];
  for (const name of drop) {
    headers.delete(name);
  }
  if (!toGet) {
    return { ...init, headers };
  }
  return { ...init, headers, method: "GET", body: null };
}

// The metadata request carries none of the caller's headers, and its body is read up to MAX_BODY
function metadataFetch(send: FetchLike, signal: AbortSignal | null | undefined): MetadataFetch {
  return async (url) => {
    const timeout = AbortSignal.timeout(METADATA_TIMEOUT);
    const response = await send(url, {
      // Uncompressed only, so the size limit holds for the decoded body too
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      await response.body?.cancel();
      throw new Error(`unexpected content encoding ${encoding}`);
    }
    const reader = response.body?.getReader();
    const read = reader ? await readAtMost(reader, MAX_BODY) : { chunks: [], complete: true };
    if (!read.complete) {
      await reader?.cancel();
      throw new Error(`larger than ${String(MAX_BODY)} bytes`);
    }
    return { status: response.status, body: Buffer.concat(read.chunks).toString("utf8") };
  };
}

async function readAtMost(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number): Promise<Read> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { chunks, complete: true };
    }
    chunks.push(value);
    size += value.byteLength;
    if (size > limit) {
      return { chunks, complete: false };
    }
  }
}

// Read up to MAX_BODY bytes of a response within READ_DEADLINE. Return an equivalent response, and whether all of
// the body was read. If not, the response replays what was read and then streams the rest.
async function buffer(response: Response): Promise<{ response: Response; complete: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { response, complete: true };
  }
  let read: Read;
  try {
    read = await withDeadline(readAtMost(reader, MAX_BODY), READ_DEADLINE);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = read.complete ? Buffer.concat(read.chunks) : replay(read.chunks, reader);
  return { response: new Response(body, response), complete: read.complete };
}

function replay(chunks: Uint8Array[], rest: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
    },
    async pull(controller) {
      const { done, value } = await rest.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return rest.cancel(reason);
    },
  });
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DOMException(`response body not read within ${String(ms)} ms`, "TimeoutError"));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
