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
 * Discovery of the targets that announce the delegated token extension.
 *
 * A target is an MCP endpoint. It announces the extension in its OAuth protected resource metadata (RFC 9728):
 * `mcp_extensions` contains {@link MCP_EXTENSION_ID} and `resource` is the target itself.
 */

import { debuglog } from "node:util";

import { MCP_EXTENSION_ID } from "../constants.js";

const log = debuglog("indykite-delegated-token");

export const WELL_KNOWN_PATH = "/.well-known/oauth-protected-resource";

/** Status and body of a metadata answer. */
export interface MetadataResponse {
  status: number;
  body: string;
}

/** Fetch a URL with a plain GET. Reject on a network error. */
export type MetadataFetch = (url: string) => Promise<MetadataResponse>;

const RESOURCE_METADATA = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i;

/** Scheme, host and port of `url`. */
function origin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Scheme, host, port, path and query of `url`, without fragment and credentials.
 *
 * The query is kept: RFC 9728 identifies a protected resource by its whole URL.
 */
export function targetKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
}

/** Whether `a` and `b` have the same scheme, host and port. A URL that cannot be parsed has no origin. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return origin(a) === origin(b);
  } catch {
    return false;
  }
}

// `URL` gives IPv4 hosts in dotted form and IPv6 hosts compressed, in brackets
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/**
 * Whether `url` is `https`, or `http` to a loopback host.
 *
 * Over plain HTTP to another host, anyone on the network could read the token, or forge the metadata that announces
 * the extension.
 */
export function secureTransport(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.test(parsed.hostname));
}

/**
 * The RFC 9728 metadata URL of `target`: the well-known path goes between its host and its path.
 *
 * Only a path of `/` is dropped (RFC 9728 section 3.1). Any other path is kept as is.
 */
