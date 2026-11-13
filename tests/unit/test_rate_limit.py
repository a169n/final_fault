"""Rate limiting and abuse protection (Task 11).

The token bucket is tested with a fake clock (``now=``). The gateway tests freeze the limiter's
clock (``rate_limit.monotonic``) so that a slow test run cannot refill a bucket between calls.
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

import httpx
import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.security import rate_limit, tokens
from app.security.rate_limit import TokenBucket

SECRET = "unit-test-secret-0123456789abcdefghij"
LOG = pathlib.Path(os.environ["LOG_DIR"]) / "events.jsonl"
CREDS = {"username": "bursar", "password": "wrong"}


# --- the token bucket ---------------------------------------------------------------------------

def test_bucket_allows_burst_then_limits() -> None:
    bucket = TokenBucket(rate_per_s=1, burst=5)
    assert [bucket.allow("ip", now=0.0)[0] for _ in range(5)] == [True] * 5
    allowed, retry_after = bucket.allow("ip", now=0.0)
    assert allowed is False
    assert retry_after == pytest.approx(1.0)


def test_bucket_refills_over_time() -> None:
    bucket = TokenBucket(rate_per_s=2, burst=4)
    for _ in range(4):
        assert bucket.allow("k", now=10.0) == (True, 0.0)
    allowed, retry_after = bucket.allow("k", now=10.25)  # half a token back
    assert allowed is False and retry_after == pytest.approx(0.25)
    assert bucket.allow("k", now=10.5)[0] is True       # one token back, and spent
    assert bucket.allow("k", now=10.5)[0] is False
    # a long idle period refills to the burst, never beyond it
    assert [bucket.allow("k", now=1_000.0)[0] for _ in range(5)] == [True] * 4 + [False]


def test_keys_are_independent() -> None:
    bucket = TokenBucket(rate_per_s=1, burst=2)
    assert [bucket.allow("a", now=0.0)[0] for _ in range(3)] == [True, True, False]
    assert [bucket.allow("b", now=0.0)[0] for _ in range(3)] == [True, True, False]


def test_idle_keys_are_evicted_after_60_s() -> None:
    bucket = TokenBucket(rate_per_s=10, burst=20)
    bucket.allow("old", now=0.0)
    bucket.allow("recent", now=50.0)
    assert len(bucket) == 2
    bucket.allow("trigger", now=61.0)
    assert len(bucket) == 2  # "old" (idle 61 s) evicted; "recent" (idle 11 s) kept
    bucket.allow("trigger", now=200.0)
    assert len(bucket) == 1


def test_eviction_never_hands_out_a_fresh_bucket_early() -> None:
    # A slow bucket that takes longer than 60 s to refill keeps its state until it is full again.
    bucket = TokenBucket(rate_per_s=0.01, burst=2)
    bucket.allow("k", now=0.0)
    bucket.allow("k", now=0.0)
    assert bucket.allow("k", now=61.0)[0] is False  # 0.61 token: still limited, not evicted


def test_key_table_is_bounded_and_fails_closed() -> None:
    bucket = TokenBucket(rate_per_s=1, burst=1, max_keys=3)
    assert all(bucket.allow(f"k{i}", now=0.0)[0] for i in range(3))
    allowed, retry_after = bucket.allow("k-new", now=0.0)
    assert allowed is False and retry_after > 0  # a key flood cannot grow memory without bound
    assert len(bucket) == 3


@pytest.mark.parametrize("rate,burst", [(0, 5), (-1, 5), (1, 0), (float("nan"), 5)])
def test_bucket_rejects_nonsense_quotas(rate: float, burst: int) -> None:
    with pytest.raises(ValueError):
        TokenBucket(rate_per_s=rate, burst=burst)


def test_default_quotas() -> None:
    assert rate_limit.quota("login") == (1.0, 5)
    assert rate_limit.quota("student") == (10.0, 20)
    assert rate_limit.quota("staff") == (5000.0, 5000)
    assert rate_limit.quota("admin") == (1000.0, 1000)


def test_quotas_are_env_overridable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RATE_LIMIT_STUDENT_PER_S", "3")
    monkeypatch.setenv("RATE_LIMIT_STUDENT_BURST", "7")
    monkeypatch.setenv("RATE_LIMIT_ADMIN_PER_S", "not-a-number")  # ignored, with the default kept
    rate_limit.reset()
    assert rate_limit.quota("student") == (3.0, 7)
    assert rate_limit.quota("admin") == (1000.0, 1000)
    bucket = rate_limit.bucket("student")
    assert [bucket.allow("s7", now=0.0)[0] for _ in range(8)] == [True] * 7 + [False]


def test_staff_quota_absorbs_high_load_peak() -> None:
    # Review Focus 1: the high-load ramp (110 workers, ~2 000 req/s) runs as one staff principal.
    # Even if every request lands on ONE gateway, the staff quota must not produce a single 429.
    bucket = TokenBucket(*rate_limit.quota("staff"))
    calls = 2_200
    results = [bucket.allow("staff:bursar", now=100.0 + i / calls)[0] for i in range(calls)]
    assert all(results)
    # sustained: three more seconds at the same rate are absorbed by the refill
    more = [bucket.allow("staff:bursar", now=101.0 + i / calls)[0] for i in range(3 * calls)]
    assert all(more)


# --- the gateway ---------------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JWT_SECRET", SECRET)


@pytest.fixture
def frozen(monkeypatch: pytest.MonkeyPatch) -> list:
    """The limiter's clock, frozen at 1 000 s; tests advance it by assigning clock[0]."""
    clock = [1_000.0]
    monkeypatch.setattr(rate_limit, "monotonic", lambda: clock[0])
    return clock


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> list:
    """Fake replicas: every API pool answers 2xx; the auth pool rejects every password (401)."""
    from app.fault_tolerance.software import circuit_breaker
    from app.services import gateway

    monkeypatch.setattr(circuit_breaker, "_breakers", {})
    for pool in ("students", "payments", "transcripts", "timetables", "auth"):
        monkeypatch.setitem(gateway.POOLS, pool, [f"http://{pool}-1:3000"])
    seen: list = []

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        seen.append(url)
        if url.startswith("http://auth-1"):
            return httpx.Response(401, json={"error": "invalid credentials"})
        return httpx.Response(201 if method == "POST" else 200, json={"ok": True})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    return seen


