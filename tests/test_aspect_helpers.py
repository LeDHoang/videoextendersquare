"""Aspect helpers (pipeline/utils.py) and their parity fixture.

The same fixture drives web/src/utils/aspect.test.js, so the Python worker
and the upload stage agree on every canvas and master size.
"""
import json
from pathlib import Path

import pytest

from pipeline.utils import (
    aspect_canvas,
    aspect_matches,
    budget_size,
    calculate_aspect_padding,
    calculate_square_padding,
    eye_aspect,
    master_size,
    nearest_aspect,
    needs_extend,
)
from server.social.services import post_aspect

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "aspect_vectors.json").read_text())


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: f"{c['w']}x{c['h']}")
def test_fixture_vectors(case):
    w, h = case["w"], case["h"]
    assert nearest_aspect(w, h) == case["nearest"]
    assert list(master_size(w, h)) == case["master_native"]
    for target in ("1:1", "16:9", "9:16"):
        want = case[target]
        assert aspect_matches(w, h, target) is want["matches"]
        assert list(aspect_canvas(w, h, target)) == want["canvas"]
        assert list(calculate_aspect_padding(w, h, target)) == want["padding"]
        assert list(master_size(w, h, target)) == want["master"]


def test_square_padding_unchanged():
    for w, h in [(1920, 1080), (1080, 1920), (1081, 1920), (500, 500)]:
        assert calculate_aspect_padding(w, h, "1:1") == calculate_square_padding(w, h)


def test_master_sizes():
    assert master_size(1920, 1080, "16:9") == (3640, 2048)
    assert master_size(1080, 1920, "9:16") == (2048, 3640)
    assert master_size(300, 300, "1:1") == (2048, 2048)
    # Ultra-wide native: long side caps at 4096, short side shrinks.
    assert master_size(2560, 1080) == (4096, 1728)


def test_tolerance_and_extend():
    assert aspect_matches(1920, 1088, "16:9")
    assert not needs_extend(1920, 1088, "16:9")
    assert needs_extend(1920, 1080, "1:1")
    assert not needs_extend(1920, 1080, "1:1", extend=False)


def test_budget_and_eye():
    assert budget_size(2048, 2048, 2160 * 2160) == (2048, 2048)
    w, h = budget_size(3640, 2048, 2160 * 2160)
    assert w * h <= 2160 * 2160 and w % 2 == 0 and h % 2 == 0
    assert eye_aspect(4096, 2048, "sbs") == 1.0
    assert eye_aspect(2048, 4096, "tb") == 1.0
    assert post_aspect(None, None) == 1.0
    assert post_aspect(1920, 1080) == round(16 / 9, 4)
    assert post_aspect(7280, 2048, "sbs") == round(3640 / 2048, 4)
