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
import { secureTransport } from "./discovery.js";
import { type FetchLike, redirectGuard } from "./fetch.js";

export interface DelegatedTokenInterceptorOptions {
  /** Send the token over plain HTTP to any host, such as inside a private network. Default: `false`. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  allowHttp?: boolean | undefined; // skipcq
}

export interface DelegatedTokenA2AOptions extends DelegatedTokenInterceptorOptions {
  /** The `fetch` that the transports wrap. Default: the global `fetch`. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  fetch?: FetchLike | undefined; // skipcq
  /** The v0.3 compatibility setting of the JSON-RPC and REST transports. Default: disabled. */
  // `exactOptionalPropertyTypes`: callers can pass `undefined`
  legacyCompat?: { enabled: boolean } | undefined; // skipcq
}

const GRPC_BINDING = "GRPC";

/** Whether the agent card lists the delegated token extension in `capabilities.extensions`. */
export function announcesExtension(card: AgentCard | null | undefined): boolean {
  // The SDK uses the card as served, and proto3 JSON leaves out an empty `extensions`
  const extensions = card?.capabilities?.extensions;
  return extensions?.some((extension) => extension.uri === A2A_EXTENSION_URI) ?? false;
}

/**
 * Whether every interface of the agent card passes {@link secureTransport}.
 *
 * gRPC interfaces are left out: their targets are `host:port`, not URLs, and over gRPC the token is as safe as the
 * channel's credentials.
 */
function servedSecurely(card: AgentCard): boolean {
  // Proto3 JSON leaves out an empty `supportedInterfaces` too
  const interfaces = (card.supportedInterfaces as AgentCard["supportedInterfaces"] | undefined) ?? [];
  return interfaces.every(({ url, protocolBinding }) => protocolBinding === GRPC_BINDING || secureTransport(url));
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
 * set is kept. The token only goes to agents whose interfaces all pass {@link secureTransport}, unless `allowHttp`.
 *
 * The A2A transports send the token with `fetch`, which keeps it across a redirect to another origin. Use
 * {@link delegatedTokenClientOptions}, which also guards the transports, rather than this interceptor alone.
 */
export class DelegatedTokenInterceptor implements CallInterceptor {
  readonly #allowHttp: boolean;

  constructor(options: DelegatedTokenInterceptorOptions = {}) {
    this.#allowHttp = options.allowHttp ?? false;
  }

  /** Add the token and the extension to the call's service parameters. */
  before(args: BeforeArgs): Promise<void> {
    const token = getDelegatedToken();
    const secure = this.#allowHttp || servedSecurely(args.agentCard);
    if (token === undefined || !secure || !announcesExtension(args.agentCard)) {
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
 * `fetch` never sends the token to the origin of a redirect. The settings of the replaced transports are lost: give
 * them in `options`.
 */
export function delegatedTokenClientOptions(
  base: ClientFactoryOptions = ClientFactoryOptions.default,
  options: DelegatedTokenA2AOptions = {},
): ClientFactoryOptions {
  const fetchImpl = redirectGuard(options.fetch);
  const { legacyCompat } = options;
  const transport = legacyCompat ? { fetchImpl, legacyCompat } : { fetchImpl };
  return ClientFactoryOptions.createFrom(base, {
    transports: [new JsonRpcTransportFactory(transport), new RestTransportFactory(transport)],
    clientConfig: { interceptors: [new DelegatedTokenInterceptor({ allowHttp: options.allowHttp })] },
  });
}
