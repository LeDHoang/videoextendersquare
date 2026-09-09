#!/usr/bin/env python3
"""MiniMax-H3 Ref2VA outpainting via ComfyUI API (standalone, H100).

Template-driven: converts templates/minimax_h3_r2v.json (official
Comfy-Org r2v workflow) to API prompt, then adapts it for outpainting:
  * ref_video_0 <- LoadVideo(padded source canvas; full clip, not frames)
  * stock ref LoadImages deleted (missing files would fail the run)
  * turbo 4-step path enabled (PrimitiveBoolean -> true)
  * canvas via width/height literals, length via duration float (17k+5 snap)
  * optional Fun-ControlNet mask patch (--mask inversely: mask=1 bands):
    ModelPatchLoader + MiniMaxH3FunControlNetApply inserted after the
    MODEL switch; mask clip + source video staged alongside input
  * optional post-decode source composite (--composite): original center
    pixels pasted back over the output with a feathered ramp (pixel-exact
    preservation regardless of model obedience)

Staging is H3-specific: 24fps fixed, 124f trim (17*7+5), square canvas
rendered in ffmpeg (pad + scale), mask clip via numpy+feather.

Examples:
  scripts/comfy_h3_outpaint.py --dry-run
  scripts/comfy_h3_outpaint.py --dry-run --mask
  scripts/comfy_h3_outpaint.py --input clip.mp4 --canvas 768 \\
      --prompt "smoky sky above, dusty ground below" --seed 7 \\
      --prefix bf_h3 --output output/bf_h3.mp4
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

import cv2
import numpy as np

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(WS, "scripts"))
import comfy_ltx_outpaint as base

TEMPLATE_H3 = os.path.join(WS, "templates", "minimax_h3_r2v.json")
CONTROLNET = ("controlnet/"
              "minimax_h3_fun_controlnet_union_pruned_int8_convrot."
              "safetensors")
H3_FPS = 24
H3_LEN = 124  # 17*7+5 frames ~= 5.17s @24fps


def find_nodes(prompt, class_type):
    return sorted([nid for nid, n in prompt.items()
                   if n["class_type"] == class_type], key=int)


def one(prompt, class_type):
    ids = find_nodes(prompt, class_type)
    if len(ids) != 1:
        raise ValueError(f"expected 1 {class_type}, found {ids}")
    return ids[0]


def consumers_of(prompt, nid, slot=None):
    out = []
    for uid, u in prompt.items():
        for k, v in u["inputs"].items():
            if isinstance(v, list) and v[0] == nid and \
                    (slot is None or v[1] == slot):
                out.append((uid, k))
    return out


def instantiate(prompt, class_type, partial):
    """Append a node, filling required inputs with spec defaults."""
    specs = base.load_specs([class_type])
    spec = specs[class_type]
    inputs = {}
    for grp in ("required", "optional"):
        for key, idef in (spec.get("input", {}).get(grp) or {}).items():
            if not base.is_widget_input(idef) \
                    and not base.is_dynamic_combo(idef):
                continue
            if base.is_hidden(idef):
                continue
            if key in partial:
                continue
            d = base.spec_default(idef)
            if d is not None:
                inputs[key] = d
    inputs.update(partial)
    nid = str(max(map(int, prompt)) + 1)
    prompt[nid] = {"class_type": class_type, "inputs": inputs}
    return nid


def ffprobe_src(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-show_entries",
                        "stream=width,height,r_frame_rate,duration",
                        "-of", "json", path],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=60, check=True)
    s = json.loads(r.stdout)["streams"][0]
    num, den = map(int, s["r_frame_rate"].split("/"))
    return int(s["width"]), int(s["height"]), num / den


def stage_inputs(args):
    """Trim + 24fps + square pad/scale + mask clip into ComfyUI/input/."""
    input_dir = os.path.join(base.COMFY, "input")
    os.makedirs(input_dir, exist_ok=True)
    # unique staging tag per run: the server execution-caches loaders by
    # filename, so re-staging under a reused prefix serves stale frames.
    tag = f"{args.prefix or f'h3_{int(time.time())}'}_{os.getpid()}"
    iw, ih, _fps = ffprobe_src(args.input)
    dur = H3_LEN / H3_FPS
    # source rect inside canvas (even dims for h264).
    k = args.canvas / max(iw, ih)
    rw, rh = int(iw * k) // 2 * 2, int(ih * k) // 2 * 2
    x0, y0 = (args.canvas - rw) // 2, (args.canvas - rh) // 2
    rect = (x0, y0, rw, rh)
    raw = os.path.join(input_dir, f"{tag}_raw.mp4")
    if iw == ih == args.canvas:
        # already canvas (e.g. harmonize pass input): fps + trim only.
        vf = "setsar=1"
    else:
        vf = f"scale={rw}:{rh}:flags=lanczos,setsar=1"
    subprocess.run(["ffmpeg", "-y", "-ss", str(args.trim_start), "-i",
                    args.input, "-t", str(dur), "-r", str(H3_FPS),
                    "-vf", vf, "-c:v", "libx264", "-preset", "fast",
                    "-crf", "17", "-c:a", "aac",
                    "-movflags", "+faststart", raw],
                   check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE)
    # canvas via edge-replicate (NOT black): the Fun-ControlNet control
    # video must carry structure in the bands, else inpainting collapses
    # the masked surround to black. Extended region gets a soft blur to
    # keep replicate streaks smooth; center stays pixel-exact.
    pad = os.path.join(input_dir, f"{tag}_pad.mp4")
    cap = cv2.VideoCapture(raw)
    # rawvideo pipe (no intermediate files: PNG seq + imwrite proved
    # flaky under NFS, silently truncating the canvas clip).
    soft_sig = args.canvas / 128
    m = np.zeros((args.canvas, args.canvas), np.float32)
    m[y0:y0 + rh, x0:x0 + rw] = 1.0
    m = cv2.GaussianBlur(m, (0, 0), max(4, args.canvas // 128))[..., None]
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", f"{args.canvas}x{args.canvas}", "-framerate", str(H3_FPS),
         "-i", "-", "-i", raw, "-map", "0:v", "-map", "1:a?",
         "-c:v", "libx264", "-preset", "fast", "-crf", "17",
         "-c:a", "copy", "-t", str(H3_LEN / H3_FPS), pad],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE)
    n = 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        fr = cv2.resize(fr, (rw, rh))
        cv = cv2.copyMakeBorder(fr, y0, args.canvas - y0 - rh,
                                x0, args.canvas - x0 - rw,
                                cv2.BORDER_REPLICATE)
        soft = cv2.GaussianBlur(cv, (0, 0), soft_sig)
        ff.stdin.write(np.clip(cv * m + soft * (1 - m), 0,
                               255).astype(np.uint8).tobytes())
        n += 1
    cap.release()
    _, err = ff.communicate()
    if ff.returncode != 0:
        raise RuntimeError(f"canvas pipe failed: {err.decode()[-500:]}")
    print(f"canvas frames piped: {n}")
    os.remove(raw)
    if n < 22:
        raise ValueError(f"only {n} staged frames, need >= 22")
    # exact 17k+5 frame snap (H3 VAE requirement): count staged, snap
    # DOWN, re-trim to the snap so ref length == generation length.
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams",
                        "v:0", "-count_frames", "-show_entries",
                        "stream=nb_read_frames", "-of", "csv=p=0", pad],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=120, check=True)
    nfr = int(r.stdout.decode().strip())
    snap = max(22, ((nfr - 5) // 17) * 17 + 5)
    if snap < nfr:
        cut = pad + ".cut.mp4"
        subprocess.run(["ffmpeg", "-y", "-i", pad, "-frames:v", str(snap),
                        "-c:v", "libx264", "-preset", "fast", "-crf", "17",
                        "-c:a", "copy", cut],
                       check=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
        os.replace(cut, pad)
    print(f"staged frames: {nfr} -> snap {snap}")
    args.h3_len = snap
    mask_path = None
    if args.mask or args.composite:
        m = np.ones((args.canvas, args.canvas), np.float32)
        m[int(y0):int(y0 + rh), int(x0):int(x0 + rw)] = 0.0
        feather = max(8, args.canvas // 64)
        m = cv2.GaussianBlur(m, (0, 0), feather)
        # static mask: FunControlNet clamps per-frame indices, so one
        # frame broadcasts across the clip (also avoids VIDEO->MASK).
        mask_path = os.path.join(input_dir, f"{tag}_mask.png")
        cv2.imwrite(mask_path, (m * 255).astype(np.uint8))
    return (os.path.basename(pad),
            os.path.basename(mask_path) if mask_path else None,
            (float(x0), float(y0), float(rw), float(rh)))


def adapt_outpaint(prompt, args, video_file, mask_file):
    applied = {}
    # stock ref images are disconnected dead weight that would fail on
    # missing files -> delete (loud if anything consumes them).
    for nid in find_nodes(prompt, "LoadImage"):
        if consumers_of(prompt, nid):
            raise ValueError(f"LoadImage {nid} has consumers, "
                             f"refusing to delete")
        del prompt[nid]
        applied[f"del.LoadImage.{nid}"] = True
    # full-clip video reference (video-to-video, not first/last frame).
    lv = instantiate(prompt, "LoadVideo", {"file": video_file})
    applied["LoadVideo.file"] = video_file
    # VHS LoadVideo yields VIDEO; H3 wants IMAGE batches -> decode frames.
    gvc = instantiate(prompt, "GetVideoComponents", {"video": [lv, 0]})
    h3 = one(prompt, "MiniMaxH3ReferenceToVideo")
    # COMFY_AUTOGROW_V3: backend takes the group dict, not flat keys.
    prompt[h3]["inputs"]["ref_videos"] = {"ref_video_0": [gvc, 0]}
    applied["ref_videos"] = {"ref_video_0": [gvc, 0]}
    # length as literal (the math node's slot wiring is untrusted).
    prompt[h3]["inputs"]["length"] = args.h3_len
    applied["length_literal"] = args.h3_len
    # ComfyMathExpression letter inputs (values.a) are COMFY_AUTOGROW and
    # invisible to the generic converter -> set duration link explicitly.
    prompt["131"]["inputs"]["values.a"] = ["132", 0]
    # canvas + length: literals replace ResolutionSelector/math links.
    prompt[h3]["inputs"]["width"] = args.canvas
    prompt[h3]["inputs"]["height"] = args.canvas
    applied["canvas"] = args.canvas
    for x in find_nodes(prompt, "PrimitiveFloat"):
        prompt[x]["inputs"]["value"] = round(args.h3_len / H3_FPS, 4)
    applied["duration_s"] = round(args.h3_len / H3_FPS, 4)
    applied["h3_len"] = args.h3_len
    # turbo 4-step path on (matches downloaded LoRA); --no-turbo keeps
    # the base 20-step schedule (better for partial-denoise refinement).
    for x in find_nodes(prompt, "PrimitiveBoolean"):
        prompt[x]["inputs"]["value"] = not args.no_turbo
    applied["turbo"] = not args.no_turbo
    if args.denoise is not None:
        sch = one(prompt, "BasicScheduler")
        prompt[sch]["inputs"]["denoise"] = args.denoise
        applied["denoise"] = args.denoise
    if args.prompt is not None:
        prompt[h3]["inputs"]["prompt"] = args.prompt
        applied["prompt"] = args.prompt[:80]
    if args.seed is not None:
        for x in find_nodes(prompt, "RandomNoise"):
            prompt[x]["inputs"]["noise_seed"] = args.seed
            applied[f"RandomNoise.{x}"] = args.seed
    if args.prefix:
        nid = one(prompt, "SaveVideo")
        prompt[nid]["inputs"]["filename_prefix"] = args.prefix
        applied["SaveVideo.prefix"] = args.prefix
    # mask patch (insert after MODEL switch, before guider).
    if args.mask:
        if not mask_file:
            raise ValueError("--mask needs staged mask clip")
        # MODEL switch = the one fed by UNETLoader.
        unet = one(prompt, "UNETLoader")
        model_src = None
        for x in find_nodes(prompt, "ComfySwitchNode"):
            for k, v in prompt[x]["inputs"].items():
                if isinstance(v, list) and v[0] == unet:
                    model_src = x
        if model_src is None:
            raise ValueError("no switch routes UNET MODEL")
        lmi = instantiate(prompt, "LoadImage", {"image": mask_file})
        itm = instantiate(prompt, "ImageToMask", {"channel": "red"})
        prompt[itm]["inputs"]["image"] = [lmi, 0]
        mpl = instantiate(prompt, "ModelPatchLoader", {"name": CONTROLNET})
        fun = instantiate(prompt, "MiniMaxH3FunControlNetApply", {})
        # video VAE = the one feeding VAEDecode (not audio).
        dec = one(prompt, "VAEDecode")
        vvae = prompt[dec]["inputs"]["vae"][0]
        prompt[fun]["inputs"]["model"] = [model_src, 0]
        prompt[fun]["inputs"]["model_patch"] = [mpl, 0]
        prompt[fun]["inputs"]["vae"] = [vvae, 0]
        prompt[fun]["inputs"]["mask"] = [itm, 0]
        prompt[fun]["inputs"]["source_video"] = [gvc, 0]
        # inpaint triple needs control_video too: hint=zeros alone makes
        # the masked area collapse to black (VideoX recipe: latent +
        # masked latent + mask = 49ch). Control = padded source canvas.
        prompt[fun]["inputs"]["control_video"] = [gvc, 0]
        prompt[fun]["inputs"]["strength"] = args.mask_strength
        prompt[fun]["inputs"]["start_percent"] = args.ctl_start
        prompt[fun]["inputs"]["end_percent"] = args.ctl_end
        # rewire MODEL consumers of the switch -> patched model
        # (excluding the patch node itself: its model input IS the switch).
        for uid, k in consumers_of(prompt, model_src, 0):
            if uid == fun:
                continue
            prompt[uid]["inputs"][k] = [fun, 0]
        applied["mask_patch"] = {"nodes": [lmi, itm, mpl, fun],
                                 "strength": args.mask_strength}
    return applied


def composite_source(out_path, args, rect):
    """Paste original center pixels back (feathered ramp).

    Source mapped to its canvas rect (correct aspect, NOT stretched),
    feathered alpha 1 inside -> 0 outside. Uses --comp-source when the
    generation input was itself a prior outpaint.
    """
    import tempfile
    src_path = args.comp_source or args.input
    x0, y0, rw, rh = [int(round(v)) for v in rect]
    with tempfile.TemporaryDirectory(dir=os.path.join(WS, ".cache")) as td:
        src = os.path.join(td, "src.mp4")
        subprocess.run(["ffmpeg", "-y", "-ss", str(args.trim_start), "-i",
                        src_path, "-t", str(args.h3_len / H3_FPS),
                        "-r", str(H3_FPS), src],
                       check=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
        cap_s = cv2.VideoCapture(src)
        cap_o = cv2.VideoCapture(out_path)
        fps = cap_o.get(cv2.CAP_PROP_FPS)
        src_fps = cap_s.get(cv2.CAP_PROP_FPS) or fps
        W = int(cap_o.get(cv2.CAP_PROP_FRAME_WIDTH))
        H = int(cap_o.get(cv2.CAP_PROP_FRAME_HEIGHT))
        n = int(cap_o.get(cv2.CAP_PROP_FRAME_COUNT))
        # geometry from OUTPUT dims (model may snap canvas, e.g. 1080->1072).
        # Staged-file dims win when given (--stage-src): exact centered
        # placement; otherwise source aspect mapped into output canvas.
        if args.stage_src:
            r = subprocess.run(["ffprobe", "-v", "error",
                                "-select_streams", "v:0", "-show_entries",
                                "stream=width,height", "-of", "json",
                                args.stage_src],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=60, check=True)
            st = json.loads(r.stdout)["streams"][0]
            rw, rh = int(st["width"]), int(st["height"])
        else:
            iw, ih, _ = ffprobe_src(src_path)
            rw = W
            rh = int(round(W * ih / iw)) // 2 * 2
        x0, y0 = (W - rw) // 2, (H - rh) // 2
        feather = args.feather if args.feather else max(8, W // 64)
        a = np.zeros((H, W), np.float32)
        a[y0:y0 + rh, x0:x0 + rw] = 1.0
        a = cv2.GaussianBlur(a, (0, 0), feather)[..., None]
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        tmp = os.path.join(td, "comp.mp4")
        vw = cv2.VideoWriter(tmp, fourcc, fps, (W, H))
        has_audio = base._has_audio(out_path)
        # time-based mapping (never frame-index: fps may differ between
        # output and source). Output frame i <-> source time i/fps.
        i = 0
        while True:
            ok_o, fo = cap_o.read()
            if not ok_o:
                break
            cap_s.set(cv2.CAP_PROP_POS_FRAMES,
                      int(round(i / fps * src_fps)))
            ok_s, fs = cap_s.read()
            if not ok_s:
                break
            full = np.zeros_like(fo)
            full[y0:y0 + rh, x0:x0 + rw] = cv2.resize(fs, (rw, rh))
            vw.write(np.clip(full * a + fo * (1 - a), 0,
                             255).astype(np.uint8))
            i += 1
        cap_s.release()
        cap_o.release()
        vw.release()
        # mux original audio back (writer drops it).
        fin = out_path + ".comp.mp4"
        # no -shortest: container frame counts lie; the pixel loop above
        # already bounds the video, audio just ends when it ends.
        acmd = ["ffmpeg", "-y", "-i", tmp]
        if has_audio:
            acmd += ["-i", out_path, "-map", "0:v", "-map", "1:a?",
                     "-c:v", "libx264", "-preset", "fast", "-crf", "17",
                     "-c:a", "copy", fin]
        else:
            acmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "17",
                     fin]
        subprocess.run(acmd, check=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
        os.replace(fin, out_path)
        print(f"composited {src_path.split('/')[-1]} center over "
              f"{out_path} (rect {[x0, y0, rw, rh]})")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mask", action="store_true",
                    help="Fun-ControlNet mask patch (mask=1 regen bands)")
    ap.add_argument("--mask-strength", type=float, default=1.0)
    ap.add_argument("--denoise", type=float, default=None,
                    help="BasicScheduler denoise (harmonize pass, e.g. 0.5)")
    ap.add_argument("--no-turbo", action="store_true",
                    help="use base 20-step schedule instead of turbo 4-step")
    ap.add_argument("--feather", type=int, default=0,
                    help="composite feather px (0 = auto W//64)")
    ap.add_argument("--comp-source", default=None,
                    help="true source clip for --composite "
                    "(default --input; set to original when --input is a "
                    "prior outpaint)")
    ap.add_argument("--stage-src", default=None,
                    help="staged source file: rect = its dims centered in "
                    "output (exact; else aspect-mapped)")
    ap.add_argument("--ctl-start", type=float, default=0.0,
                    help="FunControl start_percent (late-only e.g. 0.7)")
    ap.add_argument("--ctl-end", type=float, default=1.0)
    ap.add_argument("--composite-only", action="store_true",
                    help="skip generation; composite source center over "
                    "--output in place (rect recomputed from --input)")
    ap.add_argument("--composite", action="store_true",
                    help="paste source center back post-decode")
    ap.add_argument("--input", default=None)
    ap.add_argument("--trim-start", type=float, default=0.0)
    ap.add_argument("--canvas", type=int, default=768)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--negative", default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--prefix", default=None)
    ap.add_argument("--output", default=None)
    ap.add_argument("--timeout", type=int, default=7200)
    args = ap.parse_args()

    if not os.path.exists(TEMPLATE_H3):
        raise RuntimeError(f"missing {TEMPLATE_H3}")

    if args.composite_only:
        # rect from source dims + canvas (same geometry as staging).
        if not args.input or not args.output:
            raise ValueError("--composite-only needs --input/--output")
        iw, ih, _ = ffprobe_src(args.input)
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams",
                            "v:0", "-show_entries",
                            "stream=duration,avg_frame_rate",
                            "-of", "json", args.output],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=60, check=True)
        s = json.loads(r.stdout)["streams"][0]
        # duration (seconds) is trustworthy; frame counts are not. Render
        # the source with margin; the blend loop is min-bounded.
        out_dur = float(s.get("duration") or 0)
        num, den = map(int, s["avg_frame_rate"].split("/"))
        args.h3_len = int(out_dur * num / den) + 24
        args.trim_start = args.trim_start
        k = args.canvas / max(iw, ih)
        rw, rh = int(iw * k) // 2 * 2, int(ih * k) // 2 * 2
        x0, y0 = (args.canvas - rw) // 2, (args.canvas - rh) // 2
        composite_source(args.output, args,
                         (float(x0), float(y0), float(rw), float(rh)))
        return

    wf = json.load(open(TEMPLATE_H3))
    prompt = base.graph_to_api_prompt(wf)
    print(f"converted {len(prompt)} nodes")

    if args.dry_run:
        # light adapt (no staging): file names as placeholders.
        args.h3_len = H3_LEN
        applied = adapt_outpaint(prompt, args, "<staged>.mp4",
                                 "<mask>.png" if args.mask else None)
        print("overrides:", json.dumps(applied, indent=1)[:1500])
        print(json.dumps(prompt, indent=1)[:1500])
        print("... dry-run OK")
        return

    if not args.input:
        raise ValueError("--input required")
    if not args.prefix:
        args.prefix = f"h3_{int(time.time())}"
    video_file, mask_file, rect = stage_inputs(args)
    print(f"staged {video_file} mask={mask_file}")
    applied = adapt_outpaint(prompt, args, video_file, mask_file)
    print("overrides:", json.dumps(applied, indent=1))

    t0 = time.time()
    pid, entry = base.submit_and_wait(prompt, timeout_s=args.timeout)
    files = base.resolve_outputs(prompt, entry)
    print(f"done in {time.time() - t0:.0f}s, outputs: {files}")
    if args.output and files:
        shutil.copy(files[0], args.output)
        print(f"copied -> {args.output}")
        if args.composite:
            composite_source(args.output, args, rect)


if __name__ == "__main__":
    main()
