"""Strict input validation and gateway request limits (Task 10).

In endterm the services validate every POST body against a closed pydantic model and answer
422 {"error": "invalid input", "fields": [...]} before touching the database; the gateway rejects
oversized bodies (413), non-JSON POST bodies (400) and unsafe path segments (400) before any
authentication work or upstream call. Baseline and midterm keep the lenient midterm logic, so the
three modes stay comparable (in midterm, ``amount: 1e9`` overflows NUMERIC(10,2) and is a 5xx).
"""
from __future__ import annotations

import json
from decimal import Decimal

import httpx
import pytest
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.security import validation
from app.security.validation import PaymentIn, StudentIn, TimetableJobIn

SECRET = "unit-test-secret-0123456789abcdefghij"


def _rejected(result) -> list:
    """The field names of a 422 from ``validation.parse``; fails if the input was accepted."""
    assert isinstance(result, JSONResponse), f"accepted: {result!r}"
    assert result.status_code == 422
    body = json.loads(result.body)
    assert body["error"] == "invalid input"
    return [f["field"] for f in body["fields"]]


# --- the models --------------------------------------------------------------------------------

@pytest.mark.parametrize("override,field", [
    ({"amount": -1}, "amount"),
    ({"amount": 0}, "amount"),
    ({"amount": 10000.01}, "amount"),
    ({"amount": 1e9}, "amount"),            # overflows NUMERIC(10,2): a 5xx in baseline/midterm
    ({"amount": "abc"}, "amount"),
    ({"amount": 1.001}, "amount"),
    ({"amount": float("nan")}, "amount"),
    ({"amount": float("inf")}, "amount"),
    ({"amount": True}, "amount"),
    ({"amount": None}, "amount"),
    ({"studentId": "s1'; DROP TABLE students;--"}, "studentId"),
    ({"studentId": ""}, "studentId"),
    ({"studentId": "S1"}, "studentId"),
    ({"studentId": "s1\n"}, "studentId"),
    ({"studentId": "s1234567"}, "studentId"),
    ({"studentId": 7}, "studentId"),
    ({"admin": True}, "admin"),             # an extra field
])
def test_payment_rejects(override: dict, field: str) -> None:
    body = {"studentId": "s7", "amount": 100, **override}
    assert field in _rejected(validation.parse(PaymentIn, body))


@pytest.mark.parametrize("missing", ["studentId", "amount"])
def test_payment_rejects_missing_field(missing: str) -> None:
    body = {"studentId": "s7", "amount": 100}
    del body[missing]
    assert missing in _rejected(validation.parse(PaymentIn, body))


def test_payment_accepts_valid() -> None:
    payment = validation.parse(PaymentIn, {"studentId": "s7", "amount": 100.50})
    assert isinstance(payment, PaymentIn)
    assert payment.studentId == "s7"
    assert payment.amount == Decimal("100.50")
    assert validation.parse(PaymentIn, {"studentId": "s200", "amount": 10000}).amount == Decimal("10000")


def test_rejection_does_not_echo_the_input() -> None:
    hostile = "s1'; DROP TABLE students;--"
    result = validation.parse(PaymentIn, {"studentId": hostile, "amount": 1})
    assert hostile not in result.body.decode()
    assert "DROP" not in result.body.decode()


@pytest.mark.parametrize("name", ["Ann\x00", "Ann\nINFO forged log line", "\x1b[31mred", "a\tb",
                                  "evil‮txt.exe", "line sep", "   ", ""])
def test_student_name_rejects_control_chars(name: str) -> None:
    assert "name" in _rejected(validation.parse(StudentIn, {"id": "s9", "name": name}))


def test_student_accepts_valid_and_defaults_credits() -> None:
    student = validation.parse(StudentIn, {"id": "s9", "name": "Aigerim Nurlanqyzy-O'Neil"})
    assert isinstance(student, StudentIn)
    assert (student.id, student.credits) == ("s9", 0)
    assert validation.parse(StudentIn, {"id": "s9", "name": "Әлия Сәрсенова", "credits": 300}).credits == 300


