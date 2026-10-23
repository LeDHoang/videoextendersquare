"""MAKE 3D — turn a square 2D upload or extend render into a side-by-side
stereo (2:1) result with the local W8T converter (pipeline/spatial_worker.py).

The job is an ordinary image/video job: progress, cancel, result and download
use the /api/{kind}/jobs/{id} routes, and publish takes its job_id with
stereo_layout "sbs" (uploads._check_stereo_pointer). Free and local, but it
takes a queue slot like any job. Off unless SX_STEREO_CONVERT_ENABLED is set
and the depth model's packages are installed (requirements-3d.txt).
"""

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from pipeline import spatial_worker as sw
from server import media as SM
from server import output, quotas
from server.features import feature_enabled, stereo_convert_installed
from server.jobs import QueueFull, job_manager
from server.routers.uploads import _resolve_source
from server.social.auth import AuthContext, rate_limiter, require_auth_csrf, validate_origin
from server.social.database import get_db

router = APIRouter(prefix="/api/stereo", tags=["stereo"])

CONVERTS_PER_HOUR = 10


class ConvertRequest(BaseModel):
    kind: Literal["image", "video"]
    # Exactly one: a staged square upload or a finished extend job.
    stage_id: str | None = None
    job_id: str | None = None


def _reject(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=400, detail={"code": code, "message": message})


@router.post("/convert")
def convert_to_3d(
    req: ConvertRequest,
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    """Queue a 2D-to-3D conversion of one square image or video (≤ 60 s)."""
    if not feature_enabled("SX_STEREO_CONVERT_ENABLED", default=False):
        raise HTTPException(status_code=404, detail="Not Found")
    if not stereo_convert_installed():
        raise HTTPException(
            status_code=503,
            detail={"code": "STEREO_CONVERT_UNAVAILABLE", "message": "3D conversion is not installed on this server."},
        )
    validate_origin(request)
    src_path, _name = _resolve_source(req.kind, req.stage_id, req.job_id, request, context)
    # A job_id is not checked against kind by _resolve_source (a staged file is).
    if Path(src_path).suffix.lstrip(".").lower() not in (SM.IMAGE_EXTS if req.kind == "image" else SM.VIDEO_EXTS):
        raise _reject("WRONG_KIND", f"This file is not {'an image' if req.kind == 'image' else 'a video'}.")

    info = SM.probe_media_info(src_path) or {}
    width, height = info.get("width"), info.get("height")
    if not width or not height:
        raise _reject("UNREADABLE_SOURCE", "This file could not be read.")
    if width != height:
        # A square frame is never a stereo pair here (those are exactly 2:1 or 1:2).
        raise _reject("NOT_SQUARE", f"MAKE 3D needs a square (1:1) source; got {width}x{height}. Extend it first.")
    rw, _rh, crop = sw.eye_geometry(width, height)
    if rw - 2 * crop < 64:
        raise _reject("TOO_SMALL", "MAKE 3D needs a source of at least 68x68.")
    if req.kind == "video" and not 0 < (info.get("duration_ms") or 0) <= sw.MAX_VIDEO_SECONDS * 1000:
        raise _reject("SOURCE_TOO_LONG", f"MAKE 3D takes videos up to {sw.MAX_VIDEO_SECONDS}s.")

    rate_limiter.check(db, f"stereo-convert:{context.user.id}", CONVERTS_PER_HOUR, 60 * 60)
    try:
        job_id = job_manager.reserve_job(kind=req.kind, owner_id=context.user.id)
    except QueueFull as ex:
        raise quotas.queue_full_error(ex) from ex

    out_path = str(output.job_dir(job_id) / ("sbs.mp4" if req.kind == "video" else "sbs.jpg"))
    if req.kind == "video":
        fn, kwargs = sw.process_video_spatial, {"video_path": src_path, "output_path": out_path}
    else:
        fn, kwargs = sw.process_image_spatial, {"image_path": src_path, "output_path": out_path}

    def postprocess(raw):
        worker_path, metrics = raw
        rec = output.persist(worker_path, req.kind, job_id)
        rec["metrics"] = metrics
        rec["stereo_layout"] = "sbs"
        # A video master is already H.264 within the stereo cap, so it is its own browser preview.
        rec["download_url"] = f"/api/{req.kind}/jobs/{job_id}/download"
        return rec

    try:
        job_manager.submit(job_id, fn, kwargs, postprocess=postprocess)
    except Exception as exc:
        job_manager.discard_job(job_id)
        raise HTTPException(
            status_code=503,
            detail={"code": "JOB_ENQUEUE_FAILED", "message": "Processing could not be queued."},
        ) from exc
    return {"job_id": job_id, "status": "queued", "kind": req.kind, "payment_source": "local"}
