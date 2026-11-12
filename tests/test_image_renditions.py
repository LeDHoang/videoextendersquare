"""WebP renditions of image posts: sizes, publish, payload fields, backfill."""

from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path

import pytest
from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server import media
from server.routers import image as image_router
from server.routers import social, uploads
from server.social import auth, database
from server.social.database import Base, get_db
from server.social.models import Post, User
from server.social.services import _image_entry, create_or_update_post, record_media_files, shared_preview_urls

PASSWORD = "correct horse battery staple 2026"


def _png(path: Path, size: tuple[int, int]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", size)
    # Some detail, so sizes are not trivially tiny.
    for x in range(0, size[0], 16):
        img.paste((x % 256, 90, 200), (x, 0, min(x + 8, size[0]), size[1]))
    img.save(path, "PNG")
    return path


# ─── Sizes ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("size, tile, two_d, vr", [
    ((1080, 1080), (720, 720), (1080, 1080), (1080, 1080)),
    ((1080, 1920), (405, 720), (1080, 1920), (1080, 1920)),
    ((1920, 1080), (720, 405), (1920, 1080), (1920, 1080)),
    ((4000, 3000), (720, 540), (1440, 1080), (2048, 1536)),
    ((3000, 3000), (720, 720), (1080, 1080), (2048, 2048)),
    ((64, 64), (64, 64), (64, 64), (64, 64)),
])
def test_rendition_sizes_fit_their_box_and_never_upscale(size, tile, two_d, vr):
    assert media.image_rendition_size(size, "tile") == tile
    assert media.image_rendition_size(size, "2d") == two_d
    assert media.image_rendition_size(size, "vr") == vr


def test_renditions_of_a_1080_still_skip_vr_and_are_webp(tmp_path):
    src = _png(tmp_path / "a.png", (1080, 1080))
    built = media.make_image_renditions(str(src))
    assert set(built) == {"tile", "2d"}
    for name, size in (("tile", (720, 720)), ("2d", (1080, 1080))):
        assert built[name] == str(media.image_rendition_path(str(src), name))
        with Image.open(built[name]) as img:
            assert img.format == "WEBP" and img.size == size
    assert not media.image_rendition_path(str(src), "vr").exists()


def test_a_large_still_gets_a_2048_vr_rendition(tmp_path):
    src = _png(tmp_path / "big.png", (3000, 2000))
    built = media.make_image_renditions(str(src))
    assert set(built) == {"tile", "2d", "vr"}
    with Image.open(built["vr"]) as img:
        assert img.size == (2048, 1365)
    with Image.open(built["2d"]) as img:
        assert img.size == (1620, 1080)


def test_vr_false_builds_no_vr_rendition(tmp_path):
    src = _png(tmp_path / "eye.png", (3000, 3000))
    assert set(media.make_image_renditions(str(src), vr=False)) == {"tile", "2d"}


def test_fresh_renditions_are_kept_and_stale_ones_rebuilt(tmp_path):
    src = _png(tmp_path / "a.png", (1080, 1080))
    tile = Path(media.make_image_renditions(str(src))["tile"])
    before = tile.stat().st_mtime_ns
    time.sleep(0.01)
    media.make_image_renditions(str(src))
    assert tile.stat().st_mtime_ns == before
    # A replaced original is newer than its tile: the tile is rebuilt.
    os.utime(src, ns=(before + 10**9, before + 10**9))
    media.make_image_renditions(str(src))
    assert tile.stat().st_mtime_ns != before


def test_alpha_is_kept(tmp_path):
    src = tmp_path / "alpha.png"
    Image.new("RGBA", (100, 100), (255, 0, 0, 0)).save(src)
    with Image.open(media.make_image_renditions(str(src))["2d"]) as img:
        assert img.mode == "RGBA"


def test_renditions_are_derived_siblings():
    stored = Path("output/uploads/a.png")
    siblings = {p.name for p in media.derived_files(stored)}
    assert {"a-tile.webp", "a-2d.webp", "a-vr.webp", "a-mono-tile.webp", "a-mono-2d.webp"} <= siblings
    assert media.is_derived_media("a-tile.webp") and media.is_derived_media("a-2d.webp")
    assert media.is_derived_media("a-vr.webp")
    assert not media.is_derived_media("a.webp")


# ─── Payload fields ─────────────────────────────────────────────────────────


def test_image_entry_uses_recorded_renditions_and_falls_back_to_the_original():
    files = {"uploads/a.png": {"bytes": 1}}
    plain = _image_entry("uploads/a.png", 1080, 1080, "mono", files)
    assert plain["display_url"] == plain["vr_url"] == plain["url"] == plain["poster_url"]

    files.update({"uploads/a-tile.webp": {"bytes": 1}, "uploads/a-2d.webp": {"bytes": 1}})
    entry = _image_entry("uploads/a.png", 1080, 1080, "mono", files)
    assert entry["url"].endswith("/a.png")
    assert entry["poster_url"].endswith("/a-tile.webp")
    assert entry["display_url"].endswith("/a-2d.webp")
    # No VR file (the original is not larger than 2D): VR uses the 2D file.
    assert entry["vr_url"] == entry["display_url"]

    files["uploads/a-vr.webp"] = {"bytes": 1}
    assert _image_entry("uploads/a.png", 3000, 3000, "mono", files)["vr_url"].endswith("/a-vr.webp")


