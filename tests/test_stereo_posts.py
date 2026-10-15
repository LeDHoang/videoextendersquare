from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest
from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import media
from server.routers import image as image_router
from server.routers import reels, social, uploads
from server.routers import video as video_router
from server.social import auth
from server.social import database
from server.social.database import Base, get_db
from server.social.models import Post
from server.social.services import post_card

PASSWORD = "correct horse battery staple 2026"

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe are required to build and probe sample media",
)

LEFT = (220, 30, 30)
RIGHT = (30, 30, 220)


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Serializers resolve media under ./output like the server does.
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret-for-hmac-cookies")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setattr(uploads, "OUTPUT_DIR", Path("output"))
    monkeypatch.setattr(uploads, "UPLOAD_DIR", Path("output") / "uploads")
    engine = create_engine("sqlite:///" + str(tmp_path / "stereo.db"), connect_args={"check_same_thread": False})
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
    engine.dispose()


def _register(client, username):
    response = client.post("/api/auth/register", json={
        "email": f"{username}@example.com", "username": username,
        "password": PASSWORD, "display_name": username,
    })
    assert response.status_code == 200, response.text
    return response.json()["user"]


def _publish(client, body):
    return client.post("/api/uploads/publish", json=body, headers={"x-csrf-token": client.cookies.get("echo_csrf")})


def _stereo_still(layout: str, eye: int = 64) -> Image.Image:
    size = (eye * 2, eye) if layout == "sbs" else (eye, eye * 2)
    img = Image.new("RGB", size, RIGHT)
    img.paste(Image.new("RGB", (eye, eye), LEFT), (0, 0))
    return img


def _stage_image(tmp_path, user, name, img: Image.Image):
    path = tmp_path / f"{name}.png"
    img.save(path, "PNG")
    image_router.STAGED_UPLOADS[name] = (str(path), time.time(), f"user:{user['id']}")
    return name


@pytest.fixture(autouse=True)
def _clear_stages():
    yield
    image_router.STAGED_UPLOADS.clear()
    video_router.STAGED_UPLOADS.clear()


@pytest.mark.parametrize("layout", ["sbs", "tb"])
def test_stereo_image_post_gets_left_eye_mono_rendition(client, tmp_path, layout):
    user = _register(client, f"stereo_img_{layout}")
    stage = _stage_image(tmp_path, user, f"img-{layout}", _stereo_still(layout))
    response = _publish(client, {"kind": "image", "title": "Stereo still", "stage_id": stage, "stereo_layout": layout})
    assert response.status_code == 200, response.text
    meta = response.json()["meta"]
    assert meta["stereo_layout"] == layout
    assert meta["stereo_crop"] is False
    assert meta["url"].endswith("-mono.png")
    assert meta["stereo_url"] == f"/media/{meta['path']}"
    assert meta["poster_url"].endswith("-mono-poster.jpg")
    assert meta["images"][0]["stereo_layout"] == layout
    assert meta["images"][0]["url"] == meta["url"]

    mono = Path("output") / meta["url"].removeprefix("/media/")
    with Image.open(mono) as eye:
        assert eye.size == (64, 64)
        assert eye.convert("RGB").getpixel((32, 32)) == LEFT
    with client.testing_session() as db:
        assert db.query(Post).one().stereo_layout == layout


def test_stereo_slideshow_requires_every_image_to_match(client, tmp_path):
    user = _register(client, "stereo_slides")
    cover = _stage_image(tmp_path, user, "slide-a", _stereo_still("sbs"))
    second = _stage_image(tmp_path, user, "slide-b", _stereo_still("sbs"))
    flat = _stage_image(tmp_path, user, "slide-flat", Image.new("RGB", (64, 64), LEFT))

    mixed = _publish(client, {
        "kind": "image", "title": "Mixed", "stage_id": cover,
        "extra_stage_ids": [flat], "stereo_layout": "sbs",
    })
    assert mixed.status_code == 422
    assert not list(Path("output").rglob("*.png"))

    ok = _publish(client, {
        "kind": "image", "title": "Pair", "stage_id": cover,
        "extra_stage_ids": [second], "stereo_layout": "sbs",
    })
    assert ok.status_code == 200, ok.text
    images = ok.json()["meta"]["images"]
    assert [image["stereo_layout"] for image in images] == ["sbs", "sbs"]
    assert all(image["url"].endswith("-mono.png") for image in images)
    assert all(image["stereo_url"] == f"/media/{image['path']}" for image in images)


