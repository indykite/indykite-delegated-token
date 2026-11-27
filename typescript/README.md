# IndyKite delegated token - TypeScript

TypeScript package (ES modules with type definitions) for the delegated token propagation of the IndyKite Agent
Gateway.

> [!WARNING]
> Work in progress, not published to npm yet.

The agent gateway in front of an MCP server or an A2A agent sends the workflow's delegated token in the `X-IK-Token`
header. When that server or agent calls another MCP server or A2A agent through the next gateway, the call must carry
the token too. This package does both halves:

- **server side**: middleware that makes the token of the current request available through `getDelegatedToken()`;
- **client side**: a `fetch` wrapper (MCP) and an interceptor (A2A) that send it on, only to targets that announce the
  delegated token extension.

## Installation

```sh
npm install @indykite/delegated-token
```

Node.js 22+, no dependencies.

| Entry point                             | Contents                                     | Works with                       |
| --------------------------------------- | -------------------------------------------- | -------------------------------- |
| `@indykite/delegated-token`             | `getDelegatedToken()`, `runWithToken()`, ... | -                                |
| `@indykite/delegated-token/express`     | `delegatedToken()` middleware                | Express 4 and 5, `@a2a-js/sdk`   |
| `@indykite/delegated-token/hono`        | `delegatedToken()` middleware                | Hono 4                           |
| `@indykite/delegated-token/mcp-handler` | `withDelegatedToken(handler)`                | Vercel `mcp-handler` 1.x and 2.x |
| `@indykite/delegated-token/fetch`       | `delegatedTokenFetch()`, `redirectGuard()`   | MCP TypeScript SDK 1.x and 2.x   |
| `@indykite/delegated-token/a2a`         | `delegatedTokenClientOptions()`              | `@a2a-js/sdk` 1.3+               |

