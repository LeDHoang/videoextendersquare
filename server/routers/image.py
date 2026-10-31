"""Image processing router — upload, job creation, SSE progress, and downloads."""

import os
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from pipeline.image_worker import process_image
from pipeline.stereo_detect import detect_stereo
from core import models as _models
from server.billing.parameters import image_parameters
from server.billing.runtime import failure_callback, lifecycle_callback, resolve_fal_key, success_callback
from server.billing.service import BillingError, create_billing_job, finalize_job_failure, require_billing_secrets, stage_fingerprint
from pipeline.utils import calculate_square_padding, get_image_dimensions, shown_image_size
from server import media as SM
from server import output
from server import quotas
from server.jobs import JobStatus, QueueFull, job_manager, public_result
from server.sse import job_progress_stream
from server.social.auth import AuthContext, get_optional_auth, require_auth_csrf, stage_owner_identity, stage_owner_matches, validate_origin
from server.social.database import get_db
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

router = APIRouter(prefix="/api/image", tags=["image"])

# stage_id -> (path, staged_at). See video.py's identical pattern.
STAGED_UPLOADS: dict[str, tuple[str, float, str]] = {}
STAGE_TTL_S = 6 * 3600


def cleanup_stale_uploads() -> int:
    now = time.time()
    stale = [sid for sid, entry in STAGED_UPLOADS.items() if now - entry[1] > STAGE_TTL_S]
    for sid in stale:
        entry = STAGED_UPLOADS.pop(sid, None)
        path = entry[0] if entry else None
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except OSError:
                pass
    return len(stale)


