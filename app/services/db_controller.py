"""Database controller: observes both PostgreSQL nodes and, in final mode, acts on what it sees (H8).

Every second it asks each node for its role (``NodeState``). In every mode it only exports that
picture as metrics, so the database is observed the same way in baseline and in final. With
``FINAL_ENABLED=1`` it also takes three actions, each with one narrow database privilege
(``config/postgres/init/90-grants.sql``, role ``failover``):

* **promote**: no node has accepted writes for ``FAILOVER_THRESHOLD`` probes in a row, and a
  standby is reachable that was in sync when the primary was last seen -> ``pg_promote()``.
  A standby that was not in sync is never promoted: that would silently drop acknowledged writes.
* **fence**: two nodes accept writes (the old primary came back) -> the one on the lower timeline
  is made read-only (``default_transaction_read_only``). The operator restarts it and
  ``config/postgres/scripts/node.sh`` rebuilds it as a standby.
* **sync on/off**: synchronous replication is on while a standby streams, so an acknowledged
  write is on both nodes before the client hears about it (no acknowledged write is lost in a
  failover). When the standby is gone it is switched off after ``SYNC_GRACE`` probes, otherwise
  every write would wait for a standby that is not there.

``decide`` is a pure function of the observed states, so the policy is unit-tested without a
database (``tests/unit/test_db_controller.py``).
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import psycopg
from fastapi import FastAPI
from prometheus_client import Counter, Gauge
from psycopg.rows import dict_row

from ..core.eventlog import final_enabled, log, mode
from ..core.service import create_app
from ..fault_tolerance.infrastructure.db_failover import PROBE_SQL, NodeState, pick_writer

PROBE_INTERVAL_S = float(os.environ.get("DB_PROBE_INTERVAL_S", 1.0))
PROBE_TIMEOUT_S = float(os.environ.get("DB_PROBE_TIMEOUT_S", 1.0))
FAILOVER_THRESHOLD = int(os.environ.get("FAILOVER_THRESHOLD", 3))   # probes without a writer before promoting
SYNC_GRACE = int(os.environ.get("SYNC_GRACE", 2))                   # probes without a standby before going async
BACKUP_STATUS = pathlib.Path(os.environ.get("BACKUP_DIR", "/backups")) / "latest.json"

CONTROLLER_SQL = PROBE_SQL + (
    ", (SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming') AS standbys"
    ", current_setting('synchronous_standby_names') AS sync_names"
)

NODE_UP = Gauge("db_node_up", "Database node answers the controller's probe (1) or not (0).", ["node"])
NODE_WRITABLE = Gauge("db_node_writable", "Database node accepts writes (1): a primary that is not fenced.", ["node"])
NODE_FENCED = Gauge("db_node_fenced", "Stale primary made read-only by the controller (1).", ["node"])
WRITER_AVAILABLE = Gauge("db_writer_available", "A node accepts writes (1) or none does (0).")
STANDBY_STREAMING = Gauge("db_standby_streaming", "Standbys streaming from the current writer.")
SYNC_REPLICATION = Gauge("db_sync_replication", "Synchronous replication is on at the writer (1).")
FAILOVERS = Counter("db_failovers_total", "Standby promotions performed by the controller.")
FAILOVER_REFUSED = Counter("db_failover_refused_total", "Promotions refused, by reason.", ["reason"])
# Registered on the first backup seen: an unlabelled gauge is exported as 0 from the moment it is
# created, and "last backup at time 0" would make BackupStale fire in every mode without backups.
_backup_gauges: Optional[Tuple[Gauge, Gauge]] = None


def _nodes_from_env() -> Dict[str, str]:
    # DB_NODES="postgres-primary=postgresql://...,postgres-replica=postgresql://..."; order = preference
    nodes: Dict[str, str] = {}
    for item in os.environ.get("DB_NODES", "").split(","):
        name, _, url = item.partition("=")
        if name and url:
            nodes[name.strip()] = url.strip()
    return nodes


@dataclass(frozen=True)
class Action:
    kind: str    # promote | fence | sync_on | sync_off | refuse
    node: str
    reason: str = ""


@dataclass
class Memory:
    """What the controller remembers between probes."""
    no_writer: int = 0             # consecutive probes without a writable node
    no_standby: int = 0            # consecutive probes in which the writer had no streaming standby
    standby_in_sync: bool = False  # the writer was last seen with synchronous replication on and a standby streaming
    refused_logged: bool = field(default=False, compare=False)


def decide(states: Dict[str, Optional[NodeState]], memory: Memory,
           threshold: int = FAILOVER_THRESHOLD, sync_grace: int = SYNC_GRACE) -> List[Action]:
    """The controller's policy. Updates ``memory`` and returns the actions for this probe."""
    actions: List[Action] = []
    writer = pick_writer(states)

    # Fence: every other node that still accepts writes is a stale primary.
    if writer is not None:
        for name, state in states.items():
            if name != writer and state is not None and state.writable:
                actions.append(Action("fence", name, f"stale primary, {writer} is on a newer or equal timeline"))

    if writer is None:
        memory.no_writer += 1
        standby = next((n for n, s in states.items() if s is not None and s.standby), None)
        if memory.no_writer >= threshold and standby is not None:
            if memory.standby_in_sync:
                actions.append(Action("promote", standby, f"no writer for {memory.no_writer} probes"))
            else:
                actions.append(Action("refuse", standby, "standby_not_in_sync"))
        return actions

    memory.no_writer = 0
    memory.refused_logged = False
    state = states[writer]
    assert state is not None
    sync_on = state.sync_names != ""
    if state.standbys > 0:
        memory.no_standby = 0
        if not sync_on:
            actions.append(Action("sync_on", writer, "standby streaming"))
    else:
        memory.no_standby += 1
        if sync_on and memory.no_standby >= sync_grace:
            actions.append(Action("sync_off", writer, f"no standby for {memory.no_standby} probes"))
    memory.standby_in_sync = sync_on and state.standbys > 0
    return actions


