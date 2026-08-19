"""Video processing router — upload, job creation, SSE progress, and downloads."""

import asyncio
import os
import uuid
from pathlib import Path
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from pipeline.utils import (
    calculate_square_padding,
    get_video_dimensions_and_duration,
    log_pipeline_execution,
)
from pipeline.video_worker import process_video
from server import media as SM
from server import output
from server.jobs import JobStatus, job_manager

router = APIRouter(prefix="/api/video", tags=["video"])

STAGED_UPLOADS: dict[str, str] = {}


@router.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    """Stage an uploaded video file and return its metadata."""
    content = await file.read()
    stage_id = uuid.uuid4().hex[:10]
    dest_path = SM.stage_upload(file.filename or "upload.mp4", content)

    STAGED_UPLOADS[stage_id] = dest_path

    w, h, dur = get_video_dimensions_and_duration(dest_path)
    top, bottom, left, right = calculate_square_padding(w, h)
    orientation = "LANDSCAPE" if w > h else ("PORTRAIT" if h > w else "SQUARE")

    return {
        "stage_id": stage_id,
        "filename": file.filename,
        "size_bytes": len(content),
        "width": w,
        "height": h,
        "duration": round(dur, 2),
        "orientation": orientation,
        "padding": {"top": top, "bottom": bottom, "left": left, "right": right},
    }


@router.post("/process")
def start_video_process(
    stage_id: str = Form(...),
    prompt: str = Form(""),
    upscale_only: bool = Form(False),
    upscale_engine: str = Form("fast"),
    sharpening: float = Form(0.0),
    outpaint_model: str = Form("fal-ai/ltx-2.3-quality/outpaint"),
    upscale_model: str = Form("fal-ai/seedvr/upscale/video"),
    ltx_resolution: str = Form("720p"),
    ltx_audio: bool = Form(True),
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
):
    """Start video processing job in background worker pool."""
    src_path = STAGED_UPLOADS.get(stage_id)
    if not src_path or not os.path.exists(src_path):
        raise HTTPException(status_code=400, detail="Invalid or expired stage_id")

    job_id = job_manager.create_job(kind="video")

    kwargs = {
        "video_path": src_path,
        "prompt": prompt,
        "fal_key": os.environ.get("FAL_KEY"),
        "outpaint_model": outpaint_model,
        "upscale_model": upscale_model,
        "upscale_only": upscale_only,
        "sharpening": sharpening,
        "upscale_engine": upscale_engine,
        "ltx_resolution": ltx_resolution,
        "ltx_audio": ltx_audio,
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
    }

    def postprocess(raw):
        if isinstance(raw, tuple) and len(raw) == 2 and isinstance(raw[1], dict):
            (outpaint_url, worker_path), metrics = raw
        else:
            (outpaint_url, worker_path), metrics = raw, {}
        rec = output.persist(worker_path, "video", job_id)
        rec["outpaint_url"] = outpaint_url
        rec["metrics"] = metrics

        # H.264 proxy for in-browser playback (HEVC masters do not decode in HTML5)
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
                params={"upscale_engine": upscale_engine, "upscale_only": upscale_only},
            )
        except Exception:
            pass  # logging must never fail the job

        rec["download_url"] = f"/api/video/jobs/{job_id}/download"
        return rec

    job_manager.submit(job_id, process_video, kwargs, postprocess=postprocess)

    return {"job_id": job_id, "status": "queued"}


def _append_message(job_id: str, msg: str) -> None:
    """Append a progress message to a job's record (thread-safe)."""
    rec = job_manager.get_job(job_id)
    if rec:
        with rec._lock:
            rec.messages.append(msg)


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
async def stream_job_progress(job_id: str):
    """SSE endpoint streaming job progress in real time."""
    rec = job_manager.get_job(job_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        last_msg_count = 0
        while True:
            with rec._lock:
                status = rec.status.value
                phase = rec.phase
                progress = rec.progress
                elapsed = rec.elapsed
                msgs = list(rec.messages)
                err = rec.error
                res = rec.result

            new_msgs = msgs[last_msg_count:]
            last_msg_count = len(msgs)

            data = {
                "status": status,
                "phase": phase,
                "progress": progress,
                "elapsed": elapsed,
                "new_messages": new_msgs,
                "result": res,
                "error": err,
            }

            yield {"event": "progress", "data": data}

            if status in ("complete", "failed"):
                break

            await asyncio.sleep(0.5)

    return EventSourceResponse(event_generator())


@router.get("/jobs/{job_id}/download")
def download_video(job_id: str, kind: str = "master"):
    """Download the completed job's master (HEVC) or preview (H.264) file."""
    rec = job_manager.get_job(job_id)
    if not rec or rec.status != JobStatus.COMPLETE or not rec.result:
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