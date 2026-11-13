from __future__ import annotations

from typing import Callable, Dict, List

from ...core.eventlog import endterm_enabled, ft_enabled

_cursor: Dict[str, int] = {}


def _never(_instance: str) -> bool:
    return False


def ring(pool: str, instances: List[str], is_up: Callable[[str], bool],
         is_ejected: Callable[[str], bool] = _never) -> List[str]:
    candidates = [i for i in instances if is_up(i)] if ft_enabled() else instances  # H1 + S4; baseline is blind
    if endterm_enabled():  # outlier ejection; the detector caps how much of a pool it may eject
        candidates = [i for i in candidates if not is_ejected(i)]
    live = candidates or instances  # all down or ejected: try anyway
    n = _cursor.get(pool, 0) % len(live)
    _cursor[pool] = n + 1
    return live[n:] + live[:n]  # rotated: a retry hits the next replica