def _client() -> TestClient:
    from app.services import gateway

    return TestClient(gateway.app)  # no `with`: the health and ejection loops are not started


def _bearer(sub: str, role: str, student_id=None) -> dict:
    return {"authorization": f"Bearer {tokens.issue(sub, role, student_id)}"}


def _sample(name: str, labels: dict) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def _offset() -> int:
    return LOG.stat().st_size if LOG.exists() else 0


def _audit_since(start: int) -> list:
    return [e for e in (json.loads(line) for line in LOG.read_text()[start:].splitlines() if line.strip())
            if e.get("kind") == "audit"]


def test_rate_limited_scopes_exported_from_start_up() -> None:
    # A fresh interpreter: other tests clear the process-wide registry. Importing the gateway alone
    # must export every scope (and the rate_limited deny reason) as 0, so rate() sees the first 429s.
    script = ("import json; from prometheus_client import REGISTRY; import app.services.gateway; "
              "print(json.dumps({'scopes': {s: REGISTRY.get_sample_value('rate_limited_total', {'scope': s}) "
              "for s in %r}, 'reason': REGISTRY.get_sample_value('auth_denied_total', {'reason': %r})}))"
              % (rate_limit.SCOPES, rate_limit.REASON))
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, check=True,
                         cwd=pathlib.Path(__file__).resolve().parents[2], env=os.environ.copy())
    exported = json.loads(out.stdout.strip().splitlines()[-1])
    assert exported == {"scopes": {s: 0.0 for s in rate_limit.SCOPES}, "reason": 0.0}


def test_login_bruteforce_limited_after_5(endterm: None, upstream: list, frozen: list) -> None:
    client = _client()
    xff = {"x-forwarded-for": "198.51.100.7"}
    limited_before = _sample("rate_limited_total", {"scope": "login"})
    denied_before = _sample("auth_denied_total", {"reason": "rate_limited"})
    statuses = [client.post("/auth/token", json=CREDS, headers=xff).status_code for _ in range(5)]
    assert statuses == [401] * 5  # wrong password, relayed to the auth service
    start = _offset()
    response = client.post("/auth/token", json=CREDS,
                           headers={**xff, "x-request-id": "rid-brute-force-06"})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "1"
    assert response.json() == {"error": "too many requests"}
    assert len(upstream) == 5  # the 6th attempt never reaches the auth service
    assert _sample("rate_limited_total", {"scope": "login"}) == limited_before + 1
    assert _sample("auth_denied_total", {"reason": "rate_limited"}) == denied_before + 1
    (event,) = _audit_since(start)
    assert (event["outcome"], event["reason"], event["action"]) == ("deny", "rate_limited", "POST /auth/token")
    assert (event["scope"], event["client"], event["rid"]) == ("login", "198.51.100.7", "rid-brute-force-06")
    assert "wrong" not in json.dumps(event)  # the password is never logged

    # another client address has its own quota; the limited one recovers after 1 s
    assert client.post("/auth/token", json=CREDS, headers={"x-forwarded-for": "198.51.100.8"}).status_code == 401
    frozen[0] += 1.0
    assert client.post("/auth/token", json=CREDS, headers=xff).status_code == 401