NODES = _nodes_from_env()
_memory = Memory()
_last: Dict[str, Optional[NodeState]] = {}


async def _connect(url: str) -> psycopg.AsyncConnection:
    return await asyncio.wait_for(
        psycopg.AsyncConnection.connect(url, autocommit=True, connect_timeout=max(1, int(PROBE_TIMEOUT_S))),
        timeout=PROBE_TIMEOUT_S)


async def _probe(url: str) -> Optional[NodeState]:
    try:
        async with await _connect(url) as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await asyncio.wait_for(cur.execute(CONTROLLER_SQL), timeout=PROBE_TIMEOUT_S)
                row = await cur.fetchone()
        return NodeState(standby=row["standby"], fenced=row["fenced"], timeline=row["timeline"],
                         standbys=row["standbys"], sync_names=row["sync_names"])
    except Exception:
        return None


async def _run(node: str, *statements: str) -> None:
    async with await _connect(NODES[node]) as conn:
        for sql in statements:
            await conn.execute(sql)


async def _apply(action: Action) -> None:
    if action.kind == "refuse":
        if not _memory.refused_logged:  # once per outage, not once per probe
            FAILOVER_REFUSED.labels(reason=action.reason).inc()
            log(kind="failover", target="db", action="promotion_refused", node=action.node,
                reason=action.reason, level="error")
            _memory.refused_logged = True
        return
    try:
        if action.kind == "promote":
            # The promoted node may carry the old primary's synchronous_standby_names (it was cloned
            # from it); with no standby attached every write would hang, so clear it in the same step.
            await _run(action.node, "SELECT pg_promote(true, 10)",
                       "ALTER SYSTEM SET synchronous_standby_names = ''", "SELECT pg_reload_conf()")
            FAILOVERS.inc()
            _memory.no_writer = 0
            _memory.standby_in_sync = False
        elif action.kind == "fence":
            await _run(action.node, "ALTER SYSTEM SET default_transaction_read_only = on", "SELECT pg_reload_conf()")
        elif action.kind == "sync_on":
            await _run(action.node, "ALTER SYSTEM SET synchronous_standby_names = '*'", "SELECT pg_reload_conf()")
        elif action.kind == "sync_off":
            await _run(action.node, "ALTER SYSTEM SET synchronous_standby_names = ''", "SELECT pg_reload_conf()")
        log(kind="failover", target="db", action=action.kind, node=action.node, reason=action.reason,
            level="warning" if action.kind in ("promote", "fence", "sync_off") else "info")
    except Exception as exc:
        log(kind="failover", target="db", action=f"{action.kind}_failed", node=action.node, ok=False, err=str(exc))


