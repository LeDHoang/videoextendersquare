from decimal import Decimal

import pytest

from core.pricing import PricingError, credits_for_cost, parameter_hash, quote_image, quote_video


def test_credit_markup_rounds_up():
    assert credits_for_cost(Decimal("0")) == 0
    assert credits_for_cost(Decimal("0.035")) == 5
    assert credits_for_cost(Decimal("0.30")) == 41


def test_representative_video_prices():
    ltx = quote_video(
        width=1920,
        height=1080,
        duration=5,
        params={"outpaint_model": "fal-ai/ltx-2.3-quality/outpaint", "ltx_resolution": "720p"},
    )
    assert ltx["credits"] == 21
    assert ltx["stages"][0]["details"]["frames"] == 121
    assert ltx["stages"][0]["details"]["billed_megapixels"] == 63
    assert ltx["stages"][0]["pricing_version"] == "2026-09-13"
    assert ltx["stages"][0]["pricing_verified_at"] == "2026-09-13"
    assert ltx["stages"][0]["pricing_source"].startswith("https://fal.ai/models/")
    assert "ceil" in ltx["stages"][0]["rounding_rule"]
    assert ltx["stages"][0]["constraints"]["max_frames"] == 481

    luma = quote_video(
        width=1920,
        height=1080,
        duration=5,
        params={"outpaint_model": "fal-ai/luma-dream-machine/ray-2-flash/reframe"},
    )
    assert luma["credits"] == 41

    wan = quote_video(
        width=1920,
        height=1080,
        duration=5,
        params={"outpaint_model": "fal-ai/wan-vace-14b/outpainting", "wan_resolution": "720p"},
    )
    assert wan["credits"] == 54
    assert wan["stages"][0]["details"]["frames"] == 81

    bytedance = quote_video(
        width=1080,
        height=1080,
        duration=5,
        params={
            "upscale_only": True,
            "upscale_engine": "fal",
            "upscale_model": "fal-ai/bytedance-upscaler/upscale/video",
            "bytedance_target_res": "4k",
            "bytedance_target_fps": "30fps",
            "bytedance_tier": "fast",
        },
    )
    assert bytedance["credits"] == 20


def test_image_apps_one_megapixel_and_square_skip():
    one_mp = quote_image(width=1000, height=500, params={})
    assert one_mp["credits"] == 5
    assert one_mp["stages"][0]["details"]["output_megapixels"] == 1.0

    square = quote_image(width=1000, height=1000, params={})
    assert square["credits"] == 0
    assert square["stages"] == []


def test_trim_duration_is_authoritative_and_per_item():
    params = {
        "outpaint_model": "fal-ai/luma-dream-machine/ray-2-flash/reframe",
        "trim_enabled": True,
        "trim_start": 8,
        "trim_duration": 7,
    }
    first = quote_video(width=1920, height=1080, duration=10, params=params)
    second = quote_video(width=1920, height=1080, duration=30, params=params)
    assert first["details"]["effective_duration"] == 2.0
    assert second["details"]["effective_duration"] == 7.0
    assert first["credits"] + second["credits"] == 74


def test_byok_only_and_provider_limits_are_rejected():
    with pytest.raises(PricingError, match="personal Fal key"):
        quote_image(
            width=1000,
            height=1000,
            params={"upscale_engine": "fal", "upscale_model": "fal-ai/ccsr"},
        )

    with pytest.raises(PricingError, match="at most"):
        quote_video(
            width=1920,
            height=1080,
            duration=16,
            params={"outpaint_model": "fal-ai/wan-vace-14b/outpainting"},
        )

    with pytest.raises(PricingError, match="cannot expand"):
        quote_video(
            width=4000,
            height=1000,
            duration=5,
            params={"outpaint_model": "fal-ai/wan-vace-14b/outpainting"},
        )

    with pytest.raises(PricingError, match="Unsupported LTX resolution"):
        quote_video(
            width=1920,
            height=1080,
            duration=5,
            params={"outpaint_model": "fal-ai/ltx-2.3-quality/outpaint", "ltx_resolution": "invalid"},
        )


def test_parameter_hash_is_stable_and_stage_bound():
    params_a = {"b": 2, "a": 1}
    params_b = {"a": 1, "b": 2}
    assert parameter_hash(kind="image", stage_id="abc", params=params_a) == parameter_hash(
        kind="image", stage_id="abc", params=params_b
    )
    assert parameter_hash(kind="image", stage_id="abc", params=params_a) != parameter_hash(
        kind="image", stage_id="other", params=params_a
    )
