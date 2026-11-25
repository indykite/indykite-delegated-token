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

import { createHash } from "node:crypto";
import { once } from "node:events";

import { DELEGATED_TOKEN_HEADER } from "../constants.js";
import { getDelegatedToken } from "../context.js";
import {
  challengeLink,
  DEFAULT_REGISTRY,
  type ExtensionRegistry,
  type MetadataFetch,
  sameOrigin,
  secureTransport,
} from "./discovery.js";

export {
  DEFAULT_REGISTRY,
  ExtensionRegistry,
  type ExtensionRegistryOptions,
  type MetadataFetch,
  type MetadataResponse,
  secureTransport,
} from "./discovery.js";

/** The `fetch` signature that the MCP client transports accept. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DelegatedTokenFetchOptions {
  /** The `fetch` to wrap. Default: the global `fetch`. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  fetch?: FetchLike | undefined; // skipcq
  /** Where to remember which targets announce the extension. Default: {@link DEFAULT_REGISTRY}. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  registry?: ExtensionRegistry | undefined; // skipcq
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
  request?: Request;
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
 * also one the caller set, goes only to the origin of the request, never to the origin of a redirect. It only goes to
 * targets that pass {@link secureTransport}, unless the registry has `allowHttp`.
 */
export function delegatedTokenFetch(options: DelegatedTokenFetchOptions = {}): FetchLike {
  const send = options.fetch ?? globalFetch;
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const guarded = redirectGuard(send);
  // skipcq: JS-0116 - async, so an invalid header or URL rejects, as fetch does, instead of throwing
  return async (input, init) => {
    const token = getDelegatedToken();
    if (token === undefined || headersOf(input, init).has(DELEGATED_TOKEN_HEADER)) {
      return guarded(input, init);
    }
    if (!registry.allowHttp && !secureTransport(input instanceof Request ? input.url : input.toString())) {
      // Neither the token nor the metadata that announces it would be protected
      return guarded(input, init);
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
  // skipcq: JS-0116 - async, so an invalid header or URL rejects, as fetch does, instead of throwing
  return async (input, init) => {
    if (!headersOf(input, init).has(DELEGATED_TOKEN_HEADER)) {
      return fetch(input, init);
    }
    return guard(fetch, normalize(input, init));
  };
}

/** The global `fetch`, read at call time so tests and polyfills that replace it apply. */
function globalFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

/** The headers the request will be sent with: those of `init`, or else those of the `Request`. */
function headersOf(input: string | URL | Request, init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

/**
 * The call, with its headers and body copied as `fetch` does, so a change to them after the call does not reach it. A
 * `Request` is copied with the caller's init applied, and sent with the overrides only.
 */
function normalize(input: string | URL | Request, init: RequestInit | undefined): Call {
  if (!(input instanceof Request)) {
    const copy = { ...init, headers: new Headers(init?.headers), body: snapshot(init?.body) };
    return { url: input.toString(), init: copy };
  }
  const request = new Request(input, init);
  return { url: request.url, init: {}, request };
}

/** A copy of a body the caller can change, of the same type so `fetch` sends the same `Content-Type`. */
function snapshot(body: RequestInit["body"]): NonNullable<RequestInit["body"]> | null {
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  if (body instanceof ArrayBuffer) {
    return body.slice(0);
  }
  if (body instanceof URLSearchParams) {
    return new URLSearchParams(body);
  }
  if (!(body instanceof FormData)) {
    // Strings, blobs and streams cannot change
    return body ?? null;
  }
  const copy = new FormData();
  for (const [name, value] of body) {
    copy.append(name, value);
  }
  return copy;
}

/** Send the call with `fetch`. */
function send(fetch: FetchLike, call: Call): Promise<Response> {
  return fetch(call.request ?? call.url, call.init);
}

/** Whether the request can be sent again: its body is not a stream. The body of a `Request` always is. */
function replayable(call: Call): boolean {
  if (call.request) {
    return call.request.body === null;
  }
  const body = call.init.body;
  if (body == null || typeof body === "string" || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
    return true;
  }
  return body instanceof Blob || body instanceof URLSearchParams || body instanceof FormData;
}

/** Send the call, with the token if the target announces, and retry it once with the token after a 401 challenge. */
async function propagate(propagation: Propagation, call: Call): Promise<Response> {
  const { registry } = propagation;
  const signal = call.init.signal ?? call.request?.signal;
  const metadata = metadataFetch(propagation.send);
  if (await untilAborted(registry.discover(call.url, metadata), signal)) {
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
  if (
    !(await readsWhole(response)) ||
    !(await untilAborted(registry.learnFromChallenge(call.url, challenge, metadata), signal))
  ) {
    return response;
  }
  return sendWithToken(propagation, call);
}

/** Send the call with the token, through the redirect guard. */
function sendWithToken(propagation: Propagation, call: Call): Promise<Response> {
  const headers = new Headers(call.init.headers ?? call.request?.headers);
  headers.set(DELEGATED_TOKEN_HEADER, propagation.token);
  return guard(propagation.send, { ...call, init: { ...call.init, headers } });
}

/**
 * Send a request that carries the token. `fetch` keeps custom headers across a cross-origin redirect, so the redirects
 * are followed here.
 *
 * With `manual`, `fetch` would check `integrity` against each redirect, so it is checked here on the final response.
 */
async function guard(fetch: FetchLike, call: Call): Promise<Response> {
  if ((call.init.redirect ?? call.request?.redirect ?? "follow") !== "follow") {
    return send(fetch, call);
  }
  const integrity = call.init.integrity ?? call.request?.integrity ?? "";
  const response = await follow(fetch, { ...call, init: { ...call.init, redirect: "manual", integrity: "" } });
  return integrity ? checkIntegrity(response, integrity) : response;
}

/**
 * `response`, if its body matches `integrity`, as `fetch` checks it (Subresource Integrity): one of the hashes of the
 * strongest known algorithm must match. Metadata without a known algorithm matches any body.
 */
async function checkIntegrity(response: Response, integrity: string): Promise<Response> {
  const hashes = integrity
    .split(/\s+/)
    .map((token) => /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+)/.exec(token))
    .filter((match) => match !== null);
  // The names sort by strength
  const strongest = hashes
    .map(([, algorithm]) => algorithm)
    .sort()
    .at(-1);
  if (strongest === undefined) {
    return response;
  }
  const digest = createHash(strongest)
    .update(new Uint8Array(await response.clone().arrayBuffer()))
    .digest();
  // The hash can be in base64 or base64url, without its padding
  const forms = [digest.toString("base64").replaceAll("=", ""), digest.toString("base64url")];
  if (!hashes.some(([, algorithm, hash]) => algorithm === strongest && forms.some((form) => form === hash))) {
    discard(response.body);
    throw new TypeError("integrity mismatch");
  }
  return response;
}

/** Follow the redirects of the call, at most MAX_REDIRECTS, and drop the credentials on another origin. */
async function follow(fetch: FetchLike, first: Call): Promise<Response> {
  let hop = first;
  for (let hops = 0; ; hops++) {
    const response = await send(fetch, hop);
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || location === null) {
      return markRedirected(response, hops);
    }
    const toGet = becomesGet(response.status, hop.init.method ?? hop.request?.method);
    if (!toGet && !replayable(hop)) {
      return markRedirected(response, hops);
    }
    discard(response.body);
    if (hops === MAX_REDIRECTS) {
      throw new TypeError("redirect count exceeded");
    }
    const next = new URL(location, hop.url).href;
    hop = { url: next, init: redirected(plain(hop), toGet, sameOrigin(first.url, next)) };
  }
}

/**
 * `response`, with `redirected` set after a followed redirect as `fetch` does, also on its clones. Each hop is fetched
 * with `manual`.
 */
function markRedirected(response: Response, hops: number): Response {
  if (hops === 0) {
    return response;
  }
  const clone = response.clone.bind(response);
  return Object.defineProperties(response, {
    redirected: { value: true },
    clone: { value: () => markRedirected(clone(), hops) },
  });
}

/**
 * The init of a redirect: the options of the caller's `Request`, if any, without its body. A `Request` with a body
 * reaches here only when the redirect turns it into a GET.
 */
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

/** Whether the redirect turns the request into a GET (Fetch standard, HTTP-redirect fetch, step 12). */
function becomesGet(status: number, method = "GET"): boolean {
  const upper = method.toUpperCase();
  if (status === 303) {
    return upper !== "GET" && upper !== "HEAD";
  }
  return (status === 301 || status === 302) && upper === "POST";
}

/** The init of the next hop, without the credentials on another origin and without the body for a GET. */
function redirected(init: RequestInit, toGet: boolean, keepCredentials: boolean): RequestInit {
  const headers = new Headers(init.headers);
  const drop = [...(keepCredentials ? [] : CREDENTIAL_HEADERS), ...(toGet ? BODY_HEADERS : [])];
  for (const name of drop) {
    headers.delete(name);
  }
  return toGet ? { ...init, headers, method: "GET", body: null } : { ...init, headers };
}

/**
 * `promise`, or a rejection with the reason of `signal` if it aborts first.
 *
 * Concurrent calls share one metadata fetch, so a caller that aborts stops waiting for it but does not stop it.
 */
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    // Its own rejection, if any, must not be unhandled
    promise.catch(() => undefined);
    signal.throwIfAborted();
  }
  // Removes the abort listener when the wait ends
  const done = new AbortController();
  try {
    await Promise.race([promise, once(signal, "abort", { signal: done.signal })]);
  } finally {
    done.abort();
  }
  signal.throwIfAborted();
  return promise;
}

