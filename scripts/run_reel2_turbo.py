#!/usr/bin/env python3
"""TwoAbove H3 TURBO outpainting for reel2 (Video-87640.mp4, 35.224s portrait).

Separate A/B script vs the stock 14-step pipeline (scripts/full_reels.py):
same staging / chunking / stitch / decrush, but with the LightX2V FL2VA
8-step Turbo LoRA spliced between MiniMaxChunkFeedForward and the outpaint
node, running 8 steps.

Collision-safe vs the main run (shared NFS workspace): chunk prefix
reel2_twb{i} (main run uses reel2_twf), final output/reel2_turbofull.mp4,
log logs/comfy_reel2_turbo.log, stitch tmp .cache/stitch_turbo_tmp.mp4.

Run on a second 1-GPU workspace; needs its own ComfyUI server on 8188.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

import cv2

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(WS, "scripts"))
import comfy_ltx_outpaint as base
import comfy_h3tw_outpaint as tw
from full_reels import (FPS, chunks, chunk_ok, count, decrush, norm30,
                        np_clip)

SRC = os.path.join(WS, "input/reels/Video-87640.mp4")
DUR = 35.224
TAG = "reel2_turbo"
LORA = "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"
LOG = os.path.join(WS, "logs/comfy_reel2_turbo.log")
STITCH_TMP = os.path.join(WS, ".cache/stitch_turbo_tmp.mp4")


def log(msg):
    line = f"{msg} {time.strftime('%H:%M:%S', time.gmtime())}"
    with open(LOG, "a") as f:
        f.write(line + "\n")


def splice_lora(prompt, lora_name, strength):
    """Insert LoraLoaderModelOnly after MiniMaxChunkFeedForward; rewire the
    outpaint node's model input to it. Returns LoRA node id."""
    ff = tw.one(prompt, "MiniMaxChunkFeedForward")
    lid = str(max(int(n) for n in prompt) + 1)
    prompt[lid] = {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {"model": [ff, 0], "lora_name": lora_name,
                   "strength_model": strength},
    }
    op = tw.one(prompt, "MiniMaxH3SimpleVideoOutpaint")
    prompt[op]["inputs"]["model"] = [lid, 0]
    return lid


def build_prompt(args, staged_src, prefix):
    wf = json.load(open(tw.TEMPLATE))
    prompt = base.graph_to_api_prompt(wf)
    lv = tw.one(prompt, "LoadVideo")
    prompt[lv]["inputs"]["file"] = staged_src
    op = tw.one(prompt, "MiniMaxH3SimpleVideoOutpaint")
    o = prompt[op]["inputs"]
    o["skip_first_frames"] = 0
    o["frame_load_cap"] = args.frame_cap
    o["target_aspect"] = "1:1 square"
    o["generation_megapixels"] = 1.0
    o["minimum_source_megapixels"] = 0.5
    o["max_upscale"] = 1.5
    o["seed"] = args.seed
    o["steps"] = args.steps
    o["sampler_name"] = args.sampler
    o["scheduler"] = "simple"
    o["prompt"] = ""
    o["temporal_window_frames"] = "auto"
    for nid in tw.find_nodes(prompt, "CLIPLoader"):
        prompt[nid]["inputs"]["clip_name"] = tw.TW_CLIP
    for nid in tw.find_nodes(prompt, "UNETLoader"):
        prompt[nid]["inputs"]["unet_name"] = tw.TW_UNET
    lid = splice_lora(prompt, LORA, args.lora_strength)
    sv = tw.one(prompt, "SaveVideo")
    prompt[sv]["inputs"]["filename_prefix"] = prefix
    return prompt, lid


