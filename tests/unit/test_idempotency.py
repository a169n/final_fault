"""S5 idempotent payments: the client's Idempotency-Key is honoured only with FT on."""
from __future__ import annotations

import uuid

from app.fault_tolerance.software.idempotency import forward_key, payment_key

KEY = "client-key-123"


def test_payment_key_ignored_in_baseline() -> None:
    first = payment_key({"idempotency-key": KEY})
    second = payment_key({"idempotency-key": KEY})
    assert first != KEY
    assert first != second  # every retry is a new charge in baseline
    uuid.UUID(first)


def test_payment_key_from_header_in_ft(ft: None) -> None:
    assert payment_key({"idempotency-key": KEY}) == KEY


def test_payment_key_generated_when_missing_in_ft(ft: None) -> None:
    uuid.UUID(payment_key({}))


def test_forward_key_reuses_client_key() -> None:
    assert forward_key({"idempotency-key": KEY}) == KEY
    uuid.UUID(forward_key({}))


# --- the duplicate path is scoped to the same payment (endterm) ---------------------------------

import asyncio  # noqa: E402
import json  # noqa: E402
from decimal import Decimal  # noqa: E402

import pytest  # noqa: E402

from app.fault_tolerance.software import idempotency  # noqa: E402

S7_ROW = {"id": 7, "idempotency_key": KEY, "student_id": "s7", "amount": Decimal("1.00"), "state": "completed"}


@pytest.fixture
def stored(monkeypatch: pytest.MonkeyPatch) -> list:
    """The payments table holds s7's payment under KEY; returns the queries made."""
    queries: list = []

    async def fake_read(sql, params=()):
        queries.append(sql)
        return [dict(S7_ROW)] if params == (KEY,) else []

    monkeypatch.setattr(idempotency, "read", fake_read)
    monkeypatch.setattr(idempotency, "read_primary", fake_read)
    return queries


def _call(*args):
    response = asyncio.run(idempotency.original_response(*args))
    return response.status_code, json.loads(response.body)


def test_same_payment_replayed_in_endterm(endterm: None, stored: list) -> None:
    status, body = _call(KEY, "s7", Decimal("1.00"))
    assert status == 200
    assert body["id"] == 7 and body["duplicate"] is True


def test_other_students_key_refused_in_endterm(endterm: None, stored: list) -> None:
    """s8 re-uses s7's key: no 2xx, and nothing of s7's payment is returned."""
    status, body = _call(KEY, "s8", Decimal("1.00"))
    assert status == 409
    assert body == {"error": "Idempotency-Key already used for a different payment"}


def test_same_student_different_amount_refused_in_endterm(endterm: None, stored: list) -> None:
    status, body = _call(KEY, "s7", Decimal("2.00"))
    assert status == 409
    assert "student_id" not in body


def test_midterm_duplicate_path_unchanged(ft: None, stored: list) -> None:
    status, body = _call(KEY, "s8", 5.0)  # midterm has no principals: behaviour kept for the comparison
    assert status == 200
    assert body["id"] == 7


@pytest.mark.parametrize("amount", [Decimal("1.00"), Decimal("1"), 1.0, "1.00"])
def test_same_payment_compares_amounts_numerically(amount) -> None:
    assert idempotency.same_payment(S7_ROW, "s7", amount)


def test_same_payment_false_on_garbage() -> None:
    assert not idempotency.same_payment({"student_id": "s7", "amount": None}, "s7", Decimal("1"))
