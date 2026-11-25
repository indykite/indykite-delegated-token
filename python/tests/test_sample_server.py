# Copyright (c) 2026 IndyKite
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

pytest.importorskip("mcp.server.mcpserver")  # the sample is built on mcp 2.x
pytest.importorskip("a2a")
pytest.importorskip("uvicorn")

from starlette.testclient import TestClient

SERVER = Path(__file__).parent.parent / "examples" / "sample_mcp_server" / "server.py"
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}},
}


def load_sample(monkeypatch: pytest.MonkeyPatch, allowed_hosts: str) -> ModuleType:
    monkeypatch.setenv("ALLOWED_HOSTS", allowed_hosts)
    spec = importlib.util.spec_from_file_location("sample_mcp_server", SERVER)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("allowed_hosts", "host", "status"),
    [
        ("", "sample-mcp:8000", 200),  # behind the gateway, which reaches the server by a name of its own
        ("sample-mcp:*", "sample-mcp:8000", 200),
        ("sample-mcp:*", "evil.example.com:8000", 421),
    ],
)
def test_host_header(monkeypatch: pytest.MonkeyPatch, allowed_hosts: str, host: str, status: int) -> None:
    sample = load_sample(monkeypatch, allowed_hosts)
    with TestClient(sample.app(), base_url=f"http://{host}") as client:
        response = client.post("/mcp", json=INITIALIZE, headers={"Accept": "application/json, text/event-stream"})
        assert response.status_code == status
        assert client.get("/healthz").status_code == 200
