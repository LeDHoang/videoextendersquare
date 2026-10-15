"""STUDIO health probes (ffms2, znedi3) must reflect what a render can load.

Regression: the znedi3 probe reported ok because a plugin file existed (or the
'pip:vapoursynth' sentinel came back), while every studio render died in
vspipe on "No attribute with the name znedi3 exists". ffms2, the studio
source filter, was not probed at all. VapourSynth is never required here:
vspipe, the plugin finders and the subprocess runner are mocked.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from core import probes, tooling

NO_ZNEDI3 = (
    "AttributeError: No attribute with the name znedi3 exists. "
    "Did you mistype a plugin namespace or forget to install a plugin?"
)
NO_FFMS2 = NO_ZNEDI3.replace("znedi3", "ffms2")


@pytest.fixture
def fake_vspipe(monkeypatch):
    """Capture every vspipe call plus the .vpy script it was handed."""
    calls: list[dict] = []
    result: dict = {"proc": None}

    def fake_run(args, timeout=20):
        script_path = args[3]
        with open(script_path, encoding="utf-8") as f:
            calls.append({"args": list(args), "timeout": timeout,
                          "script": f.read(), "path": script_path})
        proc = result["proc"]
        return proc(args) if callable(proc) else proc

    monkeypatch.setattr(tooling, "_vspipe_quietly", lambda: "/fake/vspipe")
    monkeypatch.setattr(tooling, "run", fake_run)
    return calls, result


def _done(returncode: int, stderr: str = ""):
    return lambda args: subprocess.CompletedProcess(args, returncode, "", stderr)


# --- load lines: shared by the worker .vpy and the probes ---

@pytest.mark.parametrize("loader", [tooling.ffms2_load_lines, tooling.znedi3_load_lines])
@pytest.mark.parametrize("plugin", [None, "", "pip:vapoursynth"])
def test_load_lines_empty_when_autoloaded_or_missing(loader, plugin):
    assert loader(plugin) == ""


@pytest.mark.parametrize("loader, namespace", [
    (tooling.ffms2_load_lines, "ffms2"),
    (tooling.znedi3_load_lines, "znedi3"),
])
def test_load_lines_guard_loadplugin_on_missing_namespace(tmp_path, loader, namespace):
    lib = tmp_path / f"lib{namespace}.so"
    lines = loader(str(lib))
    assert lines.startswith(f"if not hasattr(core, '{namespace}'):\n")
    assert f"core.std.LoadPlugin({str(lib)!r})" in lines


@pytest.mark.parametrize("template, loader", [
    (tooling._FFMS2_SMOKE_VPY, tooling.ffms2_load_lines),
    (tooling._ZNEDI3_SMOKE_VPY, tooling.znedi3_load_lines),
])
def test_load_lines_stay_valid_python_for_awkward_paths(tmp_path, template, loader):
    odd = tmp_path / "it's [ez]" / "plugin.so"
    script = template.format(load=loader(str(odd)))
    compile(script, "<smoke>", "exec")
    assert repr(os.path.abspath(str(odd))) in script


# --- smoke tests: one vspipe run each, with a timeout ---

def test_znedi3_smoke_runs_vspipe_with_worker_load_lines(fake_vspipe, tmp_path):
    calls, result = fake_vspipe
    result["proc"] = _done(0)
    so = str(tmp_path / "vsznedi3.so")

    assert tooling.smoke_znedi3(so, timeout=7) == (True, "")

    (call,) = calls
    assert call["args"] == ["/fake/vspipe", "--end", "0", call["path"], "--"]
    assert call["timeout"] == 7
    assert tooling.znedi3_load_lines(so) in call["script"]
    assert "core.znedi3.nnedi3(" in call["script"]
    assert not os.path.exists(call["path"]), "temp .vpy must be cleaned up"


def test_ffms2_smoke_runs_vspipe_with_worker_load_lines(fake_vspipe, tmp_path):
    calls, result = fake_vspipe
    result["proc"] = _done(0)
    lib = str(tmp_path / "libffms2.dylib")

    assert tooling.smoke_ffms2(lib, timeout=7) == (True, "")

    (call,) = calls
    assert call["args"] == ["/fake/vspipe", "--end", "0", call["path"], "--"]
    assert call["timeout"] == 7
    assert tooling.ffms2_load_lines(lib) in call["script"]
    assert "core.ffms2.Version()" in call["script"]
    assert "znedi3" not in call["script"]
    assert not os.path.exists(call["path"])


@pytest.mark.parametrize("smoke, error", [
    (tooling.smoke_ffms2, NO_FFMS2),
    (tooling.smoke_znedi3, NO_ZNEDI3),
])
def test_smoke_reports_missing_namespace(fake_vspipe, smoke, error):
    calls, result = fake_vspipe
    stderr = (
        "Script evaluation failed:\n"
        "Python exception: No attribute with that name exists.\n\n"
        "Traceback (most recent call last):\n"
        '  File "vapoursynth.pyx", line 3126, in vapoursynth.Core.__getattr__\n'
        f"{error}\n\n"
    )
    result["proc"] = _done(1, stderr)

    assert smoke("pip:vapoursynth") == (False, error)
    assert "LoadPlugin" not in calls[0]["script"]
    assert not os.path.exists(calls[0]["path"])


def test_smoke_timeout_is_a_failure(fake_vspipe):
    calls, result = fake_vspipe
    result["proc"] = None  # tooling.run returns None on TimeoutExpired / OSError

    ok, err = tooling.smoke_znedi3(None, timeout=3)

    assert not ok and "3s" in err
    assert not os.path.exists(calls[0]["path"])


@pytest.mark.parametrize("smoke", [tooling.smoke_ffms2, tooling.smoke_znedi3])
def test_smoke_without_vspipe_spawns_nothing(monkeypatch, smoke):
    monkeypatch.setattr(tooling, "_vspipe_quietly", lambda: None)
    monkeypatch.setattr(tooling, "run", lambda *a, **k: pytest.fail("must not spawn"))

    assert smoke("/x/plugin.so") == (False, "vspipe not found")


# --- build_probes wiring: what /api/health (and so the UI gating) sees ---

@pytest.fixture
def studio_env(monkeypatch):
    """No ffmpeg (skips encoder smoke tests); VapourSynth and plugins controllable."""
    state = {
        "has_vs": True,
        "znedi3": None, "znedi3_smoke": (True, ""), "znedi3_calls": [],
        "ffms2": "/opt/homebrew/lib/libffms2.dylib", "ffms2_smoke": (True, ""), "ffms2_calls": [],
    }

    def fake_smoke(name):
        def smoke(plugin, timeout=20):
            state[f"{name}_calls"].append(plugin)
            return state[f"{name}_smoke"]
        return smoke

    monkeypatch.setattr(shutil, "which", lambda name: None)
    monkeypatch.setattr(tooling, "vapoursynth_available", lambda: state["has_vs"])
    monkeypatch.setattr(tooling, "find_ffms2_plugin", lambda: state["ffms2"])
    monkeypatch.setattr(tooling, "find_znedi3_plugin", lambda: state["znedi3"])
    monkeypatch.setattr(tooling, "smoke_ffms2", fake_smoke("ffms2"))
    monkeypatch.setattr(tooling, "smoke_znedi3", fake_smoke("znedi3"))
    return state


@pytest.mark.parametrize("plugin_kind", ["sentinel", "file"])
def test_znedi3_probe_fails_when_found_plugin_does_not_load(studio_env, tmp_path, plugin_kind):
    if plugin_kind == "file":
        so = tmp_path / "vsznedi3.so"
        so.write_bytes(b"\0")
        studio_env["znedi3"] = str(so)
    else:
        studio_env["znedi3"] = "pip:vapoursynth"
    studio_env["znedi3_smoke"] = (False, NO_ZNEDI3)

    out = probes.build_probes()

    z = out["znedi3"]
    assert not z.ok
    assert z.detail == "not loadable"
    assert NO_ZNEDI3 in z.fix and studio_env["znedi3"] in z.fix
    assert out["vapoursynth"].ok and out["ffms2"].ok
    assert not probes.studio_available(out)
    assert studio_env["znedi3_calls"] == [studio_env["znedi3"]]


def test_ffms2_probe_fails_when_found_plugin_does_not_load(studio_env):
    studio_env["znedi3"] = "pip:vapoursynth"
    studio_env["ffms2_smoke"] = (False, NO_FFMS2)

    out = probes.build_probes()

    f = out["ffms2"]
    assert not f.ok
    assert f.detail == "not loadable"
    assert NO_FFMS2 in f.fix and studio_env["ffms2"] in f.fix
    assert out["znedi3"].ok
    assert not probes.studio_available(out)
    assert studio_env["ffms2_calls"] == [studio_env["ffms2"]]


def test_ffms2_probe_not_found_explains_install(studio_env):
    studio_env["ffms2"] = None
    studio_env["ffms2_smoke"] = (False, NO_FFMS2)

    f = probes.build_probes()["ffms2"]

    # Still smoked: vspipe's own VapourSynth may autoload ffms2.
    assert studio_env["ffms2_calls"] == [None]
    assert not f.ok and f.detail == "not found"
    assert "brew install ffms2" in f.fix


def test_studio_ok_when_both_smoke_tests_pass(studio_env):
    studio_env["znedi3"] = "/opt/homebrew/lib/vapoursynth/vsznedi3.so"

    out = probes.build_probes()

    for pid in ("ffms2", "znedi3"):
        assert out[pid].ok and out[pid].detail == "available"
        assert "smoke test failed" not in out[pid].fix
    assert probes.studio_available(out)


def test_znedi3_probe_still_smokes_when_no_plugin_found(studio_env):
    # vspipe's own VapourSynth may autoload znedi3 even if we found no file.
    studio_env["znedi3"] = None
    studio_env["znedi3_smoke"] = (False, NO_ZNEDI3)

    z = probes.build_probes()["znedi3"]

    assert studio_env["znedi3_calls"] == [None]
    assert not z.ok and z.detail == "not found"
    assert "pip install vapoursynth" in z.fix


def test_probes_skip_smoke_without_vapoursynth(studio_env):
    studio_env["has_vs"] = False
    studio_env["znedi3"] = "pip:vapoursynth"

    out = probes.build_probes()

    assert studio_env["ffms2_calls"] == [] and studio_env["znedi3_calls"] == []
    for pid in ("ffms2", "znedi3"):
        assert not out[pid].ok
        assert "smoke test failed" not in out[pid].fix
    assert not probes.studio_available(out)