def test_stereo_publish_rejects_wrong_geometry_and_extended_renders(client, tmp_path):
    user = _register(client, "stereo_reject")
    square = _stage_image(tmp_path, user, "square", Image.new("RGB", (64, 64), LEFT))
    wide = _stage_image(tmp_path, user, "wide", _stereo_still("sbs"))

    assert _publish(client, {"kind": "image", "title": "Sq", "stage_id": square, "stereo_layout": "sbs"}).status_code == 422
    assert _publish(client, {"kind": "image", "title": "Wrong", "stage_id": wide, "stereo_layout": "tb"}).status_code == 422
    extended = _publish(client, {"kind": "video", "title": "Ext", "job_id": "abc123", "stereo_layout": "sbs"})
    assert extended.status_code == 422
    assert "as-is" in extended.text
    assert _publish(client, {"kind": "image", "title": "Bad", "stage_id": wide, "stereo_layout": "half"}).status_code == 422
    with client.testing_session() as db:
        assert db.query(Post).count() == 0


def test_posts_default_to_mono(client, tmp_path):
    user = _register(client, "stereo_mono")
    stage = _stage_image(tmp_path, user, "plain", Image.new("RGB", (64, 64), LEFT))
    response = _publish(client, {"kind": "image", "title": "Plain", "stage_id": stage})
    assert response.status_code == 200, response.text
    meta = response.json()["meta"]
    assert meta["stereo_layout"] == "mono"
    assert meta["stereo_url"] is None
    assert meta["url"] == f"/media/{meta['path']}"
    assert meta["images"][0]["stereo_layout"] == "mono"


def test_mono_renditions_never_surface_as_tiles(tmp_path):
    root = tmp_path / "output"
    (root / "uploads").mkdir(parents=True)
    for name in ("clip.mp4", "clip-mono.mp4", "clip-mono-explore.mp4", "still.png", "still-mono.png", "still-mono-poster.jpg"):
        (root / "uploads" / name).write_bytes(b"x")
    names = sorted(item["filename"] for item in media.scan_output_media(str(root)))
    assert names == ["clip.mp4", "still.png"]


def test_legacy_folder_rule():
    assert media.legacy_stereo_layout("testpipeline-3d/clip.mp4") == "sbs"
    assert media.legacy_stereo_layout("testpipeline/clip.mp4") == "mono"
    assert media.legacy_stereo_layout("uploads/my-3d-trip-1.mp4") == "mono"


def test_stereo_post_without_rendition_falls_back_to_crop(client, tmp_path):
    """Legacy SBS rows have no mono file yet: 2D plays the raw file cropped."""
    user = _register(client, "stereo_legacy")
    stage = _stage_image(tmp_path, user, "legacy", _stereo_still("sbs"))
    meta = _publish(client, {"kind": "image", "title": "L", "stage_id": stage, "stereo_layout": "sbs"}).json()["meta"]
    (Path("output") / meta["url"].removeprefix("/media/")).unlink()
    with client.testing_session() as db:
        card = post_card(db.query(Post).one(), db)
    assert card["stereo_crop"] is True
    assert card["url"] == card["stereo_url"] == f"/media/{meta['path']}"


# ─── Video (ffmpeg) ─────────────────────────────────────────────────────

def _stereo_video(path: Path, layout: str, eye: int = 128) -> None:
    stack = "hstack" if layout == "sbs" else "vstack"
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi", "-i", f"color=c=0xDC1E1E:s={eye}x{eye}:d=1:r=10",
            "-f", "lavfi", "-i", f"color=c=0x1E1EDC:s={eye}x{eye}:d=1:r=10",
            "-filter_complex", f"[0][1]{stack}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
    )


