"""End-to-end tests against the running endterm stack (docker compose).

Run with the stack up:  npm run up:endterm && python3 -m pytest -m integration -q
Every test skips unless GET {STACK_URL}/health reports mode == "endterm", so a local run without
the stack never fails because nothing is listening. With STACK_REQUIRED=1 (the CI integration job)
an unreachable stack is a failure instead, so the suite cannot pass by skipping.

They use only synthetic data and only the local stack: the demo users seeded by auth-1 with
DEMO_PASSWORD, and the primary database on 127.0.0.1:55432 as the least-privilege role app_rw
(APP_DB_PASSWORD), both read from the generated, git-ignored .env.
"""
from __future__ import annotations

import json
import os
import pathlib
import time
import uuid
from decimal import Decimal
from typing import Dict, Iterator, Optional

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.integration

ROOT = pathlib.Path(__file__).resolve().parents[2]
STACK_URL = os.environ.get("STACK_URL", "http://localhost:8080")       # nginx, the public entry point
DB_HOST = os.environ.get("STACK_DB_HOST", "127.0.0.1")
DB_PORT = int(os.environ.get("STACK_DB_PORT", "55432"))                  # postgres-primary, host-only
EVENTS = ROOT / "logs" / "events.jsonl"                                   # every service appends here
STACK_REQUIRED = os.environ.get("STACK_REQUIRED") == "1"


def _unavailable(reason: str) -> None:
    if STACK_REQUIRED:
        pytest.fail(reason, pytrace=False)
    pytest.skip(reason)


def _dotenv() -> Dict[str, str]:
    path = ROOT / ".env"
    env: Dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env


def _secret(name: str) -> str:
    value = os.environ.get(name) or _dotenv().get(name)
    if not value:
        _unavailable(f"{name} not found in the environment or .env (run npm run up:endterm)")
    return value


@pytest.fixture(scope="module")
def client() -> Iterator[httpx.Client]:
    with httpx.Client(base_url=STACK_URL, timeout=10.0) as c:
        try:
            health = c.get("/health").json()
        except (httpx.HTTPError, ValueError):
            _unavailable(f"no stack at {STACK_URL} (run npm run up:endterm)")
        if health.get("mode") != "endterm":
            _unavailable(f"stack at {STACK_URL} is in mode {health.get('mode')!r}, not endterm")
        yield c


@pytest.fixture(scope="module")
def tokens(client: httpx.Client) -> Dict[str, str]:
    """One token per demo user, fetched once: login is limited to 1/s, burst 5, per client IP.

    On a freshly started stack auth-1 may still be seeding the demo users (401) or not ready (5xx),
    so a login is retried for up to 30 s before the test fails.
    """
    password = _secret("DEMO_PASSWORD")
    out: Dict[str, str] = {}
    for user in ("s7", "s8", "bursar"):
        deadline = time.monotonic() + 30
        while True:
            r = client.post("/auth/token", json={"username": user, "password": password})
            if r.status_code == 200 or time.monotonic() > deadline:
                break
            time.sleep(max(1.5, float(r.headers.get("retry-after", "0") or 0)))
        assert r.status_code == 200, (user, r.status_code, r.text)
        out[user] = r.json()["access_token"]
    return out


@pytest.fixture(scope="module")
def db(client: httpx.Client) -> Iterator[psycopg.Connection]:
    """The primary, as the application role: what a compromised service could do, no more."""
    conninfo = dict(host=DB_HOST, port=DB_PORT, dbname="university", user="app_rw",
                    password=_secret("APP_DB_PASSWORD"), connect_timeout=5)
    try:
        conn = psycopg.connect(**conninfo, autocommit=True)
    except psycopg.OperationalError as exc:
        _unavailable(f"cannot reach postgres-primary at {DB_HOST}:{DB_PORT}: {exc}")
    with conn:
        yield conn


