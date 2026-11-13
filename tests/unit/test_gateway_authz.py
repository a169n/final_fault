"""The gateway as policy enforcement point (Task 9).

In endterm every /api/* request needs a valid bearer token and must pass the policy matrix,
and every deny is audited and counted. Baseline and midterm keep the open midterm behaviour,
so the three modes can be compared. The upstream replicas are a monkeypatched ``_client``.
"""
from __future__ import annotations

import json
import os
import pathlib

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.security import tokens

SECRET = "unit-test-secret-0123456789abcdefghij"
LOG = pathlib.Path(os.environ["LOG_DIR"]) / "events.jsonl"


@pytest.fixture(autouse=True)
def secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JWT_SECRET", SECRET)


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> list:
    """Every API pool answers 200/201 from one fake replica; returns the calls it saw."""
    from app.fault_tolerance.software import circuit_breaker
    from app.services import gateway

    monkeypatch.setattr(circuit_breaker, "_breakers", {})
    for pool in ("students", "payments", "transcripts", "timetables"):
        monkeypatch.setitem(gateway.POOLS, pool, [f"http://{pool}-1:3000"])
    seen: list = []

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        seen.append({"method": method, "url": url, "headers": headers, "content": content})
        return httpx.Response(201 if method == "POST" else 200, json={"ok": True})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    return seen


def _client() -> TestClient:
    from app.services import gateway

    return TestClient(gateway.app)  # no `with`: the health and ejection loops are not started


def _bearer(sub: str, role: str, student_id=None) -> dict:
    return {"authorization": f"Bearer {tokens.issue(sub, role, student_id)}"}


def _denied(reason: str) -> float:
    return REGISTRY.get_sample_value("auth_denied_total", {"reason": reason}) or 0.0


def _audit_since(start: int) -> list:
    return [e for e in (json.loads(line) for line in LOG.read_text()[start:].splitlines() if line.strip())
            if e.get("kind") == "audit"]


def _offset() -> int:
    return LOG.stat().st_size if LOG.exists() else 0


def test_gateway_returns_401_without_token_in_endterm(endterm: None, upstream: list) -> None:
    before, start = _denied("missing_token"), _offset()
    response = _client().get("/api/students/s7", headers={"x-request-id": "rid-no-token-01"})
    assert response.status_code == 401
    assert response.json() == {"error": "unauthorized"}
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert upstream == []  # never reaches a replica
    assert _denied("missing_token") == before + 1
    (event,) = _audit_since(start)
    assert (event["outcome"], event["reason"], event["rid"]) == ("deny", "missing_token", "rid-no-token-01")


@pytest.mark.parametrize("mode", ["baseline", "ft"])
def test_gateway_allows_without_token_in_midterm(request: pytest.FixtureRequest, upstream: list,
                                                 mode: str) -> None:
    if mode != "baseline":
        request.getfixturevalue(mode)
    start = _offset()
    assert _client().get("/api/students/s7").status_code == 200
    assert _client().post("/api/students", json={"id": "x1", "name": "X"}).status_code == 201
    assert len(upstream) == 2
    assert _audit_since(start) == []  # no enforcement, so nothing to audit


def test_valid_token_is_forwarded_without_the_authorization_header(endterm: None, upstream: list) -> None:
    response = _client().get("/api/students/s7", headers=_bearer("s7", "student", "s7"))
    assert response.status_code == 200
    assert [c["url"] for c in upstream] == ["http://students-1:3000/s7"]
    assert "authorization" not in {k.lower() for k in upstream[0]["headers"]}  # the token stops here


