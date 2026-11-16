# IndyKite delegated token - Python

Python package for the delegated token propagation of the IndyKite Agent Gateway.

> [!WARNING]
> Work in progress, not published to PyPI yet.

The agent gateway in front of an MCP server or an A2A agent sends the delegated token of the workflow in the
`X-IK-Token` header. When that server or agent calls another MCP server or A2A agent through the next gateway, the
call must carry the token too, or the gateway refuses it. This package does both halves:

- **server side**: `install(server)` for MCP servers, or an ASGI middleware for A2A agents, makes the token of the
  request being handled available through `get_delegated_token()`;
- **client side**: an HTTP client for MCP calls and an interceptor for A2A calls send it on, to the targets that
  announce the delegated token extension and to no others. Agent frameworks use the same clients, see
  [Agent frameworks](#agent-frameworks).

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
handled within their own HTTP request. Two concurrent requests always see their own tokens. A request with more than
one `X-IK-Token` value, as several headers or one joined with commas, gets no token: a proxy may have appended the
real one to one the caller forged.

FastMCP tools declared with `task=True` are not supported: they run as background tasks after their request has been
handled, possibly in another process, and see no token.

### A2A agent: receive the token

An A2A agent built with a2a-sdk is a Starlette or FastAPI app. Add `DelegatedTokenASGIMiddleware` as its outermost
middleware, with `strip_header=True`:

```python
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from starlette.applications import Starlette
from starlette.middleware import Middleware

from indykite_delegated_token.server.asgi import DelegatedTokenASGIMiddleware

app = Starlette(
    routes=[*create_agent_card_routes(card), *create_jsonrpc_routes(handler, "/")],
    middleware=[Middleware(DelegatedTokenASGIMiddleware, strip_header=True)],
)
```

With FastAPI: `app.add_middleware(DelegatedTokenASGIMiddleware, strip_header=True)`.

The executor reads the token with `get_delegated_token()`, and the clients below send it on. Each `execute` call sees
the token of the request that sent its message, also for a follow-up message to an existing task and for streaming
requests. The agent card does not need to list the extension: the gateway declares it.

`strip_header=True` removes `X-IK-Token` from the request that the app sees, so the token is reachable only through
`get_delegated_token()`. a2a-sdk copies all request headers into its call context and logs that context at DEBUG;
with the flag, the token is not in those logs. The flag is off by default. Do not set it in front of an MCP server
that uses `install()`: `install()` reads the header from the request, so it would see no token.

The middleware works for JSON-RPC and REST. The gateway exposes JSON-RPC only; gRPC is not supported.

Work that leaves the request, such as a queue or another process, must carry the token itself: read it with
`get_delegated_token()` and restore it in the worker with `use_token(token)`. Tasks the executor starts in the same
process keep the token of their request, also after the response is sent. The token may expire before such work ends;
the next gateway then refuses the call.

> [!WARNING]
> Do not pass this package's HTTP clients to a2a-sdk's push notification sender. It sends from the context of the
> request that started the task, so every push would carry that first request's token. Push notifications with the
> delegated token are not supported.

For other ASGI apps, wrap the app: `app = DelegatedTokenASGIMiddleware(app)`.

### Client: send the token on

The MCP clients below use the Streamable HTTP transport. The legacy SSE transport is not supported: its messages go
to a URL per session, which no metadata can announce.

The package's `http_client()` uses the proxies of `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`, as the
SDKs' own clients do. Given a `transport`, to configure TLS, proxies or limits, it uses that transport's settings
only.

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
extension to `A2A-Extensions`. Other agents get neither; an `X-IK-Token` the caller set in the call's service
parameters is removed for them. Over gRPC, the token is as protected as the channel: create it with TLS credentials.

The httpx client given to a2a-sdk must not follow redirects, which is a2a-sdk's and httpx's default: httpx would copy
`X-IK-Token` onto a redirect, also to another origin or from `https` to `http`.

> [!IMPORTANT]
> **Open MCP clients inside the tool call.** The 1.x client sends its requests from a task started when it connects,
> so a client opened earlier, for example at startup, keeps the token it had then, usually none. The 2.x client sends
> each POST with the token of the call that made it, but its GET stream and its closing DELETE carry the token of the
> call that opened or closed the client: a client opened at startup sends them without the token, and one reused
> across tool calls keeps sending the first call's token after its request has ended.

### Which targets get the token

A request carries `X-IK-Token` only when there is a token and the target announced the extension, whoever set the
token: the package from the request being handled, the developer, or a framework's header hook.

- **MCP targets** announce in their OAuth protected resource metadata (RFC 9728): `mcp_extensions` contains
  `com.indykite/delegated-token`, and `resource` is the target's URL. Before the first request to a target, the
  client fetches `/.well-known/oauth-protected-resource<path>` on the target's origin, without any credentials, with
  the client's timeouts, or 10 seconds for those it leaves unset, and 30 seconds in all.
- The answer is cached per target (scheme, host, port, path and query) for an hour, so a target that stops announcing
  stops getting the token; concurrent first calls share one fetch. A 404 is cached as "does not announce". Other
  statuses, such as 401 or 5xx, and answers that cannot be used, larger than 64 KiB, compressed, or not read within
  30 seconds, count as "does not announce" for a minute. Network errors are not cached, and the calls that shared
  that fetch go out without the token. If the call that leads a fetch is cancelled, the calls waiting for it fetch
  again. At most 1024 targets are kept, the least recently used are
  dropped first. `ExtensionRegistry(ttl=..., error_ttl=..., max_targets=...)` changes these.
- When a target that is not known to announce answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, the
  client follows the link, only if it is on the target's origin, and retries the request once with the token if the
  target announces. The link's answer is cached like the well-known one, so it is not followed again on every 401.
  A 401 whose body is larger than 64 KiB is returned as it is, without following the link; one
  whose body takes more than 30 seconds to arrive fails the call with a read timeout.
- **A2A agents** announce in their agent card, see above. The card is trusted as given: a2a-sdk does not tell the
  interceptor where the card came from, so resolve cards only from agents your server's operator configured.
- The token only goes over `https`, or over `http` to a loopback host (`localhost`, `127.0.0.0/8`, `::1`): over plain
  HTTP anyone on the network could read it, or forge the metadata that announces the extension. To send it over plain
  HTTP anyway, for example inside a private network, pass `registry=ExtensionRegistry(allow_http=True)` to the MCP
  client, and `allow_http=True` to `DelegatedTokenInterceptor`.
- A token the caller set itself in `X-IK-Token` goes out as set, but follows the same rules: a target that does not
  announce, another origin after a redirect, or plain HTTP without `allow_http`, never gets it. The header is removed
  from those requests.
- When the client follows redirects, the token only goes to the origin of the first request, or to its upgrade from
  `http` to `https` on the same host and default ports: a redirect to another origin, or from `https` to `http`, never
  gets it, even if its target announces.
- The cache is shared by every client of the process. Clients that reach the same URL through different network
  paths, such as different proxies, must not share it: pass each its own `registry=ExtensionRegistry()`.

> [!WARNING]
> Announcing the extension does not make a target trustworthy: anyone can announce it, and every target that does
> receives the token. Call only targets that your server's operator configured, such as `TARGET_MCP_URL` in the
> examples, never a URL that comes from the tool's caller or from a model.

### Agent frameworks

Agent frameworks send the token on through the same HTTP clients. Two rules apply to all of them:

- **Open the MCP client, toolset or server inside the request**, never at startup, and do not share it between
  requests. The gateway lists tools only for a token, filtered for its user. A session kept across requests would
  list one user's tools for another, and on MCP SDK 1.x send the first user's token.
- **Use `client.httpx` with frameworks on MCP SDK 1.x and `client.httpx2` with those on 2.x**, as for the MCP SDK
  itself. A wrong choice fails: the framework rejects the client.

| Framework                                          | MCP SDK                       | Hook                                                                          |
| -------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| LangChain MCP adapters 0.3, LangGraph              | 1.x                           | `httpx_client_factory`; on the LangGraph server, also `token_from_run_config` |
| CrewAI 1.15, native `mcps=`                        | 1.x                           | `install_globally(gateways=[...])`                                            |
| Google ADK 2.14, `McpToolset`                      | 1.x, 2.x                      | `httpx_client_factory` and `header_provider`                                  |
| OpenAI Agents SDK 0.24, `MCPServerStreamableHttp`  | 1.x, 2.x                      | `httpx_client_factory`                                                        |
| Pydantic AI 2.68, `MCPToolset`                     | 2.x                           | `http_client`                                                                 |
| LlamaIndex MCP tools 0.7, `BasicMCPClient`         | 2.x                           | `http_client`                                                                 |
| Microsoft Agent Framework, `MCPStreamableHTTPTool` | 1.x up to 1.22, 2.x from 1.23 | `http_client`                                                                 |

**LangChain / LangGraph** - the adapters open a session per tool call:

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

from indykite_delegated_token.client.httpx import http_client
from indykite_delegated_token.integrations.langchain import token_from_run_config

client = MultiServerMCPClient(
    {"target": {"url": TARGET_MCP_URL, "transport": "streamable_http", "httpx_client_factory": http_client}},
    tool_interceptors=[token_from_run_config],  # LangGraph server only
)
tools = await client.get_tools()  # inside the request
```

On the LangGraph server a run executes in a queue worker, outside the HTTP request. List `X-IK-Token` in the
deployment's setting for headers copied into the run configuration. The token is then needed twice:

- to list the tools, which happens before any tool call: build the graph for each run, and wrap the listing in
  `use_token(run_config_token(config))`;
- for each tool call, which runs outside that block: `token_from_run_config` takes it from the run configuration.

```python
from langchain_core.runnables import RunnableConfig

from indykite_delegated_token import use_token
from indykite_delegated_token.integrations.langchain import run_config_token


async def make_graph(config: RunnableConfig):  # the graph factory named in langgraph.json
    with use_token(run_config_token(config)):
        tools = await client.get_tools()
    return create_agent(model, tools)
```

The token is stored with the run and may appear in traces: leave it out of tracing.

**CrewAI** - CrewAI takes no HTTP client, so the package hooks `httpx` for the whole process:

```python
from indykite_delegated_token.client.httpx import install_globally

install_globally(gateways=["https://gateway.example.com"])
```

Only requests to the listed origins (scheme, host, port) are handled, so the token never reaches the LLM provider.
They still get the token only if their target announces the extension. A request to another origin stays untouched,
also when it is redirected to a listed origin. `uninstall_globally()` undoes it. Not
supported: `MCPServerAdapter` of `crewai-tools`, whose session runs in its own thread, and tools written as plain
functions that CrewAI runs in a thread without the request's context.

**Google ADK** - pass both the header provider and the package's client factory:

```python
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams

from indykite_delegated_token.client.httpx2 import http_client  # client.httpx on MCP SDK 1.x
from indykite_delegated_token.integrations.adk import header_provider

toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(url=TARGET_MCP_URL, httpx_client_factory=http_client),
    header_provider=header_provider,
)
```

ADK keys its sessions on the headers, so each token gets its own session. The client factory is required: without
it, the header goes to every server of the toolset, also to those that do not announce the extension.

**OpenAI Agents SDK** - enter the server inside the request:

```python
from agents.mcp import MCPServerStreamableHttp

