"""Video processing router — upload, job creation, SSE progress, and downloads."""

import json
import os
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from pipeline.utils import (
    calculate_square_padding,
    get_video_dimensions_and_duration,
    log_pipeline_execution,
)
from core import models as _models
from server.billing.parameters import video_parameters
from server.billing.runtime import failure_callback, lifecycle_callback, resolve_fal_key, success_callback
from server.billing.service import BillingError, create_billing_job, finalize_job_failure
from pipeline.video_worker import process_video
from server import media as SM
from server import output
from server.jobs import JobStatus, job_manager
from server.sse import job_progress_stream
from server.social.auth import AuthContext, get_optional_auth, validate_csrf, validate_origin
from server.social.database import get_db
from sqlalchemy.orm import Session

router = APIRouter(prefix="/api/video", tags=["video"])

# stage_id -> (path, staged_at). Entries older than STAGE_TTL_S are evicted by
# cleanup_stale_uploads() (called periodically from server/app.py's lifespan)
# so an abandoned upload doesn't hold its temp file forever.
STAGED_UPLOADS: dict[str, tuple[str, float]] = {}
STAGE_TTL_S = 6 * 3600

# Fields the worker branches on by exact string match (server/pipeline/video_worker.py) —
# an unrecognized value doesn't error there, it silently falls through to a
# default branch, so reject anything outside the known set up front instead.
_UPSCALE_ENGINES = {"fast", "fal", "studio"}
_LTX_RESOLUTIONS = {"480p", "720p", "1080p"}
_LTX_TRANSFORMERS = {"high", "low", "both"}
_SEEDVR_TARGETS = {"720p", "1080p", "2160p"}
_BYTEDANCE_RES = {"1080p", "2k", "4k"}
_BYTEDANCE_FPS = {"30fps", "60fps"}
_BYTEDANCE_TIERS = {"fast", "standard", "pro"}


def _parse_ltx_loras(raw: str) -> list[dict]:
    """Parse the JSON-encoded ``ltx_loras`` form field into a validated list
    of LoRA dicts ({path, scale, transformer}), at most 3 entries. The worker
    passes these straight through to the fal.ai endpoint, so URLs are only
    sanity-checked here (http/https), not fetched."""
    raw = (raw or "").strip() if isinstance(raw, str) else raw
    if not raw:
        return []
    try:
        loras = json.loads(raw)
    except (TypeError, ValueError) as ex:
        raise HTTPException(status_code=400, detail=f"ltx_loras must be a JSON array: {ex}")
    if not isinstance(loras, list):
        raise HTTPException(status_code=400, detail="ltx_loras must be a JSON array of LoRA objects")
    if len(loras) > 3:
        raise HTTPException(status_code=400, detail="ltx_loras accepts at most 3 LoRAs")

    cleaned = []
    for i, lora in enumerate(loras):
        if not isinstance(lora, dict):
            raise HTTPException(status_code=400, detail=f"ltx_loras[{i}] must be an object")
        path = str(lora.get("path", "")).strip()
        if not path.startswith(("https://", "http://")):
            raise HTTPException(status_code=400, detail=f"ltx_loras[{i}].path must be an http(s) URL to a .safetensors file")
        try:
            scale = float(lora.get("scale", 1.0))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"ltx_loras[{i}].scale must be a number")
        if not 0.0 <= scale <= 2.0:
            raise HTTPException(status_code=400, detail=f"ltx_loras[{i}].scale must be between 0.0 and 2.0")
        transformer = str(lora.get("transformer", "both"))
        if transformer not in _LTX_TRANSFORMERS:
            raise HTTPException(status_code=400, detail=f"ltx_loras[{i}].transformer must be one of {sorted(_LTX_TRANSFORMERS)}")
        cleaned.append({"path": path, "scale": scale, "transformer": transformer})
    return cleaned


