"Authoritative ECHO Credit pricing for supported Fal-backed stages."

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from typing import Any

from core import models

CREDIT_USD = Decimal("0.01")
PRICE_MULTIPLIER = Decimal("1.35")
MICRO_USD = Decimal("1000000")
QUOTE_TTL_SECONDS = 600
IMAGE_OUTPAINT_MAX_SIDE = 1400


class PricingError(ValueError):
    pass


@dataclass(frozen=True)
class StageCost:
    stage: str
    label: str
    model: str
    provider_cost_usd: Decimal
    credits: int
    pricing_version: str
    pricing_verified_at: str
    pricing_source: str
    rounding_rule: str
    constraints: dict[str, Any]
    details: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "label": self.label,
            "model": self.model,
            "provider_cost_usd": format(self.provider_cost_usd.quantize(Decimal("0.000001")), "f"),
            "provider_cost_microusd": int(
                (self.provider_cost_usd * MICRO_USD).to_integral_value(rounding=ROUND_CEILING)
            ),
            "credits": self.credits,
            "pricing_version": self.pricing_version,
            "pricing_verified_at": self.pricing_verified_at,
            "pricing_source": self.pricing_source,
            "rounding_rule": self.rounding_rule,
            "constraints": self.constraints,
            "details": self.details,
        }


def credits_for_cost(cost: Decimal) -> int:
    if cost <= 0:
        return 0
    return int((cost * PRICE_MULTIPLIER * 100).to_integral_value(rounding=ROUND_CEILING))


def _decimal(value: Any) -> Decimal:
    return Decimal(str(value))


def _ceil_seconds(duration: float) -> Decimal:
    return _decimal(max(0.0, duration)).to_integral_value(rounding=ROUND_CEILING)


def _catalog_entry(model_id: str, catalog: list[dict]) -> dict | None:
    normalized = models.normalize_model_id(model_id).casefold()
    return next((entry for entry in catalog if entry["model"].casefold() == normalized), None)


def _effective_duration(duration: float, params: dict[str, Any]) -> Decimal:
    source = max(0.0, float(duration or 0.0))
    if not bool(params.get("trim_enabled", False)):
        return _decimal(source)
    start = max(0.0, float(params.get("trim_start", 0.0) or 0.0))
    requested = min(15.0, max(1.0, float(params.get("trim_duration", 15.0) or 15.0)))
    available = max(0.0, source - start)
    return _decimal(min(requested, available))


def _frames(duration: Decimal, fps: int, *, minimum: int, maximum: int) -> int:
    count = int((duration * fps).to_integral_value(rounding=ROUND_HALF_UP)) + 1
    if count < minimum:
        count = minimum
    if count > maximum:
        raise PricingError(
            f"Selected model supports at most {(maximum - 1) / fps:.2f}s at {fps}fps; trim the source."
        )
    return count


def _stage(stage: str, entry: dict, cost: Decimal, **details: Any) -> StageCost:
    if not entry.get("credit_enabled"):
        raise PricingError(f"{entry.get('label', entry.get('model', 'Model'))} requires a personal Fal key.")
    return StageCost(
        stage=stage,
        label=entry["label"],
        model=entry["model"],
        provider_cost_usd=cost,
        credits=credits_for_cost(cost),
        pricing_version=str(entry.get("pricing_version") or models.PRICING_VERSION),
        pricing_verified_at=str(entry.get("pricing_verified_at") or models.PRICING_VERIFIED_AT),
        pricing_source=str(entry.get("pricing_source") or ""),
        rounding_rule=str(entry.get("rounding_rule") or "final credit charge rounds up"),
        constraints=dict(entry.get("constraints") or {}),
        details=details,
    )


