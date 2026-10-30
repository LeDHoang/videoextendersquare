"""Render maths of the Make 3D converter (pipeline/spatial_worker.py): numpy +
OpenCV only, so no depth model is needed."""
from __future__ import annotations

import math

import numpy as np
import pytest

from pipeline import spatial_worker as sw


def texture(h: int, w: int, seed: int = 3) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, 256, (h, w, 3), dtype=np.uint8)


def exact_strength(width: int, shift_px: int) -> float:
    """Strength that makes the far-plane shift a whole number of pixels."""
    return shift_px / (sw.MAX_SHIFT * width)


def test_far_content_shifts_right_and_screen_plane_stays_put():
    left = texture(40, 120)
    s = exact_strength(120, 3)
    far = sw.render_right_eye(left, np.zeros((40, 120), np.float32), s)
    assert np.abs(far[:, 3:].astype(int) - left[:, :-3]).max() <= 1
    plane = np.full((40, 120), sw.MAX_SHIFT / (sw.MAX_SHIFT + sw.POP_OUT), np.float32)
    assert np.abs(sw.render_right_eye(left, plane, s).astype(int) - left).max() <= 1


def test_render_shift_stays_within_budget(monkeypatch):
    """Far pixels move right by at most the far-plane budget, the nearest
    left by at most the pop-out budget."""
    seen = {}
    real = sw.softsplat

    def spy(img, fx, importance):
        seen["fx"] = fx
        return real(img, fx, importance)

    monkeypatch.setattr(sw, "softsplat", spy)
    near = np.random.default_rng(0).random((30, 90)).astype(np.float32)
    sw.render_right_eye(texture(30, 90), near, 2.0)
    assert seen["fx"].min() >= -sw.POP_OUT * 90 * 2.0 - 1e-9
    assert seen["fx"].max() <= sw.MAX_SHIFT * 90 * 2.0 + 1e-9
    assert sw.POP_OUT <= sw.MAX_SHIFT  # eye_geometry's crop covers both edge strips


def test_softsplat_only_moves_pixels_right():
    W = 90
    left = np.zeros((30, W, 3), np.uint8)
    left[..., 0] = np.arange(W)  # red = source column
    near = np.random.default_rng(2).random((30, W)).astype(np.float32)
    out, _ = sw.softsplat(left, 2.5 * (1.0 - near), sw.NEAR_IMPORTANCE * near)
    valid = ~np.isnan(out[..., 0])
    target = np.broadcast_to(np.arange(W, dtype=np.float32), (30, W))
    assert (out[..., 0][valid] <= target[valid] + 1e-3).all()


def test_nearer_surface_wins_where_both_land():
    left = texture(32, 100)
    left[:, 40:61] = 255
    near = np.zeros((32, 100), np.float32)
    near[:, 40:61] = 1.0
    right = sw.render_right_eye(left, near, exact_strength(100, 3))
    # The block moves left by 1.3 px; background from columns 37..39 lands under it.
    assert (right[:, 40:59] == 255).all()
    assert np.abs(right[:, 64:].astype(int) - left[:, 61:-3]).max() <= 1


def test_softsplat_marks_disocclusions_and_fill_closes_them():
    left = texture(16, 50)
    near = np.zeros((16, 50), np.float32)
    near[:, 20:30] = 1.0
    fx = sw.MAX_SHIFT * 50 * exact_strength(50, 4) * (1.0 - near)
    out, den = sw.softsplat(left, fx, sw.NEAR_IMPORTANCE * near)
    hole = np.isnan(out[..., 0])
    assert hole[:, :4].all()  # nothing lands left of the far-plane shift
    assert hole[:, 30:34].all()  # behind the near block's right edge
    assert (den[~hole] > 0).all()
    filled = sw.nearest_fill(out)
    assert not np.isnan(filled).any()
    assert np.array_equal(filled[:, 31], filled[:, 29])  # nearest valid pixel is the block edge


def test_background_fill_mirrors_the_far_side_of_a_hole():
    left = texture(16, 50)
    left[:, 20:30] = 255  # near block
    near = np.zeros((16, 50), np.float32)
    near[:, 20:30] = 1.0
    fx = sw.MAX_SHIFT * 50 * exact_strength(50, 4) * (1.0 - near)
    out, _ = sw.softsplat(left, fx, sw.NEAR_IMPORTANCE * near)
    z, _ = sw.softsplat(np.repeat(near[..., None], 3, axis=2), fx, sw.NEAR_IMPORTANCE * near)
    filled = sw.background_fill(out, z[..., 0])
    assert not np.isnan(filled).any()
    # The hole behind the block (columns 30..33) mirrors the background at 34..37, not the block.
    assert np.array_equal(filled[:, 30:34], out[:, 34:38][:, ::-1])
    assert (filled[:, 30:34] != 255).any()
    # The frame-edge strip has background on one side only and mirrors it too.
    assert np.array_equal(filled[:, 0:4], out[:, 4:8][:, ::-1])


def test_render_has_no_holes_on_random_depth():
    rng = np.random.default_rng(5)
    near = rng.random((48, 48)).astype(np.float32)
    right = sw.render_right_eye(texture(48, 48), near, 2.0)
    assert right.dtype == np.uint8 and right.shape == (48, 48, 3)


