"""Single source of truth for cloud model endpoints and their pricing.

The frontend (VideoPage) used to hardcode model IDs and per-second/per-MP
pricing that duplicated the backend's cost math, so the sidebar's model-endpoint
editor had no effect on what was actually submitted, and the two copies of the
price tables could silently drift. This module is the one place model IDs,
their human labels, and their pricing rules live. The backend serves it via
`/api/config`; the frontend renders options and the cost estimator from it.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Video outpainting models
# ---------------------------------------------------------------------------
# pricing_kind:
#   "per_mp"     — billed per megapixel·frame: price is USD per MP-frame
#   "per_second" — billed per second of source duration: price is USD/s
# Each entry also carries the fields the worker needs to build its fal.ai
# arguments (matched by a substring on the model id, as the worker already did).

VIDEO_OUTPAINT = [
    {
        "label": "LTX 2.3 Quality",
        "model": "fal-ai/ltx-2.3-quality/outpaint",
        "pricing_kind": "per_mp",
        "price": 0.0024075,
        "resolutions": {"480p": 480, "720p": 720, "1080p": 1080},
        "default_resolution": "720p",
    },
    {
        "label": "LTX 2.3 Quality + LoRA",
        "model": "fal-ai/ltx-2.3-quality/outpaint/lora",
        "pricing_kind": "per_mp",
        "price": 0.0024075,
        "resolutions": {"480p": 480, "720p": 720, "1080p": 1080},
        "default_resolution": "720p",
    },
    {
        "label": "Luma Ray-2 Reframe",
        "model": "fal-ai/luma-dream-machine/ray-2-flash/reframe",
        "pricing_kind": "per_second",
        "price": 0.06,
        "aspect_ratios": ["1:1", "16:9", "9:16"],
    },
    {
        "label": "Wan VACE 14B",
        "model": "fal-ai/wan-vace-14b/video-to-video",
        "pricing_kind": "per_second",
        "price": 0.08,
        "aspect_ratios": ["1:1", "16:9", "9:16"],
    },
]


# ---------------------------------------------------------------------------
# Video fal.ai upscaling models
# ---------------------------------------------------------------------------
# pricing_kind:
#   "per_mp"     — price is USD per MP-frame (SeedVR)
#   "per_second" — price is USD per second of source duration, with optional
#                  multipliers keyed off the bytedance resolution/fps/tier.

VIDEO_UPSCALE = [
    {
        "label": "Bytedance Upscaler",
        "model": "fal-ai/bytedance-upscaler/upscale/video",
        "pricing_kind": "per_second",
        "base_rates": {"1080p": 0.0072, "2k": 0.0144, "4k": 0.0288},
        "fps_multiplier": {"30fps": 1.0, "60fps": 2.0},
        "tier_multiplier": {"fast": 1.0, "standard": 1.0, "pro": 10.0},
    },
    {
        "label": "SeedVR2 Video",
        "model": "fal-ai/seedvr/upscale/video",
        "pricing_kind": "per_mp",
        "price": 0.001,
        "resolutions": {"720p": 720, "1080p": 1080, "2160p": 2160},
    },
    {
        "label": "Kling Video",
        "model": "fal-ai/kling-video/v1.5/pro/upscale",
        "pricing_kind": "per_second",
        "price": 0.014,
    },
    {
        "label": "ESRGAN Video",
        "model": "fal-ai/esrgan-video",
        "pricing_kind": "per_second",
        "price": 0.003,
    },
]

# ---------------------------------------------------------------------------
# Image outpainting / upscaling models (defaults — the sidebar can override)
# ---------------------------------------------------------------------------
IMAGE_MODELS = {
    "outpaint_img": "fal-ai/flux/outpaint",
    "upscale_img": "fal-ai/clarity-upscaler",
}

# Default video endpoints (the sidebar editor can override these two; they
# slot into the VIDEO_OUTPAINT/VIDEO_UPSCALE catalogs above when not overridden).
DEFAULT_VIDEO_MODELS = {
    "outpaint_vid": VIDEO_OUTPAINT[0]["model"],
    "upscale_vid": VIDEO_UPSCALE[0]["model"],
}


def video_outpaint_catalog() -> list[dict]:
    """Return the outpaint catalog (labels + model ids + pricing rules)."""
    return VIDEO_OUTPAINT


def video_upscale_catalog() -> list[dict]:
    """Return the fal upscale catalog (labels + model ids + pricing rules)."""
    return VIDEO_UPSCALE


def config_payload(model_overrides: dict) -> dict:
    """Build the /api/config 'models' section from the static catalogs plus
    any user overrides (the sidebar editor writes these via update_models).

    The catalogs carry a synthetic 'kind' so the frontend can tell the
    outpaint list from the upscale list without hardcoding either. When a
    sidebar override replaces the default endpoint, the override is spliced
    into the matching catalog entry so the frontend's option dropdown and the
    submitted model id both reflect it.
    """
    outpaint_vid = model_overrides.get("outpaint_vid", DEFAULT_VIDEO_MODELS["outpaint_vid"])
    upscale_vid = model_overrides.get("upscale_vid", DEFAULT_VIDEO_MODELS["upscale_vid"])

    def _splice(catalog, override, kind):
        entries = [{"kind": kind, **e} for e in catalog]
        if override and override not in {e["model"] for e in entries}:
            # Replace the default entry's model id with the override so the
            # catalog stays the single source of truth for what's submitted.
            for e in entries:
                if e["model"] == DEFAULT_VIDEO_MODELS.get(f"{kind}_vid"):
                    e["model"] = override
                    break
        return entries

    outpaint = _splice(VIDEO_OUTPAINT, outpaint_vid, "outpaint")
    upscale = _splice(VIDEO_UPSCALE, upscale_vid, "upscale")
    return {
        "outpaint_vid": outpaint_vid,
        "upscale_vid": upscale_vid,
        "outpaint_img": model_overrides.get("outpaint_img", IMAGE_MODELS["outpaint_img"]),
        "upscale_img": model_overrides.get("upscale_img", IMAGE_MODELS["upscale_img"]),
        "video_outpaint_catalog": outpaint,
        "video_upscale_catalog": upscale,
    }


def estimate_outpaint_cost(model_id: str, *, duration: float, resolution: str | None = None) -> tuple[str, float]:
    """Return (label, estimated USD) for a video outpaint job.

    Mirrors pipeline/video_worker.py's inline math but from this single
    catalog, so the frontend estimator and the worker agree.
    """
    mid = (model_id or "").lower()
    for entry in VIDEO_OUTPAINT:
        if entry["model"].lower() in mid or mid in entry["model"].lower():
            if entry["pricing_kind"] == "per_second":
                return entry["label"], (duration if duration > 0 else 5.0) * entry["price"]
            # per_mp
            w = entry["resolutions"].get(resolution or entry.get("default_resolution"), 720)
            frames = int(duration * 24) if duration > 0 else 121
            mp = (w * w * frames) / 1000000.0
            return entry["label"], mp * entry["price"]
    # Generic fallback matching the worker's default branch.
    dur_calc = duration if duration > 0 else 5.0
    return "Video Outpaint", dur_calc * 0.06


def estimate_upscale_cost(
    model_id: str,
    *,
    duration: float,
    seedvr_target: str = "1080p",
    seedvr_factor: float = 2.0,
    bytedance_res: str = "4k",
    bytedance_fps: str = "30fps",
    bytedance_tier: str = "fast",
) -> tuple[str, float]:
    """Return (label, estimated USD) for a video fal.ai upscale job."""
    mid = (model_id or "").lower()
    for entry in VIDEO_UPSCALE:
        if entry["model"].lower() in mid or mid in entry["model"].lower():
            if entry["pricing_kind"] == "per_second":
                if "bytedance" in mid:
                    base = entry["base_rates"].get(bytedance_res, 0.0288)
                    rate = base * entry["fps_multiplier"].get(bytedance_fps, 1.0) * entry["tier_multiplier"].get(bytedance_tier, 1.0)
                    return f"Bytedance ({bytedance_res}, {bytedance_fps}, {bytedance_tier})", (duration if duration > 0 else 5.0) * rate
                dur_calc = duration if duration > 0 else 5.0
                return entry["label"], dur_calc * entry["price"]
            # per_mp (SeedVR)
            w = entry["resolutions"].get(seedvr_target, 1080)
            frames = int(duration * 24) if duration > 0 else 121
            mp = (w * w * frames) / 1000000.0
            return entry["label"], mp * entry["price"]
    dur_calc = duration if duration > 0 else 5.0
    return "Video Upscale", max(0.08, dur_calc * 0.02)