def quote_video(
    *, width: int, height: int, duration: float, params: dict[str, Any],
    source_fps: float | None = None, source_frames: int | None = None,
) -> dict[str, Any]:
    effective = _effective_duration(duration, params)
    if effective <= 0:
        raise PricingError("The selected video segment has no billable duration.")

    stages: list[StageCost] = []
    upscale_only = bool(params.get("upscale_only", False))
    is_square = int(width) == int(height)
    outpaint_model = models.normalize_model_id(
        str(params.get("outpaint_model") or models.DEFAULT_VIDEO_MODELS["outpaint_vid"])
    )
    outpaint_entry = _catalog_entry(outpaint_model, models.VIDEO_OUTPAINT)
    outpaint_frames = None
    outpaint_fps = None

    if not upscale_only and not is_square:
        if not outpaint_entry:
            raise PricingError("Custom video outpainting models require a personal Fal key.")
        model_lower = outpaint_model.casefold()
        if "ltx-2.3-quality" in model_lower:
            resolution = str(params.get("ltx_resolution") or outpaint_entry.get("default_resolution", "720p"))
            if resolution not in outpaint_entry["resolutions"]:
                raise PricingError(f"Unsupported LTX resolution: {resolution}")
            side = int(outpaint_entry["resolutions"][resolution])
            outpaint_fps = 24
            outpaint_frames = _frames(effective, outpaint_fps, minimum=9, maximum=481)
            generated_mp = math.ceil((side * side * outpaint_frames) / 1_000_000)
            cost = _decimal(outpaint_entry["unit_price_usd"]) * generated_mp
            stages.append(
                _stage(
                    "outpaint",
                    outpaint_entry,
                    cost,
                    duration_seconds=float(effective),
                    frames=outpaint_frames,
                    fps=outpaint_fps,
                    output_width=side,
                    output_height=side,
                    billed_megapixels=generated_mp,
                    resolution=resolution,
                )
            )
        elif "luma" in model_lower or "reframe" in model_lower:
            billed_seconds = _ceil_seconds(float(effective))
            cost = _decimal(outpaint_entry["unit_price_usd"]) * billed_seconds
            stages.append(
                _stage(
                    "outpaint",
                    outpaint_entry,
                    cost,
                    duration_seconds=float(effective),
                    billed_seconds=int(billed_seconds),
                    aspect_ratio="1:1",
                )
            )
        elif "wan-vace" in model_lower:
            resolution = str(params.get("wan_resolution") or outpaint_entry.get("default_resolution", "720p"))
            rates = outpaint_entry.get("resolution_rates", {})
            if resolution not in rates:
                raise PricingError(f"Unsupported Wan resolution: {resolution}")
            short_side = max(1, min(int(width), int(height)))
            long_side = max(int(width), int(height))
            per_side_ratio = math.ceil((long_side - short_side) / 2) / short_side
            if per_side_ratio > 1:
                raise PricingError("Wan VACE cannot expand this aspect ratio to square in one request.")
            outpaint_fps = 16
            outpaint_frames = _frames(effective, outpaint_fps, minimum=17, maximum=241)
            billed_seconds = Decimal(outpaint_frames - 1) / Decimal(16)
            cost = _decimal(rates[resolution]) * billed_seconds
            stages.append(
                _stage(
                    "outpaint",
                    outpaint_entry,
                    cost,
                    duration_seconds=float(effective),
                    frames=outpaint_frames,
                    fps=16,
                    billed_seconds=float(billed_seconds),
                    resolution=resolution,
                    aspect_ratio="1:1",
                )
            )
        else:
            raise PricingError("This video outpainting model requires a personal Fal key.")

    if str(params.get("upscale_engine") or "fast").casefold() == "fal":
        upscale_model = models.normalize_model_id(
            str(params.get("upscale_model") or models.DEFAULT_VIDEO_MODELS["upscale_vid"])
        )
        entry = _catalog_entry(upscale_model, models.VIDEO_UPSCALE)
        if not entry:
            raise PricingError("This video upscaling model requires a personal Fal key.")
        model_lower = upscale_model.casefold()
        if "bytedance" in model_lower:
            resolution = str(params.get("bytedance_target_res") or "4k")
            fps_label = str(params.get("bytedance_target_fps") or "30fps")
            tier = str(params.get("bytedance_tier") or "fast")
            try:
                rate = (
                    _decimal(entry["base_rates_usd"][resolution])
                    * _decimal(entry["fps_multiplier"][fps_label])
                    * _decimal(entry["tier_multiplier"][tier])
                )
            except KeyError as exc:
                raise PricingError(f"Unsupported Bytedance pricing option: {exc.args[0]}") from exc
            billed_seconds = _ceil_seconds(float(effective))
            stages.append(
                _stage(
                    "upscale",
                    entry,
                    rate * billed_seconds,
                    duration_seconds=float(effective),
                    billed_seconds=int(billed_seconds),
                    resolution=resolution,
                    fps=fps_label,
                    tier=tier,
                )
            )
        elif "seedvr" in model_lower:
            resolution = str(params.get("seedvr_target") or "1080p")
            side = int(entry["resolutions"].get(resolution, 1080))
            if outpaint_frames is not None:
                fps = int(outpaint_fps or 24)
                frame_count = outpaint_frames
            else:
                if not (source_fps and source_frames):
                    raise PricingError("SeedVR credit quotes require source frame metadata.")
                if not upscale_only and not is_square:
                    raise PricingError("Luma-to-SeedVR chaining is BYOK-only because output frame count is not deterministic.")
                fps = float(source_fps)
                frame_count = (
                    max(1, int((effective * _decimal(source_fps)).to_integral_value(rounding=ROUND_CEILING)))
                    if bool(params.get("trim_enabled", False))
                    else int(source_frames)
                )
            if not upscale_only or is_square:
                out_w = out_h = side
            elif width >= height:
                out_h = side
                out_w = math.ceil(side * width / max(1, height))
            else:
                out_w = side
                out_h = math.ceil(side * height / max(1, width))
            generated_mp = _decimal(out_w * out_h * frame_count) / MICRO_USD
            cost = _decimal(entry["unit_price_usd"]) * generated_mp
            stages.append(
                _stage(
                    "upscale",
                    entry,
                    cost,
                    duration_seconds=float(effective),
                    frames=frame_count,
                    fps=fps,
                    output_width=out_w,
                    output_height=out_h,
                    generated_megapixels=float(generated_mp),
                    resolution=resolution,
                )
            )
        else:
            raise PricingError("This video upscaling model requires a personal Fal key.")

    return _quote_payload(
        "video", stages, effective_duration=float(effective), square_input=is_square,
        source_fps=source_fps, source_frames=source_frames,
    )


