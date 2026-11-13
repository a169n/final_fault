from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Set

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .. import fault_injection
from ..core.db import close_pools, db_healthy, open_pools, read, to_jsonable, write
from ..core.eventlog import SERVICE, endterm_enabled, ft_enabled, log
from ..core.service import create_app
from ..fault_tolerance.software import job_checkpoint
from ..security import validation
from .schedule import Placements, steps

STEP_MS = int(os.environ.get("TIMETABLE_STEP_MS", 50))

_jobs: Set[asyncio.Task] = set()


async def _run(term: str, placed: Placements) -> None:
    try:
        courses = await read("SELECT id, teacher, students FROM courses")
        rooms = await read("SELECT id, capacity FROM rooms")
        for _ in steps(courses, rooms, placed):
            await asyncio.sleep(STEP_MS / 1000)  # simulated work
            if not await job_checkpoint.checkpoint(term, placed):   # S10
                return
        if await job_checkpoint.save(term, placed, "done"):
            log(kind="checkpoint", target="timetable", term=term, placed=len(placed), state="done")
    except Exception as exc:
        log(kind="recovery", target="timetable", ok=False, term=term, err=str(exc))


def _start(term: str, placed: Placements) -> None:
    task = asyncio.create_task(_run(term, placed))
    _jobs.add(task)
    task.add_done_callback(_jobs.discard)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pools()
    sweep = asyncio.create_task(job_checkpoint.sweep_loop(_start)) if ft_enabled() else None   # S10 adoption
    yield
    if sweep is not None:
        sweep.cancel()
    await close_pools()


app = create_app(lifespan=lifespan)
app.include_router(fault_injection.router)


@app.get("/health/ready")
@app.get("/health")  # alias of /health/ready: the midterm harness probes /health
async def health():
    ok = await db_healthy()
    return JSONResponse(status_code=200 if ok else 503, content={"ok": ok, "ft": ft_enabled()})


@app.post("/")
async def create_job(body: dict):
    await fault_injection.chaos_gate()
    if endterm_enabled():  # strict: a closed model, before any database work
        job = validation.parse(validation.TimetableJobIn, body)
        if isinstance(job, JSONResponse):
            return job
        term = job.term
    else:  # baseline and midterm: the lenient midterm check, unchanged
        term = str(body.get("term") or "").strip()
        if not term:
            return JSONResponse(status_code=400, content={"error": "term is required"})
    rows = await write(
        """INSERT INTO timetable_jobs (term, owner) VALUES (%s, %s)
           ON CONFLICT (term) DO NOTHING
           RETURNING term""",
        (term, SERVICE),
    )
    if not rows:  # same term again: start nothing
        existing = await read("SELECT term, state, owner FROM timetable_jobs WHERE term = %s", (term,))
        return JSONResponse(status_code=200, content={**to_jsonable(existing[0] if existing else {"term": term}),
                                                      "duplicate": True})
    _start(term, {})
    return JSONResponse(status_code=202, content={"term": term, "state": "running", "owner": SERVICE})


@app.get("/{term}")
async def get_job(term: str):
    await fault_injection.chaos_gate()
    rows = await read(
        "SELECT term, state, owner, checkpoint, heartbeat_at, created_at FROM timetable_jobs WHERE term = %s",
        (term,),
    )
    if not rows:
        return JSONResponse(status_code=404, content={"error": "job not found"})
    job = rows[0]
    placed = job.pop("checkpoint") or {}
    total = (await read("SELECT count(*) AS n FROM courses"))[0]["n"]
    done = job["state"] == "done"
    return to_jsonable({
        **job,
        "progress": f"{len(placed)}/{total}",
        "unplaced": [cid for cid, p in placed.items() if p is None] if done else None,
        "timetable": placed if done else None,
    })
