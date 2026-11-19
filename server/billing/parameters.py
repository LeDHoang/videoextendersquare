"""Canonical processing parameters shared by quote and submit endpoints."""

from __future__ import annotations

from typing import Any, Mapping

from sqlalchemy.orm import Session

from core import models
from server.social.models import AppSetting

# app_settings key of the administrator's model overrides (PUT /api/config/models).
MODEL_OVERRIDES_KEY = "model_overrides"
CATALOG_DEFAULTS = {**models.IMAGE_MODELS, **models.DEFAULT_VIDEO_MODELS}
# The LTX negative prompt a job uses when the request names none (quote and job alike).
LTX_NEGATIVE_PROMPT = "yellow tint, sepia, warm cast, color distortion, discoloration, overexposure, oversaturated"


def model_defaults(db: Session) -> dict[str, str]:
    """The model each slot uses when a request names none: the override, else the catalog default.

    The one resolver for quotes, jobs and /api/config, so a quote and its job
    price the same model.
    """
    row = db.get(AppSetting, MODEL_OVERRIDES_KEY)
    stored = row.value if row is not None and isinstance(row.value, dict) else {}
    return {slot: str(stored.get(slot) or default) for slot, default in CATALOG_DEFAULTS.items()}


def _model(raw: Mapping[str, Any], field: str, default: str) -> str:
    # A missing or empty field takes the default.
    return models.normalize_model_id(_text(raw.get(field))) or default


def _bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "yes", "on"}
    return bool(value)


def _float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _text(value: Any, default: str = "") -> str:
    return str(value if value is not None else default)


def image_parameters(raw: Mapping[str, Any], defaults: Mapping[str, str] = CATALOG_DEFAULTS) -> dict[str, Any]:
    return {
        "prompt": _text(raw.get("prompt")),
        "upscale_only": _bool(raw.get("upscale_only")),
        "sharpening": _float(raw.get("sharpening"), 0.0),
        "upscale_engine": _text(raw.get("upscale_engine"), "fast").casefold(),
        "upscale_model": _model(raw, "upscale_model", defaults["upscale_img"]),
        "outpaint_model": _model(raw, "outpaint_model", defaults["outpaint_img"]),
        "custom_outpaint_args": dict(raw.get("custom_outpaint_args") or {}),
        "custom_upscale_args": dict(raw.get("custom_upscale_args") or {}),
    }


def video_parameters(raw: Mapping[str, Any], defaults: Mapping[str, str] = CATALOG_DEFAULTS) -> dict[str, Any]:
    loras = raw.get("ltx_loras") or []
    return {
        "prompt": _text(raw.get("prompt")),
        "upscale_only": _bool(raw.get("upscale_only")),
        "upscale_engine": _text(raw.get("upscale_engine"), "fast").casefold(),
        "sharpening": _float(raw.get("sharpening"), 0.0),
        "outpaint_model": _model(raw, "outpaint_model", defaults["outpaint_vid"]),
        "upscale_model": _model(raw, "upscale_model", defaults["upscale_vid"]),
        "ltx_resolution": _text(raw.get("ltx_resolution"), "720p"),
        "ltx_audio": _bool(raw.get("ltx_audio"), True),
        "ltx_guidance": _float(raw.get("ltx_guidance"), 1.0),
        "ltx_prompt_expansion": _bool(raw.get("ltx_prompt_expansion")),
        "ltx_negative_prompt": _text(raw.get("ltx_negative_prompt"), LTX_NEGATIVE_PROMPT),
        "ltx_loras": list(loras) if isinstance(loras, list) else [],
        "luma_resolution": _text(raw.get("luma_resolution"), "1080p"),
        "seedvr_factor": _float(raw.get("seedvr_factor"), 2.0),
        "seedvr_target": _text(raw.get("seedvr_target"), "1080p"),
        "bytedance_target_res": _text(raw.get("bytedance_target_res"), "2k"),
        "bytedance_target_fps": _text(raw.get("bytedance_target_fps"), "30fps"),
        "bytedance_tier": _text(raw.get("bytedance_tier"), "fast"),
        "bytedance_preset": _text(raw.get("bytedance_preset"), "general"),
        "bytedance_fidelity": _text(raw.get("bytedance_fidelity"), "medium"),
        "trim_enabled": _bool(raw.get("trim_enabled")),
        "trim_start": _float(raw.get("trim_start"), 0.0),
        "trim_duration": _float(raw.get("trim_duration"), 15.0),
        "custom_outpaint_args": dict(raw.get("custom_outpaint_args") or {}),
        "custom_upscale_args": dict(raw.get("custom_upscale_args") or {}),
    }
