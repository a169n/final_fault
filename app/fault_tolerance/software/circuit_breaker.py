from __future__ import annotations

import os
import time
from typing import Dict, Optional

from ...core import metrics
from ...core.eventlog import log

THRESHOLD = int(os.environ.get("FT_CB_THRESHOLD", 5))  # S3
COOLDOWN_MS = int(os.environ.get("FT_CB_COOLDOWN_MS", 5000))


class CircuitBreaker:
    def __init__(self, name: str, threshold: int = THRESHOLD, cooldown_ms: int = COOLDOWN_MS) -> None:
        self.name = name
        self.threshold = threshold
        self.cooldown_ms = cooldown_ms
        self.failures = 0
        self.last_failure_at = 0.0
        metrics.CIRCUIT_OPEN.labels(name=name).set(0)  # exported from the start, so dashboards show "closed"

    def state(self, now_ms_: Optional[float] = None) -> str:
        now = time.time() * 1000 if now_ms_ is None else now_ms_
        if self.failures < self.threshold:
            return "closed"
        return "half-open" if now - self.last_failure_at >= self.cooldown_ms else "open"  # half-open: one trial call

    def success(self) -> None:
        if self.failures >= self.threshold:
            log(kind="breaker", target=self.name, state="closed")
            metrics.CIRCUIT_OPEN.labels(name=self.name).set(0)
        self.failures = 0

    def failure(self) -> None:
        self.failures += 1
        self.last_failure_at = time.time() * 1000
        if self.failures == self.threshold:
            log(kind="breaker", target=self.name, state="open")
            metrics.CIRCUIT_OPEN.labels(name=self.name).set(1)


_breakers: Dict[str, CircuitBreaker] = {}


def for_pool(pool: str) -> CircuitBreaker:
    if pool not in _breakers:
        _breakers[pool] = CircuitBreaker(pool)
    return _breakers[pool]
