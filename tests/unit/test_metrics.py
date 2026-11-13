"""Service-level Prometheus metrics: request counts, latency, upstream attempts, health and integrity."""
from __future__ import annotations

import asyncio
import re

import httpx
import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY, generate_latest

from app.core import metrics
from app.core.errors import UpstreamError
from app.core.eventlog import metrics_text
from app.core.service import create_app


@pytest.fixture(autouse=True)
def _fresh_metrics() -> None:
    """Counters are process-wide; start every test from zero so exact values can be asserted."""
    for metric in (metrics.HTTP_REQUESTS, metrics.HTTP_DURATION, metrics.UPSTREAM_ATTEMPTS,
                   metrics.INSTANCE_UP, metrics.CIRCUIT_OPEN, metrics.INSTANCE_EJECTED,
                   metrics.AUTH_DENIED, metrics.RATE_LIMITED):
        metric.clear()


def _stub() -> TestClient:
    app = create_app(with_db=False)

    @app.get("/api/students/{id}")
    async def one(id: str):
        return {"id": id}

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/health/live")
    async def live():
        return {"ok": True}

    return TestClient(app)


def _samples(name: str) -> list:
    return [s for m in REGISTRY.collect() for s in m.samples if s.name == name]


def test_request_counter_and_histogram_recorded() -> None:
    response = _stub().get("/api/students/s1")
    assert response.status_code == 200
    text = generate_latest().decode()
    line = 'http_requests_total{method="GET",route="/api/students/{id}",status="200",svc="test"} 1.0'
    assert line in text.splitlines(), text  # exposition sorts labels by name
    assert re.search(r'http_request_duration_seconds_count\{[^}]*route="/api/students/\{id\}"[^}]*\} 1\.0', text)


def test_route_label_is_template() -> None:
    client = _stub()
    for i in range(50):
        assert client.get(f"/api/students/s{i}").status_code == 200
    label_sets = {tuple(sorted(s.labels.items())) for s in _samples("http_requests_total")}
    assert len(label_sets) == 1  # 50 ids, one series: cardinality bounded by the route table
    (labels,) = label_sets
    assert dict(labels)["route"] == "/api/students/{id}"
    assert REGISTRY.get_sample_value("http_requests_total", dict(labels)) == 50


def test_unmatched_path_uses_fixed_label() -> None:
    client = _stub()
    for i in range(5):
        assert client.get(f"/no/such/path/{i}").status_code == 404
    routes = {s.labels["route"] for s in _samples("http_requests_total")}
    assert routes == {"unmatched"}


def test_health_and_metrics_paths_not_counted() -> None:
    client = _stub()
    client.get("/health")
    client.get("/health/live")
    client.get("/metrics")
    assert _samples("http_requests_total") == []
    assert [s for s in _samples("http_request_duration_seconds_count")] == []


def test_server_error_status_recorded() -> None:
    app = create_app(with_db=False)

    @app.get("/boom")
    async def boom():
        raise UpstreamError("down", 503)

    TestClient(app).get("/boom")
    assert REGISTRY.get_sample_value(
        "http_requests_total", {"svc": "test", "method": "GET", "route": "/boom", "status": "503"}) == 1


def test_metrics_endpoint_exposes_prometheus_and_ft_events() -> None:
    _stub().get("/api/students/s1")
    text = metrics_text()
    assert "http_requests_total" in text
    assert "http_request_duration_seconds_bucket" in text
    assert 'le="0.8"' in text  # the fixed bucket layout Task 4's p95 alert relies on
    assert "ft_events_total" in text


def test_observe_request_helper() -> None:
    metrics.observe_request("svc-x", "POST", "/r", 201, 0.02)
    labels = {"svc": "svc-x", "method": "POST", "route": "/r", "status": "201"}
    assert REGISTRY.get_sample_value("http_requests_total", labels) == 1
    assert REGISTRY.get_sample_value("http_request_duration_seconds_count", {"svc": "svc-x", "route": "/r"}) == 1


# --- upstream attempts (retry), instance_up (health check), breaker gauge ---------------------------

def _attempts(pool: str, instance: str, outcome: str) -> float:
    return REGISTRY.get_sample_value(
        "upstream_attempts_total", {"pool": pool, "instance": instance, "outcome": outcome}) or 0