@router.post("/upload")
def upload_image(
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    """Stage an uploaded image file and return its metadata.

    Signed-in only and counted against the hourly upload budget. Streams
    straight to disk in chunks (no full-body buffering in RAM) and
    enforces the extension allowlist + size cap while doing so. Plain `def`,
    not `async def` — see the identical note on video.py's upload_video for
    why (blocking I/O needs FastAPI's worker-thread dispatch).
    """
    validate_origin(request)
    quotas.check_upload_rate(db, context)
    stage_id = uuid.uuid4().hex[:10]
    try:
        dest_path, size_bytes = SM.stage_upload_stream(
            file.filename or "upload.png", file.file,
            SM.IMAGE_EXTS, SM.max_image_upload_bytes(),
        )
    except SM.UploadRejected as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except SM.StagingFull as ex:
        raise quotas.storage_full_error(str(ex)) from ex

    STAGED_UPLOADS[stage_id] = (dest_path, time.time(), stage_owner_identity(request, response, context))

    try:
        w, h = get_image_dimensions(dest_path)
    except ValueError as ex:
        STAGED_UPLOADS.pop(stage_id, None)
        try:
            os.unlink(dest_path)
        except OSError:
            pass
        raise HTTPException(status_code=413, detail=f"Image dimensions are too large: {ex}") from ex
    top, bottom, left, right = calculate_square_padding(w, h)
    orientation = "LANDSCAPE" if w > h else ("PORTRAIT" if h > w else "SQUARE")
    # Stereo layout follows the still as shown (EXIF orientation applied).
    shown_w, shown_h = shown_image_size(dest_path, w, h)

    return {
        "stage_id": stage_id,
        "filename": file.filename,
        "size_bytes": size_bytes,
        "width": w,
        "height": h,
        "orientation": orientation,
        "padding": {"top": top, "bottom": bottom, "left": left, "right": right},
        # See video.py: exact 2:1 / 1:2 stills may be SBS / top-bottom stereo.
        "stereo": detect_stereo(dest_path, shown_w, shown_h, kind="image"),
    }


@router.post("/process")
def start_image_process(
    request: Request,
    stage_id: str = Form(...),
    prompt: str = Form(""),
    upscale_only: bool = Form(False),
    sharpening: float = Form(0.0),
    upscale_engine: str = Form("fast"),
    upscale_model: str = Form("fal-ai/clarity-upscaler"),
    outpaint_model: str = Form("fal-ai/image-apps-v2/outpaint"),
    custom_outpaint_args: str = Form("{}"),
    custom_upscale_args: str = Form("{}"),
    payment_source: str = Form("credits"),
    quote_id: str | None = Form(None),
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    """Start an image job for a signed-in user.

    Every job takes a slot under the queue caps (429 QUEUE_FULL) before any
    billing; Fal-backed work additionally needs an owned billing record.
    """
    validate_origin(request)
    try:
        custom_outpaint = _models.parse_custom_args(custom_outpaint_args)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=f"Invalid custom_outpaint_args: {ex}") from ex
    try:
        custom_upscale = _models.parse_custom_args(custom_upscale_args)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=f"Invalid custom_upscale_args: {ex}") from ex
    staged = STAGED_UPLOADS.get(stage_id)
    src_path = staged[0] if staged else None
    if not src_path or not os.path.exists(src_path):
        raise HTTPException(status_code=400, detail="Invalid or expired stage_id")
    # A foreign stage gets the same error as a missing one (no oracle).
    if not stage_owner_matches(staged[2] if len(staged) > 2 else None, request, context):
        raise HTTPException(status_code=400, detail="Invalid or expired stage_id")

    width, height = get_image_dimensions(src_path)
    submit_fingerprint = stage_fingerprint(src_path, width=width, height=height)
    cloud_required = ((not upscale_only) and width != height) or upscale_engine.casefold() == "fal"
    params = image_parameters({
        "prompt": prompt,
        "upscale_only": upscale_only,
        "sharpening": sharpening,
        "upscale_engine": upscale_engine,
        "upscale_model": upscale_model,
        "outpaint_model": outpaint_model,
        "custom_outpaint_args": custom_outpaint,
        "custom_upscale_args": custom_upscale,
    })

    owner_id = context.user.id
    fal_key = None
    lifecycle = None
    on_success = None
    on_failure = None
    # Take a queue slot before any billing; every exit below that does not
    # hand the job to the executor gives the slot back.
    try:
        job_id = job_manager.reserve_job(kind="image", owner_id=owner_id)
    except QueueFull as ex:
        raise quotas.queue_full_error(ex) from ex
    try:
        if cloud_required:
            try:
                require_billing_secrets()
                fal_key = resolve_fal_key(db, user_id=owner_id, payment_source=payment_source)
                stage_specs = []
                if not upscale_only and width != height:
                    stage_specs.append(("outpaint", params["outpaint_model"]))
                if params["upscale_engine"] == "fal":
                    stage_specs.append(("upscale", params["upscale_model"]))
                create_billing_job(
                    db,
                    user_id=owner_id,
                    job_id=job_id,
                    kind="image",
                    payment_source=payment_source,
                    stage_id=stage_id,
                    params=params,
                    quote_id=quote_id,
                    stage_specs=stage_specs,
                    fingerprint=submit_fingerprint,
                )
            except BillingError as ex:
                db.rollback()
                code = getattr(ex, "code", "")
                status = 402 if code == "INSUFFICIENT_CREDITS" else 503 if code == "BILLING_MISCONFIGURED" else 409
                raise HTTPException(status_code=status, detail={"code": code or "BILLING_ERROR", "message": str(ex)}) from ex
            except IntegrityError as ex:
                # Same-job retry raced the first submit: the winner owns the
                # reservation — report a conflict, not a 500.
                db.rollback()
                raise HTTPException(status_code=409, detail={"code": "BILLING_CONFLICT", "message": "This job was already submitted."}) from ex
            lifecycle = lifecycle_callback(job_id)
            on_success = success_callback(job_id)
            on_failure = failure_callback(job_id)
    except BaseException:
        job_manager.discard_job(job_id)
        raise

    kwargs = {
        "image_source": src_path,
        "prompt": params["prompt"],
        "fal_key": fal_key,
        "upscale_only": params["upscale_only"],
        "sharpening": params["sharpening"],
        "upscale_engine": params["upscale_engine"],
        "upscale_model": params["upscale_model"],
        "outpaint_model": params["outpaint_model"],
        "custom_outpaint_args": params["custom_outpaint_args"],
        "custom_upscale_args": params["custom_upscale_args"],
        "billing_callback": lifecycle,
    }

    def postprocess(raw):
        outpaint_url, worker_path = raw
        rec = output.persist(worker_path, "image", job_id)
        rec["outpaint_url"] = outpaint_url
        rec["download_url"] = f"/api/image/jobs/{job_id}/download"
        return rec

    try:
        job_manager.submit(
            job_id,
            process_image,
            kwargs,
            postprocess=postprocess,
            on_success=on_success,
            on_failure=on_failure,
        )
    except Exception as exc:
        job_manager.discard_job(job_id)
        if cloud_required:
            finalize_job_failure(db, job_id, error_code="enqueue_failed")
        message = "Processing could not be queued."
        if cloud_required and payment_source.casefold() == "credits":
            message += " Reserved credits were released."
        raise HTTPException(
            status_code=503,
            detail={"code": "JOB_ENQUEUE_FAILED", "message": message},
        ) from exc
    return {"job_id": job_id, "status": "queued", "payment_source": payment_source if cloud_required else "local"}


