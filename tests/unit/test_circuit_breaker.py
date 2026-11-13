"""S3 circuit breaker: closed -> open after THRESHOLD failures -> half-open after cooldown."""
from __future__ import annotations

import time

import pytest

from app.core.errors import UpstreamError
from app.fault_tolerance.software import retry
from app.fault_tolerance.software.circuit_breaker import CircuitBreaker


def test_breaker_opens_after_threshold_and_half_opens_after_cooldown() -> None:
    breaker = CircuitBreaker("pool", threshold=5, cooldown_ms=5000)
    for _ in range(4):
        breaker.failure()
    assert breaker.state() == "closed"
    breaker.failure()
    now = time.time() * 1000
    assert breaker.state(now) == "open"
    assert breaker.state(now + 5000) == "half-open"


def test_breaker_success_closes() -> None:
    breaker = CircuitBreaker("pool", threshold=2, cooldown_ms=5000)
    breaker.failure()
    breaker.failure()
    assert breaker.state() == "open"
    breaker.success()
    assert breaker.state() == "closed"


async def test_breaker_open_short_circuits_call(ft: None) -> None:
    breaker = CircuitBreaker("pool", threshold=1, cooldown_ms=60_000)
    breaker.failure()
    calls = 0

    async def fn(timeout: float | None) -> int:
        nonlocal calls
        calls += 1
        return 1

    with pytest.raises(UpstreamError) as info:
        await retry.call("pool", fn, breaker)
    assert info.value.status == 503
    assert calls == 0
