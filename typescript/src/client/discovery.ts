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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

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

function cacheable(status: number): boolean {
  return isOk(status) || status === 404;
}

/**
 * Remembers which targets announce the extension, for the life of the process.
 *
 * Answers of the metadata endpoint, 2xx and 404, are cached. Network errors and other statuses are not, so the next
 * call to the target tries again. A target that is known to announce is never downgraded.
 */
export class ExtensionRegistry {
  readonly #announced = new Map<string, boolean>();
  readonly #pending = new Map<string, Promise<boolean>>();

  /** `true` or `false` when the target's answer is cached, `undefined` when it is not known yet. */
  known(target: string): boolean | undefined {
    return this.#announced.get(targetKey(target));
  }

  /** Forget every target. */
  clear(): void {
    this.#announced.clear();
  }

  /**
   * Whether `target` announces the extension, fetching its metadata once.
   *
   * Concurrent first calls for the same target share one fetch.
   */
  async discover(target: string, fetch: MetadataFetch): Promise<boolean> {
    const key = targetKey(target);
    const cached = this.#announced.get(key);
    if (cached !== undefined) {
      return cached;
    }
    return this.#shared(`metadata ${key}`, () => this.#fetch(key, metadataUrl(key), fetch));
  }

  /**
   * Follow the `resource_metadata` link of a 401 and return whether `target` announces now.
   *
   * The link is followed only if {@link challengeLink} accepts it. Concurrent calls with the same link share one
   * fetch.
   */
  async learnFromChallenge(target: string, wwwAuthenticate: string, fetch: MetadataFetch): Promise<boolean> {
    const key = targetKey(target);
    const link = challengeLink(key, wwwAuthenticate);
    const cached = this.#announced.get(key) ?? false;
    if (link === undefined || cached) {
      return cached;
    }
    return this.#shared(`challenge ${key} ${link}`, () => this.#fetch(key, link, fetch));
  }

  // Callers that arrive while a fetch runs take its result. Callers that arrive after it start a new one.
  #shared(key: string, run: () => Promise<boolean>): Promise<boolean> {
    const pending = this.#pending.get(key);
    if (pending) {
      return pending;
    }
    const attempt = run().finally(() => this.#pending.delete(key));
    this.#pending.set(key, attempt);
    return attempt;
  }

  async #fetch(key: string, url: string, fetch: MetadataFetch): Promise<boolean> {
    let response: MetadataResponse;
    try {
      response = await fetch(url);
    } catch (error) {
      log("fetching protected resource metadata %s failed: %s", url, error);
      return false;
    }
    const announced = announces(key, response);
    if (!cacheable(response.status)) {
      log("protected resource metadata %s returned %d", url, response.status);
      return announced;
    }
    // A slower fetch of the well-known URL must not undo what a challenge's link has shown
    this.#announced.set(key, announced || (this.#announced.get(key) ?? false));
    return announced;
  }
}

/** The registry that `delegatedTokenFetch` uses unless it is given one. */
export const DEFAULT_REGISTRY = new ExtensionRegistry();
