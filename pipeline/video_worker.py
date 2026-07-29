import os
import sys
import time
import tempfile
import uuid
import platform
import fal_client
from pipeline.utils import get_video_dimensions_and_duration, calculate_square_padding

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

def poll_job_status(handler, status_prefix, status_callback=None):
    """
    Polls the status of an asynchronous fal-client job until it completes or fails.
    """
    while True:
        status = handler.status(with_logs=True)
        
        if isinstance(status, fal_client.Queued):
            msg = f"{status_prefix}: Queued (position {status.position})"
            if status_callback:
                status_callback(msg)
        elif isinstance(status, fal_client.InProgress):
            msg = f"{status_prefix}: Processing..."
            if status.logs:
                # Append last log message if available
                last_log = status.logs[-1]["message"]
                msg += f" - {last_log}"
            if status_callback:
                status_callback(msg)
        elif isinstance(status, fal_client.Completed):
            msg = f"{status_prefix}: Completed!"
            if status_callback:
                status_callback(msg)
            break
            
        time.sleep(2.5)
        
    # Retrieve final result
    return handler.get()

_ENCODER_CACHE = None

# HEVC encoders, best-first. Hardware encoders are preferred but must be
# verified: hevc_nvenc lists in -encoders on any machine with the ffmpeg build,
# then fails at runtime with "Cannot load nvcuda.dll" if there is no NVIDIA GPU.
_HEVC_CANDIDATES = [
    ("hevc_videotoolbox", ["-q:v", "65", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]),
    ("hevc_nvenc", ["-preset", "slow", "-rc", "vbr", "-cq", "28"]),
    ("hevc_qsv", ["-global_quality", "28"]),
    ("libx265", ["-crf", "28", "-preset", "slow", "-tag:v", "hvc1"]),
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

    Presence in `ffmpeg -encoders` is necessary but not sufficient, so each
    candidate gets a one-frame smoke encode before being selected.

    Returns (encoder_name, opts_list).
    """
    global _ENCODER_CACHE
    if _ENCODER_CACHE:
        return _ENCODER_CACHE

    import subprocess

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


def process_video(video_path, prompt, fal_key=None, status_callback=None, outpaint_model="fal-ai/klingx", upscale_model="fal-ai/seedvr-upscale-video", upscale_only=False, sharpening=0.0, upscale_engine="fast"):
    """
    Asynchronously processes a local video file: outpainting it to a 1:1 square aspect ratio 
    and then upscaling the result to 4K.
    
    Args:
        video_path: Path to the local video file.
        prompt: Outpaint guidance prompt.
        fal_key: Optional fal.ai API key.
        status_callback: Callable receiving string status updates.
        outpaint_model: Model ID to use for video outpainting.
        upscale_model: Model ID to use for video upscaling.
        upscale_only: If True, skips outpainting/uploading and only upscales locally.
        sharpening: Contrast Adaptive Sharpening (CAS) strength (0.0 to 1.0).
        upscale_engine: "fast" (FFmpeg Lanczos+CAS) or "studio" (VapourSynth znedi3+FineSharp).
        
    Returns:
        tuple: (outpaint_video_url, upscaled_video_url)
    """
    if (not upscale_only) or (upscale_engine == "fal"):
        if fal_key:
            os.environ["FAL_KEY"] = fal_key
            
        if not os.environ.get("FAL_KEY"):
            raise ValueError("FAL_KEY must be set in the environment or passed as an argument.")

    if status_callback:
        status_callback("Analyzing video dimensions and duration...")

    # 1. Get video metadata
    width, height, duration = get_video_dimensions_and_duration(video_path)
    top, bottom, left, right = calculate_square_padding(width, height)
    
    if status_callback:
        status_callback(f"Native size: {width}x{height}, Duration: {duration:.2f}s. Padding: top={top}, bottom={bottom}, left={left}, right={right}")

    if upscale_only:
        temp_outpaint_path = video_path
        outpaint_url = None
    else:
        # 2. Upload video to fal.ai CDN
        if status_callback:
            status_callback("Uploading video file to fal.ai CDN...")
        video_url = fal_client.upload_file(video_path)
        
        # 3. Outpainting (if not already square)
        if top == 0 and bottom == 0 and left == 0 and right == 0:
            if status_callback:
                status_callback("Video is already square. Skipping outpainting phase.")
            outpaint_url = video_url
        else:
            if status_callback:
                status_callback(f"Submitting video outpainting job to {outpaint_model}...")
                
            arguments = {
                "video_url": video_url,
                "top": top,
                "bottom": bottom,
                "left": left,
                "right": right,
                "prompt": prompt
            }
            
            handler = fal_client.submit(outpaint_model, arguments=arguments)
            result = poll_job_status(handler, "Outpainting", status_callback)
            outpaint_url = extract_video_url(result)

        # 4. Upscaling
        if status_callback:
            status_callback("Downloading outpainted video for upscaling...")
            
        uid = uuid.uuid4().hex[:8]
        temp_outpaint_path = os.path.join(tempfile.gettempdir(), f"outpainted_video_temp_{uid}.mp4")
        import urllib.request
        urllib.request.urlretrieve(outpaint_url, temp_outpaint_path)
    
    # Determine output location
    uid = uuid.uuid4().hex[:8]
    output_video_path = os.path.join(tempfile.gettempdir(), f"delivery_4k_square_{uid}.mp4")
    if os.path.exists(output_video_path):
        os.unlink(output_video_path)
        
    import subprocess
    
    if upscale_engine == "fal":
        if status_callback:
            status_callback("Uploading video file to fal.ai CDN for cloud upscale...")

        if upscale_only or not outpaint_url:
            video_url_to_upscale = fal_client.upload_file(temp_outpaint_path)
        else:
            video_url_to_upscale = outpaint_url

        if status_callback:
            status_callback(f"Submitting video upscaling job to {upscale_model}...")

        arguments = {"video_url": video_url_to_upscale}
        handler = fal_client.submit(upscale_model, arguments=arguments)
        result = poll_job_status(handler, "Video Upscaling (FAL AI)", status_callback)
        upscaled_video_url = extract_video_url(result)

        if status_callback:
            status_callback("Downloading upscaled video from fal.ai...")

        temp_fal_vid = os.path.join(tempfile.gettempdir(), f"fal_upscaled_vid_{uid}.mp4")
        import urllib.request
        urllib.request.urlretrieve(upscaled_video_url, temp_fal_vid)

        # Probe for a working encoder
        encoder, encoder_opts = _pick_encoder()

        vf_filter = "scale=3840:3840:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp"
        if sharpening > 0.0:
            vf_filter += f",cas={sharpening}"

        cmd = [
            "ffmpeg", "-y",
            "-i", temp_fal_vid,
            "-vf", vf_filter,
            "-c:v", encoder
        ] + encoder_opts + [output_video_path]

        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        if os.path.exists(temp_fal_vid):
            os.unlink(temp_fal_vid)
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
# Double luma resolution using neural net predictor
clip = core.znedi3.nnedi3(clip, field=1, dh=True, nsize=0, nns=3, qual=2, pscrn=2)
# Finalize resize and scale chroma
clip = core.resize.Spline36(clip, width=3840, height=3840)
clip.set_output()
''')

        # Probe for a working encoder rather than assuming one per OS.
        encoder, encoder_opts = _pick_encoder()

        # Use the venv's vspipe if it isn't on PATH yet.
        vspipe = _find_vspipe()

        cmd = [
            "sh", "-c",
            f"'{vspipe}' -c y4m '{vpy_path}' - | ffmpeg -y -i - -vf 'cas=0.5' -c:v {encoder} {' '.join(encoder_opts)} '{output_video_path}'"
        ]

        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"FFmpeg pipeline crashed with error:\n{e.stderr.decode()}")
        finally:
            if os.path.exists(vpy_path):
                os.unlink(vpy_path)
    else:
        if status_callback:
            status_callback("Performing hardware-accelerated 4K upscale via FFmpeg...")

        # Build the filter graph
        vf_filter = "scale=3840:3840:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp"
        if sharpening > 0.0:
            vf_filter += f",cas={sharpening}"

        # Probe for a working encoder rather than assuming one per OS.
        encoder, encoder_opts = _pick_encoder()

        cmd = [
            "ffmpeg", "-y",
            "-i", temp_outpaint_path,
            "-vf", vf_filter,
            "-c:v", encoder
        ] + encoder_opts + [output_video_path]

        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    # Clean up intermediate video
    if not upscale_only and os.path.exists(temp_outpaint_path):
        os.unlink(temp_outpaint_path)
        
    return outpaint_url, output_video_path


