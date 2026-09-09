#!/usr/bin/env python3
"""LTX pixel-spatial upscaler via ComfyUI API (standalone, H100).

Template-driven: 2.3 uses the stock flat workflow
  ComfyUI/custom_nodes/ComfyUI-LTXVideo/example_workflows/2.3/
  LTX-2.3_ICLoRA_Pixel_Spatial_Upscaler_Distilled.json
as-is; 2.5 adapts it on the fly (UNET/CLIP/VAE loader swap, distilled
LoRA dropped, 2.5 x2 IC-LoRA) since upstream ships no 2.5 upscaler
workflow. Chain AFTER outpainting: --input is an outpainted mp4,
--scale {2,4} sets the IC-LoRA file + final canvas (input dims x scale).

Examples:
  scripts/comfy_ltx_upscale.py --dry-run
  scripts/comfy_ltx_upscale.py --template 2.3 --input output/title_dil15.mp4 \\
      --scale 2 --prompt "cinematic dark gradient" --seed 11 \\
      --prefix title_up2 --output output/title_up2.mp4
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

TEMPLATE_UP = os.path.join(
    base.COMFY, "custom_nodes", "ComfyUI-LTXVideo", "example_workflows",
    "2.3", "LTX-2.3_ICLoRA_Pixel_Spatial_Upscaler_Distilled.json")

UP25 = {
    "transformer": "ltx-2.5-22b-distilled-transformer-bf16.safetensors",
    "clip": "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    "video_vae": "ltx-2.5-video-vae-bf16.safetensors",
    "audio_vae": "ltx-2.5-audio-vae-bf16.safetensors",
    "iclora_x2": ("ltxv/ltx2/"
                  "ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0."
                  "safetensors"),
}
UP23_X2 = ("ltxv/ltx2/ltx-2.3-22b-ic-lora-pixel-spatial-upscaler-x2-0.9."
           "safetensors")
UP23_X4 = ("ltxv/ltx2/ltx-2.3-22b-ic-lora-pixel-spatial-upscaler-x4-0.9."
           "safetensors")


def find_nodes(prompt, class_type):
    return sorted([nid for nid, n in prompt.items()
                   if n["class_type"] == class_type], key=int)


def one(prompt, class_type):
    ids = find_nodes(prompt, class_type)
    if len(ids) != 1:
        raise ValueError(f"expected 1 {class_type}, found {ids}")
    return ids[0]


def consumers_of(prompt, nid, slot=None):
    """(user_nid, input_key) referencing [nid, slot] (any slot if None)."""
    out = []
    for uid, u in prompt.items():
        for k, v in u["inputs"].items():
            if isinstance(v, list) and v[0] == nid and \
                    (slot is None or v[1] == slot):
                out.append((uid, k))
    return out


def adapt_25(prompt):
    """2.3 pixel-upscaler prompt -> 2.5 stack. Loud on shape drift."""
    ckpt = one(prompt, "CheckpointLoaderSimple")
    nxt = max(map(int, prompt)) + 1
    # UNETLoader keeps the ckpt id (MODEL output slot 0 compatible).
    prompt[ckpt] = {"class_type": "UNETLoader",
                    "inputs": {"unet_name": UP25["transformer"],
                               "weight_dtype": "default"}}
    # distilled LoRA must NOT ride on the distilled transformer: drop it,
    # IC-LoRA takes MODEL straight from UNET.
    for nid in find_nodes(prompt, "LoraLoaderModelOnly"):
        del prompt[nid]
    iclora = one(prompt, "LTXICLoRALoaderModelOnly")
    prompt[iclora]["inputs"]["model"] = [ckpt, 0]
    # text encoder -> Gemma4 CLIP (keeps id; single CLIP output).
    enc = one(prompt, "LTXAVTextEncoderLoader")
    prompt[enc] = {"class_type": "CLIPLoader",
                   "inputs": {"clip_name": UP25["clip"], "type": "ltxv",
                              "device": "default"}}
    # audio VAE -> dedicated loader (keeps id; single VAE output).
    av = one(prompt, "LTXVAudioVAELoader")
    prompt[av] = {"class_type": "VAELoader",
                  "inputs": {"vae_name": UP25["audio_vae"]}}
    # video VAE: fresh node; rewire ckpt-VAE consumers (decode + encode).
    vvae = str(nxt)
    nxt += 1
    prompt[vvae] = {"class_type": "VAELoader",
                    "inputs": {"vae_name": UP25["video_vae"]}}
    for uid, k in consumers_of(prompt, ckpt, 2):
        prompt[uid]["inputs"][k] = [vvae, 0]
    # nothing may still reference ckpt slots 1/2 (CLIP/VAE are gone).
    left = consumers_of(prompt, ckpt)
    for uid, k in left:
        v = prompt[uid]["inputs"][k]
        if v[1] != 0:
            raise ValueError(f"2.5 adapt: {uid}.{k} still on ckpt "
                             f"slot {v[1]}")
    print(f"2.5 adapt: UNET@{ckpt} CLIP@{enc} VAEaudio@{av} VAEvideo@{vvae}")
    return prompt


def ffprobe_dims(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=width,height",
                        "-of", "json", path],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=60, check=True)
    s = json.loads(r.stdout)["streams"][0]
    return int(s["width"]), int(s["height"])


def apply_overrides(prompt, args, out_w, out_h):
    applied = {}
    nid = one(prompt, "LoadVideo")
    prompt[nid]["inputs"]["file"] = args.video_file
    applied["LoadVideo.file"] = args.video_file
    # final canvas: ResizeImageMaskNode feeding VAEEncode.pixels.
    venc = one(prompt, "VAEEncode")
    rnode = None
    for i in find_nodes(prompt, "ResizeImageMaskNode"):
        if prompt[venc]["inputs"]["pixels"][0] == i:
            if rnode is not None:
                raise ValueError("multiple resizes feed VAEEncode")
            rnode = i
    if rnode is None:
        raise ValueError("no ResizeImageMaskNode feeds VAEEncode")
    prompt[rnode]["inputs"]["resize_type"] = "scale dimensions"
    prompt[rnode]["inputs"]["resize_type.width"] = out_w
    prompt[rnode]["inputs"]["resize_type.height"] = out_h
    applied["final_size"] = [out_w, out_h]
    # IC-LoRA file by template+scale.
    iclora = one(prompt, "LTXICLoRALoaderModelOnly")
    if args.template == "2.5":
        if args.scale != 2:
            raise ValueError("2.5 pixel upscaler LoRA is x2-only")
        prompt[iclora]["inputs"]["lora_name"] = UP25["iclora_x2"]
    else:
        prompt[iclora]["inputs"]["lora_name"] = \
            UP23_X2 if args.scale == 2 else UP23_X4
    applied["iclora"] = prompt[iclora]["inputs"]["lora_name"]
    if args.upscaler_strength is not None:
        prompt[iclora]["inputs"]["strength_model"] = args.upscaler_strength
        applied["iclora.strength"] = args.upscaler_strength
    # prompt roles via LTXVConditioning (same convention as outpaint).
    if args.prompt is not None or args.negative is not None:
        role_of = {}
        for x in find_nodes(prompt, "CLIPTextEncode"):
            for oid, o in prompt.items():
                for k, v in o["inputs"].items():
                    if (isinstance(v, list) and v[0] == x
                            and o["class_type"] == "LTXVConditioning"):
                        role_of[x] = k
        for x, role in role_of.items():
            if role == "positive" and args.prompt is not None:
                prompt[x]["inputs"]["text"] = args.prompt
                applied[f"CLIPTextEncode.{x}.text"] = args.prompt
            if role == "negative" and args.negative is not None:
                prompt[x]["inputs"]["text"] = args.negative
                applied[f"CLIPTextEncode.{x}.text"] = args.negative
    if args.seed is not None:
        for x in find_nodes(prompt, "RandomNoise"):
            prompt[x]["inputs"]["noise_seed"] = args.seed
            applied[f"RandomNoise.{x}"] = args.seed
    if args.cfg is not None:
        for x in find_nodes(prompt, "CFGGuider"):
            prompt[x]["inputs"]["cfg"] = args.cfg
            applied[f"CFGGuider.{x}.cfg"] = args.cfg
    if args.prefix:
        nid = one(prompt, "SaveVideo")
        prompt[nid]["inputs"]["filename_prefix"] = args.prefix
        applied["SaveVideo.prefix"] = args.prefix
    return applied


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--template", choices=("2.3", "2.5"), default="2.3")
    ap.add_argument("--input", default=None, help="outpainted video to upscale")
    ap.add_argument("--trim-start", type=float, default=0.0)
    ap.add_argument("--trim-duration", type=float, default=0.0,
                    help="0 = whole input")
    ap.add_argument("--scale", type=int, choices=(2, 4), default=2)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--negative", default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--cfg", type=float, default=None)
    ap.add_argument("--upscaler-strength", type=float, default=None)
    ap.add_argument("--prefix", default=None)
    ap.add_argument("--output", default=None)
    ap.add_argument("--timeout", type=int, default=7200)
    args = ap.parse_args()

    wf = json.load(open(TEMPLATE_UP))
    prompt = base.graph_to_api_prompt(wf)
    print(f"converted {len(prompt)} nodes")
    if args.template == "2.5":
        prompt = adapt_25(prompt)

    if args.dry_run:
        print(json.dumps(prompt, indent=1)[:2000])
        print("... dry-run OK")
        return

    if not args.input:
        raise ValueError("--input required")
    # stage (trim optional) into ComfyUI/input via outpaint staging.
    pargs = argparse.Namespace(stock=False, input=args.input,
                               trim_start=args.trim_start,
                               trim_duration=args.trim_duration or 1e9,
                               prefix=args.prefix or
                               f"up_{int(time.time())}")
    if args.trim_duration <= 0:
        # whole file: copy + ensure audio, no trim.
        import shutil as _sh
        tag = pargs.prefix
        input_dir = os.path.join(base.COMFY, "input")
        os.makedirs(input_dir, exist_ok=True)
        dst = os.path.join(input_dir, f"{tag}_src.mp4")
        _sh.copy(args.input, dst)
        base._ensure_audio_track(dst)
        video_file = f"{tag}_src.mp4"
    else:
        video_file, _ = base.prepare_inputs(pargs)
    args.video_file = video_file
    iw, ih = ffprobe_dims(os.path.join(base.COMFY, "input", video_file))
    out_w, out_h = iw * args.scale, ih * args.scale
    print(f"upscale {iw}x{ih} x{args.scale} -> {out_w}x{out_h} "
          f"({out_w * out_h / 1e6:.1f} Mpx)")
    if not args.prefix:
        args.prefix = f"up_{int(time.time())}"
    applied = apply_overrides(prompt, args, out_w, out_h)
    print("overrides:", json.dumps(applied, indent=1))

    t0 = time.time()
    pid, entry = base.submit_and_wait(prompt, timeout_s=args.timeout)
    files = base.resolve_outputs(prompt, entry)
    print(f"done in {time.time() - t0:.0f}s, outputs: {files}")
    if args.output and files:
        shutil.copy(files[0], args.output)
        print(f"copied -> {args.output}")


if __name__ == "__main__":
    main()
