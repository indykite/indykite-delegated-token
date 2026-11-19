# Sample MCP server that propagates the delegated token, see 'server.py'.
# Build from the 'python' folder, so the image installs the package from this checkout:
#   docker build -f examples/sample_mcp_server/Dockerfile -t indykite-delegated-token-sample .
# Images are pinned by digest, Renovate keeps them up to date.

# Installs the package and its locked dependencies. Python matches the runtime image's, debian13's 3.13.
FROM python:3.13-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/venv

WORKDIR /src
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --frozen --no-default-groups --extra mcp --extra a2a --no-install-project
COPY indykite_delegated_token ./indykite_delegated_token
RUN uv sync --frozen --no-default-groups --extra mcp --extra a2a --no-editable

# No shell or package manager, runs as nonroot
FROM gcr.io/distroless/python3-debian13:nonroot@sha256:6c4cb3bfa4b555429dd19541796a6ba6b30c84675b460bd0bd5072f7d5bdae71
ENV PYTHONPATH=/app/site-packages \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY --from=build /venv/lib/python3.13/site-packages ./site-packages
COPY examples/sample_mcp_server/server.py ./server.py

USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)"]
ENTRYPOINT ["python3", "server.py"]
