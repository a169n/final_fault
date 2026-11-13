from __future__ import annotations

import asyncio
import datetime as _dt
import decimal
import os
from typing import Any, Dict, List, Optional, Sequence

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ..fault_tolerance.infrastructure import db_failover
from ..fault_tolerance.software import timeouts
from .errors import UpstreamError
from .eventlog import final_enabled, log

Row = Dict[str, Any]

_primary = AsyncConnectionPool(
    os.environ["DATABASE_URL"], min_size=1, max_size=10, timeout=timeouts.DB_ACQUIRE_S, open=False
)
_replica = (
    AsyncConnectionPool(
        os.environ["DATABASE_REPLICA_URL"], min_size=1, max_size=5, timeout=timeouts.DB_ACQUIRE_S, open=False
    )
    if os.environ.get("DATABASE_REPLICA_URL")
    else None
)


# H6 (final): which node takes the writes. Index into _node_pools(); 0 is the configured primary. The other
# modes never change it, so they keep writing to DATABASE_URL exactly as before.
def _node_pools() -> List[AsyncConnectionPool]:
    return [_primary] + ([_replica] if _replica is not None else [])


_node_names = [os.environ.get("DATABASE_URL", "").rsplit("@", 1)[-1].split(":")[0] or "primary",
               os.environ.get("DATABASE_REPLICA_URL", "").rsplit("@", 1)[-1].split(":")[0] or "replica"]
_writer_index = 0
_refresh_task: Optional[asyncio.Task] = None
WRITER_REFRESH_S = 0.5
WRITER_PROBE_S = 0.5
_refresh_wanted: Optional[asyncio.Event] = None


def _write_failed() -> None:
    # A failed write is the earliest sign of a failover: look for the writer now, not at the next tick.
    if _refresh_wanted is not None:
        _refresh_wanted.set()


def _writer() -> AsyncConnectionPool:
    return _node_pools()[_writer_index]


def _other() -> Optional[AsyncConnectionPool]:
    nodes = _node_pools()
    return nodes[1 - _writer_index] if len(nodes) == 2 else None


async def _probe(pool: AsyncConnectionPool) -> Optional[db_failover.NodeState]:
    try:
        async with pool.connection(timeout=WRITER_PROBE_S) as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await asyncio.wait_for(cur.execute(db_failover.PROBE_SQL), timeout=WRITER_PROBE_S)
                row = await cur.fetchone()
        return db_failover.NodeState(standby=row["standby"], fenced=row["fenced"], timeline=row["timeline"])
    except Exception:
        return None


async def refresh_writer() -> None:
    """Ask both nodes for their role and route writes to the one pick_writer chooses (H6)."""
    global _writer_index
    states = dict(zip(_node_names, await asyncio.gather(*(_probe(p) for p in _node_pools()))))
    chosen = db_failover.pick_writer(states)
    if chosen is None:
        return  # no node accepts writes right now: keep the last choice, writes fail fast (S8)
    index = _node_names.index(chosen)
    if index != _writer_index:
        log(kind="failover", target="db", action="writer_changed", to=chosen,
            timeline=states[chosen].timeline)  # type: ignore[union-attr]
        _writer_index = index


async def _refresh_loop() -> None:
    global _refresh_wanted
    _refresh_wanted = asyncio.Event()
    while True:
        try:
            await refresh_writer()
        except Exception:
            pass
        _refresh_wanted.clear()
        try:  # the next look: after WRITER_REFRESH_S, or at once when a write fails (at most 10 a second)
            await asyncio.wait_for(_refresh_wanted.wait(), timeout=WRITER_REFRESH_S)
            await asyncio.sleep(0.1)
        except asyncio.TimeoutError:
            pass


async def open_pools() -> None:
    global _refresh_task
    await _primary.open(wait=False)  # start even if the DB is down
    if _replica is not None:
        await _replica.open(wait=False)
    if final_enabled() and _replica is not None:
        _refresh_task = asyncio.create_task(_refresh_loop())


async def close_pools() -> None:
    if _refresh_task is not None:
        _refresh_task.cancel()
    await _primary.close()
    if _replica is not None:
        await _replica.close()


def to_jsonable(value: Any) -> Any:
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_jsonable(v) for v in value]
    return value


async def _query(pool: AsyncConnectionPool, sql: str, params: Sequence[Any]) -> List[Row]:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params)
            if cur.description is None:
                return []
            return await cur.fetchall()


async def read(sql: str, params: Sequence[Any] = ()) -> List[Row]:
    return await db_failover.read(lambda pool: _query(pool, sql, params), _writer(), _other())  # H2


async def read_primary(sql: str, params: Sequence[Any] = ()) -> List[Row]:
    # Background probes only: primary or nothing. Going through db_failover.read would log a
    # "degraded" read_from_replica event per poll and inflate the request-level FT metrics.
    try:
        return await _query(_writer(), sql, params)
    except Exception as exc:
        raise UpstreamError(str(exc), 503) from exc


async def write(sql: str, params: Sequence[Any] = ()) -> List[Row]:  # the writer only (H6: wherever it is)
    try:
        return await _query(_writer(), sql, params)
    except Exception as exc:
        _write_failed()
        raise UpstreamError(str(exc), 503) from exc


class transaction:

    def __init__(self) -> None:
        self._conn_ctx = None
        self._cur_ctx = None

    async def __aenter__(self):
        self._conn_ctx = _writer().connection()
        conn = await self._conn_ctx.__aenter__()
        self._cur_ctx = conn.cursor(row_factory=dict_row)
        return await self._cur_ctx.__aenter__()

    async def __aexit__(self, exc_type, exc, tb):
        await self._cur_ctx.__aexit__(exc_type, exc, tb)
        result = await self._conn_ctx.__aexit__(exc_type, exc, tb)
        if exc_type is not None:
            _write_failed()
            log(kind="recovery", target="tx", action="rollback", err=str(exc))
        return result


async def db_healthy() -> bool:
    try:
        await asyncio.wait_for(_query(_writer(), "SELECT 1", ()), timeout=timeouts.HEALTH_DB_CHECK_S)
        return True
    except Exception:
        return False
