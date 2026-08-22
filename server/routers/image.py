"""Image processing router — upload, job creation, SSE progress, and downloads."""

import os
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from pipeline.image_worker import process_image
from pipeline.utils import calculate_square_padding, get_image_dimensions
from server import media as SM
from server import output
from server.jobs import JobStatus, job_manager
from server.sse import job_progress_stream

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
    stage_id: str = Form(...),
    prompt: str = Form(""),
    upscale_only: bool = Form(False),
    sharpening: float = Form(0.0),
    upscale_engine: str = Form("fast"),
    upscale_model: str = Form("fal-ai/clarity-upscaler"),
):
    """Start image processing job in background worker pool."""
    staged = STAGED_UPLOADS.get(stage_id)
    src_path = staged[0] if staged else None
    if not src_path or not os.path.exists(src_path):
        raise HTTPException(status_code=400, detail="Invalid or expired stage_id")

    job_id = job_manager.create_job(kind="image")

    kwargs = {
        "image_source": src_path,
        "prompt": prompt,
        "fal_key": os.environ.get("FAL_KEY"),
        "upscale_only": upscale_only,
        "sharpening": sharpening,
        "upscale_engine": upscale_engine,
        "upscale_model": upscale_model,
    }

    def postprocess(raw):
        outpaint_url, worker_path = raw
        rec = output.persist(worker_path, "image", job_id)
        rec["outpaint_url"] = outpaint_url
        rec["download_url"] = f"/api/image/jobs/{job_id}/download"
        return rec

    job_manager.submit(job_id, process_image, kwargs, postprocess=postprocess)

    return {"job_id": job_id, "status": "queued"}


@router.get("/jobs/{job_id}")
def get_job_status(job_id: str):
    """Get snapshot of job status and progress."""
    rec = job_manager.get_job(job_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Job not found")

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
async def stream_job_progress(job_id: str, request: Request):
    """SSE endpoint streaming job progress in real time."""
    rec = job_manager.get_job(job_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Job not found")

    return EventSourceResponse(job_progress_stream(request, rec))


@router.get("/jobs/{job_id}/download")
def download_image(job_id: str):
    """Download the completed job's result (jailed to the job directory)."""
    rec = job_manager.get_job(job_id)
    if not rec or rec.status != JobStatus.COMPLETE or not rec.result:
        raise HTTPException(status_code=404, detail="No completed result for this job")

    p = Path(rec.result["path"]).resolve()
    if not p.is_relative_to(output.job_dir(job_id).resolve()):
        raise HTTPException(status_code=400, detail="Invalid result path")
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    media_type = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(path=str(p), media_type=media_type, filename=p.name)