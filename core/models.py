"""Single source of truth for cloud model endpoints and their pricing.

The frontend (VideoPage) used to hardcode model IDs and per-second/per-MP
pricing that duplicated the backend's cost math, so the sidebar's model-endpoint
editor had no effect on what was actually submitted, and the two copies of the
price tables could silently drift. This module is the one place model IDs,
their human labels, and their pricing rules live. The backend serves it via
`/api/config`; the frontend renders options and the cost estimator from it.
"""

from __future__ import annotations

import json
import re

PRICING_VERSION = "2026-09-13"
PRICING_VERIFIED_AT = "2026-09-13"

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
        "unit_price_usd": "0.0024075",
        "credit_enabled": True,
        "pricing_version": PRICING_VERSION,
        "pricing_verified_at": PRICING_VERIFIED_AT,
        "pricing_source": "https://fal.ai/models/fal-ai/ltx-2.3-quality/outpaint",
        "rounding_rule": "ceil total generated megapixel-frames to a whole megapixel-frame",
        "constraints": {"fps": 24, "min_frames": 9, "max_frames": 481, "resolutions": ["480p", "720p", "1080p"]},
        "resolutions": {"480p": 480, "720p": 720, "1080p": 1080},
        "default_resolution": "720p",
    },
    {
        "label": "LTX 2.3 Quality + LoRA",
        "model": "fal-ai/ltx-2.3-quality/outpaint/lora",
        "pricing_kind": "per_mp",
        "price": 0.0024075,
        "unit_price_usd": "0.0024075",
        "credit_enabled": True,
        "pricing_version": PRICING_VERSION,
        "pricing_verified_at": PRICING_VERIFIED_AT,
        "pricing_source": "https://fal.ai/models/fal-ai/ltx-2.3-quality/outpaint/lora",
        "rounding_rule": "ceil total generated megapixel-frames to a whole megapixel-frame",
        "constraints": {"fps": 24, "min_frames": 9, "max_frames": 481, "resolutions": ["480p", "720p", "1080p"], "max_loras": 3},
        "resolutions": {"480p": 480, "720p": 720, "1080p": 1080},
        "default_resolution": "720p",
    },
    {
        "label": "Luma Ray-2 Reframe",
        "model": "fal-ai/luma-dream-machine/ray-2-flash/reframe",
        "pricing_kind": "per_second",
        "price": 0.06,
        "unit_price_usd": "0.06",
        "credit_enabled": True,
        "pricing_version": PRICING_VERSION,
        "pricing_verified_at": PRICING_VERIFIED_AT,
        "pricing_source": "https://fal.ai/models/fal-ai/luma-dream-machine/ray-2-flash/reframe",
        "rounding_rule": "ceil source duration to whole seconds",
        "constraints": {"aspect_ratios": ["1:1", "16:9", "9:16"]},
        "aspect_ratios": ["1:1", "16:9", "9:16"],
    },
    {
        "label": "Wan VACE 14B",
        "model": "fal-ai/wan-vace-14b/outpainting",
        "pricing_kind": "per_second",
        "price": 0.08,
        "unit_price_usd": "0.08",
        "resolution_rates": {"480p": "0.04", "580p": "0.06", "720p": "0.08"},
        "default_resolution": "720p",
        "credit_enabled": True,
        "pricing_version": PRICING_VERSION,
        "pricing_verified_at": PRICING_VERIFIED_AT,
        "pricing_source": "https://fal.ai/models/fal-ai/wan-vace-14b/outpainting",
        "rounding_rule": "bill explicit output frames as (frames - 1) / 16 seconds",
        "constraints": {"fps": 16, "min_frames": 17, "max_frames": 241, "resolutions": ["480p", "580p", "720p"], "max_expand_ratio_per_side": 1.0},
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
        "base_rates_usd": {"1080p": "0.0072", "2k": "0.0144", "4k": "0.0288"},
        "fps_multiplier": {"30fps": 1.0, "60fps": 2.0},
        "tier_multiplier": {"fast": 1.0, "standard": 1.0, "pro": 10.0},
        "credit_enabled": True,
        "pricing_version": PRICING_VERSION,
        "pricing_verified_at": PRICING_VERIFIED_AT,
        "pricing_source": "https://fal.ai/models/fal-ai/bytedance-upscaler/upscale/video",
        "rounding_rule": "ceil source duration to whole seconds",
        "constraints": {"resolutions": ["1080p", "2k", "4k"], "frame_rates": ["30fps", "60fps"], "tiers": ["fast", "standard", "pro"]},
    },
    {
        "label": "SeedVR2 Video",
        "model": "fal-ai/seedvr/upscale/video",
        "pricing_kind": "per_mp",
        "price": 0.001,
        "unit_price_usd": "0.001",
        "credit_enabled": True,
        "pricing_version": PRICING_VERSION,
        "pricing_verified_at": PRICING_VERIFIED_AT,
        "pricing_source": "https://fal.ai/models/fal-ai/seedvr/upscale/video",
        "rounding_rule": "exact output megapixel-frames; final credit charge rounds up",
        "constraints": {"target_resolutions": ["720p", "1080p", "2160p"]},
        "resolutions": {"720p": 720, "1080p": 1080, "2160p": 2160},
    },
]

