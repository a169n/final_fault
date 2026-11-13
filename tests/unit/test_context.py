"""Correlation IDs: validated request ids, carried into every log line and response."""
from __future__ import annotations

import json
import pathlib
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import eventlog
from app.core.context import REQUEST_ID, accept_request_id
from app.core.eventlog import log
from app.core.service import create_app

UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _last_event() -> dict:
    lines = (pathlib.Path(eventlog.LOG_DIR) / "events.jsonl").read_text().splitlines()
    return json.loads(lines[-1])


def test_valid_request_id_kept() -> None:
    assert accept_request_id("abcd-1234-efgh") == "abcd-1234-efgh"


@pytest.mark.parametrize("raw", ["a\nb" * 5, "x" * 10_000, "ид-12345678", None, "", "short"])
def test_hostile_request_id_replaced(raw) -> None:
    assert UUID4.match(accept_request_id(raw))


def test_log_line_contains_rid_and_level() -> None:
    token = REQUEST_ID.set("rid-under-test-1")
    try:
        log(kind="t", ok=False)
    finally:
        REQUEST_ID.reset(token)
    event = _last_event()
    assert event["rid"] == "rid-under-test-1"
    assert event["level"] == "error"


def test_log_level_info_by_default_and_explicit_level_wins() -> None:
    log(kind="t", ok=True)
    assert _last_event()["level"] == "info"
    log(kind="t")
    assert _last_event()["level"] == "info"
    log(kind="t", ok=False, level="warn")
    assert _last_event()["level"] == "warn"


def _app() -> TestClient:
    app = create_app(with_db=False)

    @app.get("/ping")
    async def ping():
        log(kind="ping", ok=True)
        return {"rid": REQUEST_ID.get()}

    return TestClient(app)


def test_middleware_echoes_request_id() -> None:
    client = _app()
    response = client.get("/ping", headers={"x-request-id": "client-rid-0001"})
    assert response.headers["x-request-id"] == "client-rid-0001"
    assert response.json()["rid"] == "client-rid-0001"  # visible to the handler

    fresh = client.get("/ping")
    assert UUID4.match(fresh.headers["x-request-id"])
    assert fresh.json()["rid"] == fresh.headers["x-request-id"]


def test_middleware_replaces_hostile_request_id_and_logs_it() -> None:
    client = _app()
    response = client.get("/ping", headers={"x-request-id": "x" * 500})
    rid = response.headers["x-request-id"]
    assert UUID4.match(rid)
    event = _last_event()  # the middleware's own request line, written after the handler's
    assert event["kind"] == "request"
    assert event["rid"] == rid
    assert REQUEST_ID.get() is None  # reset after the request


def test_gateway_forwards_same_request_id_on_every_attempt(ft: None, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.fault_tolerance.software import retry
    from app.services import gateway

    monkeypatch.setitem(gateway.POOLS, "students", ["http://s1:8000", "http://s2:8000"])
    monkeypatch.setattr(retry, "BACKOFF_MS", 0)
    seen: list = []

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        seen.append(headers["x-request-id"])
        if len(seen) == 1:
            return httpx.Response(503, json={"error": "first replica down"})
        return httpx.Response(200, json=[{"id": "s1"}])

    monkeypatch.setattr(gateway._client, "request", fake_request)
    response = TestClient(gateway.app).get("/api/students", headers={"x-request-id": "corr-retry-0001"})
    assert response.status_code == 200
    assert response.headers["x-request-id"] == "corr-retry-0001"
    assert seen == ["corr-retry-0001", "corr-retry-0001"]  # the retry carries the same id
