"""Rate limiting and abuse protection at the gateway (Task 11; THREAT-MODEL.md B1.S3, B1.D1). Endterm only.

A token bucket per key: each key holds up to ``burst`` tokens, refilled at ``rate_per_s``; a request
spends one token, and a request that finds less than one is refused with the time until the next
token (``retry_after_s``, sent as ``Retry-After``).

Quotas, per gateway (scope → key → default):

  - ``login``:   ``POST /auth/token`` per client IP (the first ``X-Forwarded-For`` value, which nginx
    overwrites with the peer address): 1/s, burst 5, so a brute force gets 429 after 5 attempts;
  - ``student`` / ``staff`` / ``admin``: ``/api/*`` per authenticated principal (``role:sub``):
    10/s burst 20, 5 000/s burst 5 000, 1 000/s burst 1 000. The staff quota is sized so the
    legitimate high-load peak (~2 000 req/s, all as one staff user) is never throttled, even if
    every request lands on one gateway (Review Focus 1).

Each quota can be overridden with ``RATE_LIMIT_<SCOPE>_PER_S`` and ``RATE_LIMIT_<SCOPE>_BURST``
(e.g. ``RATE_LIMIT_STUDENT_BURST=40``); an unparsable or non-positive value keeps the default.

The state is in-process, so the limits are **per gateway**: with two gateways behind nginx the
effective cluster limit is up to 2× the quota, and a gateway restart empties its buckets
(THREAT-MODEL.md R2). The bucket table is bounded: idle keys are evicted after 60 s (only once
their bucket would be full again, so eviction never grants tokens early), and when ``max_keys``
are live a new key is refused (fails closed) rather than growing memory without bound.
"""
from __future__ import annotations

import math
import os
import threading
from time import monotonic
from typing import Dict, Optional, Tuple

from ..core import metrics

REASON = "rate_limited"  # the audit / auth_denied_total reason for a 429
LOGIN = "login"
SCOPES = (LOGIN, "student", "staff", "admin")
DEFAULTS: Dict[str, Tuple[float, int]] = {
    LOGIN: (1.0, 5),
    "student": (10.0, 20),
    "staff": (5000.0, 5000),
    "admin": (1000.0, 1000),
}
IDLE_S = 60.0
MAX_KEYS = 100_000
_SWEEP_EVERY_S = 1.0  # a sweep is O(keys): at most one per second, however hard a client pushes


class TokenBucket:
    def __init__(self, rate_per_s: float, burst: int, idle_s: float = IDLE_S, max_keys: int = MAX_KEYS) -> None:
        rate_per_s, burst = float(rate_per_s), int(burst)
        if not (math.isfinite(rate_per_s) and rate_per_s > 0) or burst < 1 or max_keys < 1:
            raise ValueError("rate_per_s must be > 0, burst and max_keys >= 1")
        self.rate = rate_per_s
        self.burst = burst
        self.idle_s = idle_s
        self.max_keys = max_keys
        self._state: Dict[str, Tuple[float, float]] = {}  # key -> (tokens, last seen)
        self._last_sweep: Optional[float] = None
        self._lock = threading.Lock()  # the gateway is single-threaded asyncio; TestClient is not

    def __len__(self) -> int:
        return len(self._state)

    def _refilled(self, tokens: float, last: float, now: float) -> float:
        return min(float(self.burst), tokens + max(0.0, now - last) * self.rate)

    def _sweep(self, now: float) -> None:
        self._last_sweep = now
        stale = [k for k, (tokens, last) in self._state.items()
                 if now - last >= self.idle_s and self._refilled(tokens, last, now) >= self.burst]
        for key in stale:
            del self._state[key]

    def allow(self, key: str, now: Optional[float] = None) -> Tuple[bool, float]:
        """``(allowed, retry_after_s)``; ``retry_after_s`` is 0.0 when allowed."""
        now = monotonic() if now is None else float(now)
        with self._lock:
            if self._last_sweep is None:
                self._last_sweep = now
            elif now - self._last_sweep >= _SWEEP_EVERY_S and (
                    now - self._last_sweep >= self.idle_s or len(self._state) >= self.max_keys):
                self._sweep(now)
            state = self._state.get(key)
            if state is None:
                if len(self._state) >= self.max_keys:
                    return False, 1.0  # table full of live keys: refuse rather than grow
                tokens = float(self.burst)
            else:
                tokens = self._refilled(state[0], state[1], now)
            if tokens >= 1.0:
                self._state[key] = (tokens - 1.0, now)
                return True, 0.0
            self._state[key] = (tokens, now)
            return False, (1.0 - tokens) / self.rate


def _env_number(name: str, cast, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = cast(raw.strip())
    except ValueError:
        return default
    return value if math.isfinite(value) and value > 0 else default


def quota(scope: str) -> Tuple[float, int]:
    """``(rate_per_s, burst)`` for a scope, with the environment overrides applied."""
    rate, burst = DEFAULTS[scope]
    prefix = f"RATE_LIMIT_{scope.upper()}"
    return float(_env_number(f"{prefix}_PER_S", float, rate)), int(_env_number(f"{prefix}_BURST", int, burst))


_buckets: Dict[str, TokenBucket] = {}
_buckets_lock = threading.Lock()


def bucket(scope: str) -> TokenBucket:
    """The process-wide bucket for a scope, built from ``quota(scope)`` on first use."""
    with _buckets_lock:
        found = _buckets.get(scope)
        if found is None:
            found = _buckets[scope] = TokenBucket(*quota(scope))
        return found


def reset() -> None:
    """Forget every bucket (tests; quotas are re-read from the environment on next use)."""
    with _buckets_lock:
        _buckets.clear()


def principal_scope(role: object) -> str:
    """The /api quota for a role. Anything unexpected gets the strictest one (fail closed)."""
    return role if isinstance(role, str) and role in DEFAULTS and role != LOGIN else "student"


def check(scope: str, key: str) -> Optional[float]:
    """None if the request may proceed, else the seconds until it may retry (> 0)."""
    allowed, retry_after = bucket(scope).allow(key, now=monotonic())
    return None if allowed else max(retry_after, 1e-3)


def retry_after_header(seconds: float) -> str:
    return str(max(1, math.ceil(seconds)))


def precreate() -> None:
    """Export ``rate_limited_total{scope}`` as 0 from start-up (``rate()`` misses a first scrape)."""
    for scope in SCOPES:
        metrics.RATE_LIMITED.labels(scope=scope)
