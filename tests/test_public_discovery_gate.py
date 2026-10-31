"""Production discovery gate: only files with a Post row surface in reels."""

from __future__ import annotations

import pytest

from server.routers import reels


def _item(rel):
    return {"rel_path": rel, "path": f"output/{rel}", "filename": rel.rsplit("/", 1)[-1],
            "folder": rel.split("/", 1)[0], "mtime": 1, "media_type": "video"}


SCANNED = [
    _item("uploads/posted.mp4"),
    _item("uploads/slide.jpg"),
    _item("testpipeline/loose.mp4"),
    _item("uploads/orphan.mp4"),
]


@pytest.fixture(autouse=True)
def fake_scan(monkeypatch):
    monkeypatch.setattr(reels.SM, "scan_output_media", lambda _root: list(SCANNED))
    monkeypatch.setattr(reels, "slide_media_paths", lambda _db=None: {"uploads/slide.jpg"})
    # Posts come from their media records, wherever their files are.
    monkeypatch.setattr(reels, "post_media_items", lambda _db=None: [_item("uploads/posted.mp4"), _item("uploads/remote.mp4")])
    reels.invalidate_scan_cache()
    yield
    reels.invalidate_scan_cache()


def _rels():
    return [item["rel_path"] for item in reels._scan_cached(None)]


def test_dev_keeps_loose_files_discoverable(monkeypatch):
    monkeypatch.delenv("SX_ENV", raising=False)
    assert _rels() == ["uploads/posted.mp4", "uploads/remote.mp4", "testpipeline/loose.mp4", "uploads/orphan.mp4"]


def test_production_surfaces_only_posted_files(monkeypatch):
    monkeypatch.setenv("SX_ENV", "production")
    assert _rels() == ["uploads/posted.mp4", "uploads/remote.mp4"]
