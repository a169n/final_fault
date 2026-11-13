"""The gateway proxies POST /auth/token to the auth pool (AUTH_URLS), in every mode."""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

CREDS = {"username": "bursar", "password": "pw"}


@pytest.fixture
def auth_upstream(monkeypatch: pytest.MonkeyPatch) -> list:
    from app.services import gateway

    monkeypatch.setitem(gateway.POOLS, "auth", ["http://auth-1:3000"])
    seen: list = []

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        seen.append({"method": method, "url": url, "content": content, "headers": headers})
        if b'"pw"' in (content or b""):
            return httpx.Response(200, json={"access_token": "t", "token_type": "bearer", "expires_in": 900})
        return httpx.Response(401, json={"error": "invalid credentials"})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    return seen


def _client() -> TestClient:
    from app.services import gateway

    return TestClient(gateway.app)


@pytest.mark.parametrize("mode", ["baseline", "ft", "endterm"])
def test_token_request_proxied_to_auth_pool(request: pytest.FixtureRequest, auth_upstream: list,
                                            mode: str) -> None:
    if mode != "baseline":
        request.getfixturevalue(mode)
    response = _client().post("/auth/token", json=CREDS)
    assert response.status_code == 200
    assert response.json()["access_token"] == "t"
    assert [(c["method"], c["url"]) for c in auth_upstream] == [("POST", "http://auth-1:3000/token")]


def test_wrong_password_401_passes_through_without_retry(ft: None, auth_upstream: list) -> None:
    response = _client().post("/auth/token", json={"username": "bursar", "password": "nope"})
    assert response.status_code == 401
    assert response.json() == {"error": "invalid credentials"}
    assert len(auth_upstream) == 1  # 4xx is never retried


def test_auth_pool_not_reachable_through_api_prefix(ft: None, auth_upstream: list) -> None:
    assert _client().post("/api/auth/token", json=CREDS).status_code == 422  # not a Pool
    assert auth_upstream == []


def test_form_content_type_body_relayed_as_is(ft: None, auth_upstream: list) -> None:
    # `curl -d '{...}'` sends application/x-www-form-urlencoded; the gateway must not 422 it
    raw = b'{"username":"bursar","password":"pw"}'
    response = _client().post("/auth/token", content=raw,
                              headers={"content-type": "application/x-www-form-urlencoded"})
    assert response.status_code == 200
    assert auth_upstream[0]["content"] == raw


def test_authorization_header_not_forwarded_to_auth(ft: None, auth_upstream: list) -> None:
    _client().post("/auth/token", json=CREDS, headers={"authorization": "Bearer abc.def.ghi"})
    assert "authorization" not in {k.lower() for k in auth_upstream[0]["headers"]}


@pytest.mark.parametrize("mode", ["ft", "endterm"])
def test_client_caused_login_failures_do_not_open_the_auth_breaker(
        request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    # Hostile but unauthenticated input (a lone-surrogate password, a deeply nested body, junk)
    # must come back from the real auth app as a 4xx: never retried, never a breaker failure, never
    # an outlier-ejection error. Otherwise anyone could block every login with a few requests.
    from app.fault_tolerance.software import circuit_breaker, outlier_ejection
    from app.security import passwords
    from app.services import auth, gateway

    request.getfixturevalue(mode)
    monkeypatch.setenv("JWT_SECRET", "unit-test-secret-0123456789abcdefghij")
    monkeypatch.setenv("RATE_LIMIT_LOGIN_BURST", "1000")  # this test is about the breaker, not brute force
    monkeypatch.setattr(circuit_breaker, "_breakers", {})
    monkeypatch.setattr(outlier_ejection, "_detectors", {})
    monkeypatch.setitem(gateway.POOLS, "auth", ["http://auth-1:3000"])
    stored = passwords.hash_password("pw")

    async def fake_find_user(username: str):
        return {"username": "bursar", "password_hash": stored, "role": "staff", "student_id": None} \
            if username == "bursar" else None

    monkeypatch.setattr(auth, "find_user", fake_find_user)
    seen: list = []

    async def to_auth_app(method, url, content=None, headers=None, timeout=None):
        seen.append(url)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=auth.app),
                                     base_url="http://auth-1:3000") as upstream:
            return await upstream.request(method, url, content=content, headers=headers)

    monkeypatch.setattr(gateway._client, "request", to_auth_app)
    hostile = [b'{"username":"bursar","password":"\\ud800"}', b"[" * 200_000, b"not json"]
    rounds = circuit_breaker.THRESHOLD + 1
    client = _client()
    for _ in range(rounds):
        for raw in hostile:
            assert client.post("/auth/token", content=raw).status_code in (400, 401, 413)
    # In endterm the gateway's request limits (Task 10) stop the oversized and non-JSON bodies at the
    # edge; only the valid-JSON one is relayed. Either way: one upstream attempt each, 4xx is never retried.
    relayed = 1 if mode == "endterm" else len(hostile)
    assert len(seen) == rounds * relayed
    assert circuit_breaker.for_pool("auth").state() == "closed"
    assert not outlier_ejection.for_pool("auth").is_ejected("http://auth-1:3000")
    ok = client.post("/auth/token", json=CREDS)
    assert ok.status_code == 200 and ok.json()["token_type"] == "bearer"