def test_login_limit_keys_on_the_first_forwarded_address(endterm: None, upstream: list, frozen: list) -> None:
    client = _client()
    for proxy_hop in ("10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"):
        client.post("/auth/token", json=CREDS, headers={"x-forwarded-for": f"203.0.113.9, {proxy_hop}"})
    response = client.post("/auth/token", json=CREDS, headers={"x-forwarded-for": "203.0.113.9 , 10.9.9.9"})
    assert response.status_code == 429


def test_unparsable_forwarded_address_falls_back_to_the_peer(endterm: None, upstream: list,
                                                            frozen: list) -> None:
    # A junk XFF value must not become a fresh bucket key on every request.
    client = _client()
    statuses = [client.post("/auth/token", json=CREDS, headers={"x-forwarded-for": f"junk-{i}"}).status_code
                for i in range(6)]
    assert statuses == [401] * 5 + [429]


def test_student_burst_gets_429_with_retry_after(endterm: None, upstream: list, frozen: list) -> None:
    client = _client()
    s7 = _bearer("s7", "student", "s7")
    before = _sample("rate_limited_total", {"scope": "student"})
    statuses = [client.get("/api/students/s7", headers=s7).status_code for _ in range(20)]
    assert statuses == [200] * 20
    start = _offset()
    response = client.get("/api/students/s7", headers=s7)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "1"  # ceil(0.1 s)
    assert len(upstream) == 20
    assert _sample("rate_limited_total", {"scope": "student"}) == before + 1
    (event,) = _audit_since(start)
    assert (event["reason"], event["sub"], event["role"], event["scope"]) == ("rate_limited", "s7", "student", "student")
    assert event["action"] == "GET /api/students/{id}"  # the route template, not the raw path

    # other principals are unaffected: another student, and staff
    assert client.get("/api/students/s8", headers=_bearer("s8", "student", "s8")).status_code == 200
    assert client.get("/api/students", headers=_bearer("bursar", "staff")).status_code == 200
    frozen[0] += 0.1  # one token back at 10/s
    assert client.get("/api/students/s7", headers=s7).status_code == 200
    assert client.get("/api/students/s7", headers=s7).status_code == 429


def test_rate_limit_applies_before_authorization(endterm: None, upstream: list, frozen: list) -> None:
    # Privilege probing with a valid token is throttled too: the quota is spent per request,
    # whatever the policy then decides, so a stolen student token cannot probe at full speed.
    client = _client()
    s7 = _bearer("s7", "student", "s7")
    statuses = [client.get("/api/students", headers=s7).status_code for _ in range(21)]
    assert statuses == [403] * 20 + [429]
    assert upstream == []


def test_payments_carry_their_own_quota_cost(endterm: None, upstream: list, frozen: list) -> None:
    client = _client()
    s7 = _bearer("s7", "student", "s7")
    statuses = [client.post("/api/payments", json={"studentId": "s7", "amount": 1},
                            headers={**s7, "idempotency-key": f"k-{i}"}).status_code for i in range(21)]
    assert statuses == [201] * 20 + [429]
    assert len(upstream) == 20


def test_staff_peak_through_the_gateway_is_never_limited(endterm: None, upstream: list, frozen: list) -> None:
    client = _client()
    staff = _bearer("bursar", "staff")
    before = _sample("rate_limited_total", {"scope": "staff"})
    statuses = {client.get("/api/students/s7", headers=staff).status_code for _ in range(300)}
    assert statuses == {200}
    assert _sample("rate_limited_total", {"scope": "staff"}) == before


def test_unauthenticated_requests_are_401_not_429(endterm: None, upstream: list, frozen: list) -> None:
    # Without a principal there is no per-principal bucket: authentication fails first.
    client = _client()
    assert {client.get("/api/students/s7").status_code for _ in range(30)} == {401}


@pytest.mark.parametrize("mode", ["baseline", "ft"])
def test_no_rate_limit_in_baseline_and_midterm(request: pytest.FixtureRequest, upstream: list,
                                               frozen: list, mode: str) -> None:
    if mode != "baseline":
        request.getfixturevalue(mode)
    client = _client()
    assert {client.post("/auth/token", json=CREDS).status_code for _ in range(10)} == {401}
    assert {client.get("/api/students/s7").status_code for _ in range(30)} == {200}