def image_work_dimensions(width: int, height: int) -> tuple[int, int, float]:
    width = max(1, int(width))
    height = max(1, int(height))
    longest = max(width, height)
    scale = min(1.0, IMAGE_OUTPAINT_MAX_SIDE / longest)
    return max(1, round(width * scale)), max(1, round(height * scale)), scale


def quote_image(*, width: int, height: int, params: dict[str, Any]) -> dict[str, Any]:
    stages: list[StageCost] = []
    upscale_only = bool(params.get("upscale_only", False))
    is_square = int(width) == int(height)
    work_w, work_h, scale = image_work_dimensions(width, height)

    if not upscale_only and not is_square:
        model_id = models.normalize_model_id(str(params.get("outpaint_model") or models.IMAGE_MODELS["outpaint_img"]))
        entry = _catalog_entry(model_id, models.IMAGE_OUTPAINT)
        if not entry:
            raise PricingError("Custom image outpainting models require a personal Fal key.")
        side = max(work_w, work_h)
        output_mp = _decimal(side * side) / MICRO_USD
        cost = _decimal(entry["unit_price_usd"]) * output_mp
        stages.append(
            _stage(
                "outpaint",
                entry,
                cost,
                source_width=int(width),
                source_height=int(height),
                work_width=work_w,
                work_height=work_h,
                work_scale=scale,
                output_width=side,
                output_height=side,
                output_megapixels=float(output_mp),
            )
        )

    if str(params.get("upscale_engine") or "fast").casefold() == "fal":
        model_id = models.normalize_model_id(str(params.get("upscale_model") or models.IMAGE_MODELS["upscale_img"]))
        entry = _catalog_entry(model_id, models.IMAGE_UPSCALE)
        if not entry:
            raise PricingError("This image upscaling model requires a personal Fal key.")
        if not entry.get("credit_enabled"):
            raise PricingError(f"{entry['label']} requires a personal Fal key.")
        factor = _decimal(entry.get("default_factor", 2))
        if not upscale_only and not is_square:
            input_w = input_h = max(work_w, work_h)
        else:
            input_w, input_h = int(width), int(height)
        output_mp = _decimal(input_w * input_h) * factor * factor / MICRO_USD
        cost = _decimal(entry["unit_price_usd"]) * output_mp
        stages.append(
            _stage(
                "upscale",
                entry,
                cost,
                input_width=input_w,
                input_height=input_h,
                upscale_factor=float(factor),
                output_megapixels=float(output_mp),
            )
        )

    return _quote_payload("image", stages, square_input=is_square)


def _quote_payload(kind: str, stages: list[StageCost], **details: Any) -> dict[str, Any]:
    provider_cost = sum((stage.provider_cost_usd for stage in stages), Decimal("0"))
    return {
        "kind": kind,
        "pricing_version": models.PRICING_VERSION,
        "provider_cost_usd": format(provider_cost.quantize(Decimal("0.000001")), "f"),
        "provider_cost_microusd": int((provider_cost * MICRO_USD).to_integral_value(rounding=ROUND_CEILING)),
        "credits": sum(stage.credits for stage in stages),
        "stages": [stage.as_dict() for stage in stages],
        "details": details,
    }


def parameter_hash(*, kind: str, stage_id: str, params: dict[str, Any]) -> str:
    payload = json.dumps(
        {"kind": kind, "stage_id": stage_id, "params": params},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
