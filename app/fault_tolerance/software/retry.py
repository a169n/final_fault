from __future__ import annotations

import asyncio
import os
import random
import time
from typing import Awaitable, Callable, Optional, Tuple, TypeVar

import httpx

from ...core import metrics
from ...core.errors import UpstreamError
from ...core.eventlog import ft_enabled, log
from . import timeouts
from .circuit_breaker import CircuitBreaker

T = TypeVar("T")

RETRIES = int(os.environ.get("FT_RETRIES", 3))  # S1
BACKOFF_MS = int(os.environ.get("FT_BACKOFF_MS", 50))


def _retryable(exc: BaseException) -> bool:
    if isinstance(exc, UpstreamError):
        return exc.status == 0 or exc.status >= 500  # 4xx is never retried
    return True


def _attempt_outcome(exc: BaseException) -> str:
    # The gateway wraps transport errors in UpstreamError; the cause tells a timeout from a refusal.
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException)):
        return "timeout"
    if isinstance(exc.__cause__, (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException)):
        return "timeout"
    return "error"


def backoff_s(attempt: int) -> float:
    return random.random() * (BACKOFF_MS / 1000) * 2 ** (attempt - 1)  # full jitter


async def call(
    target: str,
    fn: Callable[[Optional[float]], Awaitable[T]],
    breaker: Optional[CircuitBreaker] = None,
    instance: Optional[Callable[[], str]] = None,
    on_outcome: Optional[Callable[[str, str], None]] = None,
) -> Tuple[T, int]:
    """``instance`` names the replica the last attempt went to (the caller picks it inside ``fn``);
    it labels ``upstream_attempts_total`` so a single bad instance stands out. ``on_outcome`` is
    told (instance, outcome) after every attempt that reached an instance (outlier ejection)."""
    started = time.time() * 1000

    def record(outcome: str) -> None:
        name = instance() if instance is not None else target
        metrics.upstream_attempt(target, name, outcome)
        if on_outcome is not None:
            on_outcome(name, outcome)

    if not ft_enabled():  # baseline: one attempt, no timeout (measured the same way as the FT modes)
        try:
            value = await fn(None)
        except Exception as exc:  # a cancelled request is not an upstream outcome
            record(_attempt_outcome(exc))
            raise
        record("ok")
        return value, 1

    if breaker is not None and breaker.state() == "open":  # S3
        log(kind="upstream", target=target, ok=False, err="circuit_open", ms=0, attempts=0, breaker="open")
        metrics.upstream_attempt(target, "none", "circuit_open")  # no instance was tried
        raise UpstreamError(f"circuit open for {target}", 503)

    last_error: Optional[BaseException] = None
    for attempt in range(1, RETRIES + 1):
        try:
            value = await asyncio.wait_for(fn(timeouts.PER_ATTEMPT_S), timeout=timeouts.PER_ATTEMPT_S)  # S2
            record("ok")
            if breaker is not None:
                breaker.success()
            ms = int(time.time() * 1000 - started)
            log(kind="upstream", target=target, ok=True, ms=ms, attempts=attempt,
                breaker=None if breaker is None else breaker.state())
            return value, attempt
        except (Exception, asyncio.TimeoutError) as exc:
            last_error = exc
            record(_attempt_outcome(exc))
            if breaker is not None:
                breaker.failure()
            log(kind="attempt", target=target, ok=False, attempts=attempt,  # detection timestamp
                breaker=None if breaker is None else breaker.state(),
                err=type(exc).__name__ if isinstance(exc, asyncio.TimeoutError) else str(exc))
            if not _retryable(exc) or attempt == RETRIES:
                break
            await asyncio.sleep(backoff_s(attempt))  # S1

    ms = int(time.time() * 1000 - started)
    log(kind="upstream", target=target, ok=False, ms=ms, attempts=RETRIES,
        breaker=None if breaker is None else breaker.state(), err=str(last_error))
    raise last_error  # type: ignore[misc]
