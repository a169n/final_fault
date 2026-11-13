"""Short-lived JWTs (HS256), issued by the auth service and verified locally by the gateway.

Because verification needs only ``JWT_SECRET``, an outage of the auth service blocks new logins
but not requests that already carry a token (graceful degradation; THREAT-MODEL.md B3.D1).

Verification is strict and fails closed:
  - only HS256 is accepted (``alg=none`` and every other algorithm are refused),
  - the signature, ``iss`` (ftu-auth), ``aud`` (ftu-api) and ``exp`` are required and checked,
  - the claims must describe a known role, and a student token must name its student.
Every refusal raises ``TokenError(reason)`` with reason in expired|bad_signature|bad_audience|malformed;
the reason labels ``auth_denied_total`` at the gateway (Task 9).
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Optional

import jwt

ISSUER = "ftu-auth"
AUDIENCE = "ftu-api"
ALGORITHM = "HS256"
TTL_S = 900  # 15 minutes: there is no revocation list, so a stolen token is short-lived (R3)
ROLES = ("student", "staff", "admin")
REASONS = ("expired", "bad_signature", "bad_audience", "malformed")
MAX_TOKEN_LEN = 4096  # ours are ~250 bytes; anything far larger is not worth parsing


@dataclass(frozen=True)
class Principal:
    sub: str
    role: str
    student_id: Optional[str]


class TokenError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _secret() -> str:
    secret = os.environ.get("JWT_SECRET", "")
    if not secret:
        raise RuntimeError("JWT_SECRET is not set; run npm run up:<mode> to generate .env")
    return secret


def issue(sub: str, role: str, student_id: Optional[str], now: Optional[int] = None) -> str:
    if role not in ROLES:
        raise ValueError(f"unknown role {role!r}")
    iat = int(time.time() if now is None else now)
    claims = {"sub": sub, "role": role, "student_id": student_id,
              "iss": ISSUER, "aud": AUDIENCE, "iat": iat, "exp": iat + TTL_S}
    return jwt.encode(claims, _secret(), algorithm=ALGORITHM)


def verify(token: str, now: Optional[int] = None) -> Principal:
    if not isinstance(token, str) or not token or len(token) > MAX_TOKEN_LEN:
        raise TokenError("malformed")
    try:
        secret = _secret()
    except RuntimeError:
        raise TokenError("malformed") from None  # no secret: nothing verifies
    try:
        claims = jwt.decode(
            token, secret,
            algorithms=[ALGORITHM],      # pinned: rejects alg=none, HS512, RS256/HS256 confusion
            audience=AUDIENCE, issuer=ISSUER,
            # exp is checked below against `now` (testable clock); PyJWT still requires the claim
            options={"require": ["exp", "iat", "iss", "aud", "sub"], "verify_exp": False,
                     "verify_iat": False, "verify_nbf": False},
        )
    except jwt.InvalidSignatureError:
        raise TokenError("bad_signature") from None
    except jwt.InvalidAudienceError:
        raise TokenError("bad_audience") from None
    except jwt.PyJWTError:               # DecodeError, InvalidAlgorithmError, InvalidIssuerError, missing claim
        raise TokenError("malformed") from None
    except Exception:                    # anything unexpected: fail closed
        raise TokenError("malformed") from None

    exp = claims.get("exp")
    if not isinstance(exp, int) or isinstance(exp, bool):
        raise TokenError("malformed")
    if int(time.time() if now is None else now) >= exp:
        raise TokenError("expired")

    sub, role, student_id = claims.get("sub"), claims.get("role"), claims.get("student_id")
    if not isinstance(sub, str) or not sub or role not in ROLES:
        raise TokenError("malformed")
    if role == "student":
        if not isinstance(student_id, str) or not student_id:
            raise TokenError("malformed")
    elif student_id is not None:
        raise TokenError("malformed")
    return Principal(sub=sub, role=role, student_id=student_id)
