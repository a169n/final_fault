"""Per-instance outlier ejection (endterm).

The midterm circuit breaker (S3) is per *pool*: one slow replica among healthy ones never
opens it, because the retry on the next replica succeeds and resets the count. Every request
that lands on the slow replica first still pays its timeout (midterm report section 11).

This detector watches each replica separately, the way Envoy/Istio outlier detection does:
``consecutive`` failed attempts in a row on one instance take it out of the load-balancer
ring for ``eject_ms``. Then it comes back with a clean streak; if it is still bad, the next
``consecutive`` failures eject it again. At most ``max_ejected_fraction`` of a pool is ejected
at a time, so a pool-wide problem (the DB is down, every replica fails) never empties the
ring: that case is the circuit breaker's job, not this one.

Only the gateway uses it, and only when ``ENDTERM_ENABLED=1`` (see ``services/gateway.py``
and ``infrastructure/load_balancer.py``).
"""
from __future__ import annotations

import asyncio
import math
import os
import time
from typing import Dict, Iterable, List, Optional

from ...core import metrics
from ...core.eventlog import log

CONSECUTIVE = int(os.environ.get("FT_EJECT_CONSECUTIVE", 3))
EJECT_MS = int(os.environ.get("FT_EJECT_MS", 10_000))
MAX_EJECTED_FRACTION = 0.5
REFRESH_S = 1.0  # how often the gateway expires ejections when there is no traffic


def _now_ms() -> float:
    return time.monotonic() * 1000


class OutlierDetector:
    def __init__(self, consecutive: int = 3, eject_ms: int = 10_000, max_ejected_fraction: float = 0.5,
                 instances: Iterable[str] = ()) -> None:
        """``instances`` is the pool the cap is computed against; instances seen only through
        ``record`` are added to it."""
        self.consecutive = consecutive
        self.eject_ms = eject_ms
        self.max_ejected_fraction = max_ejected_fraction
        self._pool: List[str] = []
        self._streak: Dict[str, int] = {}
        self._ejected_until: Dict[str, float] = {}
        for instance in instances:
            self._track(instance)

    def _track(self, instance: str) -> None:
        if instance not in self._streak:
            self._pool.append(instance)
            self._streak[instance] = 0
            metrics.INSTANCE_EJECTED.labels(target=instance).set(0)  # exported from the start

    def _expire(self, now: float) -> None:
        for instance, until in list(self._ejected_until.items()):
            if now >= until:
                del self._ejected_until[instance]
                log(kind="ejection", target=instance, state="restored")
                metrics.INSTANCE_EJECTED.labels(target=instance).set(0)

    def _cap(self) -> int:
        return math.floor(len(self._pool) * self.max_ejected_fraction)

    def record(self, instance: str, ok: bool, now_ms: Optional[float] = None) -> None:
        now = _now_ms() if now_ms is None else now_ms
        self._track(instance)
        self._expire(now)
        if ok:
            self._streak[instance] = 0
            return
        self._streak[instance] += 1
        if (self._streak[instance] >= self.consecutive and instance not in self._ejected_until
                and len(self._ejected_until) < self._cap()):
            self._ejected_until[instance] = now + self.eject_ms
            self._streak[instance] = 0  # back in rotation it starts clean
            log(kind="ejection", target=instance, state="ejected", ok=False,
                failures=self.consecutive, eject_ms=self.eject_ms)
            metrics.INSTANCE_EJECTED.labels(target=instance).set(1)

    def is_ejected(self, instance: str, now_ms: Optional[float] = None) -> bool:
        self._expire(_now_ms() if now_ms is None else now_ms)
        return instance in self._ejected_until

    def ejected(self, now_ms: Optional[float] = None) -> List[str]:
        self._expire(_now_ms() if now_ms is None else now_ms)
        return [i for i in self._pool if i in self._ejected_until]


_detectors: Dict[str, OutlierDetector] = {}


def for_pool(pool: str, instances: Iterable[str] = ()) -> OutlierDetector:
    if pool not in _detectors:
        _detectors[pool] = OutlierDetector(CONSECUTIVE, EJECT_MS, MAX_EJECTED_FRACTION, instances)
    return _detectors[pool]


async def loop(pools: Dict[str, List[str]]) -> None:
    """Expire ejections on a clock, so the gauge and the "restored" event do not wait for traffic."""
    detectors = [for_pool(pool, instances) for pool, instances in pools.items() if instances]
    while True:
        for detector in detectors:
            detector.ejected()
        await asyncio.sleep(REFRESH_S)
