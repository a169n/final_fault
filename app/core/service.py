from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from . import metrics
from .context import HEADER as REQUEST_ID_HEADER
from .context import REQUEST_ID, accept_request_id
from .eventlog import SERVICE, log, metrics_text
from .errors import UpstreamError

# Probes, scrapes and the API docs are not workload: counting them would dilute error rates and latency.
_NOT_WORKLOAD = ("/health", "/metrics", "/docs", "/openapi.json")


def _is_workload(path: str) -> bool:
    return not any(path == p or path.startswith(p + "/") for p in _NOT_WORKLOAD)


def _route_label(request: Request) -> str:
    route = request.scope.get("route")  # set by the router on a match: the template, not the raw path
    return getattr(route, "path", None) or metrics.UNMATCHED


def create_app(with_db: bool = True, lifespan=None) -> FastAPI:
    if lifespan is None and with_db:
        from .db import close_pools, open_pools

        @asynccontextmanager
        async def _lifespan(app: FastAPI):
            await open_pools()
            yield
            await close_pools()

        lifespan = _lifespan

    app = FastAPI(title=SERVICE, lifespan=lifespan, redoc_url=None)  # Swagger UI: /docs

    @app.get("/health/live")
    async def _live():
        # Liveness: the process serves requests. Never touches the DB, so a DB outage does not make
        # Docker (or an orchestrator) restart healthy containers. Readiness is /health/ready, per service.
        return {"ok": True}

    @app.get("/metrics")
    async def _metrics():
        return PlainTextResponse(metrics_text(), media_type="text/plain; version=0.0.4")

    @app.exception_handler(UpstreamError)
    async def _upstream(_: Request, exc: UpstreamError):
        return JSONResponse(status_code=exc.status or 503, content={"error": str(exc)})

    @app.middleware("http")
    async def _observe(request: Request, call_next):
        started = time.perf_counter()
        rid = accept_request_id(request.headers.get(REQUEST_ID_HEADER))  # hostile ids never reach a log
        token = REQUEST_ID.set(rid)  # seen by the handler, its log lines and the gateway's forwarding
        try:
            try:
                response = await call_next(request)
            except UpstreamError as exc:
                response = JSONResponse(status_code=exc.status or 503, content={"error": str(exc)})
            except Exception as exc:
                response = JSONResponse(status_code=503, content={"error": str(exc)})
            seconds = time.perf_counter() - started
            if _is_workload(request.url.path):
                metrics.observe_request(SERVICE, request.method, _route_label(request),
                                        response.status_code, seconds)
                log(kind="request", target=f"{request.method} {request.url.path}",
                    ok=response.status_code < 500, status=response.status_code, ms=int(seconds * 1000))
        finally:
            REQUEST_ID.reset(token)
        response.headers["x-served-by"] = SERVICE
        response.headers[REQUEST_ID_HEADER] = rid
        return response

    return app
