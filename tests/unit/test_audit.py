"""Audit events (Task 9; THREAT-MODEL.md B1.R1, B1.I3).

An audit line says who did what, the outcome and why, tied to the request by ``rid``. It never
carries a password, a token or the Authorization header, whatever the caller passes in.
"""
from __future__ import annotations

import json
import os
import pathlib
from typing import List

import pytest
from prometheus_client import REGISTRY

from app.core.context import REQUEST_ID
from app.security import audit
from app.security.tokens import Principal

LOG = pathlib.Path(os.environ["LOG_DIR"]) / "events.jsonl"


@pytest.fixture
def written() -> callable:
    start = LOG.stat().st_size if LOG.exists() else 0

    def lines() -> List[dict]:
        text = LOG.read_text()[start:]
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    return lines


def _raw_since(start: int) -> str:
    return LOG.read_text()[start:]


def test_audit_event_has_no_secrets(written) -> None:
    start = LOG.stat().st_size if LOG.exists() else 0
    token = REQUEST_ID.set("rid-audit-0001")
    try:
        audit.record("login", "deny", None, "invalid_credentials", user="bursar", password="hunter2",
                     authorization="Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln",
                     access_token="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln",
                     headers={"Authorization": "Bearer abc.def.ghi", "x-request-id": "rid-audit-0001"},
                     note="Bearer abc.def.ghi", input={"username": "bursar", "password": "hunter2"})
    finally:
        REQUEST_ID.reset(token)
    raw = _raw_since(start)
    assert "hunter2" not in raw
    assert "Bearer" not in raw
    assert "eyJ" not in raw  # no JWT, under any field name
    (event,) = written()
    assert event["kind"] == "audit" and event["action"] == "login" and event["outcome"] == "deny"
    assert event["reason"] == "invalid_credentials" and event["user"] == "bursar"
    assert event["rid"] == "rid-audit-0001"


def test_audit_event_names_the_principal(written) -> None:
    audit.record("POST /api/payments", "allow", Principal("s7", "student", "s7"), "ok", student="s7")
    (event,) = written()
    assert (event["sub"], event["role"], event["student_id"]) == ("s7", "student", "s7")
    assert event["outcome"] == "allow" and event["student"] == "s7"


def test_anonymous_audit_event_has_no_principal(written) -> None:
    audit.record("GET /api/students", "deny", None, "missing_token")
    (event,) = written()
    assert event["sub"] is None and event["role"] is None


def _denied(reason: str) -> float:
    return REGISTRY.get_sample_value("auth_denied_total", {"reason": reason}) or 0.0


def test_every_deny_counts_and_allow_does_not() -> None:
    before_deny, before_ok = _denied("not_owner"), _denied("ok")
    audit.record("GET /api/students/{id}", "deny", Principal("s7", "student", "s7"), "not_owner")
    audit.record("GET /api/students/{id}", "allow", Principal("admin", "admin", None), "ok")
    assert _denied("not_owner") == before_deny + 1
    assert _denied("ok") == before_ok


def test_unknown_deny_reason_does_not_create_a_new_series() -> None:
    before = _denied("other")
    audit.record("x", "deny", None, "some reason built from input s1234")
    assert _denied("other") == before + 1
    assert REGISTRY.get_sample_value("auth_denied_total", {"reason": "some reason built from input s1234"}) is None


def test_bad_outcome_is_refused() -> None:
    with pytest.raises(ValueError):
        audit.record("x", "maybe", None, "ok")  # type: ignore[arg-type]
