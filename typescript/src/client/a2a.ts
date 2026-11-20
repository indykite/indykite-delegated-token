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
 * Client interceptor that sends the delegated token to the A2A agents that announce the extension.
 *
 * @packageDocumentation
 */

import { type AgentCard, Extensions } from "@a2a-js/sdk";
import {
  type BeforeArgs,
  type CallInterceptor,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  RestTransportFactory,
  ServiceParameters,
  type ServiceParametersUpdate,
  withA2AExtensions,
} from "@a2a-js/sdk/client";

import { A2A_EXTENSION_URI, A2A_EXTENSIONS_HEADER, DELEGATED_TOKEN_HEADER } from "../constants.js";
import { getDelegatedToken } from "../context.js";
import { type FetchLike, redirectGuard } from "./fetch.js";

/** Whether the agent card lists the delegated token extension in `capabilities.extensions`. */
export function announcesExtension(card: AgentCard | null | undefined): boolean {
  return card?.capabilities?.extensions.some((extension) => extension.uri === A2A_EXTENSION_URI) ?? false;
}

// Service parameters become HTTP headers, whose names ignore case: the values of `name` in every case, joined as
// `Headers` joins them
function parameter(parameters: ServiceParameters | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const values = Object.entries(parameters ?? {}).filter(([key]) => key.toLowerCase() === wanted);
  return values.length === 0 ? undefined : values.map(([, value]) => value).join(",");
}

// The parameters without `name` in any case, so a new value does not become a second header of the same name
function without(parameters: ServiceParameters | undefined, name: string): ServiceParameters {
  const wanted = name.toLowerCase();
  return Object.fromEntries(Object.entries(parameters ?? {}).filter(([key]) => key.toLowerCase() !== wanted));
}

/**
 * Adds `X-IK-Token`, and the extension URI to `A2A-Extensions`, to calls to agents that announce the extension.
 *
 * It works with every A2A transport, because it sets service parameters, not HTTP headers. Calls without a delegated
 * token, and calls to agents whose card does not list the extension, are left unchanged. A token the caller already
 * set is kept.
 *
 * The A2A transports send the token with `fetch`, which keeps it across a redirect to another origin. Use
 * {@link delegatedTokenClientOptions}, which also guards the transports, rather than this interceptor alone.
 */
export class DelegatedTokenInterceptor implements CallInterceptor {
  /** Add the token and the extension to the call's service parameters. */
  // skipcq: JS-0105 - implements CallInterceptor.before
  before(args: BeforeArgs): Promise<void> {
    const token = getDelegatedToken();
    if (token === undefined || !announcesExtension(args.agentCard)) {
      return Promise.resolve();
    }
    const current = args.options?.serviceParameters;
    const extensions = Extensions.parseServiceParameter(parameter(current, A2A_EXTENSIONS_HEADER));
    const updates: ServiceParametersUpdate[] = [
      withA2AExtensions(...Extensions.createFrom(extensions, A2A_EXTENSION_URI)),
    ];
    if (parameter(current, DELEGATED_TOKEN_HEADER) === undefined) {
      updates.push((parameters) => {
        parameters[DELEGATED_TOKEN_HEADER] = token;
      });
    }
    // A copy, never the caller's options: options reused for a later call would keep this call's token
    args.options = {
      ...args.options,
      serviceParameters: ServiceParameters.createFrom(without(current, A2A_EXTENSIONS_HEADER), ...updates),
    };
    return Promise.resolve();
  }

  /** Do nothing: the interceptor only changes requests. */
  // skipcq: JS-0105 - implements CallInterceptor.after
  after(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * `ClientFactory` options that send the delegated token to the agents that announce the extension.
 *
 * They add {@link DelegatedTokenInterceptor}, and replace the JSON-RPC and REST transports of `base` with ones whose
 * `fetch` never sends the token to the origin of a redirect. Pass `fetch` to wrap another `fetch` than the global one.
 */
export function delegatedTokenClientOptions(
  base: ClientFactoryOptions = ClientFactoryOptions.default,
  fetch?: FetchLike,
): ClientFactoryOptions {
  const fetchImpl = redirectGuard(fetch);
  return ClientFactoryOptions.createFrom(base, {
    transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
    clientConfig: { interceptors: [new DelegatedTokenInterceptor()] },
  });
}
