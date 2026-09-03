#!/usr/bin/env python3
"""Local LTX-2.3 IC-LoRA in/outpainting via ComfyUI API (standalone, H100).

Template-driven: loads the stock
  ComfyUI/custom_nodes/ComfyUI-LTXVideo/example_workflows/2.3/
  LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json
as a UI-graph, converts it to ComfyUI API-prompt format, applies runtime
overrides, submits to a local ComfyUI server (:8188) and fetches the result.

All heavy data stays on vol11-scratch (ComfyUI/models|input|output, .cache/).
Nothing here touches pipeline/ or server/ (later integration step).

Examples:
  # validate conversion only
  scripts/comfy_ltx_outpaint.py --dry-run
  # stock smoke test (uses bundled sample, no pre-processing)
  scripts/comfy_ltx_outpaint.py --stock --output output/smoke.mp4
  # real clip: trim 0-8s, outpaint to 1280x1280 square
  scripts/comfy_ltx_outpaint.py --input clip.mp4 --trim-start 0 \\
      --trim-duration 8 --target-width 1280 --target-height 1280 \\
      --prompt "city street at dusk" --seed 42 --output out.mp4
"""

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMFY = os.path.join(WS, "ComfyUI")
TEMPLATE = os.path.join(
    COMFY, "custom_nodes", "ComfyUI-LTXVideo", "example_workflows",
    "2.3", "LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json")
SPEC_CACHE = os.path.join(WS, ".cache", "comfy_obj_specs.json")
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")

WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN"}
SKIP_TYPES = {"MarkdownNote", "Note"}


def api_get(path, timeout=30):
    with urllib.request.urlopen(COMFY_URL + path, timeout=timeout) as r:
        return json.load(r)