def _validate_video_form(
    upscale_engine, sharpening, ltx_resolution, seedvr_factor, seedvr_target,
    bytedance_target_res, bytedance_target_fps, bytedance_tier,
    trim_start, trim_duration, ltx_guidance=1.0,
):
    def check_enum(name, value, allowed):
        if value not in allowed:
            raise HTTPException(status_code=400, detail=f"Invalid {name}: {value!r} (expected one of {sorted(allowed)})")

    check_enum("upscale_engine", upscale_engine, _UPSCALE_ENGINES)
    check_enum("ltx_resolution", ltx_resolution, _LTX_RESOLUTIONS)
    check_enum("seedvr_target", seedvr_target, _SEEDVR_TARGETS)
    check_enum("bytedance_target_res", bytedance_target_res, _BYTEDANCE_RES)
    check_enum("bytedance_target_fps", bytedance_target_fps, _BYTEDANCE_FPS)
    check_enum("bytedance_tier", bytedance_tier, _BYTEDANCE_TIERS)

    if not 0.0 <= sharpening <= 1.0:
        raise HTTPException(status_code=400, detail="sharpening must be between 0.0 and 1.0")
    if not 1.0 <= seedvr_factor <= 4.0:
        raise HTTPException(status_code=400, detail="seedvr_factor must be between 1.0 and 4.0")
    if not 1.0 <= ltx_guidance <= 20.0:
        raise HTTPException(status_code=400, detail="ltx_guidance must be between 1.0 and 20.0")
    if trim_start < 0:
        raise HTTPException(status_code=400, detail="trim_start must be >= 0")
    if not 1.0 <= trim_duration <= 15.0:
        raise HTTPException(status_code=400, detail="trim_duration must be between 1.0 and 15.0")


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
def upload_video(file: UploadFile = File(...)):
    """Stage an uploaded video file and return its metadata.

    Plain `def`, not `async def` — this streams the upload to disk in chunks
    and calls a blocking, un-awaitable ffprobe subprocess
    (get_video_dimensions_and_duration). FastAPI runs sync route handlers in
    a worker thread, so the event loop (and every other request, including
    live SSE progress streams) no longer stalls while it runs.
    """
    stage_id = uuid.uuid4().hex[:10]
    try:
        dest_path, size_bytes = SM.stage_upload_stream(
            file.filename or "upload.mp4", file.file,
            SM.VIDEO_EXTS, SM.MAX_VIDEO_UPLOAD_BYTES,
        )
    except SM.UploadRejected as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex

    STAGED_UPLOADS[stage_id] = (dest_path, time.time())

    w, h, dur = get_video_dimensions_and_duration(dest_path)
    top, bottom, left, right = calculate_square_padding(w, h)
    orientation = "LANDSCAPE" if w > h else ("PORTRAIT" if h > w else "SQUARE")

    return {
        "stage_id": stage_id,
        "filename": file.filename,
        "size_bytes": size_bytes,
        "width": w,
        "height": h,
        "duration": round(dur, 2),
        "orientation": orientation,
        "padding": {"top": top, "bottom": bottom, "left": left, "right": right},
    }


