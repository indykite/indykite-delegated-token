# IndyKite delegated token - TypeScript

TypeScript package for the delegated token propagation of the IndyKite Agent Gateway.
The package contains compiled JavaScript (ES modules) and type definitions, so plain JavaScript projects use it too.

> [!WARNING]
> Work in progress, not published to npm yet.

The agent gateway in front of an MCP server sends the delegated token of the workflow in the `X-IK-Token` header.
When a tool of that server calls another MCP server or an A2A agent through the next gateway, the call must carry the
token too, or the gateway refuses it. This package does both halves:

- **server side**: a middleware makes the token of the request being handled available to its tools, through
  `getDelegatedToken()`;
- **client side**: a `fetch` wrapper for MCP calls and an interceptor for A2A calls send it on, to the targets that
  announce the delegated token extension and to no others.

## Installation

```sh
npm install @indykite/delegated-token
```

Node.js 22+ is required. The package has no dependencies. Each entry point works with the SDK or framework you
already use:

| Entry point                             | Contents                                     | Works with                       |
| --------------------------------------- | -------------------------------------------- | -------------------------------- |
| `@indykite/delegated-token`             | `getDelegatedToken()`, `runWithToken()`, ... | -                                |
| `@indykite/delegated-token/express`     | `delegatedToken()` middleware                | Express 4 and 5                  |
| `@indykite/delegated-token/hono`        | `delegatedToken()` middleware                | Hono 4                           |
| `@indykite/delegated-token/mcp-handler` | `withDelegatedToken(handler)`                | Vercel `mcp-handler` 1.x and 2.x |
| `@indykite/delegated-token/fetch`       | `delegatedTokenFetch()`, `redirectGuard()`   | MCP TypeScript SDK 1.x and 2.x   |
| `@indykite/delegated-token/a2a`         | `delegatedTokenClientOptions()`              | `@a2a-js/sdk` 1.3+               |

The server middlewares and the `fetch` wrapper import no SDK, so the same code works with the MCP TypeScript SDK 1.x
(`@modelcontextprotocol/sdk`) and 2.x (`@modelcontextprotocol/server` and `@modelcontextprotocol/client`).

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

The token is the one of the HTTP request that carries each MCP message, also in stateful sessions. Two concurrent
requests always see their own tokens. The Express and Hono middlewares work for A2A agents too.

A framework that runs a tool outside the async context of its HTTP request can read the token from the tool's
second argument (`extra` in SDK 1.x, `ctx` in SDK 2.x):

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
```

Each request goes out with the token of the call that made it, so a client opened once, outside any request, is fine
with both SDK versions.

**A2A** - build the client from the package's options:

```ts
import { ClientFactory } from "@a2a-js/sdk/client";
import { delegatedTokenClientOptions } from "@indykite/delegated-token/a2a";

const client = await new ClientFactory(delegatedTokenClientOptions()).createFromUrl(TARGET_AGENT_URL);
```

`delegatedTokenClientOptions(base?, fetch?)` adds `DelegatedTokenInterceptor` to `base` (default:
`ClientFactoryOptions.default`). For an agent whose card lists the extension
`https://indykite.com/extensions/delegated-token/v1` in `capabilities.extensions`, the interceptor sets `X-IK-Token`
and adds the extension to `A2A-Extensions`. Other agents get neither.

The A2A HTTP transports send these headers with `fetch`, which keeps them across a redirect to another origin. So the
options also replace the JSON-RPC and REST transports of `base` with ones whose `fetch` is wrapped in
`redirectGuard()`, which follows the redirects of a request that carries the token and drops the token on another
origin. If you configure the transports yourself, pass `fetchImpl: redirectGuard()` to them.

### Which targets get the token

A request carries `X-IK-Token` only when there is a token and the target announced the extension:

- **MCP targets** announce in their OAuth protected resource metadata (RFC 9728): `mcp_extensions` contains
  `com.indykite/delegated-token`, and `resource` is the target's URL. Before the first request to a target, the
  client fetches `/.well-known/oauth-protected-resource<path>` on the target's origin, without any of the caller's
  headers. The fetch stops after 10 seconds, or earlier when the caller's signal aborts. An answer larger than
  64 KiB, or a compressed one, does not count.
- The answer is cached per target (scheme, host, port, path and query) for the life of the process; concurrent first
  calls share one fetch. A 404 is cached as "does not announce". Network errors and other statuses are not cached,
  and the calls that shared that fetch go out without the token.
- When a target that is not known to announce answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, the
  client follows the link, only if it is on the target's origin, and retries the request once with the token if the
  target announces. Only a request whose body can be sent again is retried: no body, a string, a `Uint8Array` or
  `URLSearchParams`. A `Request` object with a body is not retried, because its body is a stream. A 401 whose body is larger than 64 KiB is returned as it is, without following the link; one
  whose body takes more than 30 seconds to arrive fails the call with a `TimeoutError`.
- **A2A agents** announce in their agent card, see above.
- A token the caller set itself is never replaced.
- The token, also one the caller set, only goes to the origin of the request. `fetch` keeps custom headers across a
  cross-origin redirect, so for a request that carries the token, the wrapper follows the redirects itself (at most 20): a redirect to another
  origin, or from `https` to `http`, gets neither the token nor `Authorization` and `Cookie`. A caller that sets
  `redirect: "manual"` or `"error"` gets the redirect as `fetch` returns it.
- The cache is shared by every wrapper of the process. Wrappers that reach the same URL through different network
  paths, such as different proxies, must not share it: pass each its own `registry: new ExtensionRegistry()`.

Set `NODE_DEBUG=indykite-delegated-token` to log the metadata fetches that fail and the links that are ignored.

> [!WARNING]
> Announcing the extension does not make a target trustworthy: anyone can announce it, and every target that does
> receives the token. Call only targets that your server's operator configured, such as `TARGET_MCP_URL` in the
> examples, never a URL that comes from the tool's caller or from a model.

## Example

[`examples/sample-mcp-server`](examples/sample-mcp-server) is a runnable MCP server (SDK 2.x with Express) with two
tools, `call_mcp_tool` and `ask_agent`, which call an MCP server and an A2A agent through their gateways. It has the
same interface as the Python sample. Smaller versions for Hono with SDK 1.x and for `mcp-handler` are in
[`examples/snippets`](examples/snippets).

```sh
docker build -f examples/sample-mcp-server/Dockerfile -t indykite-delegated-token-sample .
docker run -p 8000:8000 \
  -e TARGET_MCP_URL=https://gateway.example.com/mcp \
  -e TARGET_AGENT_URL=https://agent-gateway.example.com \
  indykite-delegated-token-sample
```

The server listens on `HOST`:`PORT` (default `0.0.0.0:8000`) and answers `GET /healthz`.

## Development

The MCP SDK 1.x and 2.x have different package names, so the tests run against both in one install.

```sh
corepack enable                    # use the pnpm version from package.json
pnpm install
pnpm test                          # unit and end-to-end tests
pnpm lint && pnpm format:check && pnpm typecheck
pnpm build                         # compile to dist/
```

## License

[Apache-2.0](https://github.com/indykite/indykite-delegated-token/blob/master/LICENSE)