from indykite_delegated_token.client.httpx2 import http_client  # client.httpx on MCP SDK 1.x

async with MCPServerStreamableHttp(params={"url": TARGET_MCP_URL, "httpx_client_factory": http_client}) as server:
    agent = Agent(name="agent", mcp_servers=[server])
    ...
```

**Pydantic AI** - create the toolset inside the request:

```python
from pydantic_ai.mcp import MCPToolset

from indykite_delegated_token.client.httpx2 import http_client

async with http_client() as http:
    agent = Agent(model, toolsets=[MCPToolset(TARGET_MCP_URL, http_client=http)])
    ...
```

**LlamaIndex** - `BasicMCPClient` opens a session per call:

```python
from llama_index.tools.mcp import BasicMCPClient

from indykite_delegated_token.client.httpx2 import http_client

async with http_client() as http:
    client = BasicMCPClient(TARGET_MCP_URL, http_client=http)
    ...
```

**Microsoft Agent Framework** - enter the tool inside the request:

```python
from agent_framework import MCPStreamableHTTPTool

from indykite_delegated_token.client.httpx2 import http_client  # client.httpx up to agent-framework-core 1.22

async with http_client() as http, MCPStreamableHTTPTool("target", url=TARGET_MCP_URL, http_client=http) as tool:
    agent = Agent(chat_client, tools=[tool])
    ...
