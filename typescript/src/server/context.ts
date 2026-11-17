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

import { type HeadersLike, tokenFromHeaders } from "../context.js";

/** The parts of an MCP tool's second argument that carry its HTTP request, in SDK v1 and v2. */
export interface ToolContext {
  /** SDK v1: `extra.requestInfo`. */
  requestInfo?: { headers?: HeadersLike } | undefined;
  /** SDK v2: `ctx.http`. */
  http?: { req?: { headers: Headers } | undefined } | undefined;
}

/**
 * Read the delegated token from the HTTP request of an MCP tool call.
 *
 * Pass the tool's second argument: `extra` in SDK v1, `ctx` in SDK v2. Use it with {@link runWithToken} when a
 * framework runs the tool outside the async context of its HTTP request.
 */
export function tokenFromContext(context: ToolContext | null | undefined): string | undefined {
  return tokenFromHeaders(context?.requestInfo?.headers ?? context?.http?.req?.headers);
}