def _export(states: Dict[str, Optional[NodeState]]) -> None:
    writer = pick_writer(states)
    for name, state in states.items():
        NODE_UP.labels(node=name).set(0 if state is None else 1)
        NODE_WRITABLE.labels(node=name).set(1 if state is not None and state.writable else 0)
        NODE_FENCED.labels(node=name).set(1 if state is not None and state.fenced else 0)
    WRITER_AVAILABLE.set(0 if writer is None else 1)
    writer_state = states.get(writer) if writer else None
    STANDBY_STREAMING.set(writer_state.standbys if writer_state else 0)
    SYNC_REPLICATION.set(1 if writer_state and writer_state.sync_names != "" else 0)
    try:  # written by the backup sidecar; absent when backups are off, and then the series stays absent
        latest = json.loads(BACKUP_STATUS.read_text())
        global _backup_gauges
        if _backup_gauges is None:
            _backup_gauges = (
                Gauge("backup_last_success_timestamp_seconds", "Finish time of the newest verified backup."),
                Gauge("backup_last_size_bytes", "Size of the newest verified backup."))
        _backup_gauges[0].set(latest["finishedMs"] / 1000)
        _backup_gauges[1].set(latest["sizeBytes"])
    except Exception:
        pass


async def tick() -> Tuple[Dict[str, Optional[NodeState]], List[Action]]:
    global _last
    names = list(NODES)
    states = dict(zip(names, await asyncio.gather(*(_probe(NODES[n]) for n in names))))
    for name, state in states.items():  # log role changes: the timeline of a failover in the event log
        before = _last.get(name)
        if name not in _last or (before is None) != (state is None) or (
                before and state and (before.standby, before.fenced) != (state.standby, state.fenced)):
            log(kind="db_node", target=name, ok=state is not None,
                state="down" if state is None else "standby" if state.standby
                else "fenced" if state.fenced else "primary",
                timeline=None if state is None else state.timeline)
    _last = states
    _export(states)
    actions = decide(states, _memory) if final_enabled() else []
    for action in actions:
        await _apply(action)
    return states, actions


async def _loop() -> None:
    while True:
        try:
            await tick()
        except Exception as exc:  # the controller must never die on one bad probe
            log(kind="failover", target="db", action="tick_failed", ok=False, err=str(exc))
        await asyncio.sleep(PROBE_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_loop())
    yield
    task.cancel()


app = create_app(with_db=False, lifespan=lifespan)


def _describe(state: Optional[NodeState]) -> dict:
    if state is None:
        return {"up": False}
    return {"up": True, "role": "standby" if state.standby else "fenced" if state.fenced else "primary",
            "timeline": state.timeline, "standbys": state.standbys, "sync": state.sync_names != ""}


@app.get("/health/ready")
@app.get("/health")
async def health():
    return {"ok": True, "mode": mode(), "active": final_enabled(), "writer": pick_writer(_last),
            "nodes": {name: _describe(state) for name, state in _last.items()}}
