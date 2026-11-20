"""Multi-format output (1:1, 16:9, 9:16): quotes, worker canvases and model
arguments, stereo frame shapes, and display (rotation-aware) dimensions.

fal is never reached: the SyncClient is faked and stops at submit.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
from argon2 import PasswordHasher
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from core import models
from core.pricing import (
    IMAGE_OUTPAINT_MAX_SIDE, PricingError, image_canvas, image_work_dimensions, quote_image, quote_video,
)
from pipeline import image_worker, stereo_detect, video_worker
from pipeline.utils import aspect_matches, get_image_dimensions, get_video_dimensions_and_duration
from server.billing.service import grant_credits
from server.jobs import job_manager
from server.routers import billing, image as image_router, social, uploads
from server.routers import video as video_router
from server.social import auth
from server.social.database import Base, get_db

PASSWORD = "correct-horse-battery-99"
LTX23 = "fal-ai/ltx-2.3-quality/outpaint"
LUMA = "luma/agent/ray/v3.2/reframe"
H3 = "minimax/h3-max/reframe-video"
LTX25 = "lightricks/ltx-2.5/reframe"
SEEDVR = "fal-ai/seedvr/upscale/video"

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe not on PATH",
)


# ─── Video quotes ────────────────────────────────────────────────────────────


def test_square_quote_matches_a_legacy_caller():
    for params in (
        {"outpaint_model": LTX23},
        {"outpaint_model": H3},
        {"outpaint_model": LTX23, "upscale_engine": "fal", "upscale_model": SEEDVR},
    ):
        legacy = quote_video(width=1080, height=1920, duration=5, params=params)
        square = quote_video(width=1080, height=1920, duration=5, params={**params, "target_aspect": "1:1"})
        assert square["stages"] == legacy["stages"]
        assert square["credits"] == legacy["credits"]


@pytest.mark.parametrize(
    ("target", "canvas", "billed_mp"),
    # 121 frames (5 s at 24 fps, +1); billed MP round up.
    [("1:1", (720, 720), 63), ("16:9", (1280, 720), 112)],
)
def test_ltx23_bills_the_target_canvas(target, canvas, billed_mp):
    quote = quote_video(width=1080, height=1920, duration=5, params={"outpaint_model": LTX23, "target_aspect": target})
    details = quote["stages"][0]["details"]
    assert (details["output_width"], details["output_height"]) == canvas
    assert details["billed_megapixels"] == billed_mp
    assert abs(Decimal(quote["stages"][0]["provider_cost_usd"]) - Decimal("0.0024075") * billed_mp) < Decimal("0.000001")


def test_ltx23_canvas_table_is_short_side_at_the_resolution():
    for resolution, side in (("480p", 480), ("720p", 720), ("1080p", 1080)):
        wide = models.ltx_canvas(resolution, "16:9", side)
        tall = models.ltx_canvas(resolution, "9:16", side)
        assert min(wide) == side and wide[0] > wide[1]
        assert tall == wide[::-1]


@pytest.mark.parametrize("model", [H3, LTX25, LUMA])
def test_reframe_quotes_name_the_target(model):
    quote = quote_video(width=1080, height=1920, duration=5, params={"outpaint_model": model, "target_aspect": "16:9"})
    assert quote["stages"][0]["details"]["aspect_ratio"] == "16:9"
    assert quote["details"]["target_aspect"] == "16:9"
    assert quote["details"]["extend"] is True


def test_source_already_at_the_target_skips_outpaint():
    quote = quote_video(width=1080, height=1920, duration=5, params={"outpaint_model": H3, "target_aspect": "9:16"})
    assert quote["stages"] == []
    assert quote["details"]["extend"] is False


@pytest.mark.parametrize(("target", "out"), [("1:1", (1080, 1080)), ("16:9", (1920, 1080))])
def test_seedvr_after_extend_upscales_the_target_shape(target, out):
    params = {"outpaint_model": LTX23, "upscale_engine": "fal", "upscale_model": SEEDVR, "target_aspect": target}
    stage = quote_video(width=1080, height=1920, duration=5, params=params)["stages"][1]
    assert (stage["details"]["output_width"], stage["details"]["output_height"]) == out


def test_seedvr_upscale_only_keeps_the_source_shape():
    params = {"upscale_only": True, "upscale_engine": "fal", "upscale_model": SEEDVR, "target_aspect": "1:1"}
    quote = quote_video(width=1080, height=1920, duration=5, params=params, source_fps=30, source_frames=150)
    details = quote["stages"][0]["details"]
    assert (details["output_width"], details["output_height"]) == (1080, 1920)


def _entry(model):
    return next(e for e in models.VIDEO_OUTPAINT if e["model"] == model)


def test_model_without_the_target_aspect_is_refused(monkeypatch, tmp_path):
    monkeypatch.setitem(_entry(H3), "aspect_ratios", ["1:1"])
    with pytest.raises(PricingError, match="cannot output 16:9"):
        quote_video(width=1080, height=1920, duration=5, params={"outpaint_model": H3, "target_aspect": "16:9"})
    quote_video(width=1080, height=1920, duration=5, params={"outpaint_model": H3, "target_aspect": "1:1"})
    with pytest.raises(ValueError, match="cannot output 16:9"):
        _sent_arguments(tmp_path, monkeypatch, H3, target_aspect="16:9")


# ─── Image quotes ────────────────────────────────────────────────────────────


def test_square_image_quote_matches_a_legacy_caller():
    params = {"upscale_engine": "fal"}
    legacy = quote_image(width=1000, height=500, params=params)
    assert quote_image(width=1000, height=500, params={**params, "target_aspect": "1:1"})["stages"] == legacy["stages"]


@pytest.mark.parametrize("target", ["16:9", "9:16"])
def test_image_quote_outpaints_to_the_target(target):
    quote = quote_image(width=1000, height=1000, params={"target_aspect": target})
    details = quote["stages"][0]["details"]
    assert aspect_matches(details["output_width"], details["output_height"], target)


@pytest.mark.parametrize(
    ("size", "target"),
    [((4000, 400), "9:16"), ((400, 4000), "16:9"), ((1000, 1000), "16:9"), ((1300, 1300), "9:16"), ((3000, 2000), "1:1")],
)
def test_image_outpaint_expands_at_most_the_max_side(size, target):
    work_w, work_h, _scale = image_work_dimensions(*size, target)
    canvas_w, canvas_h = image_canvas(work_w, work_h, target)
    assert max(work_w, work_h) <= IMAGE_OUTPAINT_MAX_SIDE
    if target != "1:1":
        assert (canvas_w - work_w) + (canvas_h - work_h) <= IMAGE_OUTPAINT_MAX_SIDE
        assert aspect_matches(canvas_w, canvas_h, target)


# ─── Worker canvases ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("args", "dims"),
    [
        ((1920, 1080, "16:9"), (3640, 2048)),
        ((1080, 1920, "9:16"), (2048, 3640)),
        ((1080, 1920, "1:1"), (2048, 2048)),
        ((1080, 1920, "1:1", True), (2048, 3640)),        # keep shape
        ((1080, 1920, "16:9", False, False), (1920, 1080)),  # extend, no upscale: native short side
        ((1080, 1920, "1:1", False, False), (1920, 1920)),
        ((1081, 1921, "1:1", True, False), (1082, 1922)),
    ],
)
def test_master_dims(args, dims):
    assert video_worker.master_dims(*args) == dims


def test_scale_filter_is_exact_with_square_pixels():
    assert video_worker.scale_vf(3640, 2048) == (
        "scale=3640:2048:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,setsar=1"
    )
    assert video_worker.SQUARE_UPSCALE_VF == video_worker.scale_vf(2048, 2048)


def test_rotated_master_is_never_stream_copied(monkeypatch):
    for name in ("_is_already_square", "_is_already_hevc", "_within_bitrate_cap"):
        monkeypatch.setattr(video_worker, name, lambda *_a, **_k: True)
    monkeypatch.setattr(video_worker, "_is_rotated", lambda _path: False)
    assert video_worker._master_can_stream_copy("x.mp4", 0.0)
    monkeypatch.setattr(video_worker, "_is_rotated", lambda _path: True)
    assert not video_worker._master_can_stream_copy("x.mp4", 0.0)


# ─── Worker model arguments ──────────────────────────────────────────────────


class _Submitted(Exception):
    pass


def _sent_arguments(tmp_path, monkeypatch, model, **kwargs):
    sent = []

    class _FakeFal:
        def __init__(self, *_a, **_k):
            pass

        def upload_file(self, *_a, **_k):
            return "https://fal.test/source.mp4"

        def submit(self, endpoint, arguments):
            sent.append((endpoint, arguments))
            raise _Submitted

    monkeypatch.setattr(video_worker, "get_video_dimensions_and_duration", lambda *_a, **_k: (1080, 1920, 5.0))
    monkeypatch.setattr(video_worker.fal_client, "SyncClient", _FakeFal)
    source = tmp_path / "portrait.mp4"
    source.write_bytes(b"x")
    with pytest.raises(_Submitted):
        video_worker.process_video(str(source), "", fal_key="key", outpaint_model=model, **kwargs)
    endpoint, arguments = sent[0]
    assert endpoint == model
    return arguments


@pytest.mark.parametrize("model", [LTX23, LUMA, H3, LTX25, "someone/custom-outpaint"])
@pytest.mark.parametrize("target", ["16:9", "1:1"])
def test_worker_asks_the_model_for_the_target(tmp_path, monkeypatch, model, target):
    assert _sent_arguments(tmp_path, monkeypatch, model, target_aspect=target)["aspect_ratio"] == target


@pytest.mark.parametrize("model", [LTX23, LUMA, H3, LTX25])
def test_legacy_worker_call_stays_square(tmp_path, monkeypatch, model):
    assert _sent_arguments(tmp_path, monkeypatch, model)["aspect_ratio"] == "1:1"


# ─── Rotated sources ─────────────────────────────────────────────────────────


def rotated_video(path: Path, coded: str, rotation: int) -> Path:
    """A clip stored at `coded` size whose display matrix turns it `rotation` degrees."""
    raw = path.with_name(path.stem + "-coded.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=s={coded}:d=0.4:r=10",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(raw)],
        check=True,
    )
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-display_rotation", str(rotation), "-i", str(raw),
         "-c", "copy", str(path)],
        check=True,
    )
    return path


@needs_ffmpeg
def test_rotated_video_reports_display_dims(tmp_path):
    clip = rotated_video(tmp_path / "phone.mp4", "256x144", 90)
    assert get_video_dimensions_and_duration(str(clip))[:2] == (256, 144)
    assert get_video_dimensions_and_duration(str(clip), display=True)[:2] == (144, 256)
    assert video_worker._is_rotated(str(clip))
    assert not video_worker._is_rotated(str(tmp_path / "phone-coded.mp4"))


def _stream(path) -> str:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    return out.stdout.strip()


@needs_ffmpeg
def test_video_already_at_the_target_skips_outpaint_and_masters_wide(tmp_path):
    clip = tmp_path / "wide.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=128x72:d=0.4:r=10",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)], check=True)
    (_url, out), metrics = video_worker.process_video(str(clip), "", target_aspect="16:9")
    try:
        assert _stream(out) == "3640,2048,1:1"
        assert metrics["skipped_stages"] == ["outpaint"]
    finally:
        Path(out).unlink(missing_ok=True)


@needs_ffmpeg
def test_rotated_video_keeps_its_shown_shape_without_a_rotation_tag(tmp_path):
    clip = rotated_video(tmp_path / "phone.mp4", "256x144", 90)
    (_url, out), _metrics = video_worker.process_video(str(clip), "", upscale_only=True, target_aspect="9:16")
    try:
        assert _stream(out) == "2048,3640,1:1"
        assert not video_worker._is_rotated(out)
    finally:
        Path(out).unlink(missing_ok=True)


def _exif_rotated_still(path: Path) -> Path:
    """A 72x128 portrait stored turned a quarter (128x72), tagged EXIF orientation 6."""
    stored = Image.new("RGB", (72, 128), "white").rotate(90, expand=True)
    exif = stored.getexif()
    exif[0x0112] = 6
    stored.save(path, exif=exif)
    return path


@needs_ffmpeg
@pytest.mark.parametrize(
    ("suffix", "target", "engine", "dims"),
    [
        ("jpg", "9:16", "fast", (2048, 3640)),  # keep shape, as shown (portrait)
        ("png", "1:1", "fast", (2048, 3640)),
        ("jpg", "1:1", "none", (72, 128)),
        ("jpg", None, "fast", (2048, 2048)),    # legacy: square
    ],
)
def test_exif_rotated_still_is_baked_upright(tmp_path, monkeypatch, suffix, target, engine, dims):
    monkeypatch.chdir(tmp_path)
    src = _exif_rotated_still(tmp_path / f"phone.{suffix}")
    _url, out = image_worker.process_image(
        str(src), "", upscale_only=True, upscale_engine=engine, target_aspect=target,
    )
    assert get_image_dimensions(out) == dims


# ─── Stereo frame shapes ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("layout", "size", "eye"),
    [
        ("sbs", (2048, 1024), "1:1"),
        ("sbs", (3840, 1080), "16:9"),
        ("sbs", (2160, 1920), "9:16"),  # 9:8, manual only
        ("tb", (1024, 2048), "1:1"),
        ("tb", (1920, 2160), "16:9"),   # 8:9, manual only
        ("tb", (1080, 3840), "9:16"),
        ("sbs", (2050, 1024), None),    # square eyes are exact
        ("sbs", (1920, 1080), None),
        ("tb", (1920, 1080), None),
    ],
)
def test_frame_eye_shape(layout, size, eye):
    assert stereo_detect.frame_eye_shape(layout, *size) == eye
    assert stereo_detect.layout_matches(layout, *size) is (eye is not None)


@pytest.mark.parametrize(
    ("size", "layout"),
    [((2048, 1024), "sbs"), ((3840, 1080), "sbs"), ((1024, 2048), "tb"), ((1080, 3840), "tb"),
     ((2160, 1920), None), ((1920, 2160), None), ((1920, 1080), None)],
)
def test_candidate_layout_never_guesses_9_8_or_8_9(size, layout):
    assert stereo_detect.candidate_layout(*size) == layout


@pytest.mark.parametrize(
    ("layout", "size", "ok"),
    [("sbs", (3840, 1080), True), ("sbs", (2160, 1920), True), ("tb", (1920, 2160), True),
     ("sbs", (1920, 1080), False), ("tb", (1024, 1024), False)],
)
def test_stereo_publish_accepts_the_six_frame_shapes(monkeypatch, layout, size, ok):
    monkeypatch.setattr(uploads.SM, "probe_media_info", lambda _path: {"width": size[0], "height": size[1]})
    req = SimpleNamespace(stereo_layout=layout)
    if ok:
        uploads._check_stereo_sources(req, ["a.mp4"])
        return
    with pytest.raises(HTTPException) as caught:
        uploads._check_stereo_sources(req, ["a.mp4"])
    assert caught.value.status_code == 422
    assert ("2:1, 32:9 or 9:8" if layout == "sbs" else "1:2, 9:32 or 8:9") in caught.value.detail


def test_stereo_content_compare_runs_at_the_eye_aspect():
    eye = Image.effect_noise((960, 540), 64).convert("RGB")
    frame = Image.new("RGB", (1920, 540))
    frame.paste(eye, (0, 0))
    frame.paste(eye, (960, 0))
    left, _right = stereo_detect.eye_halves(frame, "sbs")
    assert stereo_detect._detail_patch(left, stereo_detect.EYE_PATCHES["16:9"]).size == (228, 128)
    score, shift = stereo_detect.image_match(frame, "sbs", eye="16:9")
    assert score >= stereo_detect.CONTENT_THRESHOLD and shift == 0


# ─── Routes ──────────────────────────────────────────────────────────────────


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret-for-hmac-cookies")
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "test-only-dedicated-fal-encryption-secret")
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    engine = create_engine("sqlite:///" + str(tmp_path / "formats.db"), connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    for router in (social.router, image_router.router, video_router.router, billing.router):
        application.include_router(router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    application.state.testing_session = Session
    monkeypatch.setattr(job_manager, "submit", lambda *_a, **_k: None)
    with job_manager._lock:
        before = set(job_manager._jobs)
    yield application
    with job_manager._lock:
        for job_id in set(job_manager._jobs) - before:
            job_manager._jobs.pop(job_id, None)
    image_router.STAGED_UPLOADS.clear()
    video_router.STAGED_UPLOADS.clear()
    engine.dispose()


def _register(client, username):
    response = register_verified(client, json={
        "email": f"{username}@example.com", "username": username,
        "password": PASSWORD, "accept_terms": True, "display_name": username,
    })
    assert response.status_code == 200, response.text
    return response.json()["user"]


def _csrf(client):
    return {"x-csrf-token": client.cookies.get("echo_csrf")}


@pytest.mark.parametrize("route", ["/api/video/process", "/api/image/process"])
def test_unknown_target_aspect_is_refused(app, route):
    with TestClient(app) as client:
        _register(client, "aspect_" + route.split("/")[2])
        response = client.post(
            route, data={"stage_id": "missing", "target_aspect": "4:3", "payment_source": "byok"},
            headers=_csrf(client),
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid target_aspect"


@needs_ffmpeg
def test_rotated_video_quotes_and_submits_at_display_dims(app, tmp_path, monkeypatch):
    monkeypatch.setenv("SX_CREDITS_ENABLED", "1")
    monkeypatch.setenv("FAL_KEY", "platform-fal-key")
    clip = rotated_video(tmp_path / "phone.mp4", "256x144", 90)
    params = {"upscale_only": True, "upscale_engine": "fal", "upscale_model": SEEDVR, "target_aspect": "1:1"}
    with TestClient(app) as client:
        user = _register(client, "rotated_quote")
        video_router.STAGED_UPLOADS["phone"] = (str(clip), time.time(), f"user:{user['id']}")
        with app.state.testing_session() as db:
            grant_credits(db, user["id"], 1000, source="purchase", idempotency_key="purchase:rotated-quote")
            db.commit()
        quoted = client.post(
            "/api/billing/quote", json={"kind": "video", "stage_id": "phone", "parameters": params},
            headers=_csrf(client),
        )
        assert quoted.status_code == 200, quoted.text
        stage = quoted.json()["stages"][0]["details"]
        # Shown portrait: the upscaler gets 1080 on the short side, 1920 tall.
        assert (stage["output_width"], stage["output_height"]) == (1080, 1920)

        submitted = []
        monkeypatch.setattr(job_manager, "submit", lambda job_id, fn, kwargs, **_k: submitted.append(kwargs))
        response = client.post(
            "/api/video/process",
            data={
                "stage_id": "phone", "upscale_only": "true", "upscale_engine": "fal",
                "upscale_model": SEEDVR, "target_aspect": "1:1",
                "payment_source": "credits", "quote_id": quoted.json()["quote_id"],
            },
            headers=_csrf(client),
        )
    # The submit re-probes display dims, so its fingerprint matches the quote's.
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "queued"
    assert submitted[0]["target_aspect"] == "1:1" and submitted[0]["upscale_only"] is True
