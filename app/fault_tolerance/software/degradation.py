from __future__ import annotations

import os
import time
from collections import OrderedDict
from typing import Any, Dict, Optional

from fastapi.responses import JSONResponse

from ...core.eventlog import ft_enabled, log

STALE_MAX_MS = int(os.environ.get("STALE_MAX_MS", 60_000))  # S7
# Bound on the number of cached paths. Every distinct GET path that answered 2xx is an entry, so
# without a bound a client walking many paths would grow the gateway's memory for its whole life.
STALE_MAX_ENTRIES = int(os.environ.get("STALE_MAX_ENTRIES", 10_000))


class StaleCache:
    """Last good answer per (pool, path), least recently stored evicted first."""

    def __init__(self, max_entries: int = STALE_MAX_ENTRIES) -> None:
        self._entries: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._max = max(1, max_entries)

    def __len__(self) -> int:
        return len(self._entries)

    def remember(self, key: str, body: Any, status: int = 200) -> None:
        if not 200 <= status < 300:  # only a success is a "last good" answer: never replay a 404
            return
        self._entries[key] = {"body": body, "at": time.time() * 1000}
        self._entries.move_to_end(key)
        while len(self._entries) > self._max:
            self._entries.popitem(last=False)

    def fallback(self, key: str, target: str) -> Optional[JSONResponse]:
        hit = self._entries.get(key)
        if not ft_enabled() or hit is None:
            return None
        age = int(time.time() * 1000 - hit["at"])
        if age >= STALE_MAX_MS:
            del self._entries[key]  # too old to serve again: free it now
            return None
        log(kind="degraded", target=target, reason="stale_cache", ageMs=age)
        return JSONResponse(status_code=203, content={"degraded": True, "staleAgeMs": age, "data": hit["body"]})