# ---------------------------------------------------------------------------
# Image outpainting / upscaling models (defaults — administrators can override)
# ---------------------------------------------------------------------------
IMAGE_MODELS = {
    "outpaint_img": "fal-ai/image-apps-v2/outpaint",
    "upscale_img": "fal-ai/clarity-upscaler",
}

IMAGE_OUTPAINT = [
    {
        "label": "Image Apps Outpaint",
        "model": "fal-ai/image-apps-v2/outpaint",
        "pricing_kind": "per_mp",
        "price": 0.035,
        "unit_price_usd": "0.035",
        "credit_enabled": True,
        "pricing_version": PRICING_VERSION,
        "pricing_verified_at": PRICING_VERIFIED_AT,
        "pricing_source": "https://fal.ai/models/fal-ai/image-apps-v2/outpaint",
        "rounding_rule": "exact output megapixels; final credit charge rounds up",
        "constraints": {"max_expand_per_side": 700, "max_input_long_side": 1400},
        "max_expand_per_side": 700,
    },
]

# Image upscale catalog (mirrors the stock options the Image extender offers).
# fal.ai image upscalers bill per call with list prices that change often, so
# no hardcoded price is stored here — live pricing/requirements are pulled on
# demand via GET /api/config/model-info (see server/routers/config.py).
IMAGE_UPSCALE = [
    {
        "label": "Clarity Upscaler",
        "model": "fal-ai/clarity-upscaler",
        "pricing_kind": "per_mp",
        "price": 0.03,
        "unit_price_usd": "0.03",
        "default_factor": 2.0,
        "credit_enabled": True,
        "pricing_version": PRICING_VERSION,
        "pricing_verified_at": PRICING_VERIFIED_AT,
        "pricing_source": "https://fal.ai/models/fal-ai/clarity-upscaler",
        "rounding_rule": "exact output megapixels; final credit charge rounds up",
        "constraints": {"upscale_factor": 2.0},
    },
    {"label": "CCSR", "model": "fal-ai/ccsr", "credit_enabled": False, "pricing_kind": "compute_time"},
    {"label": "AuraSR", "model": "fal-ai/aura-sr", "credit_enabled": False, "pricing_kind": "compute_time"},
    {"label": "ESRGAN", "model": "fal-ai/esrgan", "credit_enabled": False, "pricing_kind": "compute_time"},
]

