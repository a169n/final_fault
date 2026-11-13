"""Endterm per-instance outlier ejection: N consecutive failures take one replica out of rotation."""
from __future__ import annotations

import itertools

from prometheus_client import REGISTRY

from app.fault_tolerance.infrastructure.load_balancer import ring
from app.fault_tolerance.software.outlier_ejection import OutlierDetector

A, B, C = "http://a:3000", "http://b:3000", "http://c:3000"
_pool_ids = itertools.count()


def _pool() -> str:
    return f"eject-pool-{next(_pool_ids)}"  # the ring cursor is per pool and module-global


def _fail(detector: OutlierDetector, instance: str, n: int, now: float = 0) -> None:
    for _ in range(n):
        detector.record(instance, False, now_ms=now)


def test_three_consecutive_failures_eject() -> None:
    detector = OutlierDetector(consecutive=3, eject_ms=10_000, instances=[A, B, C])
    _fail(detector, A, 2)
    assert not detector.is_ejected(A, now_ms=0)
    _fail(detector, A, 1)
    assert detector.is_ejected(A, now_ms=0)
    assert detector.ejected(now_ms=0) == [A]
    assert REGISTRY.get_sample_value("instance_ejected", {"target": A}) == 1


def test_success_resets_streak() -> None:
    detector = OutlierDetector(consecutive=3, instances=[A, B, C])
    _fail(detector, A, 2)
    detector.record(A, True, now_ms=0)
    _fail(detector, A, 2)
    assert not detector.is_ejected(A, now_ms=0)
    _fail(detector, A, 1)
    assert detector.is_ejected(A, now_ms=0)


def test_failures_on_other_instances_do_not_count() -> None:
    detector = OutlierDetector(consecutive=3, instances=[A, B, C])
    for instance in (A, B, A, B):  # interleaved: the streak is per instance, not per pool
        detector.record(instance, False, now_ms=0)
    detector.record(A, True, now_ms=0)
    detector.record(A, False, now_ms=0)
    detector.record(B, False, now_ms=0)
    assert detector.ejected(now_ms=0) == [B]  # B: 3 in a row; A's streak was reset by its success


def test_ejection_expires_after_eject_ms() -> None:
    detector = OutlierDetector(consecutive=3, eject_ms=10_000, instances=[A, B, C])
    _fail(detector, A, 3, now=1_000)
    assert detector.is_ejected(A, now_ms=10_999)
    assert not detector.is_ejected(A, now_ms=11_000)
    assert detector.ejected(now_ms=11_000) == []
    assert REGISTRY.get_sample_value("instance_ejected", {"target": A}) == 0
    _fail(detector, A, 2, now=11_000)  # back in rotation with a clean streak
    assert not detector.is_ejected(A, now_ms=11_000)
    _fail(detector, A, 1, now=11_000)
    assert detector.is_ejected(A, now_ms=11_000)


def test_never_ejects_more_than_half_pool() -> None:
    detector = OutlierDetector(consecutive=3, max_ejected_fraction=0.5, instances=[A, B])
    _fail(detector, A, 3)
    _fail(detector, B, 10)
    assert detector.is_ejected(A, now_ms=0)
    assert not detector.is_ejected(B, now_ms=0)  # the second replica of two is never ejected
    assert detector.ejected(now_ms=0) == [A]


def test_single_replica_is_never_ejected() -> None:
    detector = OutlierDetector(consecutive=3, instances=[A])
    _fail(detector, A, 10)
    assert detector.ejected(now_ms=0) == []


def test_cap_frees_up_after_expiry() -> None:
    detector = OutlierDetector(consecutive=3, eject_ms=1_000, instances=[A, B])
    _fail(detector, A, 3, now=0)
    _fail(detector, B, 3, now=0)  # refused: A already holds the one slot
    assert detector.ejected(now_ms=0) == [A]
    assert detector.ejected(now_ms=1_000) == []  # A restored
    _fail(detector, B, 1, now=1_000)  # B's streak is still >= 3, the next failure ejects it
    assert detector.ejected(now_ms=1_000) == [B]


