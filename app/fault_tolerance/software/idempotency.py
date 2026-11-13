from __future__ import annotations

import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping

from fastapi.responses import JSONResponse

from ...core.db import read, read_primary, to_jsonable
from ...core.eventlog import endterm_enabled, ft_enabled, log


def forward_key(headers: Mapping[str, str]) -> str:
    return headers.get("idempotency-key") or str(uuid.uuid4())  # S5: gateway retries reuse it


def payment_key(headers: Mapping[str, str]) -> str:
    if not ft_enabled():
        return str(uuid.uuid4())  # baseline ignores the key
    return headers.get("idempotency-key") or str(uuid.uuid4())


def same_payment(row: Mapping[str, Any], student_id: Any, amount: Any) -> bool:
    """Is the stored row the same payment as this request (same student, same amount)?"""
    try:
        return str(row.get("student_id")) == str(student_id) and Decimal(str(row.get("amount"))) == Decimal(str(amount))
    except (InvalidOperation, TypeError, ValueError):
        return False


async def original_response(key: str, student_id: Any = None, amount: Any = None) -> JSONResponse:
    """The duplicate path of S5: answer with the stored payment, never charge twice.

    The key is chosen by the client and is unique across ALL payments. In endterm the stored row is
    returned only if it is the same payment (same student, same amount): otherwise a student who
    knows or guesses another student's key would get that student's payment back, and their own
    payment would be silently dropped behind a 2xx. A mismatch is a client error (409) that reveals
    nothing about the stored row. The read goes to the primary, where the conflicting row was just
    found, so a lagging standby cannot hide it.
    """
    if endterm_enabled():
        existing = await read_primary("SELECT * FROM payments WHERE idempotency_key = %s", (key,))
        row = existing[0] if existing else {}
        if not row or not same_payment(row, student_id, amount):
            log(kind="rejected", target="payment", reason="idempotency_key_reused")
            return JSONResponse(status_code=409, content={
                "error": "Idempotency-Key already used for a different payment"})
    else:  # baseline and midterm: the midterm behaviour, unchanged
        existing = await read("SELECT * FROM payments WHERE idempotency_key = %s", (key,))
        row = existing[0] if existing else {}
    log(kind="recovery", target="payment", action="duplicate_suppressed", paymentId=str(row.get("id")))
    return JSONResponse(status_code=200, content={**to_jsonable(row), "duplicate": True})
