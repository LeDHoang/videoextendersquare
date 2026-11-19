"""MiniMax H3 Max and LTX 2.5 reframe: quotes, worker arguments and form validation.

Rates are fal's listed prices on 2026-11-20 (core/models.py).
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from core.pricing import PricingError, parameter_hash, quote_video
from pipeline import video_worker
from server.billing.parameters import video_parameters

H3 = "minimax/h3-max/reframe-video"
LTX25 = "lightricks/ltx-2.5/reframe"


@pytest.mark.parametrize(
    ("resolution", "cost"),
    [("480p", "0.35"), ("768p", "0.56"), ("1080p", "1.12")],
)
def test_h3_bills_started_seconds_per_resolution(resolution, cost):
    quote = quote_video(
        width=1080, height=1920, duration=6.2,
        params={"outpaint_model": H3, "minimax_resolution": resolution},
    )
    stage = quote["stages"][0]
    assert stage["details"]["billed_seconds"] == 7
    assert stage["details"]["resolution"] == resolution
    assert Decimal(stage["provider_cost_usd"]) == Decimal(cost)


def test_h3_defaults_to_768p_and_caps_credit_quotes_at_ten_seconds():
    quote = quote_video(width=1920, height=1080, duration=10, params={"outpaint_model": H3})
    assert quote["stages"][0]["details"]["resolution"] == "768p"
    assert quote["stages"][0]["details"]["billed_seconds"] == 10
    with pytest.raises(PricingError, match="10 s or less"):
        quote_video(width=1920, height=1080, duration=10.5, params={"outpaint_model": H3})
    trimmed = {"outpaint_model": H3, "trim_enabled": True, "trim_start": 0, "trim_duration": 4}
    assert quote_video(width=1920, height=1080, duration=60, params=trimmed)["stages"][0]["details"]["billed_seconds"] == 4


def test_h3_estimate_past_ten_seconds_is_approximate():
    # BYOK estimates run past the credit limit; fal's window overlap is not priced.
    short = quote_video(width=1920, height=1080, duration=10, params={"outpaint_model": H3}, estimate=True)
    assert "approximate" not in short["stages"][0]["details"]
    long = quote_video(width=1920, height=1080, duration=12, params={"outpaint_model": H3}, estimate=True)
    stage = long["stages"][0]
    assert stage["details"]["approximate"] is True
    assert stage["details"]["billed_seconds"] == 12
    assert Decimal(stage["provider_cost_usd"]) == Decimal("0.96")
    with pytest.raises(PricingError, match="300 s or less"):
        quote_video(width=1920, height=1080, duration=301, params={"outpaint_model": H3}, estimate=True)


@pytest.mark.parametrize(("resolution", "cost"), [("720p", "0.70"), ("1080p", "1.40")])
def test_ltx25_bills_started_seconds_per_resolution(resolution, cost):
    quote = quote_video(
        width=1080, height=1920, duration=6.2,
        params={"outpaint_model": LTX25, "ltx25_resolution": resolution},
    )
    stage = quote["stages"][0]
    assert stage["details"]["billed_seconds"] == 7
    assert Decimal(stage["provider_cost_usd"]) == Decimal(cost)


def test_ltx25_defaults_to_1080p_and_has_no_ten_second_cap():
    quote = quote_video(width=1920, height=1080, duration=20, params={"outpaint_model": LTX25})
    assert quote["stages"][0]["details"]["resolution"] == "1080p"
    assert Decimal(quote["stages"][0]["provider_cost_usd"]) == Decimal("4.00")


@pytest.mark.parametrize(("model", "param"), [(H3, "minimax_resolution"), (LTX25, "ltx25_resolution")])
def test_unknown_resolution_is_refused(model, param):
    with pytest.raises(PricingError, match="Unsupported .* resolution: 4k"):
        quote_video(width=1920, height=1080, duration=5, params={"outpaint_model": model, param: "4k"})


def test_seed_and_anchor_change_the_parameter_hash():
    base = video_parameters({"outpaint_model": H3})
    assert base["minimax_seed"] == ""
    assert base["ltx25_anchor"] == "center"
    seeded = video_parameters({"outpaint_model": H3, "minimax_seed": "42"})
    assert parameter_hash(kind="video", stage_id="s", params=base) != parameter_hash(
        kind="video", stage_id="s", params=seeded
    )


class _Submitted(Exception):
    pass


def _sent_arguments(tmp_path, monkeypatch, model, duration=5.0, **kwargs):
    sent = []

    class _FakeFal:
        def __init__(self, *_a, **_k):
            pass

        def upload_file(self, *_a, **_k):
            return "https://fal.test/source.mp4"

        def submit(self, endpoint, arguments):
            sent.append((endpoint, arguments))
            raise _Submitted

    monkeypatch.setattr(video_worker, "get_video_dimensions_and_duration", lambda *_a, **_k: (1080, 1920, duration))
    monkeypatch.setattr(video_worker.fal_client, "SyncClient", _FakeFal)
    source = tmp_path / "portrait.mp4"
    source.write_bytes(b"x")
    with pytest.raises(_Submitted):
        video_worker.process_video(str(source), kwargs.pop("prompt", ""), fal_key="key", outpaint_model=model, **kwargs)
    endpoint, arguments = sent[0]
    assert endpoint == model
    return arguments


def test_worker_sends_h3_resolution_seed_and_prompt(tmp_path, monkeypatch):
    arguments = _sent_arguments(
        tmp_path, monkeypatch, H3, prompt="beach", minimax_resolution="1080p", minimax_seed="42",
    )
    assert arguments == {
        "video_url": "https://fal.test/source.mp4",
        "aspect_ratio": "1:1",
        "resolution": "1080p",
        "prompt": "beach",
        "seed": 42,
    }


def test_worker_omits_empty_h3_prompt_and_seed(tmp_path, monkeypatch):
    arguments = _sent_arguments(tmp_path, monkeypatch, H3, prompt="  ")
    assert arguments == {"video_url": "https://fal.test/source.mp4", "aspect_ratio": "1:1", "resolution": "768p"}


def test_worker_submits_h3_source_past_ten_seconds(tmp_path, monkeypatch):
    # The 10 s limit is for credit quotes only; BYOK jobs reach fal.
    arguments = _sent_arguments(tmp_path, monkeypatch, H3, duration=12.0)
    assert arguments["resolution"] == "768p"


def test_worker_sends_ltx25_placement_only_off_centre(tmp_path, monkeypatch):
    centred = _sent_arguments(tmp_path, monkeypatch, LTX25, prompt="ignored")
    assert centred == {"video_url": "https://fal.test/source.mp4", "aspect_ratio": "1:1", "resolution": "1080p"}
    top = _sent_arguments(tmp_path, monkeypatch, LTX25, ltx25_resolution="720p", ltx25_anchor="top")
    assert top["placement"] == {"anchor": "top"}
    assert top["resolution"] == "720p"
