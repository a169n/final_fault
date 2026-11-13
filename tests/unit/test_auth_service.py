"""The auth microservice: POST /token issues a short-lived JWT for valid credentials.

The DB is stubbed (``auth.find_user``): these tests pin the HTTP contract, the identical
401 for an unknown user and a wrong password, and that a password never reaches a log.
"""
from __future__ import annotations

import json
import os
import pathlib
from typing import Dict, Optional

import pytest
from fastapi.testclient import TestClient

from app.core import metrics
from app.security import passwords, tokens
from app.security.tokens import Principal

SECRET = "unit-test-secret-0123456789abcdefghij"
_HASH = passwords.hash_password("right-password")  # once: scrypt is deliberately slow
USERS: Dict[str, dict] = {
    "bursar": {"username": "bursar", "password_hash": _HASH, "role": "staff", "student_id": None},
    "s7": {"username": "s7", "password_hash": _HASH, "role": "student", "student_id": "s7"},
}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from app.services import auth

    monkeypatch.setenv("JWT_SECRET", SECRET)
    looked_up = []

    async def fake_find_user(username: str) -> Optional[dict]:
        looked_up.append(username)
        return USERS.get(username)

    monkeypatch.setattr(auth, "find_user", fake_find_user)
    return TestClient(auth.app)  # no `with`: the lifespan (DB pools, seeding) is not started


def _denied() -> float:
    return metrics.AUTH_DENIED.labels(reason="invalid_credentials")._value.get()


def test_token_issued_for_valid_credentials(client: TestClient) -> None:
    response = client.post("/token", json={"username": "s7", "password": "right-password"})
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer" and body["expires_in"] == 900
    assert tokens.verify(body["access_token"]) == Principal(sub="s7", role="student", student_id="s7")


def test_token_accepts_json_without_content_type(client: TestClient) -> None:
    # `curl -d '{...}'` sends application/x-www-form-urlencoded; the body is JSON all the same
    response = client.post("/token", content=b'{"username":"bursar","password":"right-password"}',
                           headers={"content-type": "application/x-www-form-urlencoded"})
    assert response.status_code == 200
    assert tokens.verify(response.json()["access_token"]).role == "staff"


def test_unknown_user_and_wrong_password_get_the_same_401(client: TestClient) -> None:
    before = _denied()
    wrong = client.post("/token", json={"username": "bursar", "password": "nope"})
    unknown = client.post("/token", json={"username": "nobody", "password": "right-password"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"error": "invalid credentials"}  # no user enumeration
    assert _denied() == before + 2  # AuthFailureSpike counts failed logins


@pytest.mark.parametrize("body", [
    b"", b"not json", b"[]", b'{"username":"bursar"}', b'{"password":"x"}',
    b'{"username":1,"password":"x"}', b'{"username":"bursar","password":null}',
])
def test_malformed_login_body_is_400(client: TestClient, body: bytes) -> None:
    response = client.post("/token", content=body, headers={"content-type": "application/json"})
    assert response.status_code == 400
    assert response.json() == {"error": "username and password are required"}


def test_deeply_nested_login_body_is_400_not_5xx(client: TestClient) -> None:
    # json.loads raises RecursionError here; it must not escape as a 503 (which the gateway would
    # retry and count against the auth circuit breaker)
    response = client.post("/token", content=b"[" * 200_000, headers={"content-type": "application/json"})
    assert response.status_code == 400
    assert response.json() == {"error": "username and password are required"}


@pytest.mark.parametrize("raw", [
    b'{"username":"bursar","password":"\\ud800"}',      # lone surrogate, known user
    b'{"username":"nobody","password":"x\\udfffy"}',     # lone surrogate, unknown user
    b'{"username":"bad name","password":"\\ud800"}',     # lone surrogate, implausible username
])
def test_lone_surrogate_password_is_invalid_credentials(client: TestClient, raw: bytes) -> None:
    before = _denied()
    response = client.post("/token", content=raw, headers={"content-type": "application/json"})
    assert response.status_code == 401
    assert response.json() == {"error": "invalid credentials"}
    assert _denied() == before + 1  # a failed login like any other: AuthFailureSpike sees it


@pytest.mark.parametrize("username", ["bad\nname", "x" * 65, "s7'; DROP TABLE app_users;--", "ünïcode"])
def test_odd_usernames_are_invalid_credentials_without_lookup(monkeypatch: pytest.MonkeyPatch,
                                                              client: TestClient, username: str) -> None:
    from app.services import auth

    async def must_not_be_called(_: str):
        raise AssertionError("an implausible username must not reach the DB")

    monkeypatch.setattr(auth, "find_user", must_not_be_called)
    response = client.post("/token", json={"username": username, "password": "right-password"})
    assert response.status_code == 401
    assert response.json() == {"error": "invalid credentials"}


def test_login_log_lines_never_contain_the_password(client: TestClient) -> None:
    log_file = pathlib.Path(os.environ["LOG_DIR"]) / "events.jsonl"
    start = log_file.stat().st_size if log_file.exists() else 0
    client.post("/token", json={"username": "bursar", "password": "hunter2"})
    client.post("/token", json={"username": "bursar", "password": "right-password"},
                headers={"authorization": "Bearer abc.def.ghi"})
    written = log_file.read_text()[start:]
    logins = [e for e in map(json.loads, written.splitlines()) if e.get("kind") == "audit"]
    assert [(e["action"], e["outcome"]) for e in logins] == [("login", "deny"), ("login", "allow")]  # Task 9
    assert "hunter2" not in written and "right-password" not in written
    assert "Bearer" not in written and "access_token" not in written


async def test_seed_creates_demo_users_only_when_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import auth

    writes = []

    async def fake_read_primary(sql, params=()):
        return [{"n": 0}]

    async def fake_write(sql, params=()):
        writes.append(params)
        return []

    monkeypatch.setattr(auth, "read_primary", fake_read_primary)
    monkeypatch.setattr(auth, "write", fake_write)
    assert await auth.seed_if_empty("demo-pw") is True
    seeded = {p[0]: (p[2], p[3]) for p in writes}
    assert seeded == {"admin": ("admin", None), "bursar": ("staff", None),
                      "s7": ("student", "s7"), "s8": ("student", "s8")}
    assert all(passwords.verify_password("demo-pw", p[1]) for p in writes)
    assert all("demo-pw" not in p[1] for p in writes)

    async def populated(sql, params=()):
        return [{"n": 4}]

    writes.clear()
    monkeypatch.setattr(auth, "read_primary", populated)
    assert await auth.seed_if_empty("demo-pw") is False
    assert writes == []  # never overwrites existing users (or a changed password)
