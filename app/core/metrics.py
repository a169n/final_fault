"""Service-level Prometheus metrics.

The names are a contract: the alert rules and the Grafana dashboard (Task 4) query them.
Every label value comes from a bounded set (route *templates*, pool names, configured
instance URLs, fixed reason strings), never from raw request data, so a client cannot
blow up series cardinality by sending /api/students/s1 ... s200.
"""
from __future__ import annotations

from typing import Optional

from prometheus_client import REGISTRY, Counter, Gauge, Histogram, disable_created_metrics, generate_latest

disable_created_metrics()  # *_created series add nothing the dashboards use, only scrape size

BUCKETS = (.005, .01, .025, .05, .1, .25, .5, .8, 1, 2.5, 5, 10)

HTTP_REQUESTS = Counter(
    "http_requests_total", "HTTP requests served, by route template and status.",
    ["svc", "method", "route", "status"])
HTTP_DURATION = Histogram(
    "http_request_duration_seconds", "HTTP request latency, by route template.",
    ["svc", "route"], buckets=BUCKETS)
UPSTREAM_ATTEMPTS = Counter(
    "upstream_attempts_total", "Gateway attempts to an upstream instance, by outcome "
    "(ok|error|timeout|circuit_open).", ["pool", "instance", "outcome"])
INSTANCE_UP = Gauge("instance_up", "Gateway health-check verdict per instance (1 up, 0 down).", ["target"])
CIRCUIT_OPEN = Gauge("circuit_breaker_open", "Circuit breaker state (1 open or half-open, 0 closed).", ["name"])
INSTANCE_EJECTED = Gauge("instance_ejected", "Outlier ejection state per instance (1 ejected).", ["target"])
AUTH_DENIED = Counter("auth_denied_total", "Requests denied by authentication or authorization, by reason.", ["reason"])
RATE_LIMITED = Counter("rate_limited_total", "Requests rejected by the rate limiter, by scope.", ["scope"])

# Registered lazily: only the payment service owns this number, and an unlabelled gauge would
# otherwise be exported as 0 by every other service.
_stale_pending: Optional[Gauge] = None

_completed_rows: Optional[Gauge] = None

UNMATCHED = "unmatched"


def observe_request(svc: str, method: str, route: str, status: int, seconds: float) -> None:
    HTTP_REQUESTS.labels(svc=svc, method=method, route=route, status=str(status)).inc()
    HTTP_DURATION.labels(svc=svc, route=route).observe(seconds)


def upstream_attempt(pool: str, instance: str, outcome: str) -> None:
    UPSTREAM_ATTEMPTS.labels(pool=pool, instance=instance, outcome=outcome).inc()


def set_stale_pending(count: float) -> None:
    global _stale_pending
    if _stale_pending is None:
        _stale_pending = Gauge("payments_stale_pending",
                               "Payments still pending 15 s after creation (lost or interrupted transactions).")
    _stale_pending.set(count)


def set_completed_rows(count: float) -> None:
    # Completed payments never decrease (the application role has no DELETE or TRUNCATE), so a drop
    # means records were destroyed outside the application: the PaymentRecordsLost alert.
    global _completed_rows
    if _completed_rows is None:
        _completed_rows = Gauge("payments_completed_rows", "Rows in payments with state = 'completed'.")
    _completed_rows.set(count)


def render() -> str:
    return generate_latest(REGISTRY).decode()
