"""Audit events (Task 9; THREAT-MODEL.md B1.R1, B1.I3).

``record`` writes one ``kind="audit"`` line to the shared JSONL event log. The line carries the
request's ``rid`` (added by ``eventlog.log``), the principal (``sub``, ``role``, ``student_id``),
the action (a route template, never a raw path), the outcome and the reason. It is called for
every deny, every payment allow and every admin action at the gateway, and for every login,
success or failure, at the auth service.

Every deny also increments ``auth_denied_total{reason}`` (AuthFailureSpike), including the
gateway's rate-limit refusals (``reason="rate_limited"``): a flood of 429s is abuse the alert must
see (E10). The label is the reason only when it is one of the fixed reasons below; anything else
is counted as ``other``, so a caller can never create new series.

Secrets never reach the line, whatever the caller passes:
  - a field whose name looks like a credential (password, token, secret, authorization, cookie,
    api key) is dropped, at any depth;
  - a string value that contains a bearer credential or a JWT is replaced by ``[redacted]``.
"""
from __future__ import annotations

import re
from typing import Any, Literal, Optional

from ..core import metrics
from ..core.eventlog import log
from . import policy, rate_limit, tokens
from .tokens import Principal

Outcome = Literal["allow", "deny"]

LOGIN_REASONS = ("invalid_credentials",)  # counted by the auth service
THROTTLE_REASONS = (rate_limit.REASON,)  # a 429 from the gateway's rate limiter (Task 11)
CHAOS_REASON = "bad_chaos_token"  # /chaos* without the right x-chaos-token, counted by each service (Task 12)
REASONS = tuple(dict.fromkeys(policy.REASONS + tokens.REASONS + THROTTLE_REASONS + LOGIN_REASONS
                              + (CHAOS_REASON, "other")))
GATEWAY_REASONS = tuple(dict.fromkeys(policy.REASONS + tokens.REASONS + THROTTLE_REASONS))  # 0 from start-up

REDACTED = "[redacted]"
_SECRET_KEY = re.compile(r"pass(word|wd)?|pwd|token|secret|authori[sz]ation|cookie|api[-_]?key|credential",
                         re.IGNORECASE)
_SECRET_VALUE = re.compile(r"bearer\s|basic\s|eyJ[A-Za-z0-9_-]{4,}\.", re.IGNORECASE)
_MAX_STR = 256
_MAX_DEPTH = 4


def _scrub(value: Any, depth: int = 0) -> Any:
    if isinstance(value, str):
        if _SECRET_VALUE.search(value):
            return REDACTED
        return value if len(value) <= _MAX_STR else value[:_MAX_STR] + "..."
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth >= _MAX_DEPTH:
        return REDACTED
    if isinstance(value, dict):
        return {str(k): _scrub(v, depth + 1) for k, v in value.items()
                if not _SECRET_KEY.search(str(k))}
    if isinstance(value, (list, tuple)):
        return [_scrub(v, depth + 1) for v in list(value)[:20]]
    return _scrub(str(value), depth)


def _metric_reason(reason: str) -> str:
    return reason if reason in REASONS else "other"


def precreate(reasons=GATEWAY_REASONS) -> None:
    """Export ``auth_denied_total{reason}`` as 0 before the first deny (rate() misses a first scrape)."""
    for reason in reasons:
        metrics.AUTH_DENIED.labels(reason=_metric_reason(reason))


def record(action: str, outcome: Outcome, p: Optional[Principal], reason: str, **fields: Any) -> None:
    if outcome not in ("allow", "deny"):
        raise ValueError(f"outcome must be allow or deny, not {outcome!r}")
    extra = _scrub(fields)
    for key in ("kind", "action", "outcome", "reason", "sub", "role", "student_id", "rid", "ts", "svc"):
        extra.pop(key, None)  # the fixed fields below cannot be overwritten by a caller
    if outcome == "deny":
        metrics.AUTH_DENIED.labels(reason=_metric_reason(reason)).inc()
    log(kind="audit", level="warning" if outcome == "deny" else "info",
        action=_scrub(action), outcome=outcome, reason=_scrub(reason),
        sub=_scrub(getattr(p, "sub", None)), role=_scrub(getattr(p, "role", None)),
        student_id=_scrub(getattr(p, "student_id", None)), **extra)
