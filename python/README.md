# IndyKite delegated token - Python

Python package for the delegated token propagation of the IndyKite Agent Gateway.

> [!WARNING]
> Work in progress, not published to PyPI yet.

The agent gateway in front of an MCP server sends the delegated token of the workflow in the `X-IK-Token` header.
When a tool of that server calls another MCP server or an A2A agent through the next gateway, the call must carry the
token too, or the gateway refuses it. This package does both halves:

- **server side**: `install(server)` makes the token of the request being handled available to its tools, through
  `get_delegated_token()`;
- **client side**: an HTTP client for MCP calls and an interceptor for A2A calls send it on, to the targets that
  announce the delegated token extension and to no others.

## Installation

```sh
pip install "indykite-delegated-token[mcp,a2a]"     # MCP Python SDK 2.x and A2A
pip install "indykite-delegated-token[fastmcp,a2a]" # FastMCP 4 and A2A
pip install "indykite-delegated-token[mcp1,a2a]"    # MCP Python SDK 1.x and A2A
```

Python 3.11+ is required. The package itself has no dependencies; each extra adds the SDK it adapts.

## Usage

### Server: receive the token

Call `install(server)` once, after creating the server. It accepts:

| Server                                                         | Package     |
| -------------------------------------------------------------- | ----------- |
| `mcp.server.mcpserver.MCPServer`, `mcp.server.lowlevel.Server` | `mcp` 2.x   |
| `fastmcp.FastMCP`                                              | `fastmcp` 4 |
| `mcp.server.fastmcp.FastMCP`, `mcp.server.lowlevel.Server`     | `mcp` 1.x   |

```python
from mcp.server.mcpserver import MCPServer

from indykite_delegated_token import get_delegated_token, install

server = MCPServer("my-server")
install(server)


@server.tool()
async def whoami() -> str:
    return "token received" if get_delegated_token() else "no token"
```

The token is read from the HTTP request of each MCP message, also in stateful sessions, whose messages are not
handled within their own HTTP request. Two concurrent requests always see their own tokens.

For other ASGI apps, such as A2A agents built with a2a-sdk, wrap the app in the ASGI middleware:

```python
from indykite_delegated_token.server.asgi import DelegatedTokenASGIMiddleware

app = DelegatedTokenASGIMiddleware(app)
```

### Client: send the token on

**MCP, SDK 2.x** - pass the package's `httpx2` client to `streamable_http_client`:

```python
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

from indykite_delegated_token.client.httpx2 import http_client


@server.tool()
async def call_target() -> str:
    async with (
        http_client() as client,
        streamable_http_client(TARGET_MCP_URL, http_client=client) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        result = await session.call_tool("some_tool", {})
    ...
```

**MCP, FastMCP 4** - pass the factory to `StreamableHttpTransport`:

```python
from fastmcp.client.transports import StreamableHttpTransport

from indykite_delegated_token.client.httpx2 import httpx_client_factory

transport = StreamableHttpTransport(TARGET_MCP_URL, httpx_client_factory=httpx_client_factory)
```

**MCP, SDK 1.x** - pass the package's `httpx` client to `streamable_http_client`, which yields three values in
SDK 1.x. See the caveat below.

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from indykite_delegated_token.client.httpx import http_client


@server.tool()
async def call_target() -> str:
    async with (
        http_client() as client,
        streamable_http_client(TARGET_MCP_URL, http_client=client) as (read, write, _),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        result = await session.call_tool("some_tool", {})
    ...
```

**A2A** - add the interceptor to the client:

```python
from a2a.client import ClientFactory

from indykite_delegated_token.client.a2a import DelegatedTokenInterceptor

client = ClientFactory(config).create(card, interceptors=[DelegatedTokenInterceptor()])
```

The interceptor works with every A2A transport. For an agent whose card lists the extension
`https://indykite.com/extensions/delegated-token/v1` in `capabilities.extensions`, it sets `X-IK-Token` and adds the
extension to `A2A-Extensions`. Other agents get neither.

> [!IMPORTANT]
> **MCP SDK 1.x clients must be opened inside the tool call.** The 1.x client sends its requests from a task started
> when it connects, so a client opened earlier, for example at startup, keeps the token it had then, usually none.
> The 2.x client sends each request with the token of the call that made it, so a long-lived 2.x client is fine.

### Which targets get the token

A request carries `X-IK-Token` only when there is a token and the target announced the extension:

- **MCP targets** announce in their OAuth protected resource metadata (RFC 9728): `mcp_extensions` contains
  `com.indykite/delegated-token`, and `resource` is the target's URL. Before the first request to a target, the
  client fetches `/.well-known/oauth-protected-resource<path>` on the target's origin, without any credentials, with
  the client's timeouts, or 10 seconds for those it leaves unset, and 30 seconds in all. An answer larger than
  64 KiB does not count.
- The answer is cached per target (scheme, host, port, path and query) for the life of the process; concurrent first
  calls share one fetch. A 404 is cached as "does not announce". Network errors and other statuses are not cached,
  and the calls that shared that fetch go out without the token.
- When a target that is not known to announce answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, the
  client follows the link, only if it is on the target's origin, and retries the request once with the token if the
  target announces. A 401 whose body is larger than 64 KiB is returned as it is, without following the link; one
  whose body takes more than 30 seconds to arrive fails the call with a read timeout.
- **A2A agents** announce in their agent card, see above.
- A token the caller set itself is never replaced.
- When the client follows redirects, the token only goes to the origin of the first request: a redirect to another
  origin, or from `https` to `http`, never gets it, even if its target announces.
- The cache is shared by every client of the process. Clients that reach the same URL through different network
  paths, such as different proxies, must not share it: pass each its own `registry=ExtensionRegistry()`.

> [!WARNING]
> Announcing the extension does not make a target trustworthy: anyone can announce it, and every target that does
> receives the token. Call only targets that your server's operator configured, such as `TARGET_MCP_URL` in the
> examples, never a URL that comes from the tool's caller or from a model.

## Example

[`examples/sample_mcp_server`](examples/sample_mcp_server) is a runnable MCP server (SDK 2.x) with two tools,
`call_mcp_tool` and `ask_agent`, which call an MCP server and an A2A agent through their gateways. Smaller versions
for FastMCP 4 and SDK 1.x are in [`examples/snippets`](examples/snippets).

```sh
docker build -f examples/sample_mcp_server/Dockerfile -t indykite-delegated-token-sample .
docker run -p 8000:8000 \
  -e TARGET_MCP_URL=https://gateway.example.com/mcp \
  -e TARGET_AGENT_URL=https://agent-gateway.example.com \
  indykite-delegated-token-sample
```

## Development

mcp 1.x and 2.x share the import name `mcp`, so they are tested in separate environments. The default one has
mcp 2.x, FastMCP 4 and a2a-sdk; the tests of the other SDK are skipped.

```sh
uv sync                            # create .venv with the package, dev tools and mcp 2.x
uv run pytest                      # tests against mcp 2.x and FastMCP 4
UV_PROJECT_ENVIRONMENT=.venv-mcp1 uv run --no-group mcp2 --group mcp1 pytest   # tests against mcp 1.x
uv run ruff check && uv run ruff format --check
uv run mypy --follow-imports=silent --exclude 'server/mcp_v1\.py'
```

## License

[Apache-2.0](https://github.com/indykite/indykite-delegated-token/blob/master/LICENSE)
