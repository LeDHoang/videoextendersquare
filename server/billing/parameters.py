"""Canonical processing parameters shared by quote and submit endpoints."""

from __future__ import annotations

from typing import Any, Mapping

from core import models


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


def image_parameters(raw: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "prompt": _text(raw.get("prompt")),
        "upscale_only": _bool(raw.get("upscale_only")),
        "sharpening": _float(raw.get("sharpening"), 0.0),
        "upscale_engine": _text(raw.get("upscale_engine"), "fast").casefold(),
        "upscale_model": models.normalize_model_id(
            _text(raw.get("upscale_model"), models.IMAGE_MODELS["upscale_img"])
        ),
        "outpaint_model": models.normalize_model_id(
            _text(raw.get("outpaint_model"), models.IMAGE_MODELS["outpaint_img"])
        ),
        "custom_outpaint_args": dict(raw.get("custom_outpaint_args") or {}),
        "custom_upscale_args": dict(raw.get("custom_upscale_args") or {}),
    }


def video_parameters(raw: Mapping[str, Any]) -> dict[str, Any]:
    loras = raw.get("ltx_loras") or []
    return {
        "prompt": _text(raw.get("prompt")),
        "upscale_only": _bool(raw.get("upscale_only")),
        "upscale_engine": _text(raw.get("upscale_engine"), "fast").casefold(),
        "sharpening": _float(raw.get("sharpening"), 0.0),
        "outpaint_model": models.normalize_model_id(
            _text(raw.get("outpaint_model"), models.DEFAULT_VIDEO_MODELS["outpaint_vid"])
        ),
        "upscale_model": models.normalize_model_id(
            _text(raw.get("upscale_model"), models.DEFAULT_VIDEO_MODELS["upscale_vid"])
        ),
        "ltx_resolution": _text(raw.get("ltx_resolution"), "720p"),
        "ltx_audio": _bool(raw.get("ltx_audio"), True),
        "ltx_guidance": _float(raw.get("ltx_guidance"), 1.0),
        "ltx_prompt_expansion": _bool(raw.get("ltx_prompt_expansion")),
        "ltx_negative_prompt": _text(raw.get("ltx_negative_prompt")),
        "ltx_loras": list(loras) if isinstance(loras, list) else [],
        "wan_resolution": _text(raw.get("wan_resolution"), "720p"),
        "seedvr_factor": _float(raw.get("seedvr_factor"), 2.0),
        "seedvr_target": _text(raw.get("seedvr_target"), "1080p"),
        "bytedance_target_res": _text(raw.get("bytedance_target_res"), "4k"),
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
