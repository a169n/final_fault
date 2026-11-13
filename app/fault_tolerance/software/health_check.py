from __future__ import annotations

import asyncio
import os
from typing import Dict, List

import httpx

from ...core import metrics
from ...core.context import HEADER as REQUEST_ID_HEADER
from ...core.context import new_request_id
from ...core.eventlog import log
from . import timeouts

INTERVAL_MS = int(os.environ.get("HEALTH_INTERVAL_MS", 1000))  # S4

_status: Dict[str, bool] = {}


def is_up(instance: str) -> bool:
    return _status.get(instance) is not False  # unprobed = up


def snapshot() -> Dict[str, bool]:
    return dict(_status)


async def _probe(client: httpx.AsyncClient, instance: str) -> None:
    rid = f"health-{new_request_id()}"  # probe traffic is tellable apart from user requests in the logs
    try:
        response = await client.get(f"{instance}/health/ready", timeout=timeouts.HEALTH_PROBE_S,
                                    headers={REQUEST_ID_HEADER: rid})
        up = response.status_code < 400
    except Exception:
        up = False
    was = _status.get(instance)
    if was != up:
        log(kind="health", target=instance, ok=up, transition=f"{was}->{up}", rid=rid)  # detection time
    _status[instance] = up
    metrics.INSTANCE_UP.labels(target=instance).set(1 if up else 0)  # every probe, not only transitions


async def loop(client: httpx.AsyncClient, instances: List[str]) -> None:
    while True:
        await asyncio.gather(*(_probe(client, i) for i in instances))
        await asyncio.sleep(INTERVAL_MS / 1000)
