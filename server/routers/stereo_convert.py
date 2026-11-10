"""MAKE 3D — turn a square 2D upload or extend render into a side-by-side
stereo (2:1) result with the local W8T converter (pipeline/spatial_worker.py).

The job is an ordinary image/video job: progress, cancel, result and download
use the /api/{kind}/jobs/{id} routes, and publish takes its job_id with
stereo_layout "sbs" (uploads._check_stereo_pointer). Free and local, but it
takes a queue slot like any job. Off unless SX_STEREO_CONVERT_ENABLED is set
and the depth model's packages are installed (requirements-3d.txt).

depth_pack asks for the spatial version instead: colour | nearness grey
(layout "sbsd"), which Upload Studio makes for every square upload and
publish stores beside the 2D file (uploads spatial_job_ids). It has its own
switch, SX_SPATIAL_DEFAULT_ENABLED (on by default), and its own rate bucket.
"""

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from pipeline import spatial_worker as sw
from server import media as SM
from server import kill_switch, output, quotas, trust, upload_log
from server.features import feature_enabled, stereo_convert_installed
from server.jobs import QueueFull, job_manager
from server.routers.uploads import _resolve_source
from server.social.auth import AuthContext, require_auth_csrf, validate_origin
from server.social.database import get_db
from server.social.services import MAX_POST_IMAGES

router = APIRouter(prefix="/api/stereo", tags=["stereo"])

CONVERTS_PER_HOUR = 10


class ConvertRequest(BaseModel):
    kind: Literal["image", "video"]
    # Exactly one: a staged square upload or a finished extend job.
    stage_id: str | None = None
    job_id: str | None = None
    # The spatial version (colour + depth, layout "sbsd") instead of a baked right eye.
    depth_pack: bool = False


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
    if req.depth_pack:
        enabled = feature_enabled("SX_SPATIAL_DEFAULT_ENABLED")
    else:
        enabled = feature_enabled("SX_STEREO_CONVERT_ENABLED", default=False)
    if not enabled:
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

    kill_switch.require_open(db, paid=False)
    if req.depth_pack:
        # One spatial job per published slide, so the cap follows the publish cap.
        cap = trust.limit(db, context.user, "publish_hourly") * MAX_POST_IMAGES
        quotas.check_identity(db, request, context, "spatial", cap, 60 * 60)
    else:
        quotas.check_identity(db, request, context, "stereo-convert", CONVERTS_PER_HOUR, 60 * 60)
    try:
        job_id = job_manager.reserve_job(
            kind=req.kind, owner_id=context.user.id, max_per_user=trust.limit(db, context.user, "jobs_per_user"),
        )
    except QueueFull as ex:
        raise quotas.queue_full_error(ex) from ex

    layout = "sbsd" if req.depth_pack else "sbs"
    out_path = str(output.job_dir(job_id) / f"{layout}.{'mp4' if req.kind == 'video' else 'jpg'}")
    if req.kind == "video":
        # The spatial version is VR-only (Quest decodes HEVC), so it takes
        # HEVC: about half the bytes of H.264 at the same quality.
        fn, kwargs = sw.process_video_spatial, {
            "video_path": src_path, "output_path": out_path, "depth_pack": req.depth_pack,
            "codec": "hevc" if req.depth_pack else "h264"}
    else:
        fn, kwargs = sw.process_image_spatial, {
            "image_path": src_path, "output_path": out_path, "depth_pack": req.depth_pack}

    def postprocess(raw):
        worker_path, metrics = raw
        rec = output.persist(worker_path, req.kind, job_id)
        rec["metrics"] = metrics
        rec["stereo_layout"] = layout
        # Publish checks a spatial version belongs to the file it publishes.
        rec["converted_from"] = {"stage_id": req.stage_id, "job_id": req.job_id}
        # A video master is already H.264 within the stereo cap, so it is its own browser preview.
        rec["download_url"] = f"/api/{req.kind}/jobs/{job_id}/download"
        return rec

    # The upload's trace: a staged file's own, or the one of the extend job it came from.
    trace_id = req.stage_id or upload_log.trace_for_job(req.job_id)
    # Its events are spatial_* / convert_*, so they never move the upload's status (upload_log.job_finished).
    events = "spatial" if req.depth_pack else "convert"
    upload_log.link_job(job_id, trace_id, events=events)
    upload_log.record(trace_id, f"{events}_queued", kind=req.kind, job_id=job_id, user_id=context.user.id,
                      source_stage_id=req.stage_id, source_job_id=req.job_id)
    try:
        job_manager.submit(job_id, fn, kwargs, postprocess=postprocess)
    except Exception as exc:
        job_manager.discard_job(job_id)
        upload_log.record(trace_id, f"{events}_error", job_id=job_id, error=repr(exc))
        raise HTTPException(
            status_code=503,
            detail={"code": "JOB_ENQUEUE_FAILED", "message": "Processing could not be queued."},
        ) from exc
    return {"job_id": job_id, "status": "queued", "kind": req.kind, "payment_source": "local"}