@pytest.mark.parametrize("make,reason", [
    (lambda: tokens.issue("s7", "student", "s7")[:-3] + "AAA", "bad_signature"),
    (lambda: tokens.issue("s7", "student", "s7", now=1_000_000), "expired"),
    (lambda: jwt.encode({"sub": "admin", "role": "admin", "student_id": None, "iss": tokens.ISSUER,
                         "aud": "other-api", "iat": 2_000_000_000, "exp": 4_000_000_000}, SECRET,
                        algorithm="HS256"), "bad_audience"),
    (lambda: "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiJ9.", "malformed"),
    (lambda: "not-a-jwt", "malformed"),
])
def test_bad_tokens_are_401_and_counted_by_reason(endterm: None, upstream: list, make, reason: str) -> None:
    before = _denied(reason)
    response = _client().get("/api/students", headers={"authorization": f"Bearer {make()}"})
    assert response.status_code == 401
    assert upstream == []
    assert _denied(reason) == before + 1


@pytest.mark.parametrize("header", ["Basic YWRtaW46cHc=", "Bearer", "Bearer ", "bearer  x y", "Token abc"])
def test_non_bearer_authorization_is_401(endterm: None, upstream: list, header: str) -> None:
    response = _client().get("/api/timetables/2026-fall", headers={"authorization": header})
    assert response.status_code == 401
    assert upstream == []


def test_bearer_scheme_is_case_insensitive(endterm: None, upstream: list) -> None:
    token = tokens.issue("bursar", "staff", None)
    assert _client().get("/api/students", headers={"authorization": f"bearer {token}"}).status_code == 200


def test_student_paying_for_another_student_is_403_and_audited(endterm: None, upstream: list) -> None:
    before, start = _denied("not_owner"), _offset()
    response = _client().post("/api/payments", json={"studentId": "s8", "amount": 100},
                              headers={**_bearer("s7", "student", "s7"), "idempotency-key": "attack-0001"})
    assert response.status_code == 403
    assert response.json() == {"error": "forbidden"}
    assert upstream == []  # the payment service never sees it, so the DB is unchanged
    assert _denied("not_owner") == before + 1
    (event,) = _audit_since(start)
    assert (event["sub"], event["role"], event["outcome"], event["reason"]) == ("s7", "student", "deny", "not_owner")
    assert event["action"] == "POST /api/payments"


def test_unauthorized_request_without_key_is_401_not_400(endterm: None, upstream: list) -> None:
    # authentication comes first: an anonymous caller learns nothing about the payment contract
    assert _client().post("/api/payments", json={"studentId": "s7", "amount": 1}).status_code == 401


def test_payment_allow_is_audited(endterm: None, upstream: list) -> None:
    start = _offset()
    response = _client().post("/api/payments", json={"studentId": "s7", "amount": 100},
                              headers={**_bearer("s7", "student", "s7"), "idempotency-key": "pay-s7-0001"})
    assert response.status_code == 201
    assert len(upstream) == 1
    (event,) = _audit_since(start)
    assert (event["action"], event["outcome"], event["sub"]) == ("POST /api/payments", "allow", "s7")
    assert event["student"] == "s7" and event["idempotency_key"] == "pay-s7-0001"


def test_admin_action_is_audited(endterm: None, upstream: list) -> None:
    start = _offset()
    response = _client().post("/api/students", json={"id": "s9", "name": "Nine"}, headers=_bearer("admin", "admin"))
    assert response.status_code == 201
    (event,) = _audit_since(start)
    assert (event["action"], event["outcome"], event["role"]) == ("POST /api/students", "allow", "admin")


def test_ordinary_reads_are_not_audited(endterm: None, upstream: list) -> None:
    start = _offset()
    assert _client().get("/api/students/s7", headers=_bearer("bursar", "staff")).status_code == 200
    assert _audit_since(start) == []  # the request log already has them; audit stays signal, not noise


def test_audit_action_uses_the_route_template_not_the_raw_path(endterm: None, upstream: list) -> None:
    start = _offset()
    _client().get("/api/students/s8", headers=_bearer("s7", "student", "s7"))
    (event,) = _audit_since(start)
    assert event["action"] == "GET /api/students/{id}"


