# Sample MCP server that propagates the delegated token, see 'server.ts'.
# Build from the 'typescript' folder, so the image installs the package from this checkout:
#   docker build -f examples/sample-mcp-server/Dockerfile -t indykite-delegated-token-sample .
FROM node:24-slim AS build

WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json LICENSE README.md ./
COPY src ./src
RUN pnpm pack --pack-destination /out && mv /out/*.tgz /out/indykite-delegated-token.tgz

FROM node:24-slim

WORKDIR /app
COPY --from=build /out/indykite-delegated-token.tgz ./
COPY examples/sample-mcp-server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY examples/sample-mcp-server/server.ts ./

USER 65532:65532
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '8000') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.ts"]