def api_post(path, payload, timeout=30):
    req = urllib.request.Request(
        COMFY_URL + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def load_specs(types):
    """object_info per node type, cached on vol11 (.cache/)."""
    specs = {}
    if os.path.exists(SPEC_CACHE):
        try:
            specs = json.load(open(SPEC_CACHE))
        except Exception:
            specs = {}
    missing = [t for t in types if t not in specs]
    for t in missing:
        specs[t] = api_get(f"/object_info/{t}")[t]
    if missing:
        os.makedirs(os.path.dirname(SPEC_CACHE), exist_ok=True)
        json.dump(specs, open(SPEC_CACHE, "w"), indent=1)
    return specs


def is_dynamic_combo(spec):
    kind = spec[0] if isinstance(spec, list) and spec else None
    return isinstance(kind, str) and "DYNAMICCOMBO" in kind


def is_widget_input(spec):
    """True if an INPUT_TYPES entry creates a widget (vs a link socket)."""
    kind = spec[0] if isinstance(spec, list) and spec else None
    if isinstance(kind, list):
        return True  # combo options
    if kind in WIDGET_TYPES or kind == "COMBO":
        return True
    if isinstance(kind, str) and "DYNAMICCOMBO" in kind:
        return True
    return False


def spec_default(idef):
    if isinstance(idef, list) and len(idef) > 1 and isinstance(idef[1], dict):
        return idef[1].get("default")
    return None


def is_hidden(idef):
    """Hidden inputs have no widget in the UI graph, so they never consume
    a positional widgets_values slot (e.g. SaveVideo's legacy top-level
    `codec` dynamic combo, hidden:true). They are only emitted when linked."""
    return (isinstance(idef, list) and len(idef) > 1
            and isinstance(idef[1], dict) and idef[1].get("hidden"))


class Cursor:
    """Positional widgets_values consumer with default-fill + action-drop."""

    def __init__(self, values, where):
        self.values = list(values)
        self.i = 0
        self.where = where

    def nxt(self, key, idef):
        if self.i < len(self.values):
            v = self.values[self.i]
            self.i += 1
            return v
        d = spec_default(idef)
        if d is not None:
            print(f"{self.where}: {key} absent from widgets_values, "
                  f"using spec default {d!r}", file=sys.stderr)
            return d
        raise ValueError(f"{self.where}: no value for {key!r} and no default")

    def finish(self):
        if self.i < len(self.values):
            print(f"{self.where}: dropping {len(self.values) - self.i} "
                  f"trailing action widget(s): {self.values[self.i:]}",
                  file=sys.stderr)


def convert_node(n, spec, links):
    """One UI-graph node -> (class_type, api_inputs). Raises on ambiguity."""
    where = f"node {n['id']} ({n['type']})"
    entries = {e.get("name"): e for e in n.get("inputs", [])}
    cur = Cursor(n.get("widgets_values") or [], where)
    out = {}

    def link_val(entry):
        lid = entry.get("link")
        if lid not in links:
            raise ValueError(f"{where}: dangling link {lid}")
        src, slot = links[lid]
        return [str(src), slot]

    def walk_inputs(inputs_dict, prefix=""):
        for key, idef in inputs_dict.items():
            dkey = f"{prefix}{key}" if prefix else key
            entry = entries.get(dkey, entries.get(key))
            if entry is not None and entry.get("link") is not None:
                # Link wins over any widget (connected widget inputs still
                # serialize their stale value — consume and discard it).
                if is_widget_input(idef) or is_dynamic_combo(idef):
                    stale = cur.nxt(dkey, idef)
                    print(f"{where}: {dkey} link-driven, ignoring stale "
                          f"widget value {stale!r}", file=sys.stderr)
                out[dkey] = link_val(entry)
                continue
            if is_hidden(idef):
                continue  # no widget slot in UI graph; omit unless linked
            if is_dynamic_combo(idef):
                choice = cur.nxt(dkey, idef)
                opts = {o["key"]: o for o in
                        idef[1].get("options", [])} if len(idef) > 1 else {}
                if choice not in opts:
                    raise ValueError(f"{where}: unknown {dkey} option "
                                     f"{choice!r} (known: {sorted(opts)})")
                out[dkey] = choice
                sub = dict(opts[choice].get("inputs", {}).get("required", {}))
                sub.update(opts[choice].get("inputs", {}).get("optional", {}))
                walk_inputs(sub, prefix=f"{dkey}.")
            elif is_widget_input(idef):
                out[dkey] = cur.nxt(dkey, idef)
            else:
                continue  # unconnected non-widget input (e.g. mask)

    def walk(inputs_dict):
        walk_inputs(inputs_dict)

    req = spec.get("input", {}).get("required") or {}
    opt = spec.get("input", {}).get("optional") or {}
    walk(req)
    walk(opt)
    cur.finish()
    # every widget ref in node.inputs must resolve to an assigned key
    for ename, e in entries.items():
        w = e.get("widget")
        if w and e.get("link") is None:
            ref = w.get("name", ename)
            if ref not in out and ename not in out:
                raise ValueError(f"{where}: widget ref {ref!r} unassigned")
    return n["type"], out


def graph_to_api_prompt(wf):
    """Convert UI-graph workflow JSON to ComfyUI API prompt dict.

    Mirrors the frontend graphToPrompt rules:
      * skip muted (mode==4) nodes and display notes
      * linked inputs -> [from_node_id, from_slot]
      * widget-backed inputs -> widget value (matched by widget name;
        positional fallback for nodes with empty inputs[] like loaders)
    Raises on any unresolvable mapping (loud > wrong).
    """
    types = sorted({n["type"] for n in wf["nodes"]
                    if n["type"] not in SKIP_TYPES and n.get("mode") != 4})
    specs = load_specs(types)

    # link_id -> (from_node_id, from_slot_index)
    links = {}
    for n in wf["nodes"]:
        for si, o in enumerate(n.get("outputs", [])):
            for lid in (o.get("links") or []):
                links[lid] = (n["id"], si)

    prompt = {}
    for n in wf["nodes"]:
        if n.get("mode") == 4 or n["type"] in SKIP_TYPES:
            continue
        t = n["type"]
        if t not in specs:
            raise ValueError(f"node {n['id']}: no object_info for type {t!r} "
                             f"(custom node missing?)")
        ctype, inputs = convert_node(n, specs[t], links)
        prompt[str(n["id"])] = {"class_type": ctype, "inputs": inputs}
    return prompt


def find_nodes(prompt, class_type):
    return sorted([nid for nid, n in prompt.items()
                   if n["class_type"] == class_type], key=int)


def apply_overrides(prompt, args):
    """Patch the API prompt in place. Returns dict of applied changes."""
    applied = {}

    def one(class_type):
        ids = find_nodes(prompt, class_type)
        if len(ids) != 1:
            raise ValueError(f"expected 1 {class_type}, found {ids}")
        return ids[0]

    def pair(class_type):
        ids = find_nodes(prompt, class_type)
        if len(ids) != 2:
            raise ValueError(f"expected 2 {class_type}, found {ids}")
        return ids  # smaller id = stage 1 by construction of template

    if args.video_file:
        nid = one("LoadVideo")
        prompt[nid]["inputs"]["file"] = args.video_file
        applied["LoadVideo.file"] = args.video_file
    if args.ref_image:
        nid = one("LoadImage")
        prompt[nid]["inputs"]["image"] = args.ref_image
        applied["LoadImage.image"] = args.ref_image
    if args.prompt is not None or args.negative is not None:
        # role = which LTXVConditioning socket each encoder feeds
        role_of = {}
        for nid in find_nodes(prompt, "CLIPTextEncode"):
            for oid, o in prompt.items():
                for k, v in o["inputs"].items():
                    if (isinstance(v, list) and v[0] == nid
                            and o["class_type"] == "LTXVConditioning"):
                        role_of[nid] = k
        for nid, role in role_of.items():
            if role == "positive" and args.prompt is not None:
                prompt[nid]["inputs"]["text"] = args.prompt
                applied[f"CLIPTextEncode.{nid}.text"] = args.prompt
            if role == "negative" and args.negative is not None:
                prompt[nid]["inputs"]["text"] = args.negative
                applied[f"CLIPTextEncode.{nid}.text"] = args.negative
    if args.seed is not None:
        for nid in find_nodes(prompt, "RandomNoise"):
            prompt[nid]["inputs"]["noise_seed"] = args.seed
            applied[f"RandomNoise.{nid}"] = args.seed
    if args.target_width or args.target_height or args.feathering is not None:
        nid = one("ImagePadForOutpaintTargetSize")
        cur = prompt[nid]["inputs"]
        if args.target_width:
            cur["target_width"] = args.target_width
        if args.target_height:
            cur["target_height"] = args.target_height
        if args.feathering is not None:
            cur["feathering"] = args.feathering
        applied["ImagePad"] = {k: cur[k] for k in
                               ("target_width", "target_height", "feathering")
                               if k in cur}
    if args.cfg is not None:
        for nid in find_nodes(prompt, "CFGGuider"):
            prompt[nid]["inputs"]["cfg"] = args.cfg
            applied[f"CFGGuider.{nid}.cfg"] = args.cfg
    if args.sampler:
        for nid in find_nodes(prompt, "KSamplerSelect"):
            prompt[nid]["inputs"]["sampler_name"] = args.sampler
            applied[f"KSamplerSelect.{nid}"] = args.sampler
    if args.sigmas_s1 or args.sigmas_s2:
        ids = pair("ManualSigmas")
        # longer schedule = stage 1
        s1 = max(ids, key=lambda i: len(str(prompt[i]["inputs"]["sigmas"])))
        s2 = min(ids, key=lambda i: len(str(prompt[i]["inputs"]["sigmas"])))
        if args.sigmas_s1:
            prompt[s1]["inputs"]["sigmas"] = args.sigmas_s1
            applied["sigmas_s1"] = args.sigmas_s1
        if args.sigmas_s2:
            prompt[s2]["inputs"]["sigmas"] = args.sigmas_s2
            applied["sigmas_s2"] = args.sigmas_s2
    if args.distilled_strength is not None or args.iclora_strength is not None:
        for nid in find_nodes(prompt, "LoraLoaderModelOnly"):
            if args.distilled_strength is not None:
                prompt[nid]["inputs"]["strength_model"] = \
                    args.distilled_strength
                applied["distilled_lora.strength"] = args.distilled_strength
        for nid in find_nodes(prompt, "LTXICLoRALoaderModelOnly"):
            if args.iclora_strength is not None:
                prompt[nid]["inputs"]["strength_model"] = args.iclora_strength
                applied["iclora.strength"] = args.iclora_strength
    if args.guide_strength is not None or args.attention_strength is not None:
        nid = one("LTXAddVideoICLoRAGuideAdvanced")
        if args.guide_strength is not None:
            prompt[nid]["inputs"]["strength"] = args.guide_strength
            applied["guide.strength"] = args.guide_strength
        if args.attention_strength is not None:
            prompt[nid]["inputs"]["attention_strength"] = \
                args.attention_strength
            applied["guide.attention_strength"] = args.attention_strength
    if args.fps:
        for cls, key in (("CreateVideo", "fps"),
                         ("LTXVConditioning", "frame_rate")):
            for nid in find_nodes(prompt, cls):
                prompt[nid]["inputs"][key] = float(args.fps)
                applied[f"{cls}.{nid}.{key}"] = float(args.fps)
    if args.prefix:
        nid = one("SaveVideo")
        prompt[nid]["inputs"]["filename_prefix"] = args.prefix
        applied["SaveVideo.prefix"] = args.prefix
    return applied


STOCK_VIDEO_URL = ("https://media.githubusercontent.com/media/Lightricks/"
                   "ComfyUI-LTXVideo/master/example_workflows/assets/"
                   "outpainting_input.mp4")


def _looks_like_lfs_pointer(path):
    try:
        with open(path, "rb") as f:
            head = f.read(120)
        return b"git-lfs.github.com/spec/v1" in head
    except OSError:
        return False


def _ffprobe_ok(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                            "format=duration", "-of", "csv=p=0", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=60)
        return r.returncode == 0 and r.stdout.strip()
    except Exception:
        return False


def _has_audio(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                            "-show_entries", "stream=index",
                            "-of", "csv=p=0", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=60)
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


def _ensure_audio_track(dst):
    """Mux a silent AAC track if the clip has none.

    The stock two-stage graph always runs the audio-VAE path
    (`VAEEncodeAudio` hard-fails on `audio=None`), so silent sources must
    carry an empty track. Video stream is copied, not re-encoded.
    """
    if _has_audio(dst):
        return False
    tmp = dst + ".withaudio.mp4"
    subprocess.run(["ffmpeg", "-y", "-i", dst, "-f", "lavfi", "-i",
                    "anullsrc=r=48000:cl=stereo", "-c:v", "copy",
                    "-c:a", "aac", "-shortest",
                    "-movflags", "+faststart", tmp],
                   check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE)
    os.replace(tmp, dst)
    print(f"staged {dst}: no audio in source, muxed silent AAC track")
    return True


def prepare_inputs(args):
    """Trim (ffmpeg) + stage files into ComfyUI/input/. Returns
    (video_file, ref_image) basenames. --stock skips pre-processing."""
    input_dir = os.path.join(COMFY, "input")
    os.makedirs(input_dir, exist_ok=True)
    if args.stock:
        dst = os.path.join(input_dir, "outpainting_input.mp4")
        # Shallow clones lack git-lfs, so the bundled asset dir holds a
        # 132-byte LFS pointer, not a video. Re-fetch real bytes if needed.
        if (not os.path.exists(dst) or _looks_like_lfs_pointer(dst)
                or not _ffprobe_ok(dst)):
            src = os.path.join(
                COMFY, "custom_nodes", "ComfyUI-LTXVideo",
                "example_workflows", "assets", "outpainting_input.mp4")
            if (os.path.exists(src) and not _looks_like_lfs_pointer(src)
                    and _ffprobe_ok(src)):
                shutil.copy(src, dst)
            else:
                subprocess.run(["curl", "-sL", "--max-time", "300",
                                "-o", dst, STOCK_VIDEO_URL], check=True)
            if not _ffprobe_ok(dst):
                raise RuntimeError(
                    f"stock sample {dst} is not a readable video "
                    f"(git-lfs pointer?); fetch it manually and retry")
        if not os.path.exists(os.path.join(input_dir, "example.png")):
            raise RuntimeError("ComfyUI/input/example.png missing")
        return "outpainting_input.mp4", "example.png"  # already in input/
    if not args.input:
        raise ValueError("--input required (or --stock)")
    tag = args.prefix or f"ltx_{int(time.time())}"
    base = f"{tag}_src.mp4"
    dst = os.path.join(input_dir, base)
    trim = ["ffmpeg", "-y", "-ss", str(args.trim_start), "-i", args.input,
            "-t", str(args.trim_duration), "-c", "copy",
            "-movflags", "+faststart", dst]
    try:
        subprocess.run(trim, check=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
        if not os.path.exists(dst) or os.path.getsize(dst) == 0:
            raise OSError("stream-copy produced empty file")
    except Exception:
        subprocess.run(["ffmpeg", "-y", "-ss", str(args.trim_start), "-i",
                        args.input, "-t", str(args.trim_duration),
                        "-c:v", "libx264", "-preset", "fast", "-crf", "17",
                        "-c:a", "copy", dst],
                        check=True, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE)
    _ensure_audio_track(dst)  # stock graph needs an audio stream (see def)
    ref = f"{tag}_ref.png"
    subprocess.run(["ffmpeg", "-y", "-i", dst, "-vframes", "1", "-q:v", "2",
                    os.path.join(input_dir, ref)],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return base, ref


def submit_and_wait(prompt, timeout_s=3600, poll_s=5):
    res = api_post("/prompt", {"prompt": prompt})
    pid = res["prompt_id"]
    print(f"queued prompt_id={pid}")
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        time.sleep(poll_s)
        try:
            hist = api_get(f"/history/{pid}", timeout=30)
        except Exception as e:
            print(f"history poll: {e}")
            continue
        if pid in hist:
            entry = hist[pid]
            if entry.get("status", {}).get("completed"):
                return pid, entry
            if entry.get("status", {}).get("status_str") == "error":
                raise RuntimeError(f"prompt failed: {entry['status']}")
        el = time.time() - t0
        print(f"  ... {el:.0f}s elapsed")
    raise TimeoutError(f"prompt {pid} not done after {timeout_s}s")


def resolve_outputs(prompt, entry):
    """Files produced by the SaveVideo node(s) under ComfyUI/output/.

    Only SaveVideo outputs count: passthrough nodes such as LoadVideo also
    appear in history['outputs'] but reference files in ComfyUI/input/.
    """
    save_ids = set(find_nodes(prompt, "SaveVideo"))
    files = []
    for nid, nout in (entry.get("outputs") or {}).items():
        if save_ids and str(nid) not in save_ids:
            continue
        for key in ("video", "gifs", "images"):
            for item in (nout.get(key) or []):
                sub = item.get("subfolder", "")
                path = os.path.join(COMFY, "output", sub, item["filename"])
                files.append(path)
    return files


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true",
                    help="convert template + validate, don't queue")
    ap.add_argument("--stock", action="store_true",
                    help="use bundled sample media, skip pre-processing")
    ap.add_argument("--input", default=None, help="source video path")
    ap.add_argument("--trim-start", type=float, default=0.0)
    ap.add_argument("--trim-duration", type=float, default=8.0)
    ap.add_argument("--target-width", type=int, default=None)
    ap.add_argument("--target-height", type=int, default=None)
    ap.add_argument("--feathering", type=int, default=None)
    ap.add_argument("--fps", type=float, default=None)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--negative", default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--cfg", type=float, default=None)
    ap.add_argument("--sampler", default=None)
    ap.add_argument("--sigmas-s1", default=None)
    ap.add_argument("--sigmas-s2", default=None)
    ap.add_argument("--distilled-strength", type=float, default=None)
    ap.add_argument("--iclora-strength", type=float, default=None)
    ap.add_argument("--guide-strength", type=float, default=None)
    ap.add_argument("--attention-strength", type=float, default=None)
    ap.add_argument("--prefix", default=None,
                    help="SaveVideo filename prefix (also tags staged files)")
    ap.add_argument("--output", default=None,
                    help="where to copy the finished video")
    ap.add_argument("--timeout", type=int, default=3600)
    args = ap.parse_args()

    wf = json.load(open(TEMPLATE))
    prompt = graph_to_api_prompt(wf)
    print(f"converted {len(prompt)} nodes "
          f"(skipped {len(wf['nodes']) - len(prompt)} muted/note)")

    if args.dry_run:
        print(json.dumps(prompt, indent=1)[:2000])
        print("... dry-run OK")
        return

    video_file, ref_image = prepare_inputs(args)
    args.video_file, args.ref_image = video_file, ref_image
    if not args.prefix:
        args.prefix = f"ltx_out_{int(time.time())}"
    applied = apply_overrides(prompt, args)
    print("overrides:", json.dumps(applied, indent=1))

    t0 = time.time()
    pid, entry = submit_and_wait(prompt, timeout_s=args.timeout)
    files = resolve_outputs(prompt, entry)
    print(f"done in {time.time() - t0:.0f}s, outputs: {files}")
    if args.output and files:
        shutil.copy(files[0], args.output)
        print(f"copied -> {args.output}")


if __name__ == "__main__":
    main()