export function metadataUrl(target: string): string {
  const parsed = new URL(targetKey(target));
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${WELL_KNOWN_PATH}${path}${parsed.search}`;
}

/** The `resource_metadata` parameter of a `WWW-Authenticate` header, if any. */
export function resourceMetadataLink(wwwAuthenticate: string): string | undefined {
  const match = RESOURCE_METADATA.exec(wwwAuthenticate);
  const link = match?.[1] ?? match?.[2];
  if (!link) {
    return undefined;
  }
  return link;
}

/**
 * The `resource_metadata` link of a 401's `WWW-Authenticate`, if it can be followed for `target`.
 *
 * It can only if it is on the target's origin, so a target cannot make the client fetch another host, or announce
 * for one.
 */
export function challengeLink(target: string, wwwAuthenticate: string): string | undefined {
  const link = resourceMetadataLink(wwwAuthenticate);
  if (link === undefined) {
    return undefined;
  }
  if (!sameOrigin(link, target)) {
    log("ignoring resource_metadata link %s of %s, not on its origin", link, target);
    return undefined;
  }
  return link;
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON value of `body`, or `undefined` if it is not JSON. */
function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Whether `status` is 2xx. */
function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Whether the metadata response announces the extension for `target`. */
function announces(target: string, response: MetadataResponse): boolean {
  if (!isOk(response.status)) {
    return false;
  }
  const metadata = parse(response.body);
  if (!isRecord(metadata) || !isRecord(metadata.mcp_extensions)) {
    return false;
  }
  if (!(MCP_EXTENSION_ID in metadata.mcp_extensions) || typeof metadata.resource !== "string") {
    return false;
  }
  // RFC 9728 section 3.3: the metadata only counts for the resource it names
  try {
    return targetKey(metadata.resource) === targetKey(target);
  } catch {
    return false;
  }
}

/** Whether a metadata answer with `status` is cached for `ttl`: 2xx and 404. Other statuses last `errorTtl`. */
function lasting(status: number): boolean {
  return isOk(status) || status === 404;
}

export interface ExtensionRegistryOptions {
  /** Milliseconds that a 2xx or 404 answer is cached. Default: one hour. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  ttl?: number | undefined; // skipcq
  /** Milliseconds that another status, such as 401 or 5xx, counts as not announced. Default: one minute. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  errorTtl?: number | undefined; // skipcq
  /** The most targets kept. The least recently used are dropped first. Default: 1024. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  maxTargets?: number | undefined; // skipcq
  /** Send the token over plain HTTP to any host, such as inside a private network. Default: `false`. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  allowHttp?: boolean | undefined; // skipcq
}

interface Entry {
  announced: boolean;
  /** When the entry expires, on the clock of `performance.now()`. */
  expires: number;
}

/**
 * Remembers which targets announce the extension, and to which the token may go.
 *
 * Answers of the metadata endpoint, 2xx and 404, are cached for `ttl`. Other statuses count as not announced for
 * `errorTtl`. Network errors are not cached, so the next call to the target tries again. While its entry lasts, a
 * target known to announce is not downgraded. The `maxTargets` most recently used targets are kept. The token only
 * goes to targets that pass {@link secureTransport}, unless `allowHttp`.
 */
export class ExtensionRegistry {
  /** Whether the token may go over plain HTTP to any host. */
  readonly allowHttp: boolean;
  readonly #ttl: number;
  readonly #errorTtl: number;
  readonly #maxTargets: number;
  // Target key, or target key and challenge link, to its answer, least recently used first
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<boolean>>();
  // Changes on clear(), so a fetch that started before it does not fill the cache
  #generation = 0;

  constructor(options: ExtensionRegistryOptions = {}) {
    this.allowHttp = options.allowHttp ?? false;
    this.#ttl = options.ttl ?? 3_600_000;
    this.#errorTtl = options.errorTtl ?? 60_000;
    this.#maxTargets = options.maxTargets ?? 1024;
  }

  /** `true` or `false` when the target's answer is cached, `undefined` when it is not known yet. */
  known(target: string): boolean | undefined {
    return this.#get(targetKey(target));
  }

  /** Forget every target, and the answers of the fetches that are running. */
  clear(): void {
    this.#generation++;
    this.#entries.clear();
    this.#pending.clear();
  }

  /**
   * Whether `target` announces the extension, fetching its metadata once.
   *
   * Concurrent first calls for the same target share one fetch.
   */
  // skipcq: JS-0116 - async, so an invalid URL rejects instead of throwing
  async discover(target: string, fetch: MetadataFetch): Promise<boolean> {
    const key = targetKey(target);
    const cached = this.#get(key);
    if (cached !== undefined) {
      return cached;
    }
    return this.#shared(`metadata ${key}`, () => this.#fetch(key, metadataUrl(key), fetch));
  }

  /**
   * Follow the `resource_metadata` link of a 401 and return whether `target` announces now.
   *
   * The link is followed only if {@link challengeLink} accepts it. Concurrent calls with the same link share one
   * fetch. Its answer is cached like that of the well-known URL, so a target that keeps answering 401 does not make
   * every call follow the link again.
   */
  // skipcq: JS-0116 - async, so an invalid URL rejects instead of throwing
  async learnFromChallenge(target: string, wwwAuthenticate: string, fetch: MetadataFetch): Promise<boolean> {
    const key = targetKey(target);
    const link = challengeLink(key, wwwAuthenticate);
    if (this.#get(key)) {
      return true;
    }
    if (link === undefined) {
      return false;
    }
    // Target keys have no spaces
    const linkKey = `${key} ${link}`;
    const followed = this.#get(linkKey);
    if (followed !== undefined) {
      return followed;
    }
    return this.#shared(`challenge ${linkKey}`, () => this.#fetch(key, link, fetch, linkKey));
  }

  /** The cached answer for `key`, which becomes the most recently used. */
  #get(key: string): boolean | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.#entries.delete(key);
    if (performance.now() >= entry.expires) {
      return undefined;
    }
    // The map keeps insertion order: the entry moves to the end, as the most recently used
    this.#entries.set(key, entry);
    return entry.announced;
  }

  /** Cache the answer for `key`, and drop the least recently used entries beyond `maxTargets`. */
  #set(key: string, announced: boolean, ttl: number): void {
    // A slower fetch of the well-known URL must not undo what a challenge's link has shown
    if (!announced && this.#get(key)) {
      return;
    }
    this.#entries.delete(key);
    this.#entries.set(key, { announced, expires: performance.now() + ttl });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxTargets) {
        return;
      }
      this.#entries.delete(oldest);
    }
  }

  // Callers that arrive while a fetch runs take its result. Callers that arrive after it start a new one.
  #shared(key: string, run: () => Promise<boolean>): Promise<boolean> {
    const pending = this.#pending.get(key);
    if (pending) {
      return pending;
    }
    const attempt = run().finally(() => {
      // After clear(), the key can belong to a newer attempt
      if (this.#pending.get(key) === attempt) {
        this.#pending.delete(key);
      }
    });
    this.#pending.set(key, attempt);
    return attempt;
  }

  /** Fetch the metadata at `url`, cache under `key` and `also` whether it announces for `key`, and return that. */
  async #fetch(key: string, url: string, fetch: MetadataFetch, ...also: string[]): Promise<boolean> {
    const generation = this.#generation;
    let response: MetadataResponse;
    try {
      response = await fetch(url);
    } catch (error) {
      log("fetching protected resource metadata %s failed: %s", url, error);
      return false;
    }
    const announced = announces(key, response);
    const lasts = lasting(response.status);
    if (!lasts) {
      log("protected resource metadata %s returned %d", url, response.status);
    }
    if (generation !== this.#generation) {
      return announced;
    }
    for (const entry of [key, ...also]) {
      this.#set(entry, announced, lasts ? this.#ttl : this.#errorTtl);
    }
    return announced;
  }
}

/** The registry that `delegatedTokenFetch` uses unless it is given one. */
export const DEFAULT_REGISTRY = new ExtensionRegistry();
