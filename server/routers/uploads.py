"""Uploads router — publish staged or pipeline-rendered media as reels.

Single-file flow backing the /upload page: the user either skips the
extender (already-square source) or renders through the image/video
pipeline first, fills in title/caption/tags/location, and Shares. The
publish step copies the chosen file into output/uploads/ (the one folder
the Upload page owns) and writes real user metadata via
reels.upsert_upload_meta so the item appears in Explore + Reels with
zeroed engagement instead of fake seeded numbers.
"""

import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from server import media as SM
from server.jobs import JobStatus, job_manager

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


def _slugify(text: str, fallback: str = "upload") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (slug[:60] or fallback)


def _resolve_source(kind: str, stage_id: str | None, job_id: str | None) -> tuple[str, str]:
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
def publish_upload(req: PublishRequest):
    """Copy the chosen file into output/uploads/ and attach real metadata."""
    from server.routers import reels as reels_router

    src_path, _orig = _resolve_source(req.kind, req.stage_id, req.job_id)
    src_ext = Path(src_path).suffix.lstrip(".").lower() or ("png" if req.kind == "image" else "mp4")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = UPLOAD_DIR / f"{_slugify(req.title)}-{stamp}-{uuid.uuid4().hex[:6]}.{src_ext}"
    try:
        shutil.copy2(src_path, dest)
    except OSError as ex:
        raise HTTPException(status_code=500, detail=f"Could not store upload: {ex}") from ex

    preview_url: str | None = None
    poster_url: str | None = None
    root = OUTPUT_DIR.resolve()
    try:
        if req.kind == "video":
            try:
                SM.make_web_preview(str(dest))
            except Exception:
                pass
            try:
                preview = SM.make_explore_preview(str(dest))
                if preview:
                    preview_url = f"/media/{Path(preview).resolve().relative_to(root).as_posix()}"
            except Exception:
                pass
            try:
                poster = SM.make_explore_poster(str(dest))
                if poster:
                    poster_url = f"/media/{Path(poster).resolve().relative_to(root).as_posix()}"
            except Exception:
                pass
        else:
            try:
                poster = SM.make_image_poster(str(dest))
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
    entry = reels_router.upsert_upload_meta(rel, {
        "title": req.title.strip(),
        "caption": (req.caption or "").strip(),
        "tags": tags,
        "location": {
            "city": (loc.city or "").strip(),
            "country": (loc.country or "").strip(),
            "display_name": (loc.display_name or "").strip(),
            "lat": loc.lat,
            "lon": loc.lon,
            "osm_id": str(loc.osm_id) if loc.osm_id is not None else None,
        },
        "author_name": "local_user",
        "source": "extended" if req.job_id else "upload",
    })

    return {
        "rel_path": rel,
        "media_url": f"/media/{rel}",
        "media_type": req.kind,
        "preview_url": preview_url,
        "poster_url": poster_url,
        "meta": entry,
    }