def test_stereo_image_entry_takes_renditions_of_its_left_eye_only():
    files = {
        "uploads/s.png": {"bytes": 1},
        "uploads/s-mono.png": {"bytes": 1},
        "uploads/s-mono-tile.webp": {"bytes": 1},
        "uploads/s-mono-2d.webp": {"bytes": 1},
    }
    entry = _image_entry("uploads/s.png", 128, 64, "sbs", files)
    assert entry["url"].endswith("/s-mono.png")
    assert entry["poster_url"].endswith("/s-mono-tile.webp")
    assert entry["display_url"].endswith("/s-mono-2d.webp")
    assert entry["stereo_url"].endswith("/s.png")
    # Without the left eye the 2D view crops the stereo file: no renditions.
    crop = _image_entry("uploads/s.png", 128, 64, "sbs", {"uploads/s.png": {"bytes": 1}, "uploads/s-tile.webp": {"bytes": 1}})
    assert crop["stereo_crop"] is True
    assert crop["poster_url"] == crop["display_url"] == crop["url"]


def test_shared_preview_urls_use_the_tile():
    post = Post(media_path="uploads/a.png", media_type="image", stereo_layout="mono", width=1080, height=1080,
                media_files={"uploads/a.png": {"bytes": 1}, "uploads/a-tile.webp": {"bytes": 1}})
    urls = shared_preview_urls(post)
    assert urls["preview_url"] == urls["poster_url"]
    assert urls["preview_url"].endswith("/a-tile.webp")


# ─── Publish ────────────────────────────────────────────────────────────────


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret-for-hmac-cookies")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setattr(uploads, "OUTPUT_DIR", Path("output"))
    monkeypatch.setattr(uploads, "UPLOAD_DIR", Path("output") / "uploads")
    monkeypatch.setattr(uploads, "_submit_derived_assets", lambda fn: fn())
    engine = create_engine("sqlite:///" + str(tmp_path / "renditions.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", Session)
    application = FastAPI()
    for router in (social.router, uploads.router, image_router.router):
        application.include_router(router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    with TestClient(application) as test_client:
        test_client.testing_session = Session
        yield test_client
    image_router.STAGED_UPLOADS.clear()
    engine.dispose()


def test_publish_builds_and_records_the_renditions(client, tmp_path):
    response = register_verified(client, json={
        "email": "renditions@example.com", "username": "renditions",
        "password": PASSWORD, "accept_terms": True, "display_name": "renditions",
    })
    user = response.json()["user"]
    staged = _png(tmp_path / "staged.png", (3000, 2000))
    image_router.STAGED_UPLOADS["stage"] = (str(staged), time.time(), f"user:{user['id']}")
    response = client.post("/api/uploads/publish", json={"kind": "image", "title": "Big", "stage_id": "stage"},
                           headers={"x-csrf-token": client.cookies.get("echo_csrf")})
    assert response.status_code == 200, response.text
    meta = response.json()["meta"]
    assert meta["poster_url"].endswith("-tile.webp")
    assert meta["preview_url"] == meta["poster_url"]
    image = meta["images"][0]
    assert image["display_url"].endswith("-2d.webp") and image["vr_url"].endswith("-vr.webp")
    with client.testing_session() as db:
        files = db.query(Post).one().media_files
    stem = Path(meta["path"]).stem
    assert {f"uploads/{stem}-tile.webp", f"uploads/{stem}-2d.webp", f"uploads/{stem}-vr.webp"} <= set(files)


# ─── Backfill script ────────────────────────────────────────────────────────


def _batch_module():
    spec = importlib.util.spec_from_file_location(
        "batch_image_renditions", Path(__file__).resolve().parents[1] / "scripts" / "batch_image_renditions.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def backfill(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    engine = create_engine("sqlite:///" + str(tmp_path / "backfill.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    _png(tmp_path / "output" / "uploads" / "old.png", (1080, 1080))
    _png(tmp_path / "output" / "uploads" / "big.png", (3000, 3000))
    with Session() as db:
        owner = User(username="old", username_norm="old", display_name="Old", status="active")
        db.add(owner)
        db.flush()
        for name, size in (("old", 1080), ("big", 3000)):
            post = create_or_update_post(db, media_path=f"uploads/{name}.png", media_type="image", owner=owner)
            post.width = post.height = size
            record_media_files(post, reset=True)
        db.commit()
    batch = _batch_module()
    monkeypatch.setattr(batch, "SessionLocal", Session)
    return batch, Session, tmp_path / "output" / "uploads"


def _run(batch, monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["batch_image_renditions.py", *argv])
    batch.main()


def test_backfill_dry_run_lists_and_writes_nothing(backfill, monkeypatch, capsys):
    batch, Session, uploads_dir = backfill
    before = sorted(p.name for p in uploads_dir.iterdir())
    _run(batch, monkeypatch, "--dry-run")
    out = capsys.readouterr().out
    assert "old.png — missing tile, 2d" in out
    assert "big.png — missing tile, 2d, vr" in out
    assert "would build 2 image(s) in 2 post(s)" in out
    assert sorted(p.name for p in uploads_dir.iterdir()) == before
    with Session() as db:
        assert all(not any(k.endswith(".webp") for k in post.media_files) for post in db.query(Post))


def test_backfill_builds_records_and_then_has_nothing_left(backfill, monkeypatch, capsys):
    batch, Session, uploads_dir = backfill
    _run(batch, monkeypatch, "--limit", "1")
    assert "built 1, failed 0." in capsys.readouterr().out
    _run(batch, monkeypatch)
    assert "built 1, failed 0." in capsys.readouterr().out
    assert {"old-tile.webp", "old-2d.webp", "big-tile.webp", "big-2d.webp", "big-vr.webp"} <= {
        p.name for p in uploads_dir.iterdir()}
    assert not (uploads_dir / "old-vr.webp").exists()
    with Session() as db:
        files = {k for post in db.query(Post) for k in post.media_files}
    assert {"uploads/old-tile.webp", "uploads/big-vr.webp"} <= files
    _run(batch, monkeypatch, "--dry-run")
    assert "Dry run: would build 0 image(s) in 0 post(s)." in capsys.readouterr().out