def test_gateway_fails_closed_when_the_policy_raises(endterm: None, upstream: list,
                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import gateway

    def boom(*_args, **_kwargs):
        raise RuntimeError("policy bug")

    monkeypatch.setattr(gateway.policy, "authorize", boom)
    response = _client().get("/api/students", headers=_bearer("admin", "admin"))
    assert response.status_code == 403
    assert upstream == []


def test_gateway_fails_closed_when_verify_raises(endterm: None, upstream: list,
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import gateway

    def boom(*_args, **_kwargs):
        raise RuntimeError("verifier bug")

    monkeypatch.setattr(gateway.tokens, "verify", boom)
    response = _client().get("/api/students", headers=_bearer("admin", "admin"))
    assert response.status_code == 401
    assert upstream == []


def test_login_route_stays_public_in_endterm(endterm: None, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import gateway

    monkeypatch.setitem(gateway.POOLS, "auth", ["http://auth-1:3000"])

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        return httpx.Response(200, json={"access_token": "t", "token_type": "bearer", "expires_in": 900})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    assert _client().post("/auth/token", json={"username": "bursar", "password": "pw"}).status_code == 200


def test_deny_reasons_exported_from_start(endterm: None) -> None:
    from app.services import gateway  # noqa: F401  importing the gateway creates the series

    for reason in ("missing_token", "expired", "bad_signature", "bad_audience", "malformed",
                   "forbidden", "not_owner", "no_rule", "policy_error"):
        assert REGISTRY.get_sample_value("auth_denied_total", {"reason": reason}) is not None, reason


def test_degraded_fallback_never_serves_another_pools_cached_payload(endterm: None,
                                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    """S7 must not bypass the policy: the stale cache is per pool, not per path.

    GET /api/timetables/{term} is open to every student and ``term`` is free-form, so a stale cache
    keyed by path alone would hand s8's transcript, cached for staff, to s7 asking for timetable "s8".
    """
    from app.fault_tolerance.software import circuit_breaker
    from app.fault_tolerance.software.degradation import StaleCache
    from app.services import gateway

    monkeypatch.setattr(circuit_breaker, "_breakers", {})
    monkeypatch.setattr(gateway, "_last_good", StaleCache())
    for pool in ("students", "transcripts", "timetables"):
        monkeypatch.setitem(gateway.POOLS, pool, [f"http://{pool}-1:3000"])
    secret_record = {"studentId": "s8", "grades": ["A"], "balance": 1234}

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        if url.startswith("http://timetables-1"):
            raise httpx.ConnectError("timetables down")
        return httpx.Response(200, json=secret_record)

    monkeypatch.setattr(gateway._client, "request", fake_request)
    client = _client()
    staff, student = _bearer("bursar", "staff"), _bearer("s7", "student", "s7")
    for pool in ("transcripts", "students"):  # staff warm the cache with s8's records
        assert client.get(f"/api/{pool}/s8", headers=staff).status_code == 200
        assert client.get(f"/api/{pool}/s8", headers=student).status_code == 403

    response = client.get("/api/timetables/s8", headers=student)
    assert response.status_code != 203
    assert "balance" not in response.text and "grades" not in response.text
    assert response.status_code >= 500


def test_degraded_fallback_still_serves_the_same_pools_cached_payload(endterm: None,
                                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    from app.fault_tolerance.software import circuit_breaker
    from app.fault_tolerance.software.degradation import StaleCache
    from app.services import gateway

    monkeypatch.setattr(circuit_breaker, "_breakers", {})
    monkeypatch.setattr(gateway, "_last_good", StaleCache())
    monkeypatch.setitem(gateway.POOLS, "timetables", ["http://timetables-1:3000"])
    state = {"down": False}

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        if state["down"]:
            raise httpx.ConnectError("timetables down")
        return httpx.Response(200, json={"term": "2026F", "slots": 3})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    client = _client()
    student = _bearer("s7", "student", "s7")
    assert client.get("/api/timetables/2026F", headers=student).status_code == 200
    state["down"] = True
    response = client.get("/api/timetables/2026F", headers=student)
    assert response.status_code == 203
    assert response.json()["data"] == {"term": "2026F", "slots": 3}
