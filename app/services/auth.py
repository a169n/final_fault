"""Auth microservice: exchanges a username and password for a short-lived JWT.

POST /token {"username", "password"}
  200 {"access_token", "token_type": "bearer", "expires_in": 900}
  401 {"error": "invalid credentials"}   the same body for an unknown user and a wrong password
  400 {"error": "username and password are required"}

Input the client controls (malformed or deeply nested JSON, a lone-surrogate password) always gets
a 4xx, never a 5xx: the gateway retries a 5xx and counts it against the auth circuit breaker and
outlier ejection, so a 5xx here would let anyone block every login without credentials.

Users live in ``app_users`` (config/postgres/init/30-auth.sql). On start-up, if the table is
empty, the demo users are seeded with DEMO_PASSWORD from .env (synthetic data only):
admin (admin), bursar (staff), s7 and s8 (students s7 and s8).

The gateway proxies POST /auth/token here and verifies tokens itself with JWT_SECRET, so this
service is needed only to log in: an outage blocks new logins, not existing sessions.

This service owns the failed-login count and the login audit: every login, success or failure,
writes a ``kind="audit"`` line (action ``login``), and every 401 here increments
``auth_denied_total{reason="invalid_credentials"}`` (AuthFailureSpike). The gateway must not count
or audit a 401 relayed from /auth/token a second time.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ..core import metrics
from ..core.db import close_pools, db_healthy, open_pools, read, read_primary, to_jsonable, write
from ..core.eventlog import ft_enabled, log
from ..core.service import create_app
from ..security import audit, passwords, tokens

DEMO_USERS = (  # username, role, student_id
    ("admin", "admin", None),
    ("bursar", "staff", None),
    ("s7", "student", "s7"),
    ("s8", "student", "s8"),
)
SEED_RETRY_S = 2.0
_USERNAME = re.compile(r"[A-Za-z0-9._-]{1,64}")  # an implausible name is never looked up or logged
MAX_PASSWORD_LEN = 1024                          # scrypt cost does not depend on it, but bound the input

_INVALID = {"error": "invalid credentials"}
# Exported as 0 from start-up: rate() cannot count a series' first scrape (reports/endterm/ALERTS.md).
_FAILED_LOGINS = metrics.AUTH_DENIED.labels(reason="invalid_credentials")
_dummy_hash: Optional[str] = None


def _dummy() -> str:
    # Hashed once, lazily: an unknown user still costs one scrypt check, so response time
    # does not reveal whether the user exists.
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = passwords.hash_password("dummy-password-for-unknown-users")
    return _dummy_hash


async def find_user(username: str) -> Optional[dict]:
    rows = await read(  # H2: reads fail over to the standby, so logins survive a primary outage
        "SELECT username, password_hash, role, student_id FROM app_users WHERE username = %s", (username,))
    return rows[0] if rows else None


async def seed_if_empty(demo_password: str) -> bool:
    rows = await read_primary("SELECT count(*) AS n FROM app_users")
    if rows and rows[0]["n"] > 0:
        return False
    for username, role, student_id in DEMO_USERS:
        hashed = await asyncio.to_thread(passwords.hash_password, demo_password)
        await write(
            """INSERT INTO app_users (username, password_hash, role, student_id) VALUES (%s, %s, %s, %s)
               ON CONFLICT (username) DO NOTHING""",
            (username, hashed, role, student_id),
        )
    return True


async def _seed_loop() -> None:
    demo_password = os.environ.get("DEMO_PASSWORD", "")
    if not demo_password:
        log(kind="seed", target="app_users", ok=False, err="DEMO_PASSWORD is not set")
        return
    while True:  # the primary may still be starting, or down: keep trying, never crash the service
        try:
            seeded = await seed_if_empty(demo_password)
            log(kind="seed", target="app_users", ok=True, action="seeded" if seeded else "skipped")
            return
        except Exception as exc:
            log(kind="seed", target="app_users", ok=False, err=str(exc))
            await asyncio.sleep(SEED_RETRY_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pools()
    seeding = asyncio.create_task(_seed_loop())
    yield
    seeding.cancel()
    await close_pools()


app = create_app(lifespan=lifespan)


@app.get("/health/ready")
@app.get("/health")  # alias of /health/ready
async def health():
    ok = await db_healthy()
    return JSONResponse(status_code=200 if ok else 503, content={"ok": ok, "ft": ft_enabled()})


def _deny(cause: str, username: Optional[str]) -> JSONResponse:
    # audit.record counts the deny in auth_denied_total{reason="invalid_credentials"} (one label for
    # every cause, so the metric does not reveal which usernames exist); the cause is in the line.
    audit.record("login", "deny", None, "invalid_credentials", user=username, cause=cause)
    return JSONResponse(status_code=401, content=_INVALID)


@app.post("/token")
async def token(request: Request):
    # The body is parsed as JSON whatever its content type (`curl -d` sends a form type).
    try:
        body = json.loads(await request.body() or b"null")
    except (ValueError, RecursionError):  # bad JSON or UTF-8 (both ValueError), or nested too deep
        body = None  # a 400, never a 5xx: client input must not trip the gateway's auth breaker
    username = body.get("username") if isinstance(body, dict) else None
    password = body.get("password") if isinstance(body, dict) else None
    if not isinstance(username, str) or not isinstance(password, str):
        return JSONResponse(status_code=400, content={"error": "username and password are required"})

    if not _USERNAME.fullmatch(username) or len(password) > MAX_PASSWORD_LEN:
        await asyncio.to_thread(passwords.verify_password, password[:MAX_PASSWORD_LEN], _dummy())
        return _deny("implausible_username", None)  # the raw name is not logged (log injection)

    user = await find_user(username)
    stored = user["password_hash"] if user else _dummy()
    ok = await asyncio.to_thread(passwords.verify_password, password, stored)  # off the event loop
    if not user or not ok:
        return _deny("unknown_user" if not user else "wrong_password", username)

    user = to_jsonable(user)
    access_token = tokens.issue(user["username"], user["role"], user["student_id"])
    audit.record("login", "allow", tokens.Principal(user["username"], user["role"], user["student_id"]),
                 "ok", user=user["username"])
    return {"access_token": access_token, "token_type": "bearer", "expires_in": tokens.TTL_S}
