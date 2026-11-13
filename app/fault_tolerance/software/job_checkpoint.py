from __future__ import annotations

import asyncio
import json
import os
from typing import Callable

from ...core.db import write
from ...core.eventlog import SERVICE, ft_enabled, log

Placements = dict  # course id -> [slot, room]

CHECKPOINT_EVERY = int(os.environ.get("TIMETABLE_CHECKPOINT_EVERY", 10))
LEASE_MS = int(os.environ.get("TIMETABLE_LEASE_MS", 3000))  # S10


async def save(term: str, placed: Placements, state: str = "running") -> bool:
    rows = await write(
        """UPDATE timetable_jobs SET checkpoint = %s::jsonb, state = %s, heartbeat_at = now()
           WHERE term = %s AND owner = %s
           RETURNING term""",
        (json.dumps(placed), state, term, SERVICE),
    )
    return bool(rows)  # False = lease lost, stop


async def checkpoint(term: str, placed: Placements) -> bool:
    if not ft_enabled() or len(placed) % CHECKPOINT_EVERY != 0:
        return True
    if not await save(term, placed):
        log(kind="recovery", target="timetable", action="lease_lost", term=term)
        return False
    log(kind="checkpoint", target="timetable", term=term, placed=len(placed))
    return True


async def adopt_orphaned_job(start: Callable[[str, Placements], None]) -> None:
    try:
        rows = await write(  # SKIP LOCKED: exactly one replica adopts
            """UPDATE timetable_jobs SET owner = %s, heartbeat_at = now()
               WHERE term = (SELECT term FROM timetable_jobs
                             WHERE state = 'running'
                               AND heartbeat_at < now() - (%s || ' milliseconds')::interval
                             ORDER BY heartbeat_at LIMIT 1
                             FOR UPDATE SKIP LOCKED)
               RETURNING term, checkpoint""",
            (SERVICE, str(LEASE_MS)),
        )
        for row in rows:
            placed = row["checkpoint"] or {}
            log(kind="recovery", target="timetable", action="job_resumed", term=row["term"], fromPlaced=len(placed))
            start(row["term"], placed)
    except Exception as exc:
        log(kind="recovery", target="timetable", ok=False, err=str(exc))


async def sweep_loop(start: Callable[[str, Placements], None]) -> None:
    while True:
        await adopt_orphaned_job(start)
        await asyncio.sleep(LEASE_MS / 2000)
