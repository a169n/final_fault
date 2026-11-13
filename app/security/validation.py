"""Strict input validation (services) and request limits (gateway). Endterm only.

Services: every POST body is checked against a closed model (``extra='forbid'``) before any
database work; a bad body is a 422 that names the offending fields but never echoes their values.

Gateway: cheap checks at the edge, before authentication and before any upstream call:
a body over ``MAX_BODY_BYTES`` is a 413 (enforced while streaming, so a missing or lying
Content-Length does not help), a POST whose body is not a JSON object is a 400, and a path segment
outside ``[A-Za-z0-9._-]{1,64}`` (or ``.``/``..``) is a 400.

Baseline and midterm do not call any of this: they keep the lenient midterm logic, so the three
modes can be compared (in midterm, ``amount: 1e9`` overflows NUMERIC(10,2) and returns a 5xx).
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from decimal import Decimal
from typing import Annotated, Optional, Type, TypeVar, Union

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..core.eventlog import log

STUDENT_ID = r"^s[0-9]{1,6}$"
TERM = r"^([0-9]{4}-(spring|summer|fall)|demo-[0-9]{1,20})$"  # demo-<epoch ms>, from experiments/demo.ts

MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", 16_384))
_SEGMENT = re.compile(r"[A-Za-z0-9._-]{1,64}")  # used with fullmatch: no trailing-newline loophole
_MAX_FIELDS = 20      # a 422 lists at most this many fields
_MAX_FIELD_NAME = 64  # an extra field's name is client-controlled: bound what we echo and log

# Bidirectional overrides and isolates (Trojan Source); not category Cc, but they rewrite how a name displays.
_BIDI = frozenset(range(0x202A, 0x202F)) | frozenset(range(0x2066, 0x206A))
_CONTROL_CATEGORIES = frozenset({"Cc", "Cs", "Zl", "Zp"})  # control, lone surrogate, line/paragraph separator


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PaymentIn(_Closed):
    studentId: Annotated[str, Field(pattern=STUDENT_ID)]
    amount: Annotated[Decimal, Field(gt=0, le=10_000, decimal_places=2)]  # NaN and ±inf are rejected too


class StudentIn(_Closed):
    id: Annotated[str, Field(pattern=STUDENT_ID)]
    name: Annotated[str, Field(min_length=1, max_length=100)]
    credits: Annotated[int, Field(strict=True, ge=0, le=300)] = 0  # strict: no "30" or true

    @field_validator("name")
    @classmethod
    def _printable(cls, value: str) -> str:
        if any(unicodedata.category(c) in _CONTROL_CATEGORIES or ord(c) in _BIDI for c in value):
            raise ValueError("name must not contain control characters")
        if not value.strip():
            raise ValueError("name must not be blank")
        return value


class TimetableJobIn(_Closed):
    term: Annotated[str, Field(max_length=32, pattern=TERM)]


M = TypeVar("M", bound=BaseModel)


def _field(loc: tuple) -> str:
    name = ".".join(str(part)[:_MAX_FIELD_NAME] for part in loc)
    return name[:_MAX_FIELD_NAME] or "body"


def parse(model: Type[M], body: object) -> Union[M, JSONResponse]:
    """The validated model, or a 422 naming the bad fields (without their values)."""
    try:
        return model.model_validate(body)
    except ValidationError as exc:
        errors = exc.errors(include_url=False, include_context=False, include_input=False)[:_MAX_FIELDS]
        fields = [{"field": _field(e["loc"]), "message": e["msg"]} for e in errors]
        log(kind="rejected", target=model.__name__, reason="invalid_input", fields=[f["field"] for f in fields])
        return JSONResponse(status_code=422, content={"error": "invalid input", "fields": fields})


# --- gateway limits ----------------------------------------------------------------------------

def path_ok(path: str) -> bool:
    """True for "" (a collection) or segments that each match [A-Za-z0-9._-]{1,64} and are not . or .."""
    if path == "":
        return True
    return all(_SEGMENT.fullmatch(s) is not None and s not in (".", "..") for s in path.split("/"))


class BodyTooLarge(Exception):
    pass


async def read_bounded(request: Request, limit: int = MAX_BODY_BYTES) -> bytes:
    """Read the body, giving up as soon as it exceeds ``limit``; caches it for ``request.body()``."""
    declared = request.headers.get("content-length")
    if declared is not None and declared.strip().isdigit() and int(declared) > limit:
        raise BodyTooLarge()  # refused without reading a byte
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise BodyTooLarge()
        chunks.append(chunk)
    body = b"".join(chunks)
    request._body = body  # Starlette's cache: FastAPI's body parsing and the proxy reuse it
    return body


def _reject_constant(name: str) -> None:
    raise ValueError(f"not JSON: {name}")  # NaN, Infinity: accepted by Python, not by RFC 8259


def json_object(raw: bytes) -> Optional[dict]:
    try:
        value = json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, RecursionError):  # JSONDecodeError and UnicodeDecodeError are ValueErrors
        return None
    return value if isinstance(value, dict) else None


def _is_json_type(content_type: Optional[str]) -> bool:
    media = (content_type or "").split(";", 1)[0].strip().lower()
    return media in ("", "application/json") or (media.startswith("application/") and media.endswith("+json"))


def _reject(status: int, error: str, reason: str, target: str) -> JSONResponse:
    log(kind="rejected", target=target, reason=reason, status=status)
    return JSONResponse(status_code=status, content={"error": error})


async def gateway_limits(request: Request, path: str, target: str,
                         check_content_type: bool = True) -> Optional[JSONResponse]:
    """None to proceed, or the 400/413 to return. Runs before authentication and before the
    route's own body parsing, so nothing downstream reads more than ``MAX_BODY_BYTES``.

    ``check_content_type=False`` for the login route, which relays ``curl -d`` bodies (a form
    content type) whose content is JSON.
    """
    if not path_ok(path):
        return _reject(400, "invalid path", "bad_path", target)
    try:
        raw = await read_bounded(request)
    except BodyTooLarge:
        return _reject(413, "request body too large", "body_too_large", target)
    if request.method == "POST":
        if (check_content_type and not _is_json_type(request.headers.get("content-type"))) \
                or json_object(raw) is None:
            return _reject(400, "body must be a JSON object", "not_json", target)
    return None
