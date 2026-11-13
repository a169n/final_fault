from __future__ import annotations

import os

from ...core.eventlog import final_enabled, ft_enabled

PER_ATTEMPT_S = int(os.environ.get("FT_TIMEOUT_MS", 800)) / 1000  # S2: one service call

# S8 fail-fast; baseline waits. Final nests the timeouts: the DB wait (0.5 s) is shorter than one
# gateway attempt (PER_ATTEMPT_S, 0.8 s), so a service answers 503 itself before the gateway gives
# up on it. In midterm/endterm the DB wait (1.0 s) outlived the attempt and every DB failure looked
# like a timeout to the gateway (endterm report §9.4, first follow-up).
DB_ACQUIRE_S = 0.5 if final_enabled() else 1.0 if ft_enabled() else 60.0

HEALTH_PROBE_S = 0.5  # gateway -> /health/ready

HEALTH_DB_CHECK_S = 0.3  # must stay < HEALTH_PROBE_S
