"""Fault injection endpoints used by the experiment harness (``/chaos``, ``/chaos/crash``).

Endterm lockdown (Task 12; THREAT-MODEL.md B3.E1): with ENDTERM on, every ``/chaos*`` request must
carry ``x-chaos-token`` equal to ``CHAOS_TOKEN`` from ``.env``. The comparison is constant time
(``hmac.compare_digest``), an unset or empty ``CHAOS_TOKEN`` refuses everything (fail closed), and a
refusal is a 403 plus an audit event that never contains the presented or the real token. Baseline
and midterm keep the endpoints open, as the midterm harness and experiments expect.
"""
from __future__ import annotations

import asyncio
import hmac
import os
import random
import threading

from fastapi import APIRouter, Depends, HTTPException, Request

from .core.eventlog import endterm_enabled, log
from .security import audit

CHAOS_HEADER = "x-chaos-token"
DENY_REASON = audit.CHAOS_REASON

config = {
    "latencyMs": int(os.environ.get("CHAOS_LATENCY_MS", 0)),
    "failRate": float(os.environ.get("CHAOS_FAIL_RATE", 0)),
    "crashAfterCheckpoint": os.environ.get("CHAOS_CRASH_AFTER_CHECKPOINT") == "1",
}


def _token_ok(presented: str) -> bool:
    expected = os.environ.get("CHAOS_TOKEN", "")
    # bytes, so a non-ASCII header is a mismatch and not a TypeError (compare_digest rejects non-ASCII str)
    match = hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))
    return match and expected != ""  # fail closed when no token is configured


async def require_chaos_token(request: Request) -> None:
    if not endterm_enabled():
        return
    presented = request.headers.get(CHAOS_HEADER)
    if _token_ok(presented or ""):
        return
    route = request.scope.get("route")
    action = f"{request.method} {getattr(route, 'path', '/chaos')}"  # route template: a fixed set of actions
    client = request.client.host if request.client else None
    audit.record(action, "deny", None, DENY_REASON, presented=presented is not None, ip=client)
    raise HTTPException(status_code=403, detail="forbidden")


router = APIRouter(dependencies=[Depends(require_chaos_token)])


async def chaos_gate() -> None:
    if config["latencyMs"] > 0:
        await asyncio.sleep(config["latencyMs"] / 1000)
    if config["failRate"] > 0 and random.random() < config["failRate"]:
        raise HTTPException(status_code=503, detail="injected fault")


@router.get("/chaos")
async def get_chaos():
    return config


@router.post("/chaos")
async def set_chaos(body: dict):
    config.update(body or {})
    log(kind="chaos", action="configure", **config)
    return config


@router.post("/chaos/crash")
async def crash():
    log(kind="chaos", action="crash")
    threading.Timer(0.05, lambda: os._exit(1)).start()  # hard crash, no cleanup
    return {"crashing": True}
