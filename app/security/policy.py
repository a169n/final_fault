"""Authorization matrix for the gateway, the policy enforcement point (Task 9).

| Route                      | anonymous | student                               | staff | admin |
|----------------------------|-----------|---------------------------------------|-------|-------|
| GET  /api/students         | 401       | 403                                   | yes   | yes   |
| GET  /api/students/{id}    | 401       | only if id == student_id              | yes   | yes   |
| POST /api/students         | 401       | 403                                   | 403   | yes   |
| POST /api/payments         | 401       | only if body.studentId == student_id  | yes   | yes   |
| GET  /api/payments/{key}   | 401       | 403                                   | yes   | yes   |
| GET  /api/transcripts/{id} | 401       | own only                              | yes   | yes   |
| POST /api/timetables       | 401       | 403                                   | 403   | yes   |
| GET  /api/timetables/{term}| 401       | yes                                   | yes   | yes   |

It fails closed:
  - no principal → 401 on every route, listed or not (authentication comes first);
  - a route the matrix does not list (another method, a list route not above, a sub-path with
    more than one segment, a ``.``/``..`` segment that the upstream URL would normalise away, or a
    segment that names one of the upstream's own endpoints, e.g. ``/api/timetables/openapi.json``,
    which the gateway would forward to ``/openapi.json`` on the service) → 403;
  - a principal that is not a well-formed ``Principal`` (unknown role, student without an id) → 403;
  - any exception while deciding → 403 (401 without a principal), reason ``policy_error``.

``pool`` is the first path segment after ``/api`` and ``path`` the rest, as the gateway routes them.
Every ``Decision.reason`` comes from a fixed set, because it labels ``auth_denied_total``.
"""
from __future__ import annotations

from typing import Callable, Dict, NamedTuple, Optional, Tuple

from .tokens import ROLES, Principal

ALLOWED = "ok"
REASONS = ("missing_token", "forbidden", "not_owner", "no_rule", "policy_error")  # deny reasons


class Decision(NamedTuple):
    allowed: bool
    status: int   # 200 allowed, 401 not authenticated, 403 not authorized
    reason: str   # ALLOWED or one of REASONS


ALLOW = Decision(True, 200, ALLOWED)

# A rule decides for an authenticated, well-formed principal: (principal, param, body) -> Decision.
Rule = Callable[[Principal, Optional[str], Optional[dict]], Decision]


def _roles(*roles: str) -> Rule:
    def rule(p: Principal, _param: Optional[str], _body: Optional[dict]) -> Decision:
        return ALLOW if p.role in roles else Decision(False, 403, "forbidden")
    return rule


def _staff_or_own_param(p: Principal, param: Optional[str], _body: Optional[dict]) -> Decision:
    if p.role in ("staff", "admin"):
        return ALLOW
    return ALLOW if p.role == "student" and param == p.student_id else Decision(False, 403, "not_owner")


def _staff_or_own_payment(p: Principal, _param: Optional[str], body: Optional[dict]) -> Decision:
    if p.role in ("staff", "admin"):
        return ALLOW
    student_id = body.get("studentId") if isinstance(body, dict) else None
    ok = p.role == "student" and isinstance(student_id, str) and student_id == p.student_id
    return ALLOW if ok else Decision(False, 403, "not_owner")


# (method, pool, has a {param} segment) -> (route template, rule)
RULES: Dict[Tuple[str, str, bool], Tuple[str, Rule]] = {
    ("GET", "students", False): ("/api/students", _roles("staff", "admin")),
    ("GET", "students", True): ("/api/students/{id}", _staff_or_own_param),
    ("POST", "students", False): ("/api/students", _roles("admin")),
    ("POST", "payments", False): ("/api/payments", _staff_or_own_payment),
    ("GET", "payments", True): ("/api/payments/{key}", _roles("staff", "admin")),
    ("GET", "transcripts", True): ("/api/transcripts/{id}", _staff_or_own_param),
    ("POST", "timetables", False): ("/api/timetables", _roles("admin")),
    ("GET", "timetables", True): ("/api/timetables/{term}", _roles("student", "staff", "admin")),
}


# Single segments that are endpoints of every upstream service (app/core/service.py, FastAPI's docs,
# app/fault_injection.py), not a {param}: the gateway forwards /api/<pool>/<seg> to /<seg> upstream.
RESERVED_SEGMENTS = frozenset({"health", "metrics", "chaos", "docs", "redoc", "openapi.json"})


def _param(path: str) -> Tuple[bool, Optional[str]]:
    """(is a single plain segment or empty, the segment or None). ``s7/x``, ``.``, ``..`` and a
    reserved upstream endpoint name are not."""
    if path == "":
        return True, None
    if "/" in path or path in (".", "..") or path in RESERVED_SEGMENTS:
        return False, None
    return True, path


def route_template(method: str, pool: str, path: str) -> str:
    """A bounded name for the route (audit ``action``): the template, never the raw path."""
    plain, param = _param(path)
    entry = RULES.get((method, pool, param is not None)) if plain else None
    if entry:
        return f"{method} {entry[0]}"
    return f"{method} /api/{pool}" + ("/*" if path else "")


def _well_formed(p: object) -> bool:
    if not isinstance(p, Principal) or not isinstance(p.sub, str) or not p.sub or p.role not in ROLES:
        return False
    if p.role == "student":
        return isinstance(p.student_id, str) and bool(p.student_id)
    return p.student_id is None


def _evaluate(p: Optional[Principal], method: str, pool: str, path: str, body: Optional[dict]) -> Decision:
    if p is None:
        return Decision(False, 401, "missing_token")
    if not _well_formed(p):
        return Decision(False, 403, "forbidden")
    plain, param = _param(path)
    entry = RULES.get((method, pool, param is not None)) if plain else None
    if entry is None:
        return Decision(False, 403, "no_rule")
    decision = entry[1](p, param, body)
    if not isinstance(decision, Decision):  # a rule must decide explicitly
        return Decision(False, 403, "policy_error")
    return decision


def authorize(p: Optional[Principal], method: str, pool: str, path: str, body: Optional[dict]) -> Decision:
    try:
        return _evaluate(p, method, pool, path, body)
    except Exception:  # fail closed: a bug in a rule never lets a request through
        return Decision(False, 401 if p is None else 403, "policy_error")