def run_chunk(args, a, b, i):
    px = f"{TAG}_f{i}"
    out = os.path.join(WS, f"output/{px}.mp4")
    ns = argparse.Namespace(prefix=px, input=SRC, trim_start=a,
                            trim_duration=round(b - a, 3))
    staged = tw.stage(ns)
    # Effective coverage: input -ss can snap forward to a keyframe near
    # EOF, so a short stage is anchored at its END (b is exact).
    cap0 = cv2.VideoCapture(os.path.join(base.COMFY, "input", staged))
    nst = int(cap0.get(cv2.CAP_PROP_FRAME_COUNT))
    cap0.release()
    exp0 = round((b - a) * 30)
    eff_a = a if abs(nst - exp0) <= 2 else round(b - nst / 30.0, 3)
    if eff_a != a:
        print(f"chunk {i}: short stage {nst}f vs {exp0}f, "
              f"coverage [{eff_a:.3f},{b:.3f}]")
    prompt, lid = build_prompt(args, staged, px)
    if args.dry_run:
        print(f"chunk {i} [{eff_a:.2f},{b:.2f}]: LoRA node {lid} = "
              f"{json.dumps(prompt[lid])}")
        op = tw.one(prompt, "MiniMaxH3SimpleVideoOutpaint")
        print(f"chunk {i}: outpaint model link = "
              f"{prompt[op]['inputs']['model']}, "
              f"steps={prompt[op]['inputs']['steps']}, "
              f"sampler={prompt[op]['inputs']['sampler_name']}")
        return True, eff_a
    t0 = time.time()
    pid, entry = base.submit_and_wait(prompt, timeout_s=args.timeout)
    files = tw.resolve_any(entry)
    log(f"chunk {i} {px} rc-ok in {time.time()-t0:.0f}s outputs={files}")
    if not files:
        return False, a
    # auto-trim node snap-up tail (17k+5), keep raw like the stock driver
    nstaged = nst
    cap = cv2.VideoCapture(files[0])
    nout = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    if nout > nstaged:
        cut = out.replace(".mp4", f"_{nout}f.mp4")
        shutil.copy(files[0], cut)
        subprocess.run(["ffmpeg", "-y", "-i", cut, "-frames:v",
                        str(nstaged), "-c:v", "libx264", "-preset",
                        "fast", "-crf", "17", "-an", out],
                       check=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
    else:
        shutil.copy(files[0], out)
    return True, eff_a


def stitch(parts, bounds, dst, W, H, sw, sh):
    """Time-based composite + portrait/landscape-aware decrush."""
    allfr, starts = [], []
    for p, (a, b) in zip(parts, bounds):
        cap = cv2.VideoCapture(p)
        frames = []
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            if (fr.shape[1], fr.shape[0]) != (W, H):
                fr = cv2.resize(fr, (W, H))
            frames.append(decrush(fr, sw, sh, W, H))
        cap.release()
        assert len(frames) > 1, f"{p} empty"
        allfr.append(frames)
        starts.append(a)
    cov0 = starts[0]
    cov1 = max(a + len(fr) / FPS for a, fr in zip(starts, allfr))
    nout = int(round((cov1 - cov0) * FPS))
    vw = cv2.VideoWriter(STITCH_TMP, cv2.VideoWriter_fourcc(*"mp4v"),
                         FPS, (W, H))
    for i in range(nout):
        t = cov0 + i / FPS
        cov = [(j, (t - a) * FPS) for j, a in enumerate(starts)
               if 0 <= (t - a) * FPS <= len(allfr[j]) - 1]
        if not cov:
            j = min(range(len(starts)), key=lambda j: abs(t - starts[j]))
            k = int(round((t - starts[j]) * FPS))
            k = max(0, min(k, len(allfr[j]) - 1))
            vw.write(allfr[j][k])
            continue
        if len(cov) == 1:
            j, kf = cov[0]
            vw.write(allfr[j][int(round(kf))])
        else:
            (j1, k1), (j2, k2) = cov[0], cov[-1]
            z0, z1 = starts[j2], starts[j1] + (len(allfr[j1]) - 1) / FPS
            alpha = 0.5 if z1 <= z0 else (t - z0) / (z1 - z0)
            f1 = allfr[j1][int(round(k1))].astype("float32")
            f2 = allfr[j2][int(round(k2))].astype("float32")
            vw.write(np_clip(f1 * (1 - alpha) + f2 * alpha))
    vw.release()
    subprocess.run(["ffmpeg", "-y", "-i", STITCH_TMP, "-c:v", "libx264",
                    "-preset", "fast", "-crf", "17", "-an", dst],
                   check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE)
    return nout


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--sampler", default="res_multistep")
    ap.add_argument("--lora-strength", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--frame-cap", type=int, default=120)
    ap.add_argument("--timeout", type=int, default=3600)
    args = ap.parse_args()

    assert os.path.exists(SRC), f"missing {SRC}"
    assert os.path.exists(os.path.join(
        WS, "ComfyUI/models/loras", LORA)), f"missing LoRA {LORA}"
    log(f"=== TURBO {TAG} start steps={args.steps} sampler={args.sampler} "
        f"lora_strength={args.lora_strength} seed={args.seed}")

    spans = chunks(DUR, 3.0, 1.0)
    parts, bounds = [], []

    def eff_start(a, b, px):
        """Effective coverage start from the staged file (short EOF
        stages anchor at their end)."""
        sp = os.path.join(base.COMFY, "input", f"{px}_src.mp4")
        try:
            cap = cv2.VideoCapture(sp)
            nst = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            cap.release()
        except Exception:
            return a
        exp0 = round((b - a) * 30)
        return a if abs(nst - exp0) <= 2 else round(b - nst / 30.0, 3)

    for i, (a, b) in enumerate(spans):
        px = f"{TAG}_f{i}"
        out = os.path.join(WS, f"output/{px}.mp4")
        last = i == len(spans) - 1
        if args.dry_run:
            run_chunk(args, a, b, i)
            continue
        if not chunk_ok(out, a, b, last):
            t0 = time.time()
            try:
                ok, eff_a = run_chunk(args, a, b, i)
            except Exception as e:
                log(f"FAIL tw {px}: {e}")
                break
            log(f"rc={'0' if ok else '1'} in {time.time()-t0:.0f}s :: "
                f"{SRC} --trim-start {a}")
            if not ok or not chunk_ok(out, a, b, last):
                log(f"FAIL tw {px}, abort")
                break
        else:
            log(f"reuse {px}")
            eff_a = eff_start(a, b, px)
        nn = os.path.join(WS, f".cache/{px}_n30.mp4")
        norm30(out, nn)
        parts.append(nn)
        bounds.append((eff_a, b))
    if args.dry_run:
        print("dry-run OK")
        return
    if len(parts) != len(spans):
        log("incomplete, no stitch")
        return
    n0 = count(parts[0])
    W0, H0 = n0[1], n0[2]
    # staged dims from probed orientation (reel2 portrait -> 704x1248)
    pr = subprocess.run(["ffprobe", "-v", "error", "-select_streams",
                         "v:0", "-show_entries", "stream=width,height",
                         "-of", "json", SRC], stdout=subprocess.PIPE,
                        check=True)
    ps = json.loads(pr.stdout)["streams"][0]
    sw, sh = (1248, 704) if int(ps["width"]) >= int(ps["height"]) \
        else (704, 1248)
    dst = os.path.join(WS, "output/reel2_turbofull.mp4")
    total = stitch(parts, bounds, dst, W0, H0, sw, sh)
    exp = round(DUR * FPS)
    got = count(dst)[0]
    log(f"VALIDATE {TAG}: {count(dst)} stitched={total} expected~{exp} "
        f"{'OK' if abs(got - exp) <= 12 else 'MISMATCH'}")
    log(f"=== TURBO {TAG} end ALLDONE")


if __name__ == "__main__":
    main()