@pytest.mark.parametrize("override,field", [
    ({"id": "x1"}, "id"),
    ({"name": "n" * 101}, "name"),
    ({"credits": -1}, "credits"),
    ({"credits": 301}, "credits"),
    ({"credits": "30"}, "credits"),
    ({"credits": True}, "credits"),
    ({"balance": 1_000_000}, "balance"),    # mass assignment of a field the client must not set
])
def test_student_rejects(override: dict, field: str) -> None:
    body = {"id": "s9", "name": "Nine", **override}
    assert field in _rejected(validation.parse(StudentIn, body))


@pytest.mark.parametrize("term", ["2026-fall", "2027-spring", "1999-summer", "demo-1762700000000"])
def test_timetable_term_accepts(term: str) -> None:
    assert validation.parse(TimetableJobIn, {"term": term}).term == term


@pytest.mark.parametrize("term", ["", "2026-autumn", "2026-Fall", "26-fall", "demo-", "demo-x",
                                  "2026-fall\n", "../2026-fall", "demo-" + "1" * 40, 2026])
def test_timetable_term_rejects(term) -> None:
    assert "term" in _rejected(validation.parse(TimetableJobIn, {"term": term}))


# --- the services ------------------------------------------------------------------------------

@pytest.fixture
def no_db(monkeypatch: pytest.MonkeyPatch) -> list:
    """Payment's DB steps replaced by recorders; returns the checkpoints written."""
    from app.services import payment

    written: list = []

    async def write_checkpoint(key, student_id, amount):
        written.append((student_id, amount))
        return None  # "duplicate": the service answers with the original response

    async def original_response(key, student_id=None, amount=None):
        return JSONResponse(status_code=200, content={"replayed": True})

    monkeypatch.setattr(payment.checkpoint_rollback, "write_checkpoint", write_checkpoint)
    monkeypatch.setattr(payment.idempotency, "original_response", original_response)
    return written


def test_payment_service_rejects_before_the_database_in_endterm(endterm: None, no_db: list) -> None:
    from app.services import payment

    response = TestClient(payment.app).post("/", json={"studentId": "s7", "amount": 1e9},
                                            headers={"idempotency-key": "k-1"})
    assert response.status_code == 422
    assert response.json()["error"] == "invalid input"
    assert [f["field"] for f in response.json()["fields"]] == ["amount"]
    assert no_db == []


def test_payment_service_uses_the_validated_values_in_endterm(endterm: None, no_db: list) -> None:
    from app.services import payment

    response = TestClient(payment.app).post("/", json={"studentId": "s7", "amount": 100.50},
                                            headers={"idempotency-key": "k-2"})
    assert response.status_code == 200
    assert no_db == [("s7", Decimal("100.50"))]


def test_payment_service_keeps_midterm_leniency(ft: None, no_db: list) -> None:
    from app.services import payment

    client = TestClient(payment.app)
    assert client.post("/", json={"studentId": "s7", "amount": "abc"}).status_code == 400  # midterm check
    assert client.post("/", json={"studentId": "s7", "amount": 1e9, "x": 1}).status_code == 200
    assert no_db == [("s7", 1e9)]  # reaches the database (where NUMERIC(10,2) overflows)


