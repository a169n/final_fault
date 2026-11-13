"""Password hashing with scrypt (stdlib ``hashlib.scrypt``, no extra dependency).

Stored form: ``scrypt$<salt_b64>$<hash_b64>``. Cost n=2**14, r=8, p=1 (about 16 MiB and tens
of milliseconds per check), a fresh 16-byte salt per hash, comparison with ``hmac.compare_digest``.
The plaintext is never stored or logged.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets

SCHEME = "scrypt"
N, R, P = 2 ** 14, 8, 1
SALT_BYTES = 16
KEY_BYTES = 32


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _derive(password: str, salt: bytes) -> bytes:
    # "surrogatepass": JSON can carry a lone surrogate ("\\ud800") that strict UTF-8 cannot encode.
    # A client-controlled password must never raise (a 5xx would count against the gateway's auth
    # breaker); every valid str encodes exactly as with strict UTF-8, so stored hashes are unchanged,
    # and the bytes of a lone surrogate are invalid UTF-8, so they match no real password.
    raw = password.encode("utf-8", "surrogatepass")
    return hashlib.scrypt(raw, salt=salt, n=N, r=R, p=P, dklen=KEY_BYTES)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    return f"{SCHEME}${_b64(salt)}${_b64(_derive(password, salt))}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_b64, hash_b64 = stored.split("$")
        if scheme != SCHEME or not salt_b64 or not hash_b64:
            return False
        salt = base64.b64decode(salt_b64, validate=True)
        expected = base64.b64decode(hash_b64, validate=True)
        derived = _derive(password, salt)
    except (ValueError, binascii.Error):  # UnicodeError is a ValueError: fail closed, never raise
        return False
    return hmac.compare_digest(derived, expected)