@needs_ffmpeg
@pytest.mark.parametrize("layout", ["sbs", "tb"])
def test_stereo_video_post_and_feed_payload(client, tmp_path, layout):
    user = _register(client, f"stereo_vid_{layout}")
    source = tmp_path / f"clip-{layout}.mp4"
    _stereo_video(source, layout)
    video_router.STAGED_UPLOADS["vid"] = (str(source), time.time(), f"user:{user['id']}")

    response = _publish(client, {"kind": "video", "title": "Stereo clip", "stage_id": "vid", "stereo_layout": layout})
    assert response.status_code == 200, response.text
    body = response.json()
    meta = body["meta"]
    assert meta["stereo_layout"] == layout
    assert meta["url"].endswith("-mono.mp4")
    # H.264 within the proxy cap plays as-is in VR.
    assert meta["stereo_url"] == f"/media/{meta['path']}"
    assert body["poster_url"].endswith("-mono-poster.jpg")
    assert body["preview_url"].endswith("-mono-explore.mp4")

    mono = Path("output") / meta["url"].removeprefix("/media/")
    info = media.probe_media_info(str(mono))
    assert (info["width"], info["height"]) == (128, 128)
    frame = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(mono), "-frames:v", "1", "-vf", "scale=1:1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True,
    ).stdout
    red, _green, blue = frame[:3]
    assert red > 150 and blue < 100  # left eye (red), not the right (blue)

    # The reels feed: 2D url is the mono rendition, VR gets stereo_url.
    scanned = [item for item in media.scan_output_media("output")]
    assert [item["filename"] for item in scanned] == [Path(meta["path"]).name]
    payload = reels._build_payload(scanned, "h264")
    assert len(payload) == 1
    item = payload[0]
    assert item["stereo_layout"] == layout
    assert item["url"] == meta["url"]
    assert item["stereo_url"] == meta["stereo_url"]
    assert item["stereo_crop"] is False
    assert item["poster_url"].endswith("-mono-poster.jpg")


@needs_ffmpeg
def test_oversized_h264_stereo_gets_capped_proxy(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "STEREO_PROXY_LONG_SIDE", 128)
    source = tmp_path / "big.mp4"
    _stereo_video(source, "sbs", eye=128)  # 256x128 > cap of 128
    proxy = media.make_web_preview(str(source), stereo="sbs")
    assert proxy and proxy.endswith("-preview.mp4")
    info = media.probe_media_info(proxy)
    assert (info["width"], info["height"]) == (128, 64)
    mono_path, stereo_path = media.stereo_paths(str(source))
    assert mono_path is None and str(stereo_path) == proxy
    # Mono uploads keep the old rule: H.264 plays as-is.
    assert media.make_web_preview(str(tmp_path / "big.mp4")) == str(source)


@needs_ffmpeg
def test_grid_assets_of_stereo_video_come_from_the_left_eye(client, tmp_path):
    """Profile/feed cards and the lazy grid generator never build 2:1 tiles."""
    user = _register(client, "stereo_grid")
    source = tmp_path / "grid-sbs.mp4"
    _stereo_video(source, "sbs")
    video_router.STAGED_UPLOADS["grid"] = (str(source), time.time(), f"user:{user['id']}")
    meta = _publish(client, {"kind": "video", "title": "Grid", "stage_id": "grid", "stereo_layout": "sbs"}).json()["meta"]
    mono = Path("output") / meta["url"].removeprefix("/media/")
    # Drop the grid assets publish made, as if they had never been built.
    media.explore_preview_path(str(mono)).unlink()
    media.explore_poster_path(str(mono)).unlink()

    rel, preview_url, poster_url, err = reels._gen_explore_assets(meta["path"])
    assert err is None
    assert preview_url.endswith("-mono-explore.mp4")
    assert poster_url.endswith("-mono-poster.jpg")
    info = media.probe_media_info(str(Path("output") / poster_url.removeprefix("/media/")))
    assert info["width"] == info["height"]
    assert not media.explore_preview_path(str(Path("output") / meta["path"])).exists()

    with client.testing_session() as db:
        card = social.media_card(db.query(Post).one(), db)
    assert card["preview_url"] == preview_url
    assert card["poster_url"] == poster_url
    assert card["url"] == meta["url"]


def test_profile_card_of_stereo_still_keeps_left_eye_poster(client, tmp_path):
    user = _register(client, "stereo_card")
    stage = _stage_image(tmp_path, user, "card", _stereo_still("sbs"))
    meta = _publish(client, {"kind": "image", "title": "Card", "stage_id": stage, "stereo_layout": "sbs"}).json()["meta"]
    with client.testing_session() as db:
        card = social.media_card(db.query(Post).one(), db)
    assert card["url"].endswith("-mono.png")
    assert card["preview_url"] == card["url"]
    assert card["poster_url"].endswith("-mono-poster.jpg")
    rel, preview_url, poster_url, err = reels._gen_explore_assets(meta["path"])
    assert err is None and preview_url.endswith("-mono.png") and poster_url.endswith("-mono-poster.jpg")
