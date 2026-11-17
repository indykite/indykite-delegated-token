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
 * Wrapper for web request handlers, such as the ones of Vercel `mcp-handler`.
 *
 * @packageDocumentation
 */

import { runWithToken, tokenFromHeaders } from "../context.js";

/**
 * Wrap a `(Request) => Response` handler, so each request runs with its `X-IK-Token` header as the delegated token.
 *
 * Extra arguments, such as the route context of Next.js, are passed on to the handler.
 */
export function withDelegatedToken<A extends unknown[], R>(
  handler: (req: Request, ...rest: A) => R,
): (req: Request, ...rest: A) => R {
  return (req, ...rest) => runWithToken(tokenFromHeaders(req.headers), () => handler(req, ...rest));
}