@router.post("/process")
def start_video_process(
    request: Request,
    stage_id: str = Form(...),
    prompt: str = Form(""),
    upscale_only: bool = Form(False),
    upscale_engine: str = Form("fast"),
    sharpening: float = Form(0.0),
    outpaint_model: str = Form("fal-ai/ltx-2.3-quality/outpaint"),
    upscale_model: str = Form("fal-ai/seedvr/upscale/video"),
    ltx_resolution: str = Form("720p"),
    ltx_audio: bool = Form(True),
    ltx_guidance: float = Form(1.0),
    ltx_prompt_expansion: bool = Form(False),
    ltx_negative_prompt: str = Form("yellow tint, sepia, warm cast, color distortion, discoloration, overexposure, oversaturated"),
    ltx_loras: str = Form(""),
    wan_resolution: str = Form("720p"),
    seedvr_factor: float = Form(2.0),
    seedvr_target: str = Form("1080p"),
    bytedance_target_res: str = Form("4k"),
    bytedance_target_fps: str = Form("30fps"),
    bytedance_tier: str = Form("fast"),
    bytedance_preset: str = Form("general"),
    bytedance_fidelity: str = Form("medium"),
    trim_enabled: bool = Form(False),
    trim_start: float = Form(0.0),
    trim_duration: float = Form(15.0),
    custom_outpaint_args: str = Form("{}"),
    custom_upscale_args: str = Form("{}"),
    payment_source: str = Form("credits"),
    quote_id: str | None = Form(None),
    context: AuthContext | None = Depends(get_optional_auth),
    db: Session = Depends(get_db),
):
    """Start a video job; Fal-backed work requires sign-in and credits or BYOK."""
    _validate_video_form(
        upscale_engine, sharpening, ltx_resolution, seedvr_factor, seedvr_target,
        bytedance_target_res, bytedance_target_fps, bytedance_tier,
        trim_start, trim_duration, ltx_guidance,
    )
    if wan_resolution not in {"480p", "580p", "720p"}:
        raise HTTPException(status_code=400, detail="Invalid wan_resolution")
    parsed_loras = _parse_ltx_loras(ltx_loras)
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
    width, height, _duration = get_video_dimensions_and_duration(src_path)
    cloud_required = ((not upscale_only) and width != height) or upscale_engine.casefold() == "fal"
    params = video_parameters({
        "prompt": prompt,
        "upscale_only": upscale_only,
        "upscale_engine": upscale_engine,
        "sharpening": sharpening,
        "outpaint_model": outpaint_model,
        "upscale_model": upscale_model,
        "ltx_resolution": ltx_resolution,
        "ltx_audio": ltx_audio,
        "ltx_guidance": ltx_guidance,
        "ltx_prompt_expansion": ltx_prompt_expansion,
        "ltx_negative_prompt": ltx_negative_prompt,
        "ltx_loras": parsed_loras,
        "wan_resolution": wan_resolution,
        "seedvr_factor": seedvr_factor,
        "seedvr_target": seedvr_target,
        "bytedance_target_res": bytedance_target_res,
        "bytedance_target_fps": bytedance_target_fps,
        "bytedance_tier": bytedance_tier,
        "bytedance_preset": bytedance_preset,
        "bytedance_fidelity": bytedance_fidelity,
        "trim_enabled": trim_enabled,
        "trim_start": trim_start,
        "trim_duration": trim_duration,
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
                kind="video",
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
        "video_path": src_path,
        "prompt": params["prompt"],
        "fal_key": fal_key,
        "outpaint_model": params["outpaint_model"],
        "upscale_model": params["upscale_model"],
        "upscale_only": params["upscale_only"],
        "sharpening": params["sharpening"],
        "upscale_engine": params["upscale_engine"],
        "ltx_resolution": params["ltx_resolution"],
        "ltx_audio": params["ltx_audio"],
        "ltx_guidance": params["ltx_guidance"],
        "ltx_prompt_expansion": params["ltx_prompt_expansion"],
        "ltx_negative_prompt": params["ltx_negative_prompt"],
        "ltx_loras": params["ltx_loras"],
        "wan_resolution": params["wan_resolution"],
        "seedvr_factor": params["seedvr_factor"],
        "seedvr_target": params["seedvr_target"],
        "bytedance_target_res": params["bytedance_target_res"],
        "bytedance_target_fps": params["bytedance_target_fps"],
        "bytedance_tier": params["bytedance_tier"],
        "bytedance_preset": params["bytedance_preset"],
        "bytedance_fidelity": params["bytedance_fidelity"],
        "trim_enabled": params["trim_enabled"],
        "trim_start": params["trim_start"],
        "trim_duration": params["trim_duration"],
        "custom_outpaint_args": params["custom_outpaint_args"],
        "custom_upscale_args": params["custom_upscale_args"],
        "billing_callback": lifecycle,
    }

    def postprocess(raw):
        if isinstance(raw, tuple) and len(raw) == 2 and isinstance(raw[1], dict):
            (outpaint_url, worker_path), metrics = raw
        else:
            (outpaint_url, worker_path), metrics = raw, {}
        rec = output.persist(worker_path, "video", job_id)
        rec["outpaint_url"] = outpaint_url
        rec["metrics"] = metrics

        if os.environ.get("SX_LIBX264", "1") == "1":
            _append_message(job_id, "Building H.264 preview proxy for browser playback…")
            preview = SM.make_web_preview(rec["path"])
            if preview:
                rec["preview"] = preview
                rec["preview_url"] = f"/api/video/jobs/{job_id}/download?kind=preview"

        try:
            log_pipeline_execution(
                item_name=os.path.basename(src_path),
                kind="video",
                input_path=src_path,
                output_path=rec["path"],
                metrics=metrics,
                params={"upscale_engine": params["upscale_engine"], "upscale_only": params["upscale_only"]},
            )
        except Exception:
            pass

        rec["download_url"] = f"/api/video/jobs/{job_id}/download"
        return rec

    try:
        job_manager.create_job(kind="video", owner_id=owner_id, job_id=job_id)
        job_manager.submit(
            job_id,
            process_video,
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


def _append_message(job_id: str, msg: str) -> None:
    """Append a progress message to a job's record (thread-safe)."""
    rec = job_manager.get_job(job_id)
    if rec:
        with rec._lock:
            rec.messages.append(msg)


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
def download_video(
    job_id: str, kind: str = "master", context: AuthContext | None = Depends(get_optional_auth)
):
    """Download the completed job's master (HEVC) or preview (H.264) file."""
    rec = _owned_job(job_id, context)
    if rec.status != JobStatus.COMPLETE or not rec.result:
        raise HTTPException(status_code=404, detail="No completed result for this job")

    path_key = "preview" if kind == "preview" else "path"
    path_val = rec.result.get(path_key)
    if not path_val:
        raise HTTPException(status_code=404, detail="Requested file not found")

    p = Path(path_val).resolve()
    if not p.is_relative_to(output.job_dir(job_id).resolve()):
        raise HTTPException(status_code=400, detail="Invalid result path")
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path=str(p), media_type="video/mp4", filename=p.name)