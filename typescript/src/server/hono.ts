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
 * Hono middleware that makes the delegated token of each request available to its handlers.
 *
 * @packageDocumentation
 */

import type { MiddlewareHandler } from "hono";

import { runWithToken, tokenFromHeaders } from "../context.js";

/** Run the rest of each request with its `X-IK-Token` header as the delegated token. */
export function delegatedToken(): MiddlewareHandler {
  return (c, next) => runWithToken(tokenFromHeaders(c.req.raw.headers), next);
}
