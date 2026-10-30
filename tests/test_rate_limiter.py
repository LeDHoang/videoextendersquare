import pytest
from fastapi import HTTPException

from server.social import auth


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(auth.time, "monotonic", lambda: now[0])
    return now


def test_limit_holds_within_the_window_and_frees_as_it_slides(clock):
    limiter = auth.RateLimiter()
    for _ in range(3):
        limiter.check(None, "ip:a", 3, 60)
    with pytest.raises(HTTPException) as refused:
        limiter.check(None, "ip:a", 3, 60)
    assert refused.value.status_code == 429
    # A refused request is not counted, and other keys are unaffected.
    limiter.check(None, "ip:b", 3, 60)
    clock[0] += 60
    limiter.check(None, "ip:a", 3, 60)


def test_idle_keys_are_swept(clock):
    limiter = auth.RateLimiter()
    limiter.check(None, "ip:a", 3, 10)
    limiter.check(None, "ip:b", 3, 600)
    clock[0] += auth.RateLimiter._SWEEP_SECONDS
    limiter.check(None, "ip:c", 3, 10)
    assert set(limiter._hits) == {"ip:b", "ip:c"}
