"""Uploads router — publish staged or pipeline-rendered media as reels.

Single-file flow backing the /upload page: the user either skips the
extender (already-square source, or a 3D stereo upload with one square per
eye) or renders through the image/video pipeline first, fills in title/caption/tags/location, and Shares. The
publish step copies the chosen file into output/uploads/ (the one folder
the Upload page owns) and writes real user metadata via
reels.upsert_upload_meta so the item appears in Explore + Reels with
zeroed engagement instead of fake seeded numbers.
"""

import os
import re
import shutil
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from pipeline.stereo_detect import eye_size, layout_matches
from server import media as SM
from server.jobs import JobStatus, job_manager
from server.social.auth import AuthContext, rate_limiter, require_auth_csrf, stage_owner_matches
from server.social.database import get_db
from server.social.services import MAX_POST_IMAGES, create_or_update_post, post_card

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

OUTPUT_DIR = Path("output")
UPLOAD_DIR = OUTPUT_DIR / "uploads"

_TITLE_MAX = 100
_CAPTION_MAX = 2200
_TAGS_MAX = 5
_TAG_RE = re.compile(r"^[a-z0-9_]{1,30}$")


class UploadLocation(BaseModel):
    city: str = ""
    country: str = ""
    display_name: str = ""
    lat: float | None = None
    lon: float | None = None
    osm_id: str | int | None = None


class PublishRequest(BaseModel):
    kind: Literal["image", "video"]
    title: str
    caption: str = ""
    tags: list[str] = []
    location: UploadLocation = UploadLocation()
    # Exactly one source pointer is required.
    stage_id: str | None = None
    job_id: str | None = None
    # More staged images for a multi-image (slideshow) post, after the cover
    # stage_id. Image posts only, published as-is (no extend pipeline).
    extra_stage_ids: list[str] = []
    # Stereoscopic layout of an as-is upload: "sbs" (full side-by-side, 2:1)
    # or "tb" (full top-bottom, 1:2). Every image of a slideshow must match.
    stereo_layout: Literal["mono", "sbs", "tb"] = "mono"

    @field_validator("title")
    @classmethod
    def _title_ok(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("title is required")
        if len(v) > _TITLE_MAX:
            raise ValueError(f"title must be ≤ {_TITLE_MAX} characters")
        return v

    @field_validator("caption")
    @classmethod
    def _caption_ok(cls, v: str) -> str:
        v = v or ""
        if len(v) > _CAPTION_MAX:
            raise ValueError(f"caption must be ≤ {_CAPTION_MAX} characters")
        return v

    @field_validator("tags")
    @classmethod
    def _tags_ok(cls, v: list[str]) -> list[str]:
        cleaned: list[str] = []
        for raw in v or []:
            t = str(raw or "").strip().lstrip("#").lower().replace(" ", "_")
            if not t:
                continue
            if not _TAG_RE.match(t):
                raise ValueError(
                    f"invalid tag {raw!r}: use 1-30 lowercase letters/numbers/_"
                )
            if t not in cleaned:
                cleaned.append(t)
        if len(cleaned) > _TAGS_MAX:
            raise ValueError(f"at most {_TAGS_MAX} tags")
        return cleaned


def _resolve_extra_images(
    req: "PublishRequest",
    request: Request,
    context: AuthContext,
) -> list[str]:
    """Validate and resolve a slideshow's extra staged images, in order."""
    extras = [stage_id for stage_id in req.extra_stage_ids if stage_id]
    if not extras:
        return []
    if req.kind != "image":
        raise HTTPException(status_code=400, detail="A video post holds exactly one video; images and videos cannot be mixed.")
    if req.job_id or not req.stage_id:
        raise HTTPException(status_code=400, detail="Multi-image posts are published as-is; extended images cannot be combined.")
    if len(extras) + 1 > MAX_POST_IMAGES:
        raise HTTPException(status_code=400, detail=f"An image post holds at most {MAX_POST_IMAGES} images.")
    if len(set(extras)) != len(extras) or req.stage_id in extras:
        raise HTTPException(status_code=400, detail="The same image was added twice.")
    return [_resolve_source("image", stage_id, None, request, context)[0] for stage_id in extras]


_STEREO_NAMES = {"sbs": "side-by-side (2:1)", "tb": "top-bottom (1:2)"}


def _check_stereo_pointer(req: "PublishRequest") -> None:
    """Stereo posts are published as-is: extended renders are always 2D."""
    if req.stereo_layout != "mono" and (req.job_id or not req.stage_id):
        raise HTTPException(
            status_code=422,
            detail="3D stereo posts are published as-is; extended renders are always 2D.",
        )


def _check_stereo_sources(req: "PublishRequest", sources: list[str]) -> None:
    """Every file of a stereo post must hold the layout: one square per eye."""
    layout = req.stereo_layout
    if layout == "mono":
        return
    for source in sources:
        info = SM.probe_media_info(source) or {}
        width, height = info.get("width"), info.get("height")
        if not layout_matches(layout, width, height):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"3D {_STEREO_NAMES[layout]} needs an exact "
                    f"{'2:1' if layout == 'sbs' else '1:2'} frame with one square per eye; "
                    f"got {width or '?'}x{height or '?'}."
                ),
            )
        eye_w, eye_h = eye_size(layout, width, height)
        if eye_w < 64 or eye_h < 64:
            raise HTTPException(status_code=422, detail="3D stereo frames need at least 64x64 per eye.")


