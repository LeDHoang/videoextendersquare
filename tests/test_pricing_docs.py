"""The credit catalog prices must match the Fal model docs kept in docs/Fal-ai-docs.

core/models.py is the runtime price source; the markdown pages are the copied
provider docs it was verified against. If a doc is refreshed with a new price,
this fails until the catalog (and PRICING_VERSION) is updated too.
"""

from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path

import pytest

from core import models

DOCS = Path(__file__).resolve().parents[1] / "docs" / "Fal-ai-docs"


def _pricing_section(relative: str) -> str:
    text = (DOCS / relative).read_text(encoding="utf-8")
    match = re.search(r"^## Pricing\s*$(.*?)^## ", text, flags=re.MULTILINE | re.DOTALL)
    assert match, f"{relative} has no '## Pricing' section"
    return match.group(1)


def _prices(section: str) -> list[Decimal]:
    return [Decimal(value) for value in re.findall(r"\$(\d+(?:\.\d+)?)", section)]


def _entry(catalog: list[dict], model_id: str) -> dict:
    return next(entry for entry in catalog if entry["model"] == model_id)


@pytest.mark.parametrize(
    ("doc", "model_id"),
    [
        ("ltx-2.3-quality/outpaint.md", "fal-ai/ltx-2.3-quality/outpaint"),
        ("ltx-2.3-quality/outpaint-lora.md", "fal-ai/ltx-2.3-quality/outpaint/lora"),
    ],
)
def test_ltx_price_per_megapixel_matches_docs(doc, model_id):
    section = _pricing_section(doc)
    assert "per megapixel" in section
    assert _prices(section)[0] == Decimal(_entry(models.VIDEO_OUTPAINT, model_id)["unit_price_usd"])


def test_luma_reframe_price_per_second_matches_docs():
    section = _pricing_section("luma-dream-machine/ray-2-flash/reframe")
    assert "per second" in section
    entry = _entry(models.VIDEO_OUTPAINT, "fal-ai/luma-dream-machine/ray-2-flash/reframe")
    assert _prices(section)[0] == Decimal(entry["unit_price_usd"])


def test_seedvr_price_per_megapixel_matches_docs():
    section = _pricing_section("seedvr/upscale/video.md")
    assert "per megapixel" in section
    entry = _entry(models.VIDEO_UPSCALE, "fal-ai/seedvr/upscale/video")
    assert _prices(section)[0] == Decimal(entry["unit_price_usd"])


def test_bytedance_rates_and_multipliers_match_docs():
    section = _pricing_section("bytedance-upscaler/upscale/video")
    entry = _entry(models.VIDEO_UPSCALE, "fal-ai/bytedance-upscaler/upscale/video")
    base = {key: Decimal(value) for key, value in entry["base_rates_usd"].items()}
    # "1080p costs $0.0072/s, 2K costs $0.0144/s, and 4K costs $0.0288/s, at a 30fps rate"
    assert _prices(section)[:3] == [base["1080p"], base["2k"], base["4k"]]
    assert "60fps doubles" in section
    assert Decimal(str(entry["fps_multiplier"]["60fps"])) == 2
    assert "10 times" in section
    assert Decimal(str(entry["tier_multiplier"]["pro"])) == 10
    # The pro prices quoted in the doc are the base rates x10.
    assert _prices(section)[3:6] == [rate * 10 for rate in (base["1080p"], base["2k"], base["4k"])]