The middlewares and the `fetch` wrapper import no SDK, so they work with both MCP SDK 1.x (`@modelcontextprotocol/sdk`)
and 2.x (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`).

## Usage

### Server: receive the token

**Express** - mount the middleware before the MCP route:

```ts
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { getDelegatedToken } from "@indykite/delegated-token";
import { delegatedToken } from "@indykite/delegated-token/express";

const app = createMcpExpressApp();
app.use(delegatedToken());
app.post("/mcp", async (req, res) => {
  // a tool of the server can call getDelegatedToken()
});
```

**Hono**:

```ts
import { Hono } from "hono";
import { delegatedToken } from "@indykite/delegated-token/hono";

const app = new Hono();
app.use(delegatedToken());
```

**Vercel `mcp-handler`** - wrap the handler:

```ts
import { createMcpHandler } from "mcp-handler";
import { withDelegatedToken } from "@indykite/delegated-token/mcp-handler";

const handler = withDelegatedToken(
  createMcpHandler((server) => {
    // register tools
  }),
);
export { handler as GET, handler as POST, handler as DELETE };
```

Each MCP message sees the token of the HTTP request that carried it, also in stateful sessions and under concurrency.
A request with more than one `X-IK-Token` value, as several headers or one joined with commas, gets no token: a proxy
may have appended the real one to one the caller forged.

If a framework runs tools outside the async context of their HTTP request, read the token from the tool's second
argument (`extra` in SDK 1.x, `ctx` in SDK 2.x). This is the case for the legacy SSE transport of `mcp-handler` 1.x,
which relays messages through Redis; alternatively set `disableSse: true`.

```ts
import { runWithToken, tokenFromContext } from "@indykite/delegated-token";

server.registerTool("my_tool", { description: "..." }, (ctx) =>
  runWithToken(tokenFromContext(ctx), () => callTargets()),
);
```

### A2A agent: receive the token

An A2A agent built with `@a2a-js/sdk` is an Express app. Mount `delegatedToken()` first, before the SDK handlers, with
`stripHeader: true`:

```ts
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import express from "express";
import { delegatedToken } from "@indykite/delegated-token/express";

const app = express();
app.use(delegatedToken({ stripHeader: true }));
app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: () => Promise.resolve(card) }));
app.use("/rest", restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.use("/", jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
```

The executor reads the token with `getDelegatedToken()`, and the clients below send it on. Each `execute` call sees
the token of the request that sent its message, also for a follow-up message to an existing task, for streaming
requests and with `returnImmediately`. `cancelTask` sees the token of the cancel request. The agent card does not need
to list the extension: the gateway declares it.

`stripHeader: true` removes `X-IK-Token` from `req.headers`, `req.headersDistinct` and `req.rawHeaders`, so the token
is reachable only through `getDelegatedToken()`. `@a2a-js/sdk` copies all request headers into the `ServerCallContext`
of its executors; with the flag, the token is not there, so an executor or a tracer that dumps the context cannot leak
it. The flag is off by default. Do not set it in front of an MCP server whose tools call `tokenFromContext()`: they
read the header from the request, so they would see no token.

The middleware works for JSON-RPC, REST and the v0.3 compat layer. The gateway exposes JSON-RPC only; gRPC is not
supported.

Work that leaves the process, such as a queue, must carry the token itself: read it with `getDelegatedToken()` and
restore it in the worker with `runWithToken(token, fn)`. Tasks the executor starts in the same process keep the token
of their request, also after the response is sent. The token may expire before such work ends; the next gateway then
refuses the call.

> [!WARNING]
> Push notifications with the delegated token are not supported. The SDK's push notification sender uses the global
> `fetch` and sends no token.

### Client: send the token on

**MCP, SDK 1.x and 2.x** - pass the wrapper as the transport's `fetch`:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"; // SDK 2.x
// import { Client } from "@modelcontextprotocol/sdk/client/index.js";                         // SDK 1.x
// import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { delegatedTokenFetch } from "@indykite/delegated-token/fetch";

const client = new Client({ name: "my-server", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(TARGET_MCP_URL), { fetch: delegatedTokenFetch() }));
const result = await client.callTool({ name: "some_tool", arguments: {} });
await client.close();
```

> [!IMPORTANT]
> **Connect MCP clients inside the tool call, and do not share them between requests**, as the
> [sample](examples/sample-mcp-server/server.ts) does. Each request carries the token of the call that sent it, so a
> client connected outside a request sends `initialize` without the token, and a gateway answers it with 401, as the
> MCP authorization spec requires for every request. A client shared between tool calls sends its GET stream and its
> closing DELETE with the token of the call that opened or closed it, also after that call's request has ended.

**A2A** - build the client from the package's options:

```ts
import { ClientFactory } from "@a2a-js/sdk/client";
import { delegatedTokenClientOptions } from "@indykite/delegated-token/a2a";

const client = await new ClientFactory(delegatedTokenClientOptions()).createFromUrl(TARGET_AGENT_URL);
```

`delegatedTokenClientOptions(base?, { fetch?, legacyCompat?, allowHttp? })` adds `DelegatedTokenInterceptor` to `base`
(default: `ClientFactoryOptions.default`). For agents whose card lists
`https://indykite.com/extensions/delegated-token/v1` in `capabilities.extensions`, it sets `X-IK-Token` and adds the
extension to `A2A-Extensions`.

It also replaces the JSON-RPC and REST transports of `base` with ones whose `fetch` is wrapped in `redirectGuard()`,
because plain `fetch` keeps custom headers on a cross-origin redirect. The replaced transports' settings are lost, so
give them here: `fetch` to wrap another `fetch` than the global one, `legacyCompat: { enabled: true }` for v0.3 agents.
If you configure the transports yourself, pass `fetchImpl: redirectGuard()`.

### Which targets get the token

A request carries `X-IK-Token` only when there is a token and the target announces the extension. A token the caller
set itself is never replaced.

- **MCP targets** announce in their OAuth protected resource metadata (RFC 9728): `mcp_extensions` contains
  `com.indykite/delegated-token` and `resource` is the target's URL. Before the first request, the client fetches
  `/.well-known/oauth-protected-resource<path>` on the target's origin, without the caller's headers (10 s timeout;
  answers over 64 KiB or compressed are ignored). An aborted call stops waiting, but the shared fetch goes on.
- **Cache**: per target URL (without fragment), shared by all wrappers; concurrent first calls share one fetch. 2xx and
  404 answers are cached for an hour, so a target that stops announcing stops getting the token. Other statuses, such
  as 401 or 5xx, count as "does not announce" for a minute. Network errors are not cached. At most 1024 targets are
  kept, the least recently used are dropped first. `new ExtensionRegistry({ ttl, errorTtl, maxTargets })` changes
  these (in milliseconds). Wrappers that reach the same URL through different network paths, such as proxies, need
  their own `registry: new ExtensionRegistry()`.
- **401 challenge**: if a target not known to announce answers 401 with
  `WWW-Authenticate: Bearer resource_metadata="…"` on its own origin, the client reads that metadata and retries once
  with the token. The link's answer is cached like the well-known one. Only resendable bodies are retried: none, string, `ArrayBuffer`, typed array, `Blob`,
  `URLSearchParams` or `FormData`, not streams or a `Request` with a body. A 401 body over 64 KiB is returned as is;
  one slower than 30 s fails with a `TimeoutError`.
- **Redirects**: the token, also one the caller set, only goes to the request's origin. The wrapper follows redirects
  itself (at most 20) and drops `X-IK-Token`, `Authorization` and `Cookie` on another origin or on `https` to `http`.
  With `redirect: "manual"` or `"error"` the caller gets the redirect as `fetch` returns it.
- **A2A agents** announce in their agent card, see above.
- **HTTP**: the token only goes over `https`, or over `http` to a loopback host (`localhost`, `127.0.0.0/8`, `::1`).
  Over plain HTTP anyone on the network could read it, or forge the metadata that announces the extension, so no
  metadata is fetched either. For A2A, every interface of the card must pass, except gRPC ones. To send it over plain
  HTTP anyway, for example inside a private network, pass `registry: new ExtensionRegistry({ allowHttp: true })` to
  `delegatedTokenFetch`, and `allowHttp: true` to `delegatedTokenClientOptions`.

Set `NODE_DEBUG=indykite-delegated-token` to log the metadata fetches that fail and the links and tokens that are ignored.

> [!WARNING]
> Announcing the extension does not make a target trustworthy: anyone can announce it, and every target that does
> receives the token. Call only targets that your server's operator configured, such as `TARGET_MCP_URL` in the
> examples, never a URL that comes from the tool's caller or from a model.

### Agent frameworks

Agent frameworks send the token on through `delegatedTokenFetch()`. Two rules apply to all of them:

- **Open the MCP client, toolset or server inside the request**, never at startup, and do not share it between
  requests. The gateway lists tools only for a token, filtered for its user. A client kept across requests would list
  one user's tools for another.
- **Give the wrapper to the MCP client only**, never to the client of the model provider. Do not set `X-IK-Token` as a
  static header: a static header goes to every server, also to those that do not announce the extension.

| Framework                                                 | MCP SDK        | Hook                                                     |
| --------------------------------------------------------- | -------------- | -------------------------------------------------------- |
| Vercel AI SDK 7, `@ai-sdk/mcp` 2                          | its own client | `transport: { type: "http", url, fetch }`                |
| LangChain.js, LangGraph.js: `@langchain/mcp-adapters` 2.x | 2.x            | build the `Client` with `fetch`, then `loadMcpTools`     |
| Mastra 1.85, `@mastra/mcp` 2.10, `MCPClient`              | 2.x            | `servers: { name: { url, fetch } }`                      |
| Mastra server (Hono)                                      | -              | `server: { middleware: delegatedToken() }` from `./hono` |
| OpenAI Agents SDK 0.22, `MCPServerStreamableHttp`         | 2.x            | `new MCPServerStreamableHttp({ url, fetch })`            |
| Google ADK 2.5, `MCPToolset`                              | 1.x            | `transportOptions: { fetch }`                            |

In each case `fetch` is `delegatedTokenFetch()`. Three of them need more than the hook:

**Vercel AI SDK** - tools run in the async context of the `streamText` call, also while the response streams after
the handler returned:

```ts
const mcp = await createMCPClient({ transport: { type: "http", url: TARGET_MCP_URL, fetch: delegatedTokenFetch() } });
const close = () => mcp.close(); // on every way out: `onEnd` does not run on error or abort
try {
  const result = streamText({
    model,
    tools: await mcp.tools(),
    stopWhen: stepCountIs(3),
    prompt,
    onEnd: close,
    onError: close,
    onAbort: close,
  });
  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
} catch (error) {
  await close(); // the stream never started, so none of its callbacks run
  throw error;
}
```

This assumes the default `streamRetries: 0`. With retries, `onError` also runs on an error that gets retried, and the
client would close before the retry.

**LangChain.js / LangGraph.js** - build the MCP client yourself and hand it to `loadMcpTools`:

```ts
const client = new Client({ name: "my-agent", version: "1.0.0" }); // inside the request
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(TARGET_MCP_URL), { fetch: delegatedTokenFetch() }));
  const tools = await loadMcpTools("target", client);
  // run the agent with tools
} finally {
  await client.close();
}
```

`MultiServerMCPClient` cannot carry the token: its connections take no `fetch`, and headers returned by
`beforeToolCall` open and keep one connection per distinct token. Graphs served by the LangGraph server run outside
the HTTP request and are not supported.

**Mastra** - mount the Hono middleware on the Mastra server, then build the `MCPClient` inside the request:

```ts
export const mastra = new Mastra({ agents, server: { middleware: delegatedToken() } });

const mcp = new MCPClient({
  id: randomUUID(),
  servers: { target: { url: new URL(TARGET_MCP_URL), fetch: delegatedTokenFetch() } },
});
try {
  // run the agent with await mcp.listTools()
} finally {
  await mcp.disconnect(); // Mastra keeps every MCPClient, and process listeners for it, until it disconnects
}
```

Mastra skips `server.middleware` on its public routes and on routes registered with `requiresAuth: false`. There the
tools get no token, and the calls fail. Keep auth on for routes that run agents, or wrap the handler in
`runWithToken(tokenFromHeaders(c.req.raw.headers), ...)`.

The Express, Fastify and Koa adapters of Mastra ignore `server.middleware`. With Express, mount `delegatedToken()` of
`./express` on the app. Koa and Fastify need the request wrapped by hand, for example for Koa:

```ts
app.use((ctx, next) => runWithToken(tokenFromHeaders(ctx.headers), next));
```

For work outside the request, such as a background task, keep the token and run the work in
`runWithToken(token, ...)`. Do not put the token in Mastra's `RequestContext`: Mastra may store it in workflow
snapshots and traces.

**xmcp** - export a middleware from `src/middleware.ts` of the app that runs each MCP message with its token, the same
way:

```ts
export const mcp = (ctx, next) => runWithToken(tokenFromHeaders(ctx.http?.headers), next);
```

Do not read the token with xmcp's `headers()`: outside a request it can return the headers of another one. The
package does not test the Koa, Fastify and xmcp snippets.

### Security

- **Reach the server or agent only through its gateway.** It trusts any `X-IK-Token` it receives. The gateway
  overwrites the header, but a caller that reaches the server directly can send any token.
- **Reach other agents and MCP servers only through gateways**, with TLS on every hop. Use network policy to stop
  calls to anything else.
- **Mount the middleware first.** Middleware mounted before it still sees the header.
- **Keep the token out of logs and traces.** `@a2a-js/sdk` keeps the request headers in `ServerCallContext.state`:
  use `stripHeader: true`. It keeps `Authorization` the same way. If you enable OpenTelemetry header capture
  (`OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_*`), leave `X-IK-Token` out of it.

## Examples

[`examples/sample-mcp-server`](examples/sample-mcp-server) is a runnable MCP server (SDK 2.x, Express) whose tools
`call_mcp_tool` and `ask_agent` call an MCP server and an A2A agent through their gateways, like the Python sample.
[`examples/snippets`](examples/snippets) has smaller versions for Hono with SDK 1.x and for `mcp-handler`.

```sh
docker build -f examples/sample-mcp-server/Dockerfile -t indykite-delegated-token-sample .
docker run -p 8000:8000 \
  -e TARGET_MCP_URL=https://gateway.example.com/mcp \
  -e TARGET_AGENT_URL=https://agent-gateway.example.com \
  indykite-delegated-token-sample
```

The server listens on `HOST`:`PORT` (default `0.0.0.0:8000`) and answers `GET /healthz`.

[`examples/sample-a2a-agent`](examples/sample-a2a-agent) is a runnable A2A agent (`@a2a-js/sdk`, MCP SDK 2.x) that
does the same without a model. A message with a data part `{"mcp_tool": "<name>", "arguments": {...}}` calls that tool
on `TARGET_MCP_URL`; any other message is sent as text to the agent at `TARGET_AGENT_URL`. The reply is a completed
task with one text artifact. `PUBLIC_URL` is the agent's URL in its card (default `http://localhost:<PORT>`).
`ALLOW_HTTP=1` sends the token over plain HTTP too, such as to a gateway in a private network.

```sh
docker build -f examples/sample-a2a-agent/Dockerfile -t indykite-delegated-token-sample-agent .
docker run -p 8000:8000 \
  -e PUBLIC_URL=https://sample-agent.internal.example.com \
  -e TARGET_MCP_URL=https://gateway.example.com/mcp \
  -e TARGET_AGENT_URL=https://agent-gateway.example.com \
  indykite-delegated-token-sample-agent
```

To check the chain against real gateways:

1. Deploy the sample agent behind a gateway with a token service, and point `TARGET_MCP_URL` and `TARGET_AGENT_URL`
   at targets behind gateways with a token service.
2. Send a message to the sample agent's gateway with a user token, for example `hi` for the A2A target, or a data part
   `{"mcp_tool": "whoami"}` for an MCP target with such a tool.
3. In the target's logs, or with the gateway's `whoami`, check that the target received `X-IK-Token` with the user,
   the sample agent's gateway and the target's gateway in the chain.

## Development

The tests run against MCP SDK 1.x and 2.x in one install. The framework tests in `test/frameworks` connect each
framework's MCP client to fake MCP servers; for the Vercel AI SDK and the Mastra server they run a full agent with a
scripted model.

```sh
corepack enable                    # use the pnpm version from package.json
pnpm install
pnpm test                          # unit and end-to-end tests
pnpm test:frameworks               # tests with the agent frameworks
pnpm lint && pnpm format:check && pnpm typecheck
pnpm build                         # compile to dist/
```

## License

[Apache-2.0](https://github.com/indykite/indykite-delegated-token/blob/master/LICENSE)