def test_ejection_events_logged(monkeypatch) -> None:
    from app.fault_tolerance.software import outlier_ejection

    events = []
    monkeypatch.setattr(outlier_ejection, "log", lambda **e: events.append(e))
    detector = OutlierDetector(consecutive=3, eject_ms=1_000, instances=[A, B, C])
    _fail(detector, A, 3, now=0)
    detector.is_ejected(A, now_ms=1_000)
    assert [(e["kind"], e["target"], e["state"]) for e in events] == [
        ("ejection", A, "ejected"), ("ejection", A, "restored")]


def test_ring_drops_ejected_instance_in_endterm_mode(endterm: None) -> None:
    pool = _pool()
    for _ in range(6):
        order = ring(pool, [A, B, C], lambda i: True, is_ejected=lambda i: i == A)
        assert A not in order


def test_ring_ignores_ejection_in_midterm_mode(ft: None) -> None:
    pool = _pool()
    firsts = {ring(pool, [A, B, C], lambda i: True, is_ejected=lambda i: i == A)[0] for _ in range(3)}
    assert firsts == {A, B, C}


def test_ring_all_ejected_or_down_falls_back_to_every_instance(endterm: None) -> None:
    order = ring(_pool(), [A, B], lambda i: i != B, is_ejected=lambda i: i == A)
    assert sorted(order) == [A, B]  # all filtered: try anyway (unchanged midterm fallback)


def test_ring_still_skips_down_instances_in_endterm(endterm: None) -> None:
    pool = _pool()
    for _ in range(4):
        assert B not in ring(pool, [A, B, C], lambda i: i != B)


# --- gateway wiring -------------------------------------------------------------------------------

def _gateway_with_sick_replica(monkeypatch) -> tuple:
    import httpx
    from fastapi.testclient import TestClient

    from app.fault_tolerance.software import circuit_breaker, outlier_ejection, retry
    from app.services import gateway

    monkeypatch.setitem(gateway.POOLS, "students", [A, B, C])
    monkeypatch.setattr(outlier_ejection, "_detectors", {})  # fresh per-pool detectors
    monkeypatch.setattr(circuit_breaker, "_breakers", {})
    monkeypatch.setattr(retry, "BACKOFF_MS", 0)
    hits: list = []

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        hits.append(url.split("/s7")[0])
        if url.startswith(A):
            return httpx.Response(503, json={"error": "sick replica"})
        return httpx.Response(200, json={"id": "s7"})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    monkeypatch.setenv("JWT_SECRET", "unit-test-secret-0123456789abcdefghij")
    from app.security import tokens

    staff = {"authorization": f"Bearer {tokens.issue('bursar', 'staff', None)}"}  # endterm: authorized caller
    return TestClient(gateway.app, headers=staff), hits


def test_gateway_ejects_failing_replica_in_endterm(endterm: None, monkeypatch) -> None:
    from app.fault_tolerance.software import outlier_ejection

    client, hits = _gateway_with_sick_replica(monkeypatch)
    for _ in range(9):  # the ring rotates, so A is tried first on every third request
        assert client.get("/api/students/s7").status_code == 200
    assert outlier_ejection.for_pool("students", [A, B, C]).ejected() == [A]
    hits.clear()
    for _ in range(6):
        assert client.get("/api/students/s7").status_code == 200
    assert A not in hits  # out of rotation: no request pays for the sick replica any more


def test_gateway_does_not_eject_in_midterm(ft: None, monkeypatch) -> None:
    from app.fault_tolerance.software import outlier_ejection

    client, hits = _gateway_with_sick_replica(monkeypatch)
    for _ in range(9):
        assert client.get("/api/students/s7").status_code == 200
    assert outlier_ejection._detectors == {}  # midterm keeps its behaviour: nothing recorded
    hits.clear()
    for _ in range(3):
        client.get("/api/students/s7")
    assert A in hits
