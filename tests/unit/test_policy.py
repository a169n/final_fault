"""The gateway's authorization matrix (Task 9; THREAT-MODEL.md B1.S1, B1.I1, B1.E1).

One parametrised case per cell of the plan's matrix (8 routes x 4 principals = 32). A cell that
reads "own only" is checked both ways: the student's own id is allowed, another id is 403.
Anything the matrix does not list is denied (fail closed).
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import pytest

from app.security import policy
from app.security.policy import Decision
from app.security.tokens import Principal

ANON = None
STUDENT = Principal(sub="s7", role="student", student_id="s7")
STAFF = Principal(sub="bursar", role="staff", student_id=None)
ADMIN = Principal(sub="admin", role="admin", student_id=None)
WHO = {"anonymous": ANON, "student": STUDENT, "staff": STAFF, "admin": ADMIN}

# probe = (path, body, expected status). 200 means allowed.
Probe = Tuple[str, Optional[dict], int]
OWN_PAY = {"studentId": "s7", "amount": 100}
OTHER_PAY = {"studentId": "s8", "amount": 100}

# (method, pool, {principal: [probes]}): the matrix in the plan, cell by cell.
MATRIX: List[Tuple[str, str, dict]] = [
    ("GET", "students", {
        "anonymous": [("", None, 401)], "student": [("", None, 403)],
        "staff": [("", None, 200)], "admin": [("", None, 200)]}),
    ("GET", "students/{id}", {
        "anonymous": [("s7", None, 401)], "student": [("s7", None, 200), ("s8", None, 403)],
        "staff": [("s8", None, 200)], "admin": [("s8", None, 200)]}),
    ("POST", "students", {
        "anonymous": [("", {"id": "evil-1"}, 401)], "student": [("", {"id": "evil-1"}, 403)],
        "staff": [("", {"id": "evil-1"}, 403)], "admin": [("", {"id": "s9"}, 200)]}),
    ("POST", "payments", {
        "anonymous": [("", OWN_PAY, 401)], "student": [("", OWN_PAY, 200), ("", OTHER_PAY, 403)],
        "staff": [("", OTHER_PAY, 200)], "admin": [("", OTHER_PAY, 200)]}),
    ("GET", "payments/{key}", {
        "anonymous": [("pay-1", None, 401)], "student": [("pay-1", None, 403)],
        "staff": [("pay-1", None, 200)], "admin": [("pay-1", None, 200)]}),
    ("GET", "transcripts/{id}", {
        "anonymous": [("s7", None, 401)], "student": [("s7", None, 200), ("s8", None, 403)],
        "staff": [("s8", None, 200)], "admin": [("s8", None, 200)]}),
    ("POST", "timetables", {
        "anonymous": [("", {"term": "t"}, 401)], "student": [("", {"term": "t"}, 403)],
        "staff": [("", {"term": "t"}, 403)], "admin": [("", {"term": "t"}, 200)]}),
    ("GET", "timetables/{term}", {
        "anonymous": [("2026-fall", None, 401)], "student": [("2026-fall", None, 200)],
        "staff": [("2026-fall", None, 200)], "admin": [("2026-fall", None, 200)]}),
]

CELLS = [pytest.param(method, route, who, probes, id=f"{method} /api/{route} as {who}")
         for method, route, cells in MATRIX for who, probes in cells.items()]


def test_matrix_has_32_cells() -> None:
    assert len(CELLS) == 32


@pytest.mark.parametrize("method,route,who,probes", CELLS)
def test_policy_matrix(method: str, route: str, who: str, probes: List[Probe]) -> None:
    pool = route.split("/")[0]
    for path, body, expected in probes:
        decision = policy.authorize(WHO[who], method, pool, path, body)
        assert isinstance(decision, Decision)
        assert decision.status == expected, (method, pool, path, body, decision)
        assert decision.allowed is (expected == 200)
        assert decision.reason  # every decision says why: it labels auth_denied_total and the audit line


def test_deny_reasons_are_bounded() -> None:
    reasons = {policy.authorize(WHO[who], m, r.split("/")[0], path, body).reason
               for m, r, cells in MATRIX for who, probes in cells.items() for path, body, _ in probes}
    assert reasons <= set(policy.REASONS) | {policy.ALLOWED}


@pytest.mark.parametrize("who", ["student", "staff", "admin"])
@pytest.mark.parametrize("method,pool,path", [
    ("GET", "payments", ""),              # listing payments is not in the matrix
    ("GET", "transcripts", ""),           # nor listing transcripts
    ("GET", "timetables", ""),
    ("POST", "payments", "s7"),           # POST to a sub-path
    ("POST", "students", "s7"),
    ("GET", "students", "s7/extra"),      # more than one segment
    ("GET", "students", ".."),            # a dot segment would be normalised to the list route upstream
    ("GET", "transcripts", "."),
    ("DELETE", "students", "s7"),         # an unknown method
    ("GET", "timetables", "openapi.json"),  # upstream endpoints in the {param} position
    ("GET", "timetables", "health"),
    ("GET", "timetables", "metrics"),
    ("GET", "timetables", "docs"),
    ("GET", "students", "health"),
    ("GET", "payments", "metrics"),
    ("GET", "transcripts", "chaos"),
])
def test_routes_outside_the_matrix_are_denied(who: str, method: str, pool: str, path: str) -> None:
    decision = policy.authorize(WHO[who], method, pool, path, None)
    assert (decision.allowed, decision.status, decision.reason) == (False, 403, "no_rule")


def test_routes_outside_the_matrix_need_a_token_first() -> None:
    assert policy.authorize(None, "GET", "payments", "", None) == Decision(False, 401, "missing_token")


@pytest.mark.parametrize("body", [None, [], "s7", {"studentId": ["s7"]}, {"amount": 100}, {"studentId": None}])
def test_student_payment_without_own_student_id_is_denied(body) -> None:
    assert policy.authorize(STUDENT, "POST", "payments", "", body).status == 403


def test_student_id_comparison_is_exact() -> None:
    for other in ("S7", "s7 ", "s70", ""):
        assert policy.authorize(STUDENT, "GET", "students", other, None).status == 403
        assert policy.authorize(STUDENT, "POST", "payments", "", {"studentId": other}).status == 403


def test_policy_fails_closed_on_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args, **_kwargs):
        raise RuntimeError("bug in a rule")

    monkeypatch.setattr(policy, "_evaluate", boom)
    assert policy.authorize(ADMIN, "GET", "students", "", None) == Decision(False, 403, "policy_error")
    assert policy.authorize(None, "GET", "students", "", None) == Decision(False, 401, "policy_error")


@pytest.mark.parametrize("principal", [
    object(),                                                    # not a Principal at all
    Principal(sub="x", role="root", student_id=None),            # an unknown role
    Principal(sub="x", role="student", student_id=None),         # a student without a student id
])
def test_malformed_principal_is_denied(principal) -> None:
    for method, pool, path, body in [("GET", "students", "", None), ("GET", "timetables", "t", None),
                                     ("GET", "students", "s7", None), ("POST", "payments", "", None)]:
        decision = policy.authorize(principal, method, pool, path, body)
        assert not decision.allowed and decision.status == 403, (principal, method, pool, path, decision)
