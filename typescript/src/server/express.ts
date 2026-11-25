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
 * Express middleware that makes the delegated token of each request available to its handlers.
 *
 * @packageDocumentation
 */

import type { Request, RequestHandler } from "express";

import { DELEGATED_TOKEN_HEADER } from "../constants.js";
import { runWithToken, tokenFromHeaders } from "../context.js";

export interface DelegatedTokenOptions {
  /**
   * Remove `X-IK-Token` from the request after reading it, so the handlers reach the token only through
   * `getDelegatedToken()`. Default: `false`.
   */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  stripHeader?: boolean | undefined; // skipcq
}

const HEADER = DELEGATED_TOKEN_HEADER.toLowerCase();

/**
 * Run the rest of each request with its `X-IK-Token` header as the delegated token.
 *
 * Mount it before every other middleware and handler: those mounted before it still see the header.
 *
 * With `stripHeader`, the header is also removed from `req.headers`, `req.headersDistinct` and `req.rawHeaders`.
 * `@a2a-js/sdk`, for example, copies all request headers into the call context of its executors. Do not set it in front
 * of an MCP server whose tools call `tokenFromContext()`: they read the header from the request, so they would see no
 * token.
 */
export function delegatedToken(options: DelegatedTokenOptions = {}): RequestHandler {
  return (req, _res, next) => {
    const token = tokenFromHeaders(req.headers);
    if (options.stripHeader) {
      stripToken(req);
    }
    runWithToken(token, next);
  };
}

/** Remove `X-IK-Token` from the request. Node gives `req.headers` lowercase names, and `rawHeaders` name-value pairs. */
function stripToken(req: Request): void {
  // Node builds `headersDistinct` from `rawHeaders` on first read, up to the original header count. Build it now,
  // before `rawHeaders` gets shorter, or reading it later throws.
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the name is a constant
  delete req.headersDistinct[HEADER];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the name is a constant
  delete req.headers[HEADER];
  // Name-value pairs: drop each matching name and the value after it
  req.rawHeaders = req.rawHeaders.filter((_, i, raw) => raw[i - (i % 2)]?.toLowerCase() !== HEADER);
}