# Default video endpoints (the administrator editor can override these two; they
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
    any administrator overrides (the sidebar editor writes these via update_models).

    The catalogs carry a synthetic 'kind' so the frontend can tell the
    outpaint list from the upscale list without hardcoding either. When a
    sidebar override is NOT one of the stock models, it is APPENDED as a
    ``CUSTOM(short-name)`` entry (``is_custom: True``) so the extender pages
    can render it as its own button with its requirements/cost panel —
    instead of silently renaming a stock option.
    """
    outpaint_vid = model_overrides.get("outpaint_vid", DEFAULT_VIDEO_MODELS["outpaint_vid"])
    upscale_vid = model_overrides.get("upscale_vid", DEFAULT_VIDEO_MODELS["upscale_vid"])
    outpaint_img = model_overrides.get("outpaint_img", IMAGE_MODELS["outpaint_img"])
    upscale_img = model_overrides.get("upscale_img", IMAGE_MODELS["upscale_img"])

    def _with_custom(catalog, override, kind):
        entries = [{"kind": kind, "is_custom": False, **e} for e in catalog]
        norm = normalize_model_id(override or "")
        if norm and norm.lower() not in {e["model"].lower() for e in entries}:
            entries.append(custom_entry(norm, kind))
        return entries

    return {
        "outpaint_vid": outpaint_vid,
        "upscale_vid": upscale_vid,
        "outpaint_img": outpaint_img,
        "upscale_img": upscale_img,
        "video_outpaint_catalog": _with_custom(VIDEO_OUTPAINT, outpaint_vid, "outpaint"),
        "video_upscale_catalog": _with_custom(VIDEO_UPSCALE, upscale_vid, "upscale"),
        "image_upscale_catalog": _with_custom(IMAGE_UPSCALE, upscale_img, "image_upscale"),
        "image_outpaint_catalog": _with_custom(IMAGE_OUTPAINT, outpaint_img, "image_outpaint"),
        "pricing_version": PRICING_VERSION,
    }


def normalize_model_id(raw: str) -> str:
    """Normalize a user-pasted fal.ai model id.

    Accepts bare ids (``fal-ai/foo/bar``) as well as playground/run URLs
    (``https://fal.run/fal-ai/foo/bar`` or ``https://fal.ai/models/...``,
    with or without query strings/fragments).
    """
    s = (raw or "").strip().strip("/")
    if not s:
        return ""
    # Drop ?query and #fragment from pasted playground URLs.
    s = re.split(r"[?#]", s, maxsplit=1)[0].strip().strip("/")
    low = s.lower()
    for marker in ("fal.run/", "fal.ai/models/"):
        idx = low.find(marker)
        if idx != -1:
            s = s[idx + len(marker):].strip("/")
            break
    return s.strip("/")


def short_name(model_id: str, max_len: int = 28) -> str:
    """Short display name for a custom model id (last path segment)."""
    s = normalize_model_id(model_id)
    short = s.split("/")[-1] if s else "custom"
    short = short or "custom"
    return short if len(short) <= max_len else short[: max_len - 1] + "…"


def custom_entry(model_id: str, kind: str) -> dict:
    """Build the synthetic ``CUSTOM(...)`` catalog entry for an override id.

    Pricing is a deliberately conservative estimate (same fallback rates the
    worker's cost math uses for unknown models) — the live per-model price,
    required inputs and expected outputs are pulled on demand via
    GET /api/config/model-info and shown in the extender's custom-model panel.
    """
    norm = normalize_model_id(model_id)
    label = f"CUSTOM({short_name(norm)})"
    if kind == "outpaint":
        return {
            "kind": kind,
            "is_custom": True,
            "label": label,
            "model": norm,
            "pricing_kind": "per_second",
            "price": 0.06,
            "credit_enabled": False,
            "cost_note": "Estimate only — pull live pricing via MODEL INFO before rendering.",
            "requirements": "A saved personal Fal key; source clip is uploaded by the pipeline.",
            "expects": "Sends {video_url, prompt, aspect_ratio: '1:1'}; expects a video URL back. "
                       "Models with a different input schema may reject the job — check MODEL INFO.",
        }
    if kind == "image_upscale":
        return {
            "kind": kind,
            "is_custom": True,
            "label": label,
            "model": norm,
            "pricing_kind": "unknown",
            "price": None,
            "credit_enabled": False,
            "cost_note": "No estimate stored — pull live pricing via MODEL INFO before rendering.",
            "requirements": "A saved personal Fal key; the image is uploaded by the pipeline.",
            "expects": "Sends {image_url}; expects an image URL back. "
                       "Models with a different input schema may reject the job — check MODEL INFO.",
        }
    return {
        "kind": kind,
        "is_custom": True,
        "label": label,
        "model": norm,
        "pricing_kind": "per_second",
        "price": 0.02,
        "credit_enabled": False,
        "cost_note": "Estimate only — pull live pricing via MODEL INFO before rendering.",
        "requirements": "A saved personal Fal key; the clip is uploaded by the pipeline.",
        "expects": "Sends {video_url, ...}; expects a video URL back. "
                   "Models with a different input schema may reject the job — check MODEL INFO.",
    }


def _catalog_match(model_id: str, catalog: list[dict]) -> bool:
    mid = (model_id or "").lower()
    if not mid:
        return False
    return any(e["model"].lower() in mid or mid in e["model"].lower() for e in catalog)


def is_stock_outpaint_model(model_id: str) -> bool:
    """True when the id matches a tuned stock video-outpaint entry."""
    return _catalog_match(model_id, VIDEO_OUTPAINT)


def is_stock_upscale_model(model_id: str) -> bool:
    """True when the id matches a tuned stock video-upscale entry."""
    return _catalog_match(model_id, VIDEO_UPSCALE)


def is_stock_image_outpaint_model(model_id: str) -> bool:
    """True when the id matches a tuned stock image-outpaint entry."""
    return _catalog_match(model_id, IMAGE_OUTPAINT)


def is_stock_image_upscale_model(model_id: str) -> bool:
    """True when the id matches a stock image-upscale entry."""
    return _catalog_match(model_id, IMAGE_UPSCALE)


_CUSTOM_ARG_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def parse_custom_args(raw, *, limit_keys: int = 20, limit_str: int = 2000) -> dict:
    """Validate user-supplied extra fal.ai arguments for CUSTOM(...) models.

    Only a flat object of string/number/boolean scalars is accepted — this
    covers output-shape knobs (aspect_ratio, resolution), tuning numbers and
    flags, which is the generalizable subset. Nested objects, arrays and
    media/file params are rejected: media URLs always come from the
    pipeline's own CDN upload, never from user input.

    Returns {} for empty input. Raises ValueError with a human message.
    """
    if raw is None or raw == "" or raw == {}:
        return {}
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            raise ValueError("must be a JSON object, e.g. {\"resolution\": \"720p\"}")
    elif isinstance(raw, dict):
        data = raw
    else:
        raise ValueError("must be a JSON object, e.g. {\"resolution\": \"720p\"}")
    if not isinstance(data, dict) or isinstance(data, list):
        raise ValueError("must be a JSON object, e.g. {\"resolution\": \"720p\"}")
    if len(data) > limit_keys:
        raise ValueError(f"at most {limit_keys} keys")
    out: dict = {}
    for k, v in data.items():
        if not isinstance(k, str) or not _CUSTOM_ARG_KEY_RE.match(k):
            raise ValueError(f"invalid key {k!r}: use letters/digits/underscore")
        if isinstance(v, str):
            if len(v) > limit_str:
                raise ValueError(f"{k}: text too long (max {limit_str} chars)")
        elif isinstance(v, bool) or isinstance(v, (int, float)) or v is None:
            pass
        else:
            raise ValueError(f"{k}: must be a string, number or boolean (no nested objects/arrays)")
        out[k] = v
    return out


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
    # Generic fallback matching the worker's default branch. Unknown ids are
    # user-supplied customs — label them as such so metrics stay truthful.
    dur_calc = duration if duration > 0 else 5.0
    if model_id and model_id.strip():
        return f"CUSTOM({short_name(model_id)})", dur_calc * 0.06
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
    if model_id and model_id.strip():
        return f"CUSTOM({short_name(model_id)})", max(0.08, dur_calc * 0.02)
    return "Video Upscale", max(0.08, dur_calc * 0.02)