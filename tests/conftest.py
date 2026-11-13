"""Shared test setup.

The app modules read their environment at import time (the DB pool is built from
DATABASE_URL, the event log opens LOG_DIR/events.jsonl), so the variables are set
here, at conftest import, before any test module imports ``app.*``.
"""
from __future__ import annotations

import os
import tempfile

import pytest

os.environ["DATABASE_URL"] = "postgresql://x@localhost:1/x"  # never connected: pools open lazily
os.environ["LOG_DIR"] = tempfile.mkdtemp(prefix="ft-test-logs-")  # keep test events out of logs/
os.environ["SERVICE_NAME"] = "test"
os.environ.pop("DATABASE_REPLICA_URL", None)
os.environ.pop("FT_ENABLED", None)  # baseline unless a test asks for a mode
os.environ.pop("ENDTERM_ENABLED", None)


@pytest.fixture
def ft(monkeypatch: pytest.MonkeyPatch) -> None:
    """Midterm mode: the fault-tolerance mechanisms are on."""
    monkeypatch.setenv("FT_ENABLED", "1")
    monkeypatch.delenv("ENDTERM_ENABLED", raising=False)


@pytest.fixture
def endterm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Endterm mode: FT and the endterm behaviour are both on."""
    monkeypatch.setenv("FT_ENABLED", "1")
    monkeypatch.setenv("ENDTERM_ENABLED", "1")


@pytest.fixture(autouse=True)
def fresh_rate_limits():
    """Every test starts with empty rate-limit buckets (they are per-process state in the gateway)."""
    from app.security import rate_limit

    rate_limit.reset()
    yield
    rate_limit.reset()