def _derived_files(stored: Path) -> list[Path]:
    """Every generated sibling a stored upload can own (cleanup on failure)."""
    mono = SM.mono_sibling_path(str(stored))
    return [
        stored,
        SM.explore_preview_path(str(stored)),
        SM.explore_poster_path(str(stored)),
        stored.with_name(stored.stem + "-preview.mp4"),
        mono,
        SM.explore_preview_path(str(mono)),
        SM.explore_poster_path(str(mono)),
    ]


# Stereo video encodes (left-eye rendition, VR proxy, grid assets) can take
# minutes, so publish hands them to one background worker. Until the 2D
# rendition lands the post serves stereo_crop (CSS crop of the raw file).
_stereo_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stereo-assets")


def _submit_stereo_assets(fn) -> Future:
    return _stereo_pool.submit(fn)


def _build_stereo_video_assets(dest: Path, layout: str) -> None:
    """Background: every derived asset of a published stereo video."""
    from server.routers import reels as reels_router

    mono = SM.make_left_eye_rendition(str(dest), layout)
    try:
        SM.make_web_preview(str(dest), stereo=layout)
    except Exception:
        pass
    if mono:
        for make in (SM.make_explore_preview, SM.make_explore_poster):
            try:
                make(mono)
            except Exception:
                pass
    reels_router.invalidate_scan_cache()


def _slugify(text: str, fallback: str = "upload") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (slug[:60] or fallback)


def _resolve_source(
    kind: str,
    stage_id: str | None,
    job_id: str | None,
    request: Request,
    context: AuthContext,
) -> tuple[str, str]:
    """Return (source_path, original_filename) for exactly one pointer."""
    if bool(stage_id) == bool(job_id):
        raise HTTPException(
            status_code=400,
            detail="Provide exactly one of stage_id (skip-extend) or job_id (extended).",
        )
    if job_id:
        rec = job_manager.get_job(job_id)
        if not rec or rec.status != JobStatus.COMPLETE or not rec.result:
            raise HTTPException(status_code=400, detail="job_id has no completed result")
        # Paid (cloud) jobs carry an owner — cross-user publish is forbidden.
        # Owner-less free/local jobs keep the legacy behavior (12-hex
        # unguessable job_id + completed-result requirement).
        if rec.owner_id and rec.owner_id != context.user.id:
            raise HTTPException(status_code=403, detail="job_id does not belong to this account")
        worker_path = rec.result.get("path")
        if not worker_path or not Path(worker_path).is_file():
            raise HTTPException(status_code=400, detail="job result file is missing")
        return worker_path, Path(worker_path).name
    # Staged skip-extend path: look in both routers' staging maps.
    from server.routers import image as image_router
    from server.routers import video as video_router

    staged = image_router.STAGED_UPLOADS.get(stage_id or "")
    if staged is None:
        staged = video_router.STAGED_UPLOADS.get(stage_id or "")
    if staged is None:
        raise HTTPException(status_code=400, detail="Invalid or expired stage_id")
    staged_owner = staged[2] if len(staged) > 2 else None
    if not stage_owner_matches(staged_owner, request, context):
        raise HTTPException(status_code=403, detail="stage_id does not belong to this account")
    src_path = staged[0]
    if not Path(src_path).is_file():
        raise HTTPException(status_code=400, detail="Staged file is missing")
    staged_ext = Path(src_path).suffix.lstrip(".").lower()
    allowed = SM.IMAGE_EXTS if kind == "image" else SM.VIDEO_EXTS
    if staged_ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Staged file is .{staged_ext}, expected {'image' if kind == 'image' else 'video'}",
        )
    return src_path, Path(src_path).name


