# Sample A2A agent that propagates the delegated token, see 'agent.py'.
# Build from the 'python' folder, so the image installs the package from this checkout:
#   docker build -f examples/sample_a2a_agent/Dockerfile -t indykite-delegated-token-sample-agent .
FROM python:3.14-slim

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY indykite_delegated_token ./indykite_delegated_token
RUN pip install --no-cache-dir ".[mcp,a2a]" "a2a-sdk[http-server]" uvicorn

COPY examples/sample_a2a_agent/agent.py ./agent.py

USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)"]
CMD ["python", "agent.py"]
