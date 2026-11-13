"""Payments need a client Idempotency-Key in endterm.

With redundant gateways, nginx re-sends a POST to the second gateway when the first dies
mid-request (`proxy_next_upstream ... non_idempotent`). If the gateway generated the key, each
gateway would make up its own and the student would be charged twice. So in endterm the client
must send the key; the midterm behaviour (gateway generates one) is kept for comparison.

The caller is an authorized staff (or, for timetables, admin) principal, so these tests pin the key
check itself; authorization is tested in test_gateway_authz.py.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

PAY = {"studentId": "s7", "amount": 100}
SECRET = "unit-test-secret-0123456789abcdefghij"


@pytest.fixture(autouse=True)
def secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JWT_SECRET", SECRET)


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> list:
    """Replace the gateway's HTTP client with a fake payment replica; returns the calls it saw."""
    from app.services import gateway

    monkeypatch.setitem(gateway.POOLS, "payments", ["http://p1:3000"])
    seen: list = []

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        seen.append({"method": method, "url": url, "headers": headers})
        return httpx.Response(201, json={"id": 1, "studentId": "s7", "amount": 100})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    return seen


def _client(role: str = "staff") -> TestClient:
    from app.security import tokens
    from app.services import gateway

    auth = {"authorization": f"Bearer {tokens.issue(role, role, None)}"}  # ignored outside endterm
    return TestClient(gateway.app, headers=auth)  # no `with`: the lifespan (health and ejection loops) is not started


def test_payment_without_idempotency_key_rejected(endterm: None, upstream: list) -> None:
    response = _client().post("/api/payments", json=PAY)
    assert response.status_code == 400
    assert response.json() == {"error": "Idempotency-Key header required"}
    assert upstream == []  # never reaches a payment replica


def test_payment_with_blank_idempotency_key_rejected(endterm: None, upstream: list) -> None:
    response = _client().post("/api/payments", json=PAY, headers={"idempotency-key": "  "})
    assert response.status_code == 400
    assert upstream == []


def test_payment_with_key_forwarded_in_endterm(endterm: None, upstream: list) -> None:
    response = _client().post("/api/payments", json=PAY, headers={"idempotency-key": "pay-0001"})
    assert response.status_code == 201
    assert [c["headers"]["idempotency-key"] for c in upstream] == ["pay-0001"]


def test_payment_without_key_allowed_in_midterm(ft: None, upstream: list) -> None:
    response = _client().post("/api/payments", json=PAY)
    assert response.status_code == 201
    assert len(upstream) == 1
    assert upstream[0]["headers"]["idempotency-key"]  # the gateway generated one (midterm S5)


def test_other_posts_need_no_key_in_endterm(endterm: None, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import gateway

    monkeypatch.setitem(gateway.POOLS, "timetables", ["http://t1:3000"])

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        return httpx.Response(202, json={"term": "2026-fall", "state": "running"})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    response = _client("admin").post("/api/timetables", json={"term": "2026-fall"})
    assert response.status_code == 202  # natural-key upsert: a re-sent POST is already harmless
