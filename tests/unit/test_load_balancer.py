"""H1 + S4 replica ring: health-aware in FT mode, blind in baseline."""
from __future__ import annotations

import itertools

from app.fault_tolerance.infrastructure.load_balancer import ring

INSTANCES = ["http://a", "http://b", "http://c"]
_pool_ids = itertools.count()


def _pool() -> str:
    return f"pool-{next(_pool_ids)}"  # the cursor is per pool and module-global


def test_ring_skips_down_instances_when_ft(ft: None) -> None:
    pool = _pool()
    for _ in range(6):
        assert "http://b" not in ring(pool, INSTANCES, lambda i: i != "http://b")


def test_ring_baseline_is_blind() -> None:
    order = ring(_pool(), INSTANCES, lambda i: i != "http://b")
    assert sorted(order) == sorted(INSTANCES)


def test_ring_all_down_tries_anyway(ft: None) -> None:
    order = ring(_pool(), INSTANCES, lambda i: False)
    assert sorted(order) == sorted(INSTANCES)


def test_ring_rotates_per_call(ft: None) -> None:
    pool = _pool()
    firsts = [ring(pool, INSTANCES, lambda i: True)[0] for _ in range(3)]
    assert firsts == INSTANCES
    assert ring(pool, INSTANCES, lambda i: True) == INSTANCES  # wraps around
    assert ring(pool, INSTANCES, lambda i: True) == ["http://b", "http://c", "http://a"]
