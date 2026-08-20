import os
import sys
import time
import tempfile
import threading
import uuid
import platform
import subprocess
import fal_client
from pipeline.utils import (
    get_video_dimensions_and_duration,
    calculate_square_padding,
    has_audio_stream,
    fetch_fal_result,
)

def extract_video_url(result):
    """
    Extracts the video URL from a fal.ai API result dictionary.
    """
    if not isinstance(result, dict):
        raise ValueError(f"Invalid result type from fal.ai, expected dict: {result}")
        
    if "video" in result and isinstance(result["video"], dict):
        return result["video"]["url"]
    elif "videos" in result and isinstance(result["videos"], list) and len(result["videos"]) > 0:
        return result["videos"][0]["url"]
    elif "url" in result:
        return result["url"]
        
    # Deep search fallback
    for key, value in result.items():
        if isinstance(value, dict) and "url" in value:
            return value["url"]
        elif key == "url":
            return value
            
    raise ValueError(f"Could not find output video URL in result: {result}")

def poll_job_status(handler, status_prefix, status_callback=None, timeout_s=1800.0):
    """
    Polls the status of an asynchronous fal-client job until it completes,
    fails, or exceeds *timeout_s* (default 30 minutes) — a stuck remote job
    used to hang this loop (and, with it, a whole worker thread) forever.
    """
    start = time.time()
    while True:
        if time.time() - start > timeout_s:
            raise TimeoutError(f"{status_prefix}: timed out after {timeout_s:.0f}s waiting on fal.ai")

        status = handler.status(with_logs=True)

        if isinstance(status, fal_client.Queued):
            pos = getattr(status, "position", 0)
            if status_callback:
                status_callback(f"{status_prefix}: Queued (position {pos})...")
        elif isinstance(status, fal_client.InProgress):
            logs = getattr(status, "logs", None)
            msg = f"{status_prefix}: In progress..."
            if logs and len(logs) > 0:
                last_log = logs[-1].get("message", "")
                if last_log:
                    msg = f"{status_prefix}: {last_log}"
            if status_callback:
                status_callback(msg)
        elif isinstance(status, fal_client.Completed):
            if status_callback:
                status_callback(f"{status_prefix}: Completed!")
            break
        else:
            # Some other terminal/error status class — don't spin forever on it.
            status_name = type(status).__name__
            if status_callback:
                status_callback(f"{status_prefix}: {status_name}")
            if status_name.lower() in ("failed", "error"):
                raise RuntimeError(f"{status_prefix}: fal.ai job {status_name.lower()}")

        time.sleep(2.0)

    return handler.get()

_ENCODER_CACHE = None
_ENCODER_LOCK = threading.Lock()

