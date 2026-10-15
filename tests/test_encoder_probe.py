"""ENCODER probe / pick_encoder must smoke-test at the real master size.

A 64x64 frame never reaches hardware encoder resolution/level limits, so the
probe could report an encoder that then rejects every 3840x3840 master. ffmpeg
is never required here: tooling.run and shutil.which are mocked.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

from core import probes, tooling

NAMES = [name for name, _ in tooling.HEVC_CANDIDATES]
FIRST, SECOND = NAMES[0], NAMES[1]


def _proc(args, returncode=0, stdout=""):
    return subprocess.CompletedProcess(args, returncode, stdout, "")


def _smoke_codec(args):
    """The -c:v value of a smoke-encode command, or None for other calls."""
    if "-c:v" in args and "lavfi" in args:
        return args[args.index("-c:v") + 1]
    return None


@pytest.fixture
def fake_ffmpeg(monkeypatch):
    """ffmpeg on PATH with every HEVC candidate listed; `passing` decides
    which encoders survive the smoke encode."""
    state = {"passing": set(NAMES), "smokes": []}

    def fake_run(args, timeout=20):
        codec = _smoke_codec(args)
        if codec:
            state["smokes"].append({"codec": codec, "args": list(args), "timeout": timeout})
            return _proc(args, 0 if codec in state["passing"] else 1)
        if "-version" in args:
            return _proc(args, stdout="ffmpeg version 8.1.2 Copyright (c) 2000-2026\n")
        if "-filters" in args:
            return _proc(args, stdout=" ..C cas               V->V       Contrast Adaptive Sharpen.\n")
        if "-encoders" in args:
            listed = "".join(f" V....D {n:<20} HEVC\n" for n in NAMES + ["libx264"])
            return _proc(args, stdout=listed)
        return None

    monkeypatch.setattr(tooling, "run", fake_run)
    monkeypatch.setattr(shutil, "which", lambda name: f"/usr/bin/{name}")
    # Keep the STUDIO probes out of it (they need vspipe, tested elsewhere).
    monkeypatch.setattr(tooling, "vapoursynth_available", lambda: False)
    monkeypatch.setattr(tooling, "find_ffms2_plugin", lambda: None)
    monkeypatch.setattr(tooling, "find_znedi3_plugin", lambda: None)
    monkeypatch.setattr(tooling, "_ENCODER_CACHE", None)
    return state


def test_smoke_encode_encodes_one_master_size_frame(fake_ffmpeg):
    name, opts = tooling.HEVC_CANDIDATES[0]

    assert tooling.smoke_encode(name, opts) is True

    (smoke,) = fake_ffmpeg["smokes"]
    args = smoke["args"]
    assert tooling.SMOKE_ENCODE_SIZE == "3840x3840"
    assert "testsrc=d=0.1:s=3840x3840" in args
    i = args.index("-c:v")
    assert args[i:i + 2 + len(opts)] == ["-c:v", name, *opts]
    assert args[-5:] == ["-frames:v", "1", "-f", "null", "-"]
    assert smoke["timeout"] == 40


def test_smoke_encode_fails_on_error_or_timeout(fake_ffmpeg, monkeypatch):
    fake_ffmpeg["passing"] = set()
    assert tooling.smoke_encode(FIRST, []) is False

    monkeypatch.setattr(tooling, "run", lambda *a, **k: None)  # TimeoutExpired / OSError
    assert tooling.smoke_encode(FIRST, []) is False


def test_pick_encoder_skips_candidate_failing_at_master_size(fake_ffmpeg):
    fake_ffmpeg["passing"] = {SECOND}

    name, opts = tooling.pick_encoder()

    assert (name, opts) == tooling.HEVC_CANDIDATES[1]
    assert [s["codec"] for s in fake_ffmpeg["smokes"]] == [FIRST, SECOND]
    assert all("testsrc=d=0.1:s=3840x3840" in s["args"] for s in fake_ffmpeg["smokes"])
    # Cached per process: no second round of smoke encodes.
    assert tooling.pick_encoder() == (name, opts)
    assert len(fake_ffmpeg["smokes"]) == 2


def test_encoder_probe_matches_pick_encoder(fake_ffmpeg):
    fake_ffmpeg["passing"] = {SECOND}

    enc = probes.build_probes()["encoder"]

    assert enc.ok and enc.detail == SECOND
    assert enc.detail == tooling.pick_encoder()[0]
    assert all("testsrc=d=0.1:s=3840x3840" in s["args"] for s in fake_ffmpeg["smokes"])


def test_encoder_probe_blocks_when_nothing_encodes_master_size(fake_ffmpeg):
    fake_ffmpeg["passing"] = set()

    out = probes.build_probes()

    enc = out["encoder"]
    assert not enc.ok and enc.severity == "block"
    assert enc.detail == "none working"
    assert "3840x3840 smoke test" in enc.fix
    assert enc in probes.blockers(out, need_video=True)
    assert [s["codec"] for s in fake_ffmpeg["smokes"]] == NAMES
