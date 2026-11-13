"""Liveness/readiness split: /health/live never touches the DB, /health/ready (and its /health alias)
keeps the midterm readiness semantics, and the gateway probes readiness."""
from __future__ import annotations

from typing import List

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.service import create_app
from app.fault_tolerance.software import health_check
from app.services import payment, student, timetable, transcript

DB_SERVICES = [student, payment, timetable]  # readiness == primary DB reachable


def _db(monkeypatch: pytest.MonkeyPatch, module, ok: bool) -> List[int]:
    calls: List[int] = []

    async def fake_db_healthy() -> bool:
        calls.append(1)
        return ok

    monkeypatch.setattr(module, "db_healthy", fake_db_healthy)
    return calls


@pytest.mark.parametrize("module", DB_SERVICES + [transcript], ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_live_ok_without_db(monkeypatch: pytest.MonkeyPatch, module) -> None:
    calls = _db(monkeypatch, module, ok=False)
    response = TestClient(module.app).get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert calls == []  # liveness must not depend on the DB, or a DB outage restarts every container


@pytest.mark.parametrize("module", DB_SERVICES, ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_ready_503_without_db(monkeypatch: pytest.MonkeyPatch, module) -> None:
    _db(monkeypatch, module, ok=False)
    client = TestClient(module.app)
    assert client.get("/health/ready").status_code == 503
    assert client.get("/health").status_code == 503  # alias: the midterm harness still probes /health


@pytest.mark.parametrize("module", DB_SERVICES, ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_ready_200_with_db(monkeypatch: pytest.MonkeyPatch, module) -> None:
    _db(monkeypatch, module, ok=True)
    client = TestClient(module.app)
    assert client.get("/health/ready").status_code == 200
    assert client.get("/health").status_code == 200


def test_transcript_ready_without_db_only_in_ft(monkeypatch: pytest.MonkeyPatch, ft) -> None:
    _db(monkeypatch, transcript, ok=False)
    response = TestClient(transcript.app).get("/health/ready")
    assert response.status_code == 200  # FT: the stale cache can still answer
    assert response.json()["degraded"] is True


def test_transcript_not_ready_without_db_in_baseline(monkeypatch: pytest.MonkeyPatch) -> None:
    _db(monkeypatch, transcript, ok=False)
    assert TestClient(transcript.app).get("/health/ready").status_code == 503


def test_live_registered_by_create_app() -> None:
    response = TestClient(create_app(with_db=False)).get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_gateway_live_and_ready() -> None:
    from app.services import gateway

    client = TestClient(gateway.app)  # no `with`: the lifespan (health loop) is not started
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 200
    assert client.get("/health").json()["ok"] is True


async def test_gateway_probes_readiness(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(503 if request.url.host == "down" else 200)

    monkeypatch.setattr(health_check, "_status", {})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await health_check._probe(client, "http://up:3000")
        await health_check._probe(client, "http://down:3000")
    assert seen == ["/health/ready", "/health/ready"]
    assert health_check.is_up("http://up:3000") is True
    assert health_check.is_up("http://down:3000") is False