@router.post("/publish")
def publish_upload(
    req: PublishRequest,
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    """Copy the chosen file into output/uploads/ and create an owned post."""
    from server.routers import reels as reels_router

    try:
        hourly_cap = max(1, int(os.environ.get("SX_PUBLISH_HOURLY_MAX", "5")))
    except (TypeError, ValueError):
        hourly_cap = 5
    try:
        daily_cap = max(1, int(os.environ.get("SX_PUBLISH_DAILY_MAX", "20")))
    except (TypeError, ValueError):
        daily_cap = 20
    rate_limiter.check(db, f"publish-hour:{context.user.id}", hourly_cap, 60 * 60)
    rate_limiter.check(db, f"publish-day:{context.user.id}", daily_cap, 24 * 60 * 60)
    _check_stereo_pointer(req)
    src_path, _orig = _resolve_source(req.kind, req.stage_id, req.job_id, request, context)
    extra_sources = _resolve_extra_images(req, request, context)
    _check_stereo_sources(req, [src_path, *extra_sources])
    stereo = req.stereo_layout if req.stereo_layout != "mono" else None
    src_ext = Path(src_path).suffix.lstrip(".").lower() or ("png" if req.kind == "image" else "mp4")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    base_name = f"{_slugify(req.title)}-{stamp}-{uuid.uuid4().hex[:6]}"
    dest = UPLOAD_DIR / f"{base_name}.{src_ext}"
    extra_dests = [
        UPLOAD_DIR / f"{base_name}-{index}.{Path(extra).suffix.lstrip('.').lower() or 'png'}"
        for index, extra in enumerate(extra_sources, start=2)
    ]
    copied: list[Path] = []
    try:
        for source, target in [(src_path, dest), *zip(extra_sources, extra_dests)]:
            shutil.copy2(source, target)
            copied.append(target)
    except OSError as ex:
        for target in copied:
            target.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Could not store upload: {ex}") from ex

    # Stereo stills: every 2D surface shows the left-eye rendition, so the
    # post is only created once each stored image has one (a fast PIL crop).
    # Stereo videos encode theirs in the background after the post exists.
    if stereo and req.kind == "image":
        for target in (dest, *extra_dests):
            if not SM.make_left_eye_rendition(str(target), stereo):
                for stored in (dest, *extra_dests):
                    for candidate in _derived_files(stored):
                        Path(candidate).unlink(missing_ok=True)
                raise HTTPException(status_code=500, detail="Could not build the 2D view of this 3D upload.")
    # 2D posters/previews come from the left eye of a stereo upload.
    def grid_source(stored: Path) -> str:
        return str(SM.mono_sibling_path(str(stored))) if stereo else str(stored)

    stereo_video = bool(stereo) and req.kind == "video"

    for extra_dest in extra_dests:
        try:
            SM.make_image_poster(grid_source(extra_dest))
        except Exception:
            pass

    preview_url: str | None = None
    poster_url: str | None = None
    root = OUTPUT_DIR.resolve()
    try:
        if stereo_video:
            # Only the poster now (one frame, cropped to the left eye); the
            # background job builds the rendition and its grid assets.
            try:
                poster = SM.make_explore_poster(str(dest), crop=SM.left_eye_crop(stereo))
                if poster:
                    poster_url = f"/media/{Path(poster).resolve().relative_to(root).as_posix()}"
            except Exception:
                pass
        elif req.kind == "video":
            try:
                SM.make_web_preview(str(dest), stereo=stereo)
            except Exception:
                pass
            try:
                preview = SM.make_explore_preview(grid_source(dest))
                if preview:
                    preview_url = f"/media/{Path(preview).resolve().relative_to(root).as_posix()}"
            except Exception:
                pass
            try:
                poster = SM.make_explore_poster(grid_source(dest))
                if poster:
                    poster_url = f"/media/{Path(poster).resolve().relative_to(root).as_posix()}"
            except Exception:
                pass
        else:
            try:
                poster = SM.make_image_poster(grid_source(dest))
                if poster:
                    poster_url = f"/media/{Path(poster).resolve().relative_to(root).as_posix()}"
            except Exception:
                pass
    except ValueError:
        pass

    try:
        rel = dest.resolve().relative_to(root).as_posix()
    except (OSError, ValueError) as ex:
        raise HTTPException(status_code=500, detail=f"Could not resolve upload path: {ex}") from ex

    # Auto-merge #hashtags found in the caption into the tag list.
    caption_tags = [t.lower() for t in re.findall(r"#([A-Za-z0-9_]{1,30})", req.caption or "")]
    tags = list(req.tags)
    for t in caption_tags:
        if t not in tags and len(tags) < _TAGS_MAX:
            tags.append(t)

    loc = req.location
    try:
        post = create_or_update_post(
            db,
            media_path=rel,
            media_type=req.kind,
            owner=context.user,
            title=req.title.strip(),
            caption=(req.caption or "").strip(),
            tags=tags,
            location={
                "city": (loc.city or "").strip(),
                "country": (loc.country or "").strip(),
                "display_name": (loc.display_name or "").strip(),
                "lat": loc.lat,
                "lon": loc.lon,
                "osm_id": str(loc.osm_id) if loc.osm_id is not None else None,
            },
            source="extended" if req.job_id else "upload",
            slide_paths=[target.resolve().relative_to(root).as_posix() for target in extra_dests] if req.kind == "image" else None,
            stereo_layout=req.stereo_layout,
        )
        db.commit()
        db.refresh(post)
    except Exception as ex:
        db.rollback()
        for stored in (dest, *extra_dests):
            for candidate in _derived_files(stored):
                try:
                    Path(candidate).unlink(missing_ok=True)
                except OSError:
                    pass
        if isinstance(ex, ValueError):
            raise HTTPException(status_code=400, detail=str(ex)) from ex
        raise

    if stereo_video:
        _submit_stereo_assets(lambda: _build_stereo_video_assets(dest, stereo))
    reels_router.invalidate_scan_cache()
    entry = post_card(post, db, context.user.id)
    return {
        "post_id": post.id,
        "rel_path": rel,
        "media_url": f"/media/{rel}",
        "media_type": req.kind,
        "preview_url": preview_url,
        "poster_url": poster_url,
        "meta": entry,
    }
