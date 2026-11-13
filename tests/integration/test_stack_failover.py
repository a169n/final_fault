"""End-to-end tests of the final mechanisms against the running final stack: automatic database
failover (H8), writer discovery (S12), rejoin, least privilege of the new roles, and backup/restore (H9).

Run with the stack up:  npm run up:final && python3 -m pytest -m integration -q tests/integration/test_stack_failover.py
Every test skips unless the gateway reports mode == "final" (or fails, with STACK_REQUIRED=1).
The failover test stops and restarts a database container: it takes about a minute and leaves the
two nodes with swapped roles, which is a normal state of the system.
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import time
import uuid
from typing import Dict, Optional

import httpx
import psycopg
import pytest

pytestmark = pytest.mark.integration

ROOT = pathlib.Path(__file__).resolve().parents[2]
STACK_URL = os.environ.get("STACK_URL", "http://localhost:8080")
CONTROLLER = os.environ.get("CONTROLLER_URL", "http://localhost:3061")
DB_PORTS = {"postgres-primary": 55432, "postgres-replica": 55433}
STACK_REQUIRED = os.environ.get("STACK_REQUIRED") == "1"


def _unavailable(reason: str) -> None:
    if STACK_REQUIRED:
        pytest.fail(reason, pytrace=False)
    pytest.skip(reason)


def _dotenv() -> Dict[str, str]:
    env: Dict[str, str] = {}
    path = ROOT / ".env"
    if path.exists():
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip()
    return env


ENV = _dotenv()


def _compose(*args: str) -> None:
    subprocess.run(["docker", "compose", *args], cwd=ROOT, check=True, capture_output=True, timeout=120)


def _controller() -> dict:
    return httpx.get(f"{CONTROLLER}/health", timeout=3).json()


def _wait(predicate, timeout_s: float, what: str):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as exc:  # the stack is changing under us: keep polling
            last = exc
        time.sleep(0.5)
    pytest.fail(f"timed out after {timeout_s} s waiting for {what} (last: {last!r})", pytrace=False)


def _healthy_pair() -> Optional[dict]:
    state = _controller()
    writer = state.get("writer")
    if writer and state["nodes"][writer].get("standbys", 0) >= 1 and state["nodes"][writer].get("sync"):
        return state
    return None


@pytest.fixture(scope="module")
def token() -> str:
    try:
        health = httpx.get(f"{STACK_URL}/health", timeout=3).json()
    except Exception as exc:
        _unavailable(f"stack not reachable at {STACK_URL}: {exc}")
    if health.get("mode") != "final":
        _unavailable(f"stack is in mode {health.get('mode')!r}, these tests need final (npm run up:final)")
    _wait(_healthy_pair, 60, "a primary with a synchronous standby")
    res = httpx.post(f"{STACK_URL}/auth/token", json={"username": "bursar", "password": ENV.get("DEMO_PASSWORD", "")}, timeout=5)
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


def _pay(token: str, key: Optional[str] = None) -> httpx.Response:
    return httpx.post(
        f"{STACK_URL}/api/payments", json={"studentId": "s9", "amount": 10},
        headers={"authorization": f"Bearer {token}", "idempotency-key": key or f"it-final-{uuid.uuid4()}"}, timeout=5)


def test_controller_sees_one_writer_and_a_synchronous_standby(token):
    state = _healthy_pair()
    assert state is not None
    roles = sorted(node["role"] for node in state["nodes"].values())
    assert roles == ["primary", "standby"]
    assert state["active"] is True


def test_failover_role_cannot_read_tables(token):
    """Least privilege (THREAT-MODEL.md F.E1): the controller's role sees roles and statistics, no data."""
    writer = _controller()["writer"]
    url = f"postgresql://failover:{ENV['FAILOVER_DB_PASSWORD']}@127.0.0.1:{DB_PORTS[writer]}/university"
    with psycopg.connect(url, connect_timeout=3, autocommit=True) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("SELECT count(*) FROM payments")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("ALTER SYSTEM SET max_connections = 5")  # only two parameters are granted


def test_backup_role_is_read_only(token):
    writer = _controller()["writer"]
    url = f"postgresql://backup:{ENV['BACKUP_DB_PASSWORD']}@127.0.0.1:{DB_PORTS[writer]}/university"
    with psycopg.connect(url, connect_timeout=3, autocommit=True) as conn:
        assert conn.execute("SELECT count(*) FROM students").fetchone()[0] >= 200
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("UPDATE students SET balance = 0 WHERE id = 's9'")


def test_a_recent_verified_backup_exists_and_restores(token):
    latest = json.loads((ROOT / "backups" / "latest.json").read_text())
    assert time.time() - latest["finishedMs"] / 1000 < 60, "the newest backup is older than 60 s"
    out = subprocess.run(["node", "--experimental-strip-types", "experiments/restore.ts", "--verify"],
                         cwd=ROOT, capture_output=True, text=True, timeout=120)
    report = json.loads(out.stdout)
    assert report["ok"] is True, report
    assert report["checksumOk"] is True
    assert report["scratch"]["ledgerBalanced"] is True
    assert report["merged"] is None  # --verify does not touch the live database


def test_primary_failure_promotes_the_standby_and_loses_no_acknowledged_payment(token):
    before = _controller()
    old_writer = before["writer"]
    acked = [key for key in (f"it-fo-{uuid.uuid4()}" for _ in range(20)) if _pay(token, key).status_code == 201]
    assert len(acked) == 20

    _compose("stop", old_writer)
    stopped_at = time.time()
    try:
        # payments come back without anyone starting the node again
        _wait(lambda: _pay(token).status_code == 201, 20, "a payment to succeed after the failover")
        recovery_s = time.time() - stopped_at
        after = _controller()
        assert after["writer"] not in (None, old_writer)
        assert after["nodes"][after["writer"]]["timeline"] > before["nodes"][old_writer]["timeline"]
        assert recovery_s < 20

        # every payment acknowledged before the failure is on the new primary: same key -> stored result, no new charge
        for key in acked:
            res = _pay(token, key)
            assert res.status_code == 200 and res.json()["state"] == "completed", (key, res.status_code, res.text)
    finally:
        _compose("start", old_writer)

    # the old primary rejoins as a standby by itself and replication is synchronous again
    state = _wait(_healthy_pair, 90, "the old primary to rejoin as a synchronous standby")
    assert state["nodes"][old_writer]["role"] == "standby"
