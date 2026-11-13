"""scrypt password hashing: salted, constant-time comparison, never the plaintext."""
from __future__ import annotations

import hmac

import pytest

from app.security import passwords


def test_password_roundtrip_and_wrong_password() -> None:
    stored = passwords.hash_password("correct horse battery staple")
    assert passwords.verify_password("correct horse battery staple", stored)
    assert not passwords.verify_password("correct horse battery stapl", stored)
    assert not passwords.verify_password("", stored)


def test_hash_is_salted() -> None:
    a = passwords.hash_password("hunter2")
    b = passwords.hash_password("hunter2")
    assert a != b
    assert passwords.verify_password("hunter2", a) and passwords.verify_password("hunter2", b)


def test_hash_format_has_no_plaintext() -> None:
    stored = passwords.hash_password("hunter2")
    scheme, salt, digest = stored.split("$")
    assert scheme == "scrypt" and salt and digest
    assert "hunter2" not in stored


@pytest.mark.parametrize("stored", ["", "plain", "scrypt$$", "md5$abc$def", "scrypt$!!!$???", "scrypt$a$b$c"])
def test_verify_rejects_malformed_hash(stored: str) -> None:
    assert passwords.verify_password("hunter2", stored) is False


def test_verify_uses_constant_time_compare(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    real = hmac.compare_digest

    def spy(a, b):
        calls.append(1)
        return real(a, b)

    monkeypatch.setattr(passwords.hmac, "compare_digest", spy)
    stored = passwords.hash_password("hunter2")
    assert passwords.verify_password("hunter2", stored)
    assert calls == [1]


@pytest.mark.parametrize("password", ["\ud800", "abc\udfffdef", "\udc80" * 3])
def test_lone_surrogate_password_is_a_wrong_password_not_an_exception(password: str) -> None:
    # JSON can carry "\ud800", which strict UTF-8 cannot encode: a client-controlled input must
    # fail closed (False), never raise and turn a failed login into a 5xx
    stored = passwords.hash_password("hunter2")
    assert passwords.verify_password(password, stored) is False


def test_surrogate_encoding_leaves_ordinary_passwords_unchanged() -> None:
    # surrogatepass encodes every valid str exactly like strict UTF-8, so stored hashes stay valid
    for password in ("hunter2", "pässwörd", "密码", "emoji-\U0001F600"):
        assert password.encode("utf-8", "surrogatepass") == password.encode("utf-8")
