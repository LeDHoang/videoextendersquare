"""Image processing router — upload, job creation, SSE progress, and downloads."""

import os
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from pipeline.image_worker import process_image
from core import models as _models
from server.billing.parameters import image_parameters
from server.billing.runtime import failure_callback, lifecycle_callback, resolve_fal_key, success_callback
from server.billing.service import BillingError, create_billing_job, finalize_job_failure
from pipeline.utils import calculate_square_padding, get_image_dimensions
from server import media as SM
from server import output
from server.jobs import JobStatus, job_manager
from server.sse import job_progress_stream
from server.social.auth import AuthContext, get_optional_auth, validate_csrf, validate_origin
from server.social.database import get_db
from sqlalchemy.orm import Session

router = APIRouter(prefix="/api/image", tags=["image"])

# stage_id -> (path, staged_at). See video.py's identical pattern.
STAGED_UPLOADS: dict[str, tuple[str, float]] = {}
STAGE_TTL_S = 6 * 3600


def cleanup_stale_uploads() -> int:
    now = time.time()
    stale = [sid for sid, (_, ts) in STAGED_UPLOADS.items() if now - ts > STAGE_TTL_S]
    for sid in stale:
        path, _ = STAGED_UPLOADS.pop(sid, (None, None))
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except OSError:
                pass
    return len(stale)


@router.post("/upload")
def upload_image(file: UploadFile = File(...)):
    """Stage an uploaded image file and return its metadata.

    Streams straight to disk in chunks (no full-body buffering in RAM) and
    enforces the extension allowlist + size cap while doing so. Plain `def`,
    not `async def` — see the identical note on video.py's upload_video for
    why (blocking I/O needs FastAPI's worker-thread dispatch).
    """
    stage_id = uuid.uuid4().hex[:10]
    try:
        dest_path, size_bytes = SM.stage_upload_stream(
            file.filename or "upload.png", file.file,
            SM.IMAGE_EXTS, SM.MAX_IMAGE_UPLOAD_BYTES,
        )
    except SM.UploadRejected as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex

    STAGED_UPLOADS[stage_id] = (dest_path, time.time())

    w, h = get_image_dimensions(dest_path)
    top, bottom, left, right = calculate_square_padding(w, h)
    orientation = "LANDSCAPE" if w > h else ("PORTRAIT" if h > w else "SQUARE")

    return {
        "stage_id": stage_id,
        "filename": file.filename,
        "size_bytes": size_bytes,
        "width": w,
        "height": h,
        "orientation": orientation,
        "padding": {"top": top, "bottom": bottom, "left": left, "right": right},
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
    context: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    """Start an image job; Fal-backed work requires an owned billing record."""
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

    width, height = get_image_dimensions(src_path)
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

    owner_id = None
    fal_key = None
    job_id = uuid.uuid4().hex[:12]
    lifecycle = None
    on_success = None
    on_failure = None
    if cloud_required:
        if context is None:
            raise HTTPException(status_code=401, detail={"code": "AUTH_REQUIRED", "message": "Sign in for cloud processing."})
        validate_origin(request)
        validate_csrf(request, context)
        owner_id = context.user.id
        try:
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
            )
        except BillingError as ex:
            db.rollback()
            status = 402 if getattr(ex, "code", "") == "INSUFFICIENT_CREDITS" else 409
            raise HTTPException(status_code=status, detail={"code": getattr(ex, "code", "BILLING_ERROR"), "message": str(ex)}) from ex
        lifecycle = lifecycle_callback(job_id)
        on_success = success_callback(job_id)
        on_failure = failure_callback(job_id)

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
        job_manager.create_job(kind="image", owner_id=owner_id, job_id=job_id)
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
        "result": rec.result,
        "error": rec.error,
    }


@router.get("/jobs/{job_id}/stream")
async def stream_job_progress(
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
        "result": rec.result,
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
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    media_type = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(path=str(p), media_type=media_type, filename=p.name)