/**
 * The metadata request carries none of the caller's headers, and its body is read up to MAX_BODY.
 *
 * It is shared by concurrent calls, so it stops only after METADATA_TIMEOUT, not when one caller aborts.
 */
function metadataFetch(send: FetchLike): MetadataFetch {
  return async (url) => {
    const response = await send(url, {
      // Uncompressed only, so the size limit holds for the decoded body too
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      redirect: "manual",
      signal: AbortSignal.timeout(METADATA_TIMEOUT),
    });
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      discard(response.body);
      throw new Error(`unexpected content encoding ${encoding}`);
    }
    const reader = response.body?.getReader();
    const read = reader ? await readAtMost(reader, MAX_BODY) : { chunks: [], complete: true };
    if (!read.complete) {
      discard(reader);
      throw new Error(`larger than ${String(MAX_BODY)} bytes`);
    }
    return { status: response.status, body: Buffer.concat(read.chunks).toString("utf8") };
  };
}

/** Read until the end of the stream, or until more than `limit` bytes are read. */
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

/**
 * Read a copy of the response up to MAX_BODY bytes within READ_DEADLINE, and return whether that was all of it. The
 * response keeps its body, URL and type: the parts read wait in it for the caller.
 */
async function readsWhole(response: Response): Promise<boolean> {
  const reader = response.clone().body?.getReader();
  if (!reader) {
    return true;
  }
  let read: Read;
  try {
    read = await withDeadline(readAtMost(reader, MAX_BODY), READ_DEADLINE);
  } catch (error) {
    discard(reader);
    discard(response.body);
    throw error;
  }
  if (!read.complete) {
    // Stop copying the rest of the body into the copy
    discard(reader);
  }
  return read.complete;
}

/**
 * Cancel a body that is not needed. Not awaited: cancelling a body that `fetch` tee'd waits for the other branch,
 * which may never be read.
 */
function discard(body: { cancel(): Promise<void> } | null | undefined): void {
  body?.cancel().catch(() => undefined);
}

/** Reject with a `TimeoutError` if `promise` does not settle within `ms`. */
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