```

### Security

- **Reach the server or agent only through its gateway.** It trusts any `X-IK-Token` it receives. The gateway
  overwrites the header, but a caller that reaches the server directly can send any token.
- **Reach other agents and MCP servers only through gateways**, with TLS on every hop. Use network policy to stop
  calls to anything else.
- **Add the ASGI middleware outermost.** Middleware above it still sees the header.
- **Keep the token out of logs and traces.** a2a-sdk logs request headers at DEBUG: use `strip_header=True`. It logs
  `Authorization` the same way. If you enable OpenTelemetry header capture
  (`OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_*`), leave `X-IK-Token` out of it.

## Examples

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

The server accepts any `Host` header, as it would behind a gateway that reaches it by a name of its own. Set
`ALLOWED_HOSTS`, such as `ALLOWED_HOSTS=sample-mcp:*`, to accept only those.

[`examples/sample_a2a_agent`](examples/sample_a2a_agent) is a runnable A2A agent (a2a-sdk, MCP SDK 2.x) that does
the same without a model. A message with a data part `{"mcp_tool": "<name>", "arguments": {...}}` calls that tool on
`TARGET_MCP_URL`; any other message is sent as text to the agent at `TARGET_AGENT_URL`. The reply is a completed task
with one text artifact. `PUBLIC_URL` is the agent's URL in its card.

```sh
docker build -f examples/sample_a2a_agent/Dockerfile -t indykite-delegated-token-sample-agent .
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

mcp 1.x and 2.x share the import name `mcp`, so they are tested in separate environments. The default one has
mcp 2.x, FastMCP 4 and a2a-sdk; the tests of the other SDK are skipped.

```sh
uv sync                            # create .venv with the package, dev tools and mcp 2.x
uv run pytest                      # tests against mcp 2.x and FastMCP 4
UV_PROJECT_ENVIRONMENT=.venv-mcp1 uv run --no-group mcp2 --group mcp1 pytest   # tests against mcp 1.x
uv run --group frameworks-mcp2 pytest tests/frameworks                          # frameworks on mcp 2.x
UV_PROJECT_ENVIRONMENT=.venv-mcp1 uv run --no-group mcp2 --group mcp1 --group frameworks-mcp1 pytest tests/frameworks
UV_PROJECT_ENVIRONMENT=.venv-crewai uv run --python 3.13 --no-group mcp2 --group mcp1 --group frameworks-crewai pytest tests/frameworks/test_crewai.py
uv run ruff check && uv run ruff format --check
uv run mypy --follow-imports=silent --exclude 'server/mcp_v1\.py'
```

## License

[Apache-2.0](https://github.com/indykite/indykite-delegated-token/blob/master/LICENSE)