_HEVC_CANDIDATES = [
    ("hevc_videotoolbox", ["-b:v", "14M", "-maxrate", "16M", "-bufsize", "32M", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-movflags", "+faststart"]),
    ("hevc_nvenc", ["-preset", "slow", "-rc", "vbr", "-b:v", "14M", "-maxrate", "16M", "-bufsize", "32M", "-movflags", "+faststart"]),
    ("hevc_qsv", ["-b:v", "14M", "-maxrate", "16M", "-bufsize", "32M", "-movflags", "+faststart"]),
    # CRF is the rate-control mode here — no -b:v/-maxrate/-bufsize, since
    # pairing a bitrate cap with -crf gives ffmpeg contradictory instructions
    # (CRF wins; the cap is mostly inert but was misleading in logs/docs).
    ("libx265", ["-crf", "24", "-preset", "medium", "-tag:v", "hvc1", "-movflags", "+faststart"]),
]

def _find_ffms2_plugin() -> str | None:
    """Return explicit path to ffms2 plugin if not automatically loaded into core."""
    try:
        import vapoursynth as _vs
        if hasattr(_vs.core, "ffms2"):
            return None
    except Exception:
        pass
    candidates = []
    try:
        import vapoursynth as _vs, os as _os
        venv_plugins = _os.path.join(_os.path.dirname(_vs.__file__), "plugins")
        for root, _, files in _os.walk(venv_plugins):
            for f in files:
                if "ffms2" in f.lower():
                    candidates.append(_os.path.join(root, f))
    except Exception:
        pass
    sysname = platform.system()
    if sysname == "Darwin":
        candidates.extend([
            "/opt/homebrew/lib/libffms2.dylib",
            "/opt/homebrew/lib/python3.14/site-packages/vapoursynth/plugins/libffms2.dylib",
            "/opt/homebrew/lib/vapoursynth/libffms2.dylib",
            "/usr/local/lib/libffms2.dylib",
        ])
    elif sysname == "Windows":
        candidates.extend([
            r"C:\Program Files\VapourSynth\plugins64\ffms2.dll",
            r"C:\Program Files (x86)\VapourSynth\plugins32\ffms2.dll",
        ])
    else:
        candidates.extend([
            "/usr/lib/x86_64-linux-gnu/vapoursynth/libffms2.so",
            "/usr/lib/vapoursynth/libffms2.so",
            "/usr/local/lib/vapoursynth/libffms2.so",
        ])
    return next((p for p in candidates if os.path.isfile(p)), None)

def _find_vspipe() -> str:
    """Locate vspipe, checking active venv's bin/ or Scripts/ before system PATH."""
    import shutil as _shutil, pathlib as _pl, sys as _sys
    try:
        import vapoursynth as _vs
        prefix = _pl.Path(_sys.prefix)
        candidates = [
            prefix / "bin" / "vspipe",
            prefix / "Scripts" / "vspipe.exe",
            prefix / "Scripts" / "vspipe",
            prefix / "bin" / "vspipe.exe",
            _pl.Path(_vs.__file__).parent.parent.parent.parent / "Scripts" / "vspipe.exe",
            _pl.Path(_vs.__file__).parent.parent.parent.parent / "bin" / "vspipe",
        ]
        for cand in candidates:
            if cand.exists():
                return str(cand)
    except Exception:
        pass
    found = _shutil.which("vspipe")
    if found:
        return found
    raise RuntimeError(
        "vspipe not found. Install VapourSynth or add it to PATH."
    )

def _pick_encoder():
    """Probe for an HEVC encoder that actually works. Cached per process.

    Guarded by a lock so concurrent jobs (now that the global run lock is
    gone) can't both spawn the ffmpeg smoke-test at once; in the common case
    this is pre-warmed once at startup (see server/app.py's lifespan) so the
    lock is rarely contended.
    """
    global _ENCODER_CACHE
    if _ENCODER_CACHE:
        return _ENCODER_CACHE

    with _ENCODER_LOCK:
        if _ENCODER_CACHE:
            return _ENCODER_CACHE

        no_window = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        listed = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, creationflags=no_window,
        ).stdout or ""

        for name, opts in _HEVC_CANDIDATES:
            if name not in listed:
                continue
            probe = subprocess.run(
                ["ffmpeg", "-hide_banner", "-v", "error",
                 "-f", "lavfi", "-i", "testsrc=d=0.1:s=64x64",
                 "-c:v", name, *opts, "-frames:v", "1", "-f", "null", "-"],
                capture_output=True, creationflags=no_window,
            )
            if probe.returncode == 0:
                _ENCODER_CACHE = (name, opts)
                return _ENCODER_CACHE

        raise RuntimeError(
            "No working HEVC encoder found (tried: "
            + ", ".join(n for n, _ in _HEVC_CANDIDATES) + ")"
        )

def _is_already_square(path: str, target: int = 3840) -> bool:
    """True if *path* already probes as target x target (skip a no-op scale)."""
    try:
        w, h, _ = get_video_dimensions_and_duration(path)
        return w == target and h == target
    except Exception:
        return False


def process_video(
    video_path,
    prompt,
    fal_key=None,
    status_callback=None,
    outpaint_model="fal-ai/ltx-2.3-quality/outpaint",
    upscale_model="fal-ai/seedvr/upscale/video",
    upscale_only=False,
    sharpening=0.0,
    upscale_engine="fast",
    **kwargs,
):
    """
    Asynchronously processes a local video file: outpainting it to a 1:1 square aspect ratio
    and then upscaling the result to 4K.

    Thin wrapper around _process_video_impl that guarantees any intermediate
    temp file created before a failure is cleaned up — the impl's own
    end-of-function cleanup only runs on the success path, so an exception
    raised mid-encode used to leak the trimmed/outpainted temp files.
    """
    temp_paths: list[str] = []
    try:
        return _process_video_impl(
            video_path, prompt, temp_paths,
            fal_key=fal_key,
            status_callback=status_callback,
            outpaint_model=outpaint_model,
            upscale_model=upscale_model,
            upscale_only=upscale_only,
            sharpening=sharpening,
            upscale_engine=upscale_engine,
            **kwargs,
        )
    except Exception:
        for p in temp_paths:
            if p and os.path.exists(p):
                try:
                    os.unlink(p)
                except OSError:
                    pass
        raise


def _process_video_impl(
    video_path,
    prompt,
    temp_paths,
    fal_key=None,
    status_callback=None,
    outpaint_model="fal-ai/ltx-2.3-quality/outpaint",
    upscale_model="fal-ai/seedvr/upscale/video",
    upscale_only=False,
    sharpening=0.0,
    upscale_engine="fast",
    **kwargs,
):
    t0 = time.time()
    upload_time = 0.0
    outpaint_time = 0.0
    outpaint_cost = 0.0
    upscale_time = 0.0
    upscale_cost = 0.0
    master_time = 0.0

    if (not upscale_only) or (upscale_engine == "fal"):
        if not fal_key and not os.environ.get("FAL_KEY"):
            raise ValueError("FAL_KEY must be set in the environment or passed as an argument.")

    # Use a per-call client instead of mutating the shared os.environ / the
    # module-level fal_client singleton — both are process-global state and
    # would race across concurrently running jobs with different keys.
    fal = fal_client.SyncClient(key=fal_key) if fal_key else fal_client.sync_client

    trim_enabled = bool(kwargs.get("trim_enabled", False))
    trim_start = float(kwargs.get("trim_start", 0.0))
    trim_duration = float(kwargs.get("trim_duration", 15.0))
    trim_duration = min(15.0, max(1.0, trim_duration))

    video_to_process = video_path
    temp_trimmed_path = None

    if trim_enabled:
        if status_callback:
            status_callback(f"Trimming input clip: start={trim_start:.1f}s, duration={trim_duration:.1f}s (max 15s)...")
        uid_trim = uuid.uuid4().hex[:8]
        temp_trimmed_path = os.path.join(tempfile.gettempdir(), f"trimmed_source_{uid_trim}.mp4")
        temp_paths.append(temp_trimmed_path)
        
        trim_cmd = [
            "ffmpeg", "-y",
            "-ss", str(trim_start),
            "-i", video_path,
            "-t", str(trim_duration),
            "-c:v", "libx264", "-preset", "fast", "-crf", "17",
            "-c:a", "copy",
            temp_trimmed_path
        ]
        try:
            subprocess.run(trim_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if os.path.exists(temp_trimmed_path) and os.path.getsize(temp_trimmed_path) > 0:
                video_to_process = temp_trimmed_path
        except Exception as e:
            if status_callback:
                status_callback(f"Trimming fallback: {e}")

    if status_callback:
        status_callback("Analyzing video dimensions and duration...")

    # 1. Get video metadata
    width, height, duration = get_video_dimensions_and_duration(video_to_process)
    top, bottom, left, right = calculate_square_padding(width, height)
    
    if status_callback:
        status_callback(f"Native size: {width}x{height}, Duration: {duration:.2f}s. Padding: top={top}, bottom={bottom}, left={left}, right={right}")

    if upscale_only:
        temp_outpaint_path = video_to_process
        outpaint_url = None
    else:
        # 2. Upload video to fal.ai CDN
        if status_callback:
            status_callback("Uploading video file to fal.ai CDN...")
        t_up_start = time.time()
        video_url = fal.upload_file(video_to_process)
        upload_time = time.time() - t_up_start
        
        # 3. Outpainting (if not already square)
        if top == 0 and bottom == 0 and left == 0 and right == 0:
            if status_callback:
                status_callback("Video is already square. Skipping outpainting phase.")
            outpaint_url = video_url
        else:
            if status_callback:
                status_callback(f"Submitting video outpainting job to {outpaint_model}...")
            
            t_op_start = time.time()
            model_lower = (outpaint_model or "").lower()
            if "luma" in model_lower or "reframe" in model_lower:
                arguments = {
                    "video_url": video_url,
                    "aspect_ratio": kwargs.get("luma_aspect_ratio", "1:1"),
                }
                if prompt and prompt.strip():
                    arguments["prompt"] = prompt.strip()
                dur_calc = duration if duration > 0 else 5.0
                outpaint_cost = dur_calc * 0.06
            elif "ltx" in model_lower:
                arguments = {
                    "video_url": video_url,
                    "prompt": prompt or "Seamlessly extend the background environment, high details, matching texture and lighting. Keep the origin video aethestic and lighting",
                    "aspect_ratio": kwargs.get("ltx_aspect_ratio", "1:1"),
                    "output_resolution": kwargs.get("ltx_resolution", "720p"),
                    "source_scale": float(kwargs.get("ltx_source_scale", 1.0)),
                    "video_strength": float(kwargs.get("ltx_video_strength", 1.0)),
                    "num_inference_steps": int(kwargs.get("ltx_steps", 15)),
                    "guidance_scale": float(kwargs.get("ltx_guidance", 1.0)),
                    "generate_audio": bool(kwargs.get("ltx_audio", True)),
                }
                res_tier = kwargs.get("ltx_resolution", "720p")
                w_ltx, h_ltx = (720, 720) if res_tier == "720p" else ((1080, 1080) if res_tier == "1080p" else (480, 480))
                frames_est = int(duration * 24) if duration > 0 else 121
                mp = (w_ltx * h_ltx * frames_est) / 1000000.0
                outpaint_cost = mp * 0.0024075
            elif "wan" in model_lower or "vace" in model_lower:
                arguments = {
                    "video_url": video_url,
                    "prompt": prompt or "Seamlessly extend the background environment beyond the original frame",
                    "aspect_ratio": kwargs.get("wan_aspect_ratio", "1:1"),
                }
                dur_calc = duration if duration > 0 else 5.0
                outpaint_cost = dur_calc * 0.08
            else:
                arguments = {
                    "video_url": video_url,
                    "prompt": prompt or "Seamlessly extend environment context",
                    "aspect_ratio": "1:1",
                }
                dur_calc = duration if duration > 0 else 5.0
                outpaint_cost = dur_calc * 0.06
            
            handler = fal.submit(outpaint_model, arguments=arguments)
            result = poll_job_status(handler, "Outpainting", status_callback)
            outpaint_url = extract_video_url(result)
            outpaint_time = time.time() - t_op_start

        # 4. Download outpaint video
        if status_callback:
            status_callback("Downloading outpainted video for upscaling...")
            
        uid = uuid.uuid4().hex[:8]
        temp_outpaint_path = os.path.join(tempfile.gettempdir(), f"outpainted_video_temp_{uid}.mp4")
        temp_paths.append(temp_outpaint_path)
        fetch_fal_result(outpaint_url, temp_outpaint_path)
    
    # Determine output location
    uid = uuid.uuid4().hex[:8]
    output_video_path = os.path.join(tempfile.gettempdir(), f"delivery_4k_square_{uid}.mp4")
    if os.path.exists(output_video_path):
        os.unlink(output_video_path)
    
    t_up_stage_start = time.time()
    if upscale_engine == "fal":
        if status_callback:
            status_callback("Uploading video file to fal.ai CDN for cloud upscale...")

        if upscale_only or not outpaint_url:
            video_url_to_upscale = fal.upload_file(temp_outpaint_path)
        else:
            video_url_to_upscale = outpaint_url

        if status_callback:
            status_callback(f"Submitting video upscaling job to {upscale_model}...")

        upscale_lower = (upscale_model or "").lower()
        if "seedvr" in upscale_lower:
            arguments = {
                "video_url": video_url_to_upscale,
                "upscale_mode": kwargs.get("seedvr_mode", "factor"),
                "upscale_factor": float(kwargs.get("seedvr_factor", 2.0)),
                "target_resolution": kwargs.get("seedvr_target", "1080p"),
                "noise_scale": float(kwargs.get("seedvr_noise", 0.1)),
                "output_format": kwargs.get("seedvr_format", "X264 (.mp4)"),
                "output_quality": kwargs.get("seedvr_quality", "high"),
                "output_write_mode": "balanced",
            }
            res_tier_s = kwargs.get("seedvr_target", "1080p")
            w_s, h_s = (1080, 1080) if res_tier_s == "1080p" else ((2160, 2160) if res_tier_s == "2160p" else (720, 720))
            frames_est = int(duration * 24) if duration > 0 else 121
            mp_s = (w_s * h_s * frames_est) / 1000000.0
            upscale_cost = mp_s * 0.001
        elif "bytedance" in upscale_lower:
            arguments = {
                "video_url": video_url_to_upscale,
                "target_resolution": kwargs.get("bytedance_target_res", "4k"),
                "target_fps": kwargs.get("bytedance_target_fps", "30fps"),
                "enhancement_preset": kwargs.get("bytedance_preset", "general"),
                "enhancement_tier": kwargs.get("bytedance_tier", "fast"),
                "fidelity": kwargs.get("bytedance_fidelity", "medium"),
            }
            b_res = kwargs.get("bytedance_target_res", "4k")
            b_base_rates = {"1080p": 0.0072, "2k": 0.0144, "4k": 0.0288}
            b_base = b_base_rates.get(b_res, 0.0288)
            b_fps_m = 2.0 if kwargs.get("bytedance_target_fps", "30fps") == "60fps" else 1.0
            b_tier_m = 10.0 if kwargs.get("bytedance_tier", "fast") == "pro" else 1.0
            dur_calc = duration if duration > 0 else 5.0
            upscale_cost = dur_calc * (b_base * b_fps_m * b_tier_m)
        else:
            arguments = {"video_url": video_url_to_upscale}
            dur_calc = duration if duration > 0 else 5.0
            upscale_cost = max(0.08, dur_calc * 0.02)

        handler = fal.submit(upscale_model, arguments=arguments)
        result = poll_job_status(handler, "Video Upscaling (FAL AI)", status_callback)
        upscaled_video_url = extract_video_url(result)

        if status_callback:
            status_callback("Downloading upscaled video from fal.ai...")

        temp_fal_vid = os.path.join(tempfile.gettempdir(), f"fal_upscaled_vid_{uid}.mp4")
        temp_paths.append(temp_fal_vid)
        fetch_fal_result(upscaled_video_url, temp_fal_vid)

        # Probe for a working encoder
        encoder, encoder_opts = _pick_encoder()

        # Determine best audio source stream
        audio_src = None
        if os.path.exists(temp_fal_vid) and has_audio_stream(temp_fal_vid):
            audio_src = temp_fal_vid
        elif os.path.exists(temp_outpaint_path) and has_audio_stream(temp_outpaint_path):
            audio_src = temp_outpaint_path
        elif has_audio_stream(video_path):
            audio_src = video_path

        vf_parts = [] if _is_already_square(temp_fal_vid) else [
            "scale=3840:3840:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp"
        ]
        if sharpening > 0.0:
            vf_parts.append(f"cas={sharpening}")
        vf_filter = ",".join(vf_parts)
        vf_args = ["-vf", vf_filter] if vf_filter else []

        if audio_src and audio_src != temp_fal_vid:
            cmd = [
                "ffmpeg", "-y",
                "-i", temp_fal_vid,
                "-i", audio_src,
                *vf_args,
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-c:v", encoder
            ] + encoder_opts + ["-c:a", "copy", "-shortest", output_video_path]
        elif audio_src:
            cmd = [
                "ffmpeg", "-y",
                "-i", temp_fal_vid,
                *vf_args,
                "-c:v", encoder
            ] + encoder_opts + ["-c:a", "copy", output_video_path]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-i", temp_fal_vid,
                *vf_args,
                "-c:v", encoder
            ] + encoder_opts + [output_video_path]

        t_master_start = time.time()
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        master_time = time.time() - t_master_start

        if os.path.exists(temp_fal_vid):
            os.unlink(temp_fal_vid)
        upscale_time = time.time() - t_up_stage_start
    elif upscale_engine == "studio":
        if status_callback:
            status_callback("Performing studio-quality VapourSynth upscale (znedi3 + FineSharp). This will take a LONG time...")

        vpy_path = os.path.join(tempfile.gettempdir(), f"upscale_{uid}.vpy")

        ffms2_plugin = _find_ffms2_plugin()
        load_ffms2 = f"core.std.LoadPlugin(r'{os.path.abspath(ffms2_plugin)}')\n" if ffms2_plugin else ""

        with open(vpy_path, "w") as f:
            f.write(f'''import vapoursynth as vs

core = vs.core
{load_ffms2}
abs_video_path = r'{os.path.abspath(temp_outpaint_path)}'
clip = core.ffms2.Source(abs_video_path)
clip = core.znedi3.nnedi3(clip, field=1, dh=True, nsize=0, nns=3, qual=2, pscrn=2)
clip = core.resize.Spline36(clip, width=3840, height=3840)
clip.set_output()
''')

        encoder, encoder_opts = _pick_encoder()
        vspipe = _find_vspipe()

        audio_src = video_path if has_audio_stream(video_path) else (temp_outpaint_path if has_audio_stream(temp_outpaint_path) else None)

        # Honour the user's sharpening slider instead of a hardcoded cas=0.5.
        vf_filter = f"cas={sharpening}" if sharpening > 0.0 else None

        ffmpeg_cmd = ["ffmpeg", "-y", "-i", "-"]
        if audio_src:
            ffmpeg_cmd += ["-i", audio_src]
        if vf_filter:
            ffmpeg_cmd += ["-vf", vf_filter]
        if audio_src:
            ffmpeg_cmd += ["-map", "0:v:0", "-map", "1:a:0", "-c:v", encoder, *encoder_opts, "-c:a", "copy", "-shortest"]
        else:
            ffmpeg_cmd += ["-c:v", encoder, *encoder_opts]
        ffmpeg_cmd += [output_video_path]

        # Piped directly (no shell, no string interpolation of paths into a
        # shell command) so this runs on Windows without Git Bash and isn't
        # vulnerable to a filename/path containing a quote character.
        stderr_log_path = os.path.join(tempfile.gettempdir(), f"studio_ffmpeg_stderr_{uid}.log")
        vspipe_proc = None
        ffmpeg_proc = None
        try:
            t_master_start = time.time()
            with open(stderr_log_path, "wb") as stderr_log:
                vspipe_proc = subprocess.Popen(
                    [vspipe, "-c", "y4m", vpy_path, "-"],
                    stdout=subprocess.PIPE,
                )
                ffmpeg_proc = subprocess.Popen(
                    ffmpeg_cmd,
                    stdin=vspipe_proc.stdout,
                    stdout=subprocess.DEVNULL,
                    stderr=stderr_log,
                )
                vspipe_proc.stdout.close()  # let ffmpeg own the read end (SIGPIPE-safe)
                ffmpeg_rc = ffmpeg_proc.wait()
                vspipe_rc = vspipe_proc.wait()
            master_time = time.time() - t_master_start

            if ffmpeg_rc != 0 or vspipe_rc != 0:
                tail = ""
                try:
                    with open(stderr_log_path, "r", errors="replace") as f:
                        tail = "\n".join(f.read().strip().splitlines()[-20:])
                except OSError:
                    pass
                raise RuntimeError(
                    f"Studio pipeline failed (vspipe rc={vspipe_rc}, ffmpeg rc={ffmpeg_rc}):\n{tail}"
                )
        finally:
            for proc in (vspipe_proc, ffmpeg_proc):
                if proc and proc.poll() is None:
                    proc.kill()
            if os.path.exists(vpy_path):
                os.unlink(vpy_path)
            if os.path.exists(stderr_log_path):
                os.unlink(stderr_log_path)
        upscale_time = time.time() - t_up_stage_start
    else:
        if status_callback:
            status_callback("Performing hardware-accelerated 4K upscale via FFmpeg...")

        vf_parts = [] if _is_already_square(temp_outpaint_path) else [
            "scale=3840:3840:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp"
        ]
        if sharpening > 0.0:
            vf_parts.append(f"cas={sharpening}")
        vf_filter = ",".join(vf_parts)
        vf_args = ["-vf", vf_filter] if vf_filter else []

        encoder, encoder_opts = _pick_encoder()

        audio_src = video_path if has_audio_stream(video_path) else (temp_outpaint_path if has_audio_stream(temp_outpaint_path) else None)
        if audio_src and audio_src != temp_outpaint_path:
            cmd = [
                "ffmpeg", "-y",
                "-i", temp_outpaint_path,
                "-i", audio_src,
                *vf_args,
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-c:v", encoder
            ] + encoder_opts + ["-c:a", "copy", "-shortest", output_video_path]
        elif audio_src:
            cmd = [
                "ffmpeg", "-y",
                "-i", temp_outpaint_path,
                *vf_args,
                "-c:v", encoder
            ] + encoder_opts + ["-c:a", "copy", output_video_path]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-i", temp_outpaint_path,
                *vf_args,
                "-c:v", encoder
            ] + encoder_opts + [output_video_path]

        t_master_start = time.time()
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        master_time = time.time() - t_master_start
        upscale_time = time.time() - t_up_stage_start
    
    # Clean up intermediate video
    if not upscale_only and os.path.exists(temp_outpaint_path):
        os.unlink(temp_outpaint_path)
    if temp_trimmed_path and os.path.exists(temp_trimmed_path):
        os.unlink(temp_trimmed_path)

    total_time = time.time() - t0
    total_cost = outpaint_cost + upscale_cost

    metrics = {
        "total_time": round(total_time, 2),
        "total_cost": round(total_cost, 4),
        "upload_time": round(upload_time, 2),
        "outpaint_time": round(outpaint_time, 2),
        "outpaint_cost": round(outpaint_cost, 4),
        "outpaint_model": outpaint_model if not upscale_only else "SKIPPED",
        "upscale_time": round(upscale_time, 2),
        "upscale_cost": round(upscale_cost, 4),
        "upscale_engine": "FAL AI" if upscale_engine == "fal" else upscale_engine.upper(),
        "upscale_model": upscale_model if upscale_engine == "fal" else f"Local {upscale_engine.upper()}",
        "master_time": round(master_time, 2),
    }
        
    return (outpaint_url, output_video_path), metrics
