"""LTX-2.3 Quality + LoRA end-to-end debug job.

Runs a single real fal.ai request (9 frames @ 480p ≈ $0.005–0.01) against
`fal-ai/ltx-2.3-quality/outpaint/lora` using a user-supplied Civitai LoRA to
verify that fal's SSRF-safe downloader accepts the Civitai token URL.

Usage:
    .venv/bin/python test_ltx_lora_job.py [civitai_download_url] [source_video]

Defaults are the Pixar Toon LoRA and the smallest clip in input/.
"""

import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

import fal_client  # noqa: E402

from pipeline.utils import attach_civitai_token, get_video_dimensions_and_duration  # noqa: E402

MODEL = "fal-ai/ltx-2.3-quality/outpaint/lora"
DEFAULT_LORA_URL = "https://civitai.com/api/download/models/2850271?fileId=2736407"
INPUT_DIR = Path("input")
OUTPUT_DIR = Path("output") / "testpipeline"

MP_RATE = 0.0024075  # USD per megapixel-frame for this endpoint


def console_log(msg):
    print(f"  [STATUS] {msg}", flush=True)


def check_reachable(url: str) -> None:
    """HEAD-style probe (1-byte range) to confirm the resolved URL is live."""
    req = urllib.request.Request(
        url,
        headers={
            "Range": "bytes=0-0",
            # Civitai's WAF 403s the default Python-urllib UA; its own CI
            # downloaders (requests, etc.) pass, so mimic a real client here.
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/126.0 Safari/537.36",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        ct = resp.headers.get("Content-Type", "?")
        print(f"  [PROBE] status={resp.status} content_type={ct} final={resp.geturl()[:120]}...", flush=True)


def main():
    lora_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LORA_URL
    source = sys.argv[2] if len(sys.argv) > 2 else None

    if not source:
        candidates = sorted(
            (p for p in INPUT_DIR.glob("**/*.mp4") if "preview" not in p.name.lower()),
            key=lambda p: p.stat().st_size,
        )
        source = str(candidates[0]) if candidates else None
    if not source or not os.path.exists(source):
        console_log(f"Source video not found: {source}")
        sys.exit(2)

    w, h, dur = get_video_dimensions_and_duration(source)
    console_log(f"Source: {source} ({w}x{h}, {dur:.1f}s, {os.path.getsize(source)/1e6:.1f} MB)")

    if not os.environ.get("FAL_KEY"):
        console_log("FAL_KEY missing from .env")
        sys.exit(2)

    if not os.environ.get("CIVITAI_KEY"):
        console_log("CIVITAI_KEY missing from .env — the token URL will NOT be auto-appended")
        sys.exit(2)

    resolved = attach_civitai_token(lora_url)
    masked = resolved.split("token=")[0] + "token=<redacted>" if "token=" in resolved else resolved
    console_log(f"LoRA URL (token auto-appended): {masked}")
    check_reachable(resolved)

    console_log("Uploading source to fal.ai CDN...")
    fal = fal_client.SyncClient(key=os.environ.get("FAL_KEY"))
    video_url = fal.upload_file(source)

    mp = (480 * 480 * 9) / 1_000_000.0
    console_log(f"Job cost estimate: {mp:.1f} MP -> ~${mp * MP_RATE:.4f}")

    arguments = {
        "prompt": "Pixar-style 3D animated toon look. Seamlessly extend the background environment beyond the original frame, matching texture, lighting and motion. High detail.",
        "video_url": video_url,
        "aspect_ratio": "1:1",
        "output_resolution": "480p",
        "num_frames": 9,
        "frames_per_second": 24,
        "num_inference_steps": 15,
        "guidance_scale": 1.0,
        "generate_audio": False,
        "enable_safety_checker": False,
        "loras": [{"path": resolved, "scale": 1.0, "transformer": "both"}],
    }

    console_log(f"Submitting to {MODEL}...")

    def on_queue_update(update):
        if isinstance(update, fal_client.Queued):
            print(f"  [FAL] queued at position {update.position}", flush=True)
        elif isinstance(update, fal_client.InProgress):
            for log in update.logs or []:
                print(f"  [FAL] {log.get('message')}", flush=True)

    t0 = time.time()
    result = fal_client.subscribe(
        MODEL,
        arguments=arguments,
        with_logs=True,
        on_queue_update=on_queue_update,
    )
    elapsed = time.time() - t0

    video = result.get("video", {})
    url = video.get("url", "")
    print("\n==================== RESULT ====================")
    print(f"seed   : {result.get('seed')}")
    print(f"prompt : {result.get('prompt')}")
    print(f"elapsed: {elapsed:.1f}s")
    print(f"video  : {url}")
    print(f"mp     : {mp:.1f} MP  est.paid: ~${mp * MP_RATE:.4f} (rounded up to next MP)")
    print("================================================")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = OUTPUT_DIR / f"ltx_lora_test_{ts}.mp4"
    console_log(f"Downloading result to {dest} ...")
    urllib.request.urlretrieve(url, dest)
    console_log(f"Saved {dest} ({dest.stat().st_size / 1e6:.1f} MB)")

    with open(OUTPUT_DIR / f"ltx_lora_test_{ts}.json", "w", encoding="utf-8") as f:
        import json
        safe_args = json.loads(json.dumps(arguments))
        for lora in safe_args.get("loras") or []:
            if "token=" in str(lora.get("path", "")):
                lora["path"] = str(lora["path"]).split("token=")[0] + "token=<redacted>"
        json.dump({"seed": result.get("seed"), "prompt": result.get("prompt"),
                   "video_url": url, "elapsed_s": round(elapsed, 1), "model": MODEL,
                   "lora_url": masked, "args": safe_args}, f, indent=2)
    console_log(f"Wrote {OUTPUT_DIR / f'ltx_lora_test_{ts}.json'}")


if __name__ == "__main__":
    main()