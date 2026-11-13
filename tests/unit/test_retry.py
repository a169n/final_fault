"""S1/S2 retry with timeout, as wrapped around every gateway -> service call."""
from __future__ import annotations

import pytest

from app.core.errors import UpstreamError
from app.fault_tolerance.software import retry, timeouts


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(retry, "backoff_s", lambda attempt: 0)


class Flaky:
    """Fails with the given errors in order, then returns ``value``."""

    def __init__(self, errors: list[BaseException], value: int = 7) -> None:
        self.errors = list(errors)
        self.value = value
        self.timeouts: list[float | None] = []

    async def __call__(self, timeout: float | None) -> int:
        self.timeouts.append(timeout)
        if self.errors:
            raise self.errors.pop(0)
        return self.value


async def test_retry_succeeds_on_second_attempt(ft: None) -> None:
    fn = Flaky([UpstreamError("x", 503)])
    assert await retry.call("svc", fn) == (7, 2)
    assert fn.timeouts == [timeouts.PER_ATTEMPT_S] * 2


async def test_retry_never_retries_4xx(ft: None) -> None:
    fn = Flaky([UpstreamError("x", 404)])
    with pytest.raises(UpstreamError) as info:
        await retry.call("svc", fn)
    assert info.value.status == 404
    assert len(fn.timeouts) == 1


async def test_retry_gives_up_after_budget(ft: None) -> None:
    fn = Flaky([UpstreamError("x", 503)] * 10)
    with pytest.raises(UpstreamError):
        await retry.call("svc", fn)
    assert len(fn.timeouts) == retry.RETRIES


async def test_baseline_single_attempt_no_timeout() -> None:
    fn = Flaky([UpstreamError("x", 503)])
    with pytest.raises(UpstreamError):
        await retry.call("svc", fn)
    assert fn.timeouts == [None]
