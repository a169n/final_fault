"""Chaos endpoint lockdown (Task 12; THREAT-MODEL.md B3.E1).

In endterm, ``/chaos`` and ``/chaos/crash`` answer only to a caller presenting ``x-chaos-token``
equal to ``CHAOS_TOKEN`` (compared in constant time); anything else is a 403 plus an audit event,
and the fault configuration is left untouched. Baseline and midterm keep the endpoint open, as the
midterm harness expects.
"""
from __future__ import annotations

import json
import os
import pathlib
from typing import List

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import fault_injection
from app.services import student

LOG = pathlib.Path(os.environ["LOG_DIR"]) / "events.jsonl"
TOKEN = "test-chaos-token-0123456789abcdef"


@pytest.fixture(autouse=True)
def isolated_chaos(monkeypatch: pytest.MonkeyPatch) -> List[float]:
    """Fresh fault config per test, and /chaos/crash must never really exit the test process."""
    monkeypatch.setattr(fault_injection, "config", {"latencyMs": 0, "failRate": 0.0, "crashAfterCheckpoint": False})
    exits: List[float] = []

    class FakeTimer:
        def __init__(self, delay: float, fn) -> None:
            self.delay = delay

        def start(self) -> None:
            exits.append(self.delay)

    monkeypatch.setattr(fault_injection.threading, "Timer", FakeTimer)
    monkeypatch.setenv("CHAOS_TOKEN", TOKEN)
    return exits


@pytest.fixture
def client() -> TestClient:
    return TestClient(student.app)  # a real service: the guard must sit on the router every service includes


def _events_since(start: int) -> List[dict]:
    text = LOG.read_text()[start:] if LOG.exists() else ""
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _offset() -> int:
    return LOG.stat().st_size if LOG.exists() else 0


def test_chaos_requires_token_in_endterm(endterm, client: TestClient, isolated_chaos: List[float]) -> None:
    start = _offset()
    assert client.get("/chaos").status_code == 403
    assert client.post("/chaos", json={"latencyMs": 3000}).status_code == 403
    assert client.post("/chaos", json={"latencyMs": 3000}, headers={"x-chaos-token": "wrong"}).status_code == 403
    assert client.post("/chaos/crash").status_code == 403
    assert client.post("/chaos/crash", headers={"x-chaos-token": TOKEN + "x"}).status_code == 403
    assert fault_injection.config["latencyMs"] == 0  # a refused request changes nothing
    assert isolated_chaos == []  # and crashes nothing

    raw = LOG.read_text()[start:]
    assert TOKEN not in raw and "wrong" not in raw  # neither the real nor the presented token is logged
    denies = [e for e in _events_since(start) if e.get("kind") == "audit"]
    assert len(denies) == 5
    assert all(e["outcome"] == "deny" and e["reason"] == "bad_chaos_token" for e in denies)
    assert {e["action"] for e in denies} == {"GET /chaos", "POST /chaos", "POST /chaos/crash"}

    ok = client.post("/chaos", json={"latencyMs": 3000}, headers={"x-chaos-token": TOKEN})
    assert ok.status_code == 200 and ok.json()["latencyMs"] == 3000
    assert client.get("/chaos", headers={"x-chaos-token": TOKEN}).status_code == 200
    assert client.post("/chaos/crash", headers={"x-chaos-token": TOKEN}).status_code == 200
    assert isolated_chaos == [0.05]


def test_chaos_fails_closed_without_configured_token(endterm, client: TestClient,
                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHAOS_TOKEN", "")
    assert client.get("/chaos", headers={"x-chaos-token": ""}).status_code == 403
    monkeypatch.delenv("CHAOS_TOKEN")
    assert client.get("/chaos").status_code == 403


def test_chaos_rejects_non_ascii_token_without_error(endterm, client: TestClient) -> None:
    response = client.get("/chaos", headers={"x-chaos-token": "tést".encode("latin-1")})
    assert response.status_code == 403  # not a 500 from compare_digest on non-ASCII str


@pytest.mark.parametrize("mode", ["baseline", "midterm"])
def test_chaos_open_in_midterm(mode: str, client: TestClient, monkeypatch: pytest.MonkeyPatch,
                               isolated_chaos: List[float]) -> None:
    if mode == "midterm":
        monkeypatch.setenv("FT_ENABLED", "1")
    monkeypatch.delenv("CHAOS_TOKEN", raising=False)  # the midterm harness sends no token
    assert client.get("/chaos").status_code == 200
    assert client.post("/chaos", json={"latencyMs": 5}).json()["latencyMs"] == 5
    assert client.post("/chaos/crash").status_code == 200
    assert isolated_chaos == [0.05]


def test_chaos_token_compare_constant_time(endterm, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    real = fault_injection.hmac.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(fault_injection.hmac, "compare_digest", spy)
    app = FastAPI()
    app.include_router(fault_injection.router)
    client = TestClient(app)

    assert client.get("/chaos", headers={"x-chaos-token": "nope"}).status_code == 403
    assert client.get("/chaos", headers={"x-chaos-token": TOKEN}).status_code == 200
    assert len(calls) == 2  # every check, allowed or denied, goes through compare_digest
    assert calls[0] == (b"nope", TOKEN.encode())
    assert calls[1] == (TOKEN.encode(), TOKEN.encode())
