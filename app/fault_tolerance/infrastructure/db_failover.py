"""H2 read failover to the standby, and H6 writer discovery after an automatic failover.

H2 (midterm): a read that fails on the primary is answered by the hot standby.

H6 (final): the database controller (``app/services/db_controller.py``) promotes the standby when
the primary is gone. The services then have to find the new primary on their own. Each service
asks both nodes for their role once a second (``PROBE_SQL``) and ``pick_writer`` chooses where
writes go. The rule also fences a stale primary without any coordination: of the nodes that accept
writes, the one on the highest timeline wins, and a promotion always starts a new timeline.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

from ...core.errors import UpstreamError
from ...core.eventlog import ft_enabled, log

# One row per node. timeline is 0 on a standby (pg_current_wal_lsn() is not allowed in recovery).
PROBE_SQL = (
    "SELECT pg_is_in_recovery() AS standby, "
    "current_setting('default_transaction_read_only') = 'on' AS fenced, "
    "CASE WHEN pg_is_in_recovery() THEN 0 "
    "ELSE ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::int END AS timeline"
)


@dataclass(frozen=True)
class NodeState:
    standby: bool            # in recovery: read-only by nature
    fenced: bool             # a stale primary the controller made read-only
    timeline: int = 0        # 0 for a standby
    standbys: int = 0        # streaming standbys attached (controller only)
    sync_names: str = ""     # synchronous_standby_names (controller only)

    @property
    def writable(self) -> bool:
        return not self.standby and not self.fenced


def pick_writer(states: Dict[str, Optional[NodeState]]) -> Optional[str]:
    """The node writes go to: writable, on the highest timeline. None if no node accepts writes.

    ``states`` maps a node name to its state, or to None when the node did not answer. Two writable
    nodes on the same timeline cannot be told apart (it does not happen through promotion), so the
    first one in ``states`` order is kept: the configured primary.
    """
    best: Optional[str] = None
    for name, state in states.items():
        if state is None or not state.writable:
            continue
        if best is None or state.timeline > states[best].timeline:  # type: ignore[union-attr]
            best = name
    return best


async def read(query: Callable[[Any], Awaitable[List[Any]]], primary: Any, replica: Optional[Any]) -> List[Any]:
    try:
        return await query(primary)
    except Exception as exc:
        if not ft_enabled() or replica is None:  # baseline never uses the standby
            raise UpstreamError(str(exc), 503) from exc
        try:
            rows = await query(replica)  # H2: hot standby
            log(kind="degraded", target="db", reason="read_from_replica")
            return rows
        except Exception as exc2:
            raise UpstreamError(str(exc2), 503) from exc2
