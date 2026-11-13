"""Correlation IDs.

Every request carries one id from the client (or nginx) through the gateway, every
upstream attempt and every service, so one JSONL query reconstructs a request's path.
The id is client-controlled, so it is only trusted when it is short and plain: anything
else (newlines, 10 KB, non-ASCII) is replaced by a fresh UUID before it reaches a log.
"""
from __future__ import annotations

import re
import uuid
from contextvars import ContextVar
from typing import Optional

HEADER = "x-request-id"

REQUEST_ID: ContextVar[Optional[str]] = ContextVar("request_id", default=None)

_SAFE = re.compile(r"[A-Za-z0-9._-]{8,64}")


def new_request_id() -> str:
    return str(uuid.uuid4())


def accept_request_id(raw: Optional[str]) -> str:
    if raw is not None and _SAFE.fullmatch(raw):  # fullmatch: "$" would accept a trailing "\n"
        return raw
    return new_request_id()
