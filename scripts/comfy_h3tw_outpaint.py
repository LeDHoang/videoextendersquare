#!/usr/bin/env python3
"""TwoAbove H3 latent-masked outpainting via ComfyUI API (H100).

Template-driven: converts the bundled example UI graph, patches loaders /
source / aspect / sampling, submits, downloads. Square 1:1 via the
"1:1 square" target_aspect patched into nodes.py.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(WS, "scripts"))
import comfy_ltx_outpaint as base

TEMPLATE = os.path.join(
    WS, "ComfyUI", "custom_nodes", "ComfyUI-H3VideoOutpaint",
    "example_workflows", "MiniMax H3 Video Outpaint.json")
TW_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"  # ours (not int8)
TW_UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"


def find_nodes(prompt, class_type):
    return sorted([nid for nid, n in prompt.items()
                   if n["class_type"] == class_type], key=int)


def one(prompt, class_type):
    ids = find_nodes(prompt, class_type)
    if len(ids) != 1:
        raise ValueError(f"expected 1 {class_type}, found {ids}")
    return ids[0]


def stage(args):
    input_dir = os.path.join(base.COMFY, "input")
    os.makedirs(input_dir, exist_ok=True)
    tag = args.prefix or f"h3tw_{int(time.time())}"
    dst = os.path.join(input_dir, f"{tag}_src.mp4")
    # Orientation-aware staging: probe source aspect, then direct-scale to
    # a %32 canvas (aspect error <0.5%). Deliberately NO pad/fillborders:
    # any synthetic edge pixels get pinned as source truth AND seed the
    # surround (v2's mirror-pad poisoned the whole run). Zero fake pixels.
    # (Fixed 2026-09-07: hardcoded 1248x704 squished portrait reels.)
    pr = subprocess.run(["ffprobe", "-v", "error", "-select_streams",
                         "v:0", "-show_entries", "stream=width,height",
                         "-of", "json", args.input],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        timeout=60, check=True)
    ps = json.loads(pr.stdout)["streams"][0]
    if int(ps["width"]) >= int(ps["height"]):
        sw, sh = 1248, 704
    else:
        sw, sh = 704, 1248
    vf = f"scale={sw}:{sh}:flags=lanczos,setsar=1,fps=30"
    subprocess.run(["ffmpeg", "-y", "-ss", str(args.trim_start), "-i",
                    args.input, "-t", str(args.trim_duration),
                    "-vf", vf, "-c:v", "libx264", "-preset", "fast",
                    "-crf", "17", "-c:a", "aac", "-ar", "48000",
                    "-movflags", "+faststart", dst],
                   check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE)
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams",
                        "v:0", "-count_frames", "-show_entries",
                        "stream=width,height,r_frame_rate,nb_read_frames",
                        "-of", "json", dst],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=120, check=True)
    s = json.loads(r.stdout)["streams"][0]
    nfr = int(s["nb_read_frames"])
    num, den = map(int, s["r_frame_rate"].split("/"))
    fps = num / den
    exp = round(args.trim_duration * 30)
    # Tolerance is asymmetric by design (2026-09-08): input -ss snaps
    # FORWARD to the next keyframe, so trims near EOF come up short
    # (reel2 tail chunk: 86f for 90f requested) while over-count means a
    # genuinely wrong stage. Downstream chunk_ok + time-based stitching
    # absorb short tails exactly.
    if nfr > exp + 2 or nfr < exp - 8 or abs(fps - 30) > 1 \
            or int(s["width"]) % 32 or int(s["height"]) % 32:
        raise ValueError(f"bad stage: {s['width']}x{s['height']} "
                         f"{fps}fps {nfr}f (expected ~{exp}f)")
    print(f"staged {dst}: {s['width']}x{s['height']} {fps:.0f}fps {nfr}f")
    # poison check: scale-only staging cannot mirror by construction, so
    # this is warn-only by design (2026-09-08: reel2 night chunks hit
    # MAD 7-11 on genuinely flat dark-sky content; a refuse threshold
    # would also fire on fade-to-black. v2's mirror-pad is prevented
    # structurally by staging with zero pad pixels, not by this probe).
    import cv2 as _cv2
    _cap = _cv2.VideoCapture(dst)
    _ok, _fr = _cap.read()
    _cap.release()
    if _ok:
        _g = _cv2.cvtColor(_fr, _cv2.COLOR_BGR2GRAY).astype(float)
        _edge = abs(_g[:, :128] - _g[:, 128:256][:, ::-1]).mean()
        print(f"stage mirror-probe: edge MAD={_edge:.1f} (real ~40+; "
              f"flat dark scenes read <15 — warn only)")
    return os.path.basename(dst)


def resolve_any(entry):
    files = []
    for _nid, nout in (entry.get("outputs") or {}).items():
        for _key, items in nout.items():
            if not isinstance(items, list):
                continue
            for item in items:
                if isinstance(item, dict) and "filename" in item:
                    p = os.path.join(base.COMFY, "output",
                                     item.get("subfolder", ""),
                                     item["filename"])
                    if os.path.exists(p):
                        files.append(p)
    # SaveVideoindexed outputs (<prefix>_NNNNN.*) first; streaming
    # intermediates may be listed but already cleaned up.
    files.sort(key=lambda p: (0 if "_0000" in p else 1, p))
    return files


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--input", default=None)
    ap.add_argument("--trim-start", type=float, default=1.0)
    ap.add_argument("--trim-duration", type=float, default=2.0)
    ap.add_argument("--aspect", default="1:1 square")
    ap.add_argument("--gen-mp", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--steps", type=int, default=None)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--frame-cap", type=int, default=120)
    ap.add_argument("--min-src-mp", type=float, default=0.5,
                    help="minimum source megapixels floor (0.5 admits "
                    "near-square canvases at 1280-class)")
    ap.add_argument("--prefix", default=None)
    ap.add_argument("--output", default=None)
    ap.add_argument("--timeout", type=int, default=7200)
    args = ap.parse_args()

    wf = json.load(open(TEMPLATE))
    prompt = base.graph_to_api_prompt(wf)
    print(f"converted {len(prompt)} nodes")

    if args.dry_run:
        print(json.dumps(prompt, indent=1)[:1500])
        print("... dry-run OK")
        return

    if not args.input:
        raise ValueError("--input required")
    if not args.prefix:
        args.prefix = f"h3tw_{int(time.time())}"
    src = stage(args)
    applied = {}

    lv = one(prompt, "LoadVideo")
    prompt[lv]["inputs"]["file"] = src
    applied["LoadVideo.file"] = src
    op = one(prompt, "MiniMaxH3SimpleVideoOutpaint")
    o = prompt[op]["inputs"]
    # set EVERY widget key explicitly: the template's mid-list 'fixed'
    # action widget shifts the converter's positional cursor from steps
    # onward, so converted values past seed are untrusted.
    o["skip_first_frames"] = 0
    o["frame_load_cap"] = args.frame_cap
    o["target_aspect"] = args.aspect
    o["generation_megapixels"] = args.gen_mp
    o["minimum_source_megapixels"] = args.min_src_mp
    o["max_upscale"] = 1.5
    if args.seed is not None:
        o["seed"] = args.seed
    o["steps"] = args.steps or 20
    o["sampler_name"] = "res_multistep"
    o["scheduler"] = "simple"
    o["prompt"] = args.prompt or ""
    o["temporal_window_frames"] = "auto"
    applied["outpaint"] = {
        k: o[k] for k in ("target_aspect", "generation_megapixels",
                          "frame_load_cap", "seed", "steps", "prompt")
        if k in o}
    # local model files (CLIP differs from template).
    for nid in find_nodes(prompt, "CLIPLoader"):
        prompt[nid]["inputs"]["clip_name"] = TW_CLIP
    for nid in find_nodes(prompt, "UNETLoader"):
        prompt[nid]["inputs"]["unet_name"] = TW_UNET
    sv = one(prompt, "SaveVideo")
    prompt[sv]["inputs"]["filename_prefix"] = args.prefix
    print("overrides:", json.dumps(applied, indent=1))

    t0 = time.time()
    pid, entry = base.submit_and_wait(prompt, timeout_s=args.timeout)
    files = resolve_any(entry)
    print(f"done in {time.time() - t0:.0f}s, outputs: {files}")
    if args.output and files:
        # auto-trim: node snaps frame count UP to 17k+5 and fully
        # denoises the padded tail (invented content, e.g. conf's desert
        # portrait). Cut output back to the staged source length.
        import cv2 as _cv2
        _cap = _cv2.VideoCapture(os.path.join(base.COMFY, "input", src))
        nstaged = int(_cap.get(_cv2.CAP_PROP_FRAME_COUNT))
        _cap.release()
        _cap = _cv2.VideoCapture(files[0])
        nout = int(_cap.get(_cv2.CAP_PROP_FRAME_COUNT))
        _cap.release()
        if nout > nstaged:
            cut = args.output.replace(".mp4", f"_{nout}f.mp4")
            shutil.copy(files[0], cut)
            subprocess.run(["ffmpeg", "-y", "-i", cut, "-frames:v",
                            str(nstaged), "-c:v", "libx264", "-preset",
                            "fast", "-crf", "17", "-an", args.output],
                           check=True, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE)
            print(f"tail-trimmed {nout}->{nstaged}f (raw kept at {cut})")
        else:
            shutil.copy(files[0], args.output)
            print(f"copied -> {args.output}")


if __name__ == "__main__":
    main()