def test_bilinear_taps_use_align_corners():
    i0, i1, a = sw._bilinear_taps(3, 5)
    pos = i0 + a
    assert np.allclose(pos, [0, 0.5, 1, 1.5, 2])
    assert i1.max() == 2


def test_condition_depth_dilates_then_upsamples():
    near = np.zeros((20, 20), np.float16)
    near[10, 10] = 1.0
    up = sw.condition_depth(near, 39, 39)  # exactly 2x with align_corners
    dilated = np.zeros((20, 20), np.float32)
    dilated[8:13, 8:13] = 1.0
    assert np.array_equal(up[::2, ::2], dilated)
    assert up.min() >= 0 and up.max() <= 1


def test_condition_depth_matches_torch_bilinear():
    torch = pytest.importorskip("torch")
    import cv2
    import torch.nn.functional as F
    near = np.random.default_rng(1).random((37, 52)).astype(np.float32)
    ours = sw.condition_depth(near, 211, 150)
    d = cv2.dilate(near, np.ones((5, 5), np.uint8))
    ref = F.interpolate(torch.from_numpy(d)[None, None], size=(150, 211), mode="bilinear", align_corners=True)[0, 0]
    assert np.abs(ours - ref.numpy()).max() < 1e-5


@pytest.mark.parametrize("side", [64, 512, 720, 1080, 1440, 2048, 2160, 3840, 4096, 5000])
@pytest.mark.parametrize("strength", [0.5, 1.0, 2.0])
def test_eye_geometry_square_even_capped_and_covers_shift(side, strength):
    rw, rh, crop = sw.eye_geometry(side, side, strength)
    eye = rw - 2 * crop
    assert rw == rh and rw % 2 == 0
    assert eye == rh - 2 * crop and eye % 2 == 0
    assert crop % 2 == 0  # keeps the 4:2:0 chroma grid
    assert eye <= sw.EYE_CAP
    assert crop >= sw.MAX_SHIFT * strength * rw  # the right eye's empty left strip is gone
    if side * (1 - 2 * sw.MAX_SHIFT * strength) <= sw.EYE_CAP:
        assert rw == side  # no resample when the cropped eye already fits


def test_eye_geometry_1080_and_4k_square():
    assert sw.eye_geometry(1080, 1080) == (1080, 1080, 16)  # 1048 px eyes
    assert sw.eye_geometry(4096, 4096) == (2106, 2106, 30)  # 2046 px eyes


def test_eye_geometry_keeps_aspect_for_non_square():
    rw, rh, crop = sw.eye_geometry(3840, 2160)
    assert rw - 2 * crop <= sw.EYE_CAP and (rw - 2 * crop) % 2 == 0 and (rh - 2 * crop) % 2 == 0
    assert math.isclose(rw / rh, 3840 / 2160, rel_tol=0.01)


@pytest.mark.parametrize("cuts,expected", [
    ({}, [(0, 100)]),
    ({50: 0.9}, [(0, 50), (50, 100)]),
    ({50: 0.39}, [(0, 100)]),
    ({5: 0.9}, [(0, 100)]),           # short first shot joins the next
    ({95: 0.9}, [(0, 100)]),          # short last shot joins the previous
    ({50: 0.9, 53: 0.9}, [(0, 53), (53, 100)]),  # a 3-frame flash joins the shot before it
    ({0: 1.0}, [(0, 100)]),           # frame 0 never starts a second shot
])
def test_split_shots(cuts, expected):
    assert sw.split_shots(cuts, 100) == expected


def test_split_shots_takes_extra_cuts():
    assert sw.split_shots({}, 100, extra_cuts=[40]) == [(0, 40), (40, 100)]
    assert sw.split_shots({70: 0.9}, 100, extra_cuts=[40, 0, 100]) == [(0, 40), (40, 70), (70, 100)]


def _hists(colours):
    return [sw.colour_histogram(np.full((32, 32, 3), c, np.uint8)) for c in colours]


def test_histogram_cuts_finds_a_dark_cut():
    # Two dark shots of different hue: ffmpeg's luma-heavy scene score misses these.
    assert sw.histogram_cuts(_hists([(30, 10, 10)] * 40 + [(10, 10, 40)] * 40)) == [40]


def test_histogram_cuts_skips_a_flash_and_strobing():
    dark, bright = (30, 10, 10), (240, 240, 240)
    assert sw.histogram_cuts(_hists([dark] * 40 + [bright] * 2 + [dark] * 40)) == []
    assert sw.histogram_cuts(_hists([dark, bright] * 40)) == []


def test_shot_range_and_normalize_ignore_nan():
    raw = np.linspace(0, 10, 4 * 40 * 40, dtype=np.float32).reshape(4, 40, 40)
    raw[0, 0, 0] = np.nan
    lo, hi = sw.shot_range(raw)
    assert 0 <= lo < 1 and 9 < hi <= 10
    near = sw.normalize_depth(raw, lo, hi)
    assert near.dtype == np.float16
    assert near.min() == 0 and near.max() == 1
    assert not np.isnan(near).any()
