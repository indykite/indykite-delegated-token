# IndyKite delegated token - TypeScript

TypeScript package (ES modules with type definitions) for the delegated token propagation of the IndyKite Agent
Gateway.

> [!WARNING]
> Work in progress, not published to npm yet.

The agent gateway in front of an MCP server sends the workflow's delegated token in the `X-IK-Token` header. When a
tool calls another MCP server or A2A agent through the next gateway, the call must carry the token too. This package
does both halves:

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
| `@indykite/delegated-token/express`     | `delegatedToken()` middleware                | Express 4 and 5                  |
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
The Express and Hono middlewares work for A2A agents too.

If a framework runs tools outside the async context of their HTTP request, read the token from the tool's second
argument (`extra` in SDK 1.x, `ctx` in SDK 2.x). This is the case for the legacy SSE transport of `mcp-handler` 1.x,
which relays messages through Redis; alternatively set `disableSse: true`.

```ts
import { runWithToken, tokenFromContext } from "@indykite/delegated-token";

server.registerTool("my_tool", { description: "..." }, (ctx) =>
  runWithToken(tokenFromContext(ctx), () => callTargets()),
);
```

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

## Example

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

## Development

The tests run against MCP SDK 1.x and 2.x in one install.

```sh
corepack enable                    # use the pnpm version from package.json
pnpm install
pnpm test                          # unit and end-to-end tests
pnpm lint && pnpm format:check && pnpm typecheck
pnpm build                         # compile to dist/
```

## License

[Apache-2.0](https://github.com/indykite/indykite-delegated-token/blob/master/LICENSE)
