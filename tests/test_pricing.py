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
    assert ltx["stages"][0]["pricing_version"] == "2026-10-20"
    assert ltx["stages"][0]["pricing_verified_at"] == "2026-09-13"
    assert ltx["stages"][0]["pricing_source"].startswith("https://fal.ai/models/")
    assert "ceil" in ltx["stages"][0]["rounding_rule"]
    assert ltx["stages"][0]["constraints"]["max_frames"] == 481

    luma = quote_video(
        width=1920,
        height=1080,
        duration=5,
        params={"outpaint_model": "luma/agent/ray/v3.2/reframe"},
    )
    # Ray 3.2 defaults to 720p: 5 s x $0.12 = $0.60.
    assert luma["credits"] == 81
    assert luma["stages"][0]["details"]["resolution"] == "720p"
    assert luma["stages"][0]["pricing_verified_at"] == "2026-10-20"

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
        "outpaint_model": "luma/agent/ray/v3.2/reframe",
        "trim_enabled": True,
        "trim_start": 8,
        "trim_duration": 7,
    }
    first = quote_video(width=1920, height=1080, duration=10, params=params)
    second = quote_video(width=1920, height=1080, duration=30, params=params)
    assert first["details"]["effective_duration"] == 2.0
    assert second["details"]["effective_duration"] == 7.0
    # Ray 3.2 at 720p: 2 s and 7 s x $0.12/s, each marked up and rounded up.
    assert first["credits"] + second["credits"] == 33 + 114


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


def test_luma_to_seedvr_is_refused_for_quotes_but_estimated_approximately():
    params = {
        "outpaint_model": "luma/agent/ray/v3.2/reframe",
        "upscale_engine": "fal",
        "upscale_model": "fal-ai/seedvr/upscale/video",
        "seedvr_target": "1080p",
    }
    with pytest.raises(PricingError, match="Luma-to-SeedVR"):
        quote_video(width=1920, height=1080, duration=5, params=params, source_fps=24, source_frames=120)

    estimate = quote_video(
        width=1920, height=1080, duration=5, params=params, source_fps=24, source_frames=120, estimate=True,
    )
    luma, seedvr = estimate["stages"]
    assert luma["credits"] == 81
    assert "approximate" not in luma["details"]
    assert seedvr["details"]["approximate"] is True
    # Assumes Luma returns the source frame rate: 5s x 24fps at 1080x1080.
    assert seedvr["details"]["frames"] == 120
    assert seedvr["details"]["output_width"] == seedvr["details"]["output_height"] == 1080
    assert Decimal(seedvr["provider_cost_usd"]) == Decimal("0.001") * Decimal(1080 * 1080 * 120) / Decimal(1_000_000)


@pytest.mark.parametrize(
    ("resolution", "cost"),
    [("540p", "0.42"), ("720p", "0.84"), ("1080p", "2.52")],
)
def test_ray_3_2_reframe_bills_started_source_seconds_per_resolution(resolution, cost):
    quote = quote_video(
        width=1080,
        height=1920,
        duration=6.2,
        params={"outpaint_model": "luma/agent/ray/v3.2/reframe", "luma_resolution": resolution},
    )
    stage = quote["stages"][0]
    assert stage["details"]["billed_seconds"] == 7
    assert Decimal(stage["provider_cost_usd"]) == Decimal(cost)


def test_ray_3_2_reframe_rejects_unknown_resolution():
    with pytest.raises(PricingError, match="Unsupported Luma resolution"):
        quote_video(
            width=1920, height=1080, duration=5,
            params={"outpaint_model": "luma/agent/ray/v3.2/reframe", "luma_resolution": "4k"},
        )


def test_ray_3_2_reframe_refuses_sources_over_ten_seconds():
    params = {"outpaint_model": "luma/agent/ray/v3.2/reframe"}
    assert quote_video(width=1920, height=1080, duration=10, params=params)["stages"][0]["details"]["billed_seconds"] == 10
    with pytest.raises(PricingError, match="10 s or less"):
        quote_video(width=1920, height=1080, duration=10.4, params=params)
    # Trimming the selection to 10 s or less makes the same source quotable.
    trimmed = {**params, "trim_enabled": True, "trim_start": 2.0, "trim_duration": 8.0}
    assert quote_video(width=1920, height=1080, duration=30, params=trimmed)["stages"][0]["details"]["billed_seconds"] == 8
    # Upscale-only and square sources never reach the reframe stage.
    assert quote_video(width=1080, height=1080, duration=30, params=params)["stages"] == []
