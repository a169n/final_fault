from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

from ...core.db import write
from ...core.eventlog import ft_enabled, log

ORPHAN_AFTER_MS = int(os.environ.get("ORPHAN_AFTER_MS", 10_000))  # S6


async def write_checkpoint(key: str, student_id: str, amount: float) -> Optional[Any]:
    inserted = await write(  # pending row before any money moves
        """INSERT INTO payments (idempotency_key, student_id, amount, state)
           VALUES (%s, %s, %s, 'pending')
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id, state""",
        (key, student_id, amount),
    )
    return inserted[0]["id"] if inserted else None  # None = duplicate key (S5)


async def mark_failed(payment_id: Any) -> None:
    try:
        await write("UPDATE payments SET state = 'failed', updated_at = now() WHERE id = %s", (payment_id,))
    except Exception:
        pass


async def rollback_orphans() -> None:  # pending too long = crashed mid-payment
    if not ft_enabled():
        return
    try:
        rows = await write(
            """UPDATE payments SET state = 'rolled_back', updated_at = now()
               WHERE state = 'pending' AND created_at < now() - (%s || ' milliseconds')::interval
               RETURNING id, idempotency_key""",
            (str(ORPHAN_AFTER_MS),),
        )
        for row in rows:
            log(kind="recovery", target="payment", action="checkpoint_rolled_back", paymentId=str(row["id"]))
    except Exception as exc:
        log(kind="recovery", target="payment", ok=False, err=str(exc))


async def sweep_loop() -> None:
    while True:
        await rollback_orphans()
        await asyncio.sleep(ORPHAN_AFTER_MS / 1000)
