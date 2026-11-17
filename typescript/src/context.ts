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

import { AsyncLocalStorage } from "node:async_hooks";
import { debuglog } from "node:util";

import { DELEGATED_TOKEN_HEADER } from "./constants.js";

/** Web `Headers`, Node `IncomingHttpHeaders`, or a plain record of header values. */
export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

const log = debuglog("indykite-delegated-token");

const storage = new AsyncLocalStorage<string | undefined>();

const HEADER = DELEGATED_TOKEN_HEADER.toLowerCase();

/** `value`, or `undefined` if it is empty. */
function nonEmpty(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value;
}

/** Return the delegated token of the request being handled, or `undefined` outside a request. */
export function getDelegatedToken(): string | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with `token` as the delegated token, and return its result.
 *
 * The token is visible to everything `fn` starts, including async work. An empty string counts as no token.
 */
export function runWithToken<R>(token: string | null | undefined, fn: () => R): R {
  return storage.run(nonEmpty(token), fn);
}

/** Whether `headers` is a `Headers` object, not a plain record. */
function isHeaders(headers: HeadersLike): headers is Headers {
  return typeof headers.get === "function";
}

/** All values of the header, joined with commas, or `null` if it is missing. */
function headerValue(headers: HeadersLike): string | null {
  if (isHeaders(headers)) {
    return headers.get(HEADER);
  }
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === HEADER)
    .flatMap(([, value]) => value ?? [])
    .join(",");
}

/**
 * Read the delegated token from request headers, ignoring case. Return `undefined` if it is missing or empty.
 *
 * A header with several values, as several headers or one joined with commas, gives no token: a proxy may have
 * appended the real token to one the caller forged.
 */
export function tokenFromHeaders(headers: HeadersLike | null | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }
  const value = headerValue(headers);
  if (value?.includes(",")) {
    log("ignoring the %s header, which has several values", DELEGATED_TOKEN_HEADER);
    return undefined;
  }
  return nonEmpty(value);
}
