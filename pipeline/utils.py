import io
import json
import subprocess
import urllib.request
from PIL import Image

MAX_FAL_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2GB — generous ceiling for a 4K master


def fetch_fal_result(url: str, dest_path: str, timeout: float = 120.0,
                      max_bytes: int = MAX_FAL_DOWNLOAD_BYTES) -> None:
    """Download a fal.ai result URL to *dest_path*.

    Replaces bare `urllib.request.urlretrieve` calls, which have no timeout
    and no size cap and will follow any scheme/redirect. fal.ai result URLs
    are always https, so anything else is treated as unexpected.
    """
    if not url.lower().startswith("https://"):
        raise ValueError(f"Refusing to fetch non-https URL: {url!r}")

    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        total = 0
        with open(dest_path, "wb") as out:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError(
                        f"fal.ai result exceeded {max_bytes // (1024 * 1024)}MB cap: {url!r}"
                    )
                out.write(chunk)

def get_image_dimensions(image_path_or_bytes):
    """
    Reads an image from a file path or bytes and returns its dimensions.

    Args:
        image_path_or_bytes: Str path or bytes object.

    Returns:
        tuple: (width, height)
    """
    if isinstance(image_path_or_bytes, bytes):
        image_file = io.BytesIO(image_path_or_bytes)
    else:
        image_file = image_path_or_bytes

    with Image.open(image_file) as img:
        return img.size  # (width, height)

def get_video_dimensions_and_duration(video_path):
    """
    Reads a video from a file path and returns its dimensions and duration using ffprobe.

    Args:
        video_path: Path to the local video file.

    Returns:
        tuple: (width, height, duration_seconds)
    """
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height,duration", "-of", "json", video_path],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        data = json.loads(result.stdout)
        stream = data["streams"][0]
        width = int(stream.get("width", 0))
        height = int(stream.get("height", 0))
        duration = float(stream.get("duration", 0))

        if width == 0 or height == 0:
            raise ValueError(f"Could not determine video dimensions for {video_path}")

        return width, height, duration
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError, KeyError, IndexError) as e:
        raise ValueError(f"Could not read video metadata from {video_path}: {e}")

def calculate_square_padding(width, height):
    """
    Calculates symmetric padding required to pad the shorter dimension 
    of the media to hit a perfect 1:1 aspect ratio.
    
    Args:
        width: Int width of the asset.
        height: Int height of the asset.
        
    Returns:
        tuple: (top, bottom, left, right) padding as integers.
    """
    if width > height:
        # Landscape
        diff = width - height
        top = diff // 2
        bottom = diff - top
        left = 0
        right = 0
    elif height > width:
        # Portrait
        diff = height - width
        left = diff // 2
        right = diff - left
        top = 0
        bottom = 0
    else:
        # Already square
        top = bottom = left = right = 0
        
    return top, bottom, left, right

def has_audio_stream(video_path):
    """
    Checks if a video file contains at least one audio stream using ffprobe.
    """
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=codec_name", "-of", "json", video_path],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        data = json.loads(result.stdout)
        return len(data.get("streams", [])) > 0
    except Exception:
        return False

def log_pipeline_execution(item_name, kind, input_path, output_path, metrics, params=None):
    """
    Appends execution metrics, input/output paths, timing breakdown,
    and estimated cost to persistent log files inside logs/.

    Deliberately NOT inside output/ — output/ is mounted at /media by
    server/app.py (Range-capable static serving for the Reels/Compare
    players), so a log living there was silently public at
    /media/pipeline.log, leaking internal filesystem paths and per-job cost
    estimates to anyone who could reach the app.
    """
    import datetime
    from pathlib import Path

    out_dir = Path("logs")
    out_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    
    log_entry = {
        "timestamp": timestamp,
        "item_name": item_name,
        "kind": kind,
        "input_path": str(input_path) if input_path else None,
        "output_path": str(output_path),
        "metrics": metrics or {},
        "params": params or {},
    }
    
    # 1. JSON Lines log (logs/pipeline_log.jsonl)
    jsonl_path = out_dir / "pipeline_log.jsonl"
    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(log_entry) + "\n")

    # 2. Human-readable text log (logs/pipeline.log)
    txt_path = out_dir / "pipeline.log"
    total_t = metrics.get("total_time", 0.0) if metrics else 0.0
    total_c = metrics.get("total_cost", 0.0) if metrics else 0.0
    op_model = metrics.get("outpaint_model", "N/A") if metrics else "N/A"
    up_model = metrics.get("upscale_model", "N/A") if metrics else "N/A"
    
    with open(txt_path, "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] [{kind.upper()}] {item_name}\n")
        f.write(f"  Input File : {input_path}\n")
        f.write(f"  Out File   : {output_path}\n")
        f.write(f"  Total Time : {total_t}s | Est. Cost: ${total_c:.4f} USD\n")
        if metrics:
            f.write(f"  - Upload   : {metrics.get('upload_time', 0.0)}s\n")
            f.write(f"  - Outpaint : {metrics.get('outpaint_time', 0.0)}s | {op_model} | Cost: ${metrics.get('outpaint_cost', 0.0):.4f}\n")
            f.write(f"  - Upscale  : {metrics.get('upscale_time', 0.0)}s | {up_model} | Cost: ${metrics.get('upscale_cost', 0.0):.4f}\n")
            f.write(f"  - Master   : {metrics.get('master_time', 0.0)}s (Local Encode)\n")
        f.write("-" * 75 + "\n")
