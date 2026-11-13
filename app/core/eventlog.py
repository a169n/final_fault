from __future__ import annotations

import json
import os
import pathlib
import time
from collections import Counter
from typing import Dict, Literal

from . import metrics
from .context import REQUEST_ID

LOG_DIR = os.environ.get("LOG_DIR", "/logs")
SERVICE = os.environ.get("SERVICE_NAME", "unknown")

pathlib.Path(LOG_DIR).mkdir(parents=True, exist_ok=True)
_stream = open(pathlib.Path(LOG_DIR) / "events.jsonl", "a", buffering=1)  # source of every metric

_counts: Counter = Counter()  # live view for Prometheus (H5)
_instance_up: Dict[str, int] = {}


def ft_enabled() -> bool:
    return os.environ.get("FT_ENABLED") == "1"  # baseline vs FT switch


def endterm_enabled() -> bool:
    # endterm builds on the midterm FT mechanisms, so it is only on when FT is on too
    return ft_enabled() and os.environ.get("ENDTERM_ENABLED") == "1"


def final_enabled() -> bool:
    # final builds on endterm: automatic DB failover (H6), backups (H7), nested timeouts
    return endterm_enabled() and os.environ.get("FINAL_ENABLED") == "1"


def mode() -> Literal["baseline", "midterm", "endterm", "final"]:
    if final_enabled():
        return "final"
    if endterm_enabled():
        return "endterm"
    return "midterm" if ft_enabled() else "baseline"


def now_ms() -> int:
    return int(time.time() * 1000)


def log(**event) -> None:
    # rid ties the line to its request; level lets an operator filter failures. Explicit values win.
    line = {"ts": now_ms(), "svc": SERVICE, "ft": 1 if ft_enabled() else 0, "mode": mode(),
            "rid": REQUEST_ID.get(), "level": "error" if event.get("ok") is False else "info", **event}
    _stream.write(json.dumps(line) + "\n")
    _counts[(event["kind"], _outcome(event))] += 1
    if event["kind"] == "health":
        _instance_up[event["target"]] = 1 if event["ok"] else 0


def _outcome(event: dict) -> str:
    for key in ("action", "reason", "state", "status"):
        if event.get(key) is not None:
            return str(event[key])
    if "ok" in event:
        return "ok" if event["ok"] else "fail"
    return ""


def metrics_text() -> str:
    # prometheus_client series (requests, latency, upstream, health, breaker, integrity) + event counters
    lines = [metrics.render().rstrip("\n"),
             "# HELP ft_events_total Events logged, by kind and outcome.", "# TYPE ft_events_total counter"]
    lines += [f'ft_events_total{{svc="{SERVICE}",kind="{kind}",outcome="{outcome}"}} {n}'
              for (kind, outcome), n in sorted(_counts.items())]
    if _instance_up:
        lines += ["# HELP ft_instance_up Gateway health-check verdict per instance.", "# TYPE ft_instance_up gauge"]
        lines += [f'ft_instance_up{{target="{t}"}} {v}' for t, v in sorted(_instance_up.items())]
    return "\n".join(lines) + "\n"