def test_student_service_rejects_control_chars_in_endterm(endterm: None,
                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import student

    calls: list = []

    async def write(sql, params):
        calls.append(params)
        return [{"id": params[0], "name": params[1], "credits": params[2], "balance": 0}]

    monkeypatch.setattr(student, "write", write)
    client = TestClient(student.app)
    assert client.post("/", json={"id": "s9", "name": "x\nFORGED"}).status_code == 422
    assert calls == []
    assert client.post("/", json={"id": "s9", "name": "Nine", "credits": 30}).status_code == 201
    assert calls == [("s9", "Nine", 30)]


def test_timetable_service_rejects_bad_term_in_endterm(endterm: None, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import timetable

    calls: list = []

    async def write(sql, params):
        calls.append(params)
        return []  # the term exists: no job is started

    async def read(sql, params=None):
        return [{"term": params[0], "state": "running", "owner": "timetable-1"}]

    monkeypatch.setattr(timetable, "write", write)
    monkeypatch.setattr(timetable, "read", read)
    client = TestClient(timetable.app)
    assert client.post("/", json={"term": "x'; DELETE FROM timetable_jobs;--"}).status_code == 422
    assert calls == []
    response = client.post("/", json={"term": "2026-fall"})
    assert response.status_code == 200 and response.json()["duplicate"] is True
    assert calls[0][0] == "2026-fall"


# --- the gateway -------------------------------------------------------------------------------

@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> list:
    """Every API pool answers from one fake replica; returns the calls it saw."""
    from app.fault_tolerance.software import circuit_breaker
    from app.services import gateway

    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setattr(circuit_breaker, "_breakers", {})
    for pool in ("students", "payments", "transcripts", "timetables", "auth"):
        monkeypatch.setitem(gateway.POOLS, pool, [f"http://{pool}-1:3000"])
    seen: list = []

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        seen.append({"method": method, "url": url, "content": content})
        return httpx.Response(201 if method == "POST" else 200, json={"ok": True})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    return seen


def _gateway(role: str = "admin", student_id=None) -> TestClient:
    from app.security import tokens
    from app.services import gateway

    sub = student_id or role
    return TestClient(gateway.app, headers={"authorization": f"Bearer {tokens.issue(sub, role, student_id)}",
                                            "idempotency-key": "limits-0001"})


def _big_payment() -> bytes:
    return json.dumps({"studentId": "s7", "amount": 1, "memo": "x" * 20_000}).encode()


def test_gateway_rejects_oversized_body_413(endterm: None, upstream: list) -> None:
    response = _gateway().post("/api/payments", content=_big_payment(),
                               headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"] == "request body too large"
    assert upstream == []


def test_gateway_rejects_oversized_chunked_body_413(endterm: None, upstream: list) -> None:
    def chunks():  # no Content-Length: the limit must hold while streaming
        yield b'{"studentId": "s7", "amount": 1, "memo": "'
        for _ in range(40):
            yield b"x" * 1024
        yield b'"}'

    response = _gateway().post("/api/payments", content=chunks(), headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert upstream == []


def test_gateway_accepts_body_at_the_limit(endterm: None, upstream: list) -> None:
    prefix, suffix = b'{"studentId": "s7", "amount": 1, "memo": "', b'"}'
    body = prefix + b"x" * (validation.MAX_BODY_BYTES - len(prefix) - len(suffix)) + suffix
    assert len(body) == validation.MAX_BODY_BYTES
    response = _gateway().post("/api/payments", content=body, headers={"content-type": "application/json"})
    assert response.status_code == 201
    assert upstream[0]["content"] == body  # forwarded intact (the service then rejects "memo")


@pytest.mark.parametrize("path", [
    "/api/students/%3Cscript%3E",
    "/api/students/s1;DROP",
    "/api/transcripts/" + "a" * 65,
    "/api/students/s1%2F..%2Fpayments",      # decoded: s1/../payments
    "/api/students/%2E%2E",
    "/api/timetables/2026-fall/",            # an empty segment
    "/api/payments/k%C3%A9y",                # non-ASCII
    "/api/students/s1%20",
])
def test_gateway_rejects_bad_path_segment_400(endterm: None, upstream: list, path: str) -> None:
    response = _gateway().get(path)
    assert response.status_code == 400
    assert response.json()["error"] == "invalid path"
    assert upstream == []


def test_gateway_never_forwards_a_newline_in_the_path(endterm: None, upstream: list) -> None:
    # Starlette's {path:path} does not match a newline, so the router answers 404 before any route
    # (in every mode); either way the hostile segment never reaches a replica or a log line verbatim.
    response = _gateway().get("/api/students/s1%0AINFO%20forged")
    assert response.status_code in (400, 404)
    assert upstream == []


@pytest.mark.parametrize("path", ["/api/students", "/api/students/s7", "/api/payments/pay-s7_0001.v2",
                                  "/api/timetables/2026-fall", "/api/transcripts/" + "a" * 64])
def test_gateway_accepts_safe_paths(endterm: None, upstream: list, path: str) -> None:
    assert _gateway().get(path).status_code == 200
    assert len(upstream) == 1


@pytest.mark.parametrize("content,ctype", [
    (b"not json", "application/json"),
    (b"", "application/json"),
    (b'["s7", 100]', "application/json"),
    (b'"s7"', "application/json"),
    (b'{"studentId": "s7", "amount": NaN}', "application/json"),
    (b"[" * 5_000, "application/json"),
    (b'{"studentId": "s7", "amount": 1}', "application/x-www-form-urlencoded"),
    (b'{"studentId": "s7", "amount": 1}', "text/plain"),
])
def test_gateway_rejects_non_json_post_400(endterm: None, upstream: list, content: bytes, ctype: str) -> None:
    response = _gateway().post("/api/payments", content=content, headers={"content-type": ctype})
    assert response.status_code == 400
    assert response.json()["error"] == "body must be a JSON object"
    assert upstream == []


def test_gateway_accepts_json_with_charset(endterm: None, upstream: list) -> None:
    response = _gateway().post("/api/payments", content=b'{"studentId": "s7", "amount": 1}',
                               headers={"content-type": "application/json; charset=utf-8"})
    assert response.status_code == 201


def test_limits_apply_before_authentication(endterm: None, upstream: list) -> None:
    # Cheap checks first: an anonymous 1 MB body is never parsed for the ownership check.
    from app.services import gateway

    client = TestClient(gateway.app)
    assert client.post("/api/payments", content=_big_payment(),
                       headers={"content-type": "application/json"}).status_code == 413
    assert client.get("/api/students/%3Cx%3E").status_code == 400
    assert client.get("/api/students/s7").status_code == 401  # a safe path still needs a token


def test_login_body_is_limited_in_endterm(endterm: None, upstream: list) -> None:
    from app.services import gateway

    client = TestClient(gateway.app)
    big = json.dumps({"username": "bursar", "password": "p" * 20_000}).encode()
    assert client.post("/auth/token", content=big).status_code == 413
    assert client.post("/auth/token", content=b"not json").status_code == 400
    assert upstream == []
    raw = b'{"username": "bursar", "password": "pw"}'  # `curl -d` sends a form type: still relayed
    response = client.post("/auth/token", content=raw, headers={"content-type": "application/x-www-form-urlencoded"})
    assert response.status_code == 201
    assert upstream[0]["content"] == raw


@pytest.mark.parametrize("mode", ["baseline", "ft"])
def test_gateway_limits_off_outside_endterm(request: pytest.FixtureRequest, upstream: list, mode: str) -> None:
    if mode != "baseline":
        request.getfixturevalue(mode)
    from app.services import gateway

    client = TestClient(gateway.app)
    assert client.post("/api/payments", content=_big_payment(),
                       headers={"content-type": "application/json"}).status_code == 201
    assert client.get("/api/students/s1;DROP").status_code == 200
    assert len(upstream) == 2  # the midterm gateway forwards both, for the comparison


def test_path_ok() -> None:
    assert validation.path_ok("")
    assert validation.path_ok("s7")
    assert validation.path_ok("a/b")
    assert not validation.path_ok("s7\n")
    assert not validation.path_ok(".")
    assert not validation.path_ok("a//b")


@pytest.mark.parametrize("body", [
    {"studentId": "s7", "amount": 1e9},
    {"studentId": "s7", "amount": -1},
    {"studentId": "s7", "amount": "abc"},
    {"studentId": "s7", "amount": 1.001},
    {"studentId": "s1'; DROP TABLE students;--", "amount": 1},
    {"studentId": "s7", "amount": 1, "state": "completed"},
    b'{"studentId": "s7", "amount": NaN}',
    b"{" * 3_000,
    _big_payment(),
])
def test_malformed_payment_422_not_5xx(endterm: None, no_db: list, monkeypatch: pytest.MonkeyPatch,
                                       body) -> None:
    """Gateway and the real payment app together: malformed input is a 4xx, never a 5xx or a DB write."""
    from app.fault_tolerance.software import circuit_breaker
    from app.services import gateway, payment

    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setattr(circuit_breaker, "_breakers", {})
    monkeypatch.setitem(gateway.POOLS, "payments", ["http://payment-1:3000"])

    async def to_payment_app(method, url, content=None, headers=None, timeout=None):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=payment.app),
                                     base_url="http://payment-1:3000") as upstream:
            return await upstream.request(method, url, content=content, headers=headers)

    monkeypatch.setattr(gateway._client, "request", to_payment_app)
    content = body if isinstance(body, bytes) else json.dumps(body).encode()
    response = _gateway("staff").post("/api/payments", content=content, headers={"content-type": "application/json"})
    assert response.status_code in (400, 413, 422), response.text
    assert no_db == []
    assert circuit_breaker.for_pool("payments").state() == "closed"  # client errors never trip the breaker