def _owned_job(job_id: str, context: AuthContext | None):
    rec = job_manager.get_job(job_id)
    if not rec or (rec.owner_id and (context is None or rec.owner_id != context.user.id)):
        raise HTTPException(status_code=404, detail="Job not found")
    return rec


@router.get("/jobs/{job_id}")
def get_job_status(job_id: str, context: AuthContext | None = Depends(get_optional_auth)):
    """Get snapshot of job status and progress."""
    rec = _owned_job(job_id, context)

    return {
        "job_id": rec.job_id,
        "kind": rec.kind,
        "status": rec.status.value,
        "phase": rec.phase,
        "progress": rec.progress,
        "elapsed": rec.elapsed,
        "messages": list(rec.messages),
        "result": public_result(rec.result),
        "error": rec.error,
    }


@router.post("/jobs/{job_id}/cancel", status_code=202)
def cancel_image_job(job_id: str, request: Request, context: AuthContext = Depends(require_auth_csrf)):
    """Cancel the caller's job: at once while queued, else before its next stage."""
    validate_origin(request)
    rec = job_manager.get_job(job_id)
    if not rec or rec.kind != "image" or rec.owner_id != context.user.id:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job_manager.cancel(job_id):
        raise HTTPException(status_code=409, detail={"code": "JOB_FINISHED", "message": "This job has already finished."})
    return {"job_id": job_id, "status": rec.status.value}


# Not async: a job missing from memory is read back from R2 (blocking).
@router.get("/jobs/{job_id}/stream")
def stream_job_progress(
    job_id: str, request: Request, context: AuthContext | None = Depends(get_optional_auth)
):
    """SSE endpoint streaming job progress in real time."""
    rec = _owned_job(job_id, context)

    return EventSourceResponse(job_progress_stream(request, rec))


@router.get("/jobs/{job_id}/result")
def get_job_result(job_id: str, context: AuthContext | None = Depends(get_optional_auth)):
    """Get the completed job's result metadata and download URLs."""
    rec = _owned_job(job_id, context)
    return {
        "job_id": rec.job_id,
        "kind": rec.kind,
        "status": rec.status.value,
        "phase": rec.phase,
        "elapsed": rec.elapsed,
        "result": public_result(rec.result),
        "error": rec.error,
    }


@router.get("/jobs/{job_id}/download")
def download_image(job_id: str, context: AuthContext | None = Depends(get_optional_auth)):
    """Download the completed job's result (jailed to the job directory)."""
    rec = _owned_job(job_id, context)
    if rec.status != JobStatus.COMPLETE or not rec.result:
        raise HTTPException(status_code=404, detail="No completed result for this job")

    p = Path(rec.result["path"]).resolve()
    if not p.is_relative_to(output.job_dir(job_id).resolve()):
        raise HTTPException(status_code=400, detail="Invalid result path")
    if not output.fetch(job_id, p):
        raise HTTPException(status_code=404, detail="File not found")
    media_type = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(path=str(p), media_type=media_type, filename=p.name)