def _auth(token: str, key: Optional[str] = None, rid: Optional[str] = None) -> Dict[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    if key:
        headers["Idempotency-Key"] = key
    if rid:
        headers["X-Request-ID"] = rid
    return headers


def _balance(db: psycopg.Connection, student_id: str) -> Decimal:
    row = db.execute("SELECT balance FROM students WHERE id = %s", (student_id,)).fetchone()
    assert row is not None, student_id
    return row[0]


def _payments(db: psycopg.Connection, key: str) -> list:
    return db.execute("SELECT state, student_id, amount FROM payments WHERE idempotency_key = %s",
                      (key,)).fetchall()


def _key(tag: str) -> str:
    return f"it-{tag}-{uuid.uuid4().hex[:16]}"


def test_login_and_read_own_record(client: httpx.Client, tokens: Dict[str, str]) -> None:
    own = client.get("/api/students/s7", headers=_auth(tokens["s7"]))
    assert own.status_code == 200, own.text
    assert own.json()["id"] == "s7"
    other = client.get("/api/students/s8", headers=_auth(tokens["s7"]))  # someone else's record
    assert other.status_code == 403


def test_payment_idempotent_end_to_end(client: httpx.Client, tokens: Dict[str, str],
                                       db: psycopg.Connection) -> None:
    key = _key("idem")
    before = _balance(db, "s7")
    body = {"studentId": "s7", "amount": 100}
    first = client.post("/api/payments", json=body, headers=_auth(tokens["s7"], key))
    second = client.post("/api/payments", json=body, headers=_auth(tokens["s7"], key))  # a client retry
    assert first.status_code == 201, first.text
    assert second.status_code < 300, second.text
    assert second.json()["id"] == first.json()["id"]  # the original payment, not a new one
    rows = _payments(db, key)
    assert rows == [("completed", "s7", Decimal("100.00"))]
    assert _balance(db, "s7") - before == Decimal("100.00")  # charged once


def test_unauthorized_payment_denied_and_db_unchanged(client: httpx.Client, tokens: Dict[str, str],
                                                      db: psycopg.Connection) -> None:
    before = _balance(db, "s8")
    body = {"studentId": "s8", "amount": 100}
    forged = tokens["s7"][:-4] + ("AAAA" if not tokens["s7"].endswith("AAAA") else "BBBB")
    attempts = {
        "anonymous": ({"Idempotency-Key": (k1 := _key("anon"))}, 401),
        "forged token": (_auth(forged, (k2 := _key("forged"))), 401),
        "other student": (_auth(tokens["s7"], (k3 := _key("owner"))), 403),
    }
    for name, (headers, expected) in attempts.items():
        r = client.post("/api/payments", json=body, headers=headers)
        assert r.status_code == expected, (name, r.status_code, r.text)
    for key in (k1, k2, k3):
        assert _payments(db, key) == [], key  # denied at the gateway: nothing reached the ledger
    assert _balance(db, "s8") == before


@pytest.mark.parametrize("body", [
    {"studentId": "s7", "amount": "abc"},
    {"studentId": "s7", "amount": 1e9},              # midterm: overflows NUMERIC(10,2) -> 5xx
    {"studentId": "s7", "amount": -5},
    {"studentId": "s7"},
    {"studentId": "../etc/passwd", "amount": 10},
    {"studentId": "s7", "amount": 10, "admin": True},  # closed model: unknown fields are rejected
])
def test_malformed_payment_422_not_5xx(client: httpx.Client, tokens: Dict[str, str],
                                       db: psycopg.Connection, body: dict) -> None:
    key = _key("bad")
    r = client.post("/api/payments", json=body, headers=_auth(tokens["bursar"], key))
    assert r.status_code == 422, (r.status_code, r.text)
    assert _payments(db, key) == []


def _events_with_rid(rid: str) -> list:
    if not EVENTS.exists():
        return []
    with EVENTS.open(encoding="utf-8", errors="replace") as f:
        return [e for e in map(_safe_json, f) if e and e.get("rid") == rid]


def _safe_json(line: str) -> Optional[dict]:
    if '"rid"' not in line:
        return None
    try:
        return json.loads(line)
    except ValueError:
        return None


def test_request_id_propagates_to_payment_service_log(client: httpx.Client,
                                                      tokens: Dict[str, str]) -> None:
    if not EVENTS.exists():
        _unavailable(f"{EVENTS} not found: the stack's ./logs mount is not this checkout")
    rid = f"it-rid-{uuid.uuid4().hex}"
    r = client.post("/api/payments", json={"studentId": "s7", "amount": 1},
                    headers=_auth(tokens["s7"], _key("rid"), rid))
    assert r.status_code == 201, r.text
    assert r.headers.get("x-request-id") == rid
    deadline = time.monotonic() + 10
    services: set = set()
    while time.monotonic() < deadline:
        services = {e.get("svc", "") for e in _events_with_rid(rid)}
        if any(s.startswith("gateway-") for s in services) and any(s.startswith("payment-") for s in services):
            break
        time.sleep(0.2)
    assert any(s.startswith("gateway-") for s in services), services
    assert any(s.startswith("payment-") for s in services), services


def test_app_role_cannot_truncate(db: psycopg.Connection) -> None:
    for statement in ("TRUNCATE payments", "DELETE FROM payments", "DROP TABLE payments",
                      "ALTER TABLE students ADD COLUMN pwned INT"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute(statement)
    assert db.execute("SELECT count(*) FROM payments").fetchone()[0] >= 0  # still there, still readable


def test_app_role_cannot_change_users(db: psycopg.Connection) -> None:
    """No service may promote a user or reset a password hash (90-grants.sql: no UPDATE on app_users)."""
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.execute("UPDATE app_users SET role = 'admin' WHERE username = 's7'")
    assert db.execute("SELECT role FROM app_users WHERE username = 's7'").fetchone() == ("student",)


def test_idempotency_key_of_another_student_refused(client: httpx.Client, tokens: Dict[str, str],
                                                    db: psycopg.Connection) -> None:
    """s8 re-uses s7's key: a 409, nothing of s7's payment in the answer, nothing charged to s8."""
    key = _key("collide")
    first = client.post("/api/payments", json={"studentId": "s7", "amount": 1}, headers=_auth(tokens["s7"], key))
    assert first.status_code == 201, first.text
    before = _balance(db, "s8")
    other = client.post("/api/payments", json={"studentId": "s8", "amount": 1}, headers=_auth(tokens["s8"], key))
    assert other.status_code == 409, other.text
    assert "student_id" not in other.json() and "id" not in other.json()
    assert _payments(db, key) == [("completed", "s7", Decimal("1.00"))]
    assert _balance(db, "s8") == before


@pytest.mark.parametrize("segment", ["openapi.json", "health", "metrics", "docs"])
def test_upstream_endpoints_not_reachable_through_a_param(client: httpx.Client, tokens: Dict[str, str],
                                                          segment: str) -> None:
    r = client.get(f"/api/timetables/{segment}", headers=_auth(tokens["s7"]))
    assert r.status_code == 403, (segment, r.status_code, r.text)
