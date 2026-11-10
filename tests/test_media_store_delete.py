"""media_store.delete: best effort by default, strict for staff takedowns."""
from __future__ import annotations

import pytest

from server import media_store


class FakeBucket:
    def __init__(self, errors=(), raises=False):
        self.errors, self.raises, self.deleted = list(errors), raises, []

    def delete_objects(self, Bucket, Delete):
        if self.raises:
            raise RuntimeError("bucket unreachable")
        self.deleted += [item["Key"] for item in Delete["Objects"]]
        return {"Errors": self.errors}


@pytest.fixture
def bucket(monkeypatch):
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example.com")
    monkeypatch.setenv("R2_PUBLIC_BUCKET", "bucket")

    def use(fake):
        media_store.set_client(fake)
        return fake

    yield use
    media_store.set_client(None)


def test_delete_removes_only_published_keys(bucket):
    fake = bucket(FakeBucket())
    assert media_store.delete(["uploads/a.mp4", "jobs/x/result.mp4", None], strict=True) == 1
    assert fake.deleted == ["uploads/a.mp4"]


def test_best_effort_delete_swallows_failures(bucket):
    bucket(FakeBucket(raises=True))
    assert media_store.delete(["uploads/a.mp4"]) == 1
    bucket(FakeBucket(errors=[{"Key": "uploads/a.mp4", "Message": "denied"}]))
    assert media_store.delete(["uploads/a.mp4"]) == 1


def test_strict_delete_raises_when_an_object_stays(bucket):
    bucket(FakeBucket(raises=True))
    with pytest.raises(media_store.MediaStoreError):
        media_store.delete(["uploads/a.mp4"], strict=True)
    bucket(FakeBucket(errors=[{"Key": "uploads/a.mp4", "Message": "denied"}]))
    with pytest.raises(media_store.MediaStoreError):
        media_store.delete(["uploads/a.mp4"], strict=True)