def test_retry_records_each_attempt_outcome(ft: None, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.fault_tolerance.software import retry

    monkeypatch.setattr(retry, "BACKOFF_MS", 0)
    ring = iter(["http://a", "http://b", "http://c"])
    current = {"i": "?"}

    async def fn(timeout):
        current["i"] = next(ring)
        if current["i"] == "http://a":
            raise UpstreamError("upstream 503", 503)
        if current["i"] == "http://b":
            raise asyncio.TimeoutError()
        return "ok"

    value, attempts = asyncio.run(retry.call("students", fn, instance=lambda: current["i"]))
    assert (value, attempts) == ("ok", 3)
    assert _attempts("students", "http://a", "error") == 1
    assert _attempts("students", "http://b", "timeout") == 1
    assert _attempts("students", "http://c", "ok") == 1


def test_retry_classifies_wrapped_httpx_timeout(ft: None, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.fault_tolerance.software import retry

    monkeypatch.setattr(retry, "BACKOFF_MS", 0)
    monkeypatch.setattr(retry, "RETRIES", 1)

    async def fn(timeout):
        try:
            raise httpx.ReadTimeout("slow")
        except httpx.ReadTimeout as exc:
            raise UpstreamError(str(exc), 0) from exc  # how the gateway wraps transport errors

    with pytest.raises(UpstreamError):
        asyncio.run(retry.call("students", fn, instance=lambda: "http://slow"))
    assert _attempts("students", "http://slow", "timeout") == 1


def test_retry_records_circuit_open(ft: None) -> None:
    from app.fault_tolerance.software import retry
    from app.fault_tolerance.software.circuit_breaker import CircuitBreaker

    breaker = CircuitBreaker("pool-open", threshold=1, cooldown_ms=60_000)
    breaker.failure()

    async def fn(timeout):
        raise AssertionError("must not be called while the breaker is open")

    with pytest.raises(UpstreamError):
        asyncio.run(retry.call("pool-open", fn, breaker))
    assert _attempts("pool-open", "none", "circuit_open") == 1


def test_baseline_single_attempt_recorded() -> None:
    from app.fault_tolerance.software import retry

    async def fn(timeout):
        assert timeout is None
        return "ok"

    asyncio.run(retry.call("payments", fn, instance=lambda: "http://p1"))
    assert _attempts("payments", "http://p1", "ok") == 1


def test_breaker_gauge_follows_open_and_close() -> None:
    from app.fault_tolerance.software.circuit_breaker import CircuitBreaker

    breaker = CircuitBreaker("gauge-pool", threshold=2)
    gauge = lambda: REGISTRY.get_sample_value("circuit_breaker_open", {"name": "gauge-pool"})  # noqa: E731
    assert gauge() == 0
    breaker.failure()
    assert gauge() == 0
    breaker.failure()
    assert gauge() == 1
    breaker.success()
    assert gauge() == 0


def test_health_probe_sets_instance_up() -> None:
    from app.fault_tolerance.software import health_check

    class Client:
        def __init__(self, status):
            self.status = status

        async def get(self, url, timeout=None, headers=None):
            if self.status is None:
                raise httpx.ConnectError("refused")
            return httpx.Response(self.status)

    asyncio.run(health_check._probe(Client(200), "http://up:3000"))
    asyncio.run(health_check._probe(Client(None), "http://down:3000"))
    asyncio.run(health_check._probe(Client(503), "http://sick:3000"))
    value = lambda t: REGISTRY.get_sample_value("instance_up", {"target": t})  # noqa: E731
    assert (value("http://up:3000"), value("http://down:3000"), value("http://sick:3000")) == (1, 0, 0)


def test_security_counters_exist_with_fixed_names() -> None:
    metrics.AUTH_DENIED.labels(reason="bad_token").inc()
    metrics.RATE_LIMITED.labels(scope="ip").inc()
    metrics.INSTANCE_EJECTED.labels(target="http://x").set(1)
    assert REGISTRY.get_sample_value("auth_denied_total", {"reason": "bad_token"}) == 1
    assert REGISTRY.get_sample_value("rate_limited_total", {"scope": "ip"}) == 1
    assert REGISTRY.get_sample_value("instance_ejected", {"target": "http://x"}) == 1


# --- payments_stale_pending ---------------------------------------------------------------------------

def test_stale_pending_gauge_refreshed_from_query(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import payment

    seen = {}

    async def fake_read(sql, params=()):
        seen["sql"] = sql
        return [{"n": 3, "completed": 40}]

    monkeypatch.setattr(payment, "read_primary", fake_read)
    asyncio.run(payment.refresh_stale_pending())
    assert "state = 'pending'" in seen["sql"] and "15 seconds" in seen["sql"]
    assert REGISTRY.get_sample_value("payments_stale_pending") == 3


def test_stale_pending_keeps_last_value_when_db_down(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import payment

    async def ok_read(sql, params=()):
        return [{"n": 2, "completed": 40}]

    async def down_read(sql, params=()):
        raise UpstreamError("db down", 503)

    monkeypatch.setattr(payment, "read_primary", ok_read)
    asyncio.run(payment.refresh_stale_pending())
    monkeypatch.setattr(payment, "read_primary", down_read)
    asyncio.run(payment.refresh_stale_pending())  # must not raise: the loop has to survive an outage
    assert REGISTRY.get_sample_value("payments_stale_pending") == 2



def test_stale_pending_probe_never_logs_replica_fallback(ft, monkeypatch: pytest.MonkeyPatch) -> None:
    """The 5 s probe is not workload: with FT on and the primary down it must not emit 'degraded' events."""
    from app.core import db, eventlog
    from app.services import payment

    class _DownPool:
        def connection(self):
            raise ConnectionError("primary down")

    class _ReplicaConn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def cursor(self, row_factory=None):
            return _ReplicaCursor()

    class _ReplicaCursor(_ReplicaConn):
        description = ("n",)

        async def execute(self, sql, params):
            pass

        async def fetchall(self):
            return [{"n": 7, "completed": 40}]

    class _ReplicaPool:
        def connection(self):
            return _ReplicaConn()

    monkeypatch.setattr(db, "_primary", _DownPool())
    monkeypatch.setattr(db, "_replica", _ReplicaPool())
    key = ("degraded", "read_from_replica")

    before = eventlog._counts[key]
    asyncio.run(db.read("SELECT 1"))  # control: the request path does fail over and log it
    assert eventlog._counts[key] == before + 1

    metrics.set_stale_pending(4)
    before = eventlog._counts[key]
    for _ in range(3):
        asyncio.run(payment.refresh_stale_pending())
    assert eventlog._counts[key] == before
    assert REGISTRY.get_sample_value("payments_stale_pending") == 4  # primary down: last value kept
