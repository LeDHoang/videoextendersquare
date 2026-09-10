#!/usr/bin/env python3
"""Run Burgstall's LTX-2.3 flat-video VR360 or VR180 outpaint workflow."""

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import time

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMFY = os.path.join(WS, "ComfyUI")
TEMPLATE = os.path.join(
    COMFY, "custom_nodes", "ComfyUI-VR-Outpaint-Tools",
    "example_workflows", "Burgstall-SEAMLESS-VR-Outpaint.json")

sys.path.insert(0, os.path.join(WS, "scripts"))
from comfy_ltx_outpaint import (graph_to_api_prompt, submit_and_wait)


def run(cmd):
    return subprocess.run(cmd, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE)


def probe_duration(path):
    result = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                  "-show_entries", "stream=duration", "-of", "csv=p=0",
                  path])
    return float(result.stdout)


def prepare_video(src, start, frames, fps, tag):
    os.makedirs(os.path.join(COMFY, "input"), exist_ok=True)
    name = f"{tag}_src.mp4"
    dst = os.path.join(COMFY, "input", name)
    duration = frames / fps
    run(["ffmpeg", "-y", "-ss", str(start), "-i", src,
         "-t", f"{duration:.6f}", "-vf", f"fps={fps}",
         "-frames:v", str(frames), "-c:v", "libx264", "-preset", "fast",
         "-crf", "17", "-c:a", "aac", "-ar", "48000", "-ac", "2",
         "-movflags", "+faststart", dst])
    return name


def bypass_set_get(wf):
    """Replace workflow-only Set/Get links with their real upstream links."""
    nodes = {n["id"]: n for n in wf["nodes"]}
    links = {row[0]: row for row in wf.get("links", [])}
    setters = {}
    for node in wf["nodes"]:
        if node["type"] != "SetNode":
            continue
        name = node.get("widgets_values", [None])[0]
        incoming = [e.get("link") for e in node.get("inputs", [])
                    if e.get("link") is not None]
        if len(incoming) != 1:
            raise ValueError(f"SetNode {node['id']} has {len(incoming)} inputs")
        setters[name] = links[incoming[0]][1:3]

    virtual_ids = {n["id"] for n in wf["nodes"]
                   if n["type"] in {"SetNode", "GetNode"}}
    for node in wf["nodes"]:
        if node["type"] != "GetNode":
            continue
        name = node.get("widgets_values", [None])[0]
        if name not in setters:
            raise ValueError(f"GetNode {node['id']} has no setter for {name}")
        source_id, source_slot = setters[name]
        for output in node.get("outputs", []):
            for link_id in output.get("links") or []:
                links[link_id][1] = source_id
                links[link_id][2] = source_slot

    wf["nodes"] = [n for n in wf["nodes"] if n["id"] not in virtual_ids]
    wf["links"] = [row for row in links.values()
                   if row[1] not in virtual_ids and row[3] not in virtual_ids]
    by_id = {n["id"]: n for n in wf["nodes"]}
    for node in wf["nodes"]:
        for output in node.get("outputs", []):
            output["links"] = []
    for row in wf["links"]:
        output = by_id[row[1]]["outputs"][row[2]]
        output.setdefault("links", []).append(row[0])


def prune_to_output(wf, output_id):
    links = {row[0]: row for row in wf.get("links", [])}
    nodes = {n["id"]: n for n in wf["nodes"]}
    needed = set()
    pending = [output_id]
    while pending:
        node_id = pending.pop()
        if node_id in needed:
            continue
        needed.add(node_id)
        for entry in nodes[node_id].get("inputs", []):
            link_id = entry.get("link")
            if link_id in links:
                pending.append(links[link_id][1])
    wf["nodes"] = [n for n in wf["nodes"] if n["id"] in needed]
    wf["links"] = [row for row in wf.get("links", [])
                   if row[1] in needed and row[3] in needed]


def normalize_widgets(wf):
    for node in wf["nodes"]:
        values = node.get("widgets_values")
        if node["type"] == "VHS_LoadVideo" and isinstance(values, dict):
            node["widgets_values"] = [
                values["video"], values["force_rate"], values["custom_width"],
                values["custom_height"], values["frame_load_cap"],
                values["skip_first_frames"], values["select_every_nth"],
                values.get("format", "AnimateDiff")]
        elif node["type"] == "VHS_VideoCombine" and isinstance(values, dict):
            node["widgets_values"] = [
                values["frame_rate"], values["loop_count"],
                values["filename_prefix"], values["format"],
                values["pix_fmt"], values["crf"], values["save_metadata"],
                values["trim_to_audio"], values["pingpong"],
                values["save_output"]]
        elif node["type"] == "LTXVEmptyLatentAudio":
            node["widgets_values"] = [97, 1]
        elif node["type"] == "EquirectPerStepRoll":
            node["widgets_values"] = [True, "random_per_step", 7, 0, 0.25]


def build_prompt(args, video_name):
    wf = copy.deepcopy(json.load(open(TEMPLATE)))
    bypass_set_get(wf)
    prune_to_output(wf, 5179)
    normalize_widgets(wf)
    prompt = graph_to_api_prompt(wf)

    load = prompt["5060"]["inputs"]
    load.update(video=video_name, force_rate=float(args.fps),
                frame_load_cap=args.frames, skip_first_frames=0,
                select_every_nth=1)

    estimator = prompt["5156"]["inputs"]
    estimator.update(frame_index=min(args.camera_frame, args.frames - 1),
                     strip_letterbox=False)

    projection = prompt["5157"]["inputs"]
    if args.hfov_deg is not None:
        projection.update(hfov_deg=args.hfov_deg, focal_px=0.0)
        prompt.pop("5156", None)
    vr180 = args.projection == "vr180"
    projection.update(equirect_width=args.width,
                      equirect_height=args.height,
                      fov_scale=args.fov_scale,
                      strip_letterbox=False,
                      canvas_hfov_deg=180.0 if vr180 else 360.0,
                      canvas_vfov_deg=180.0)

    prompt["5023"]["inputs"]["text_encoder"] = \
        "comfy_gemma_3_12B_it.safetensors"
    default_prompt = (
        "180 degree front hemisphere equirectangular panorama, seamless "
        "continuation of the exact source scene visible in the current frame, "
        "preserve the same location, architecture, lighting, colors, subject "
        "identity and composition, extend only the background environment into "
        "unseen directions, do not introduce new subjects, temporally "
        "consistent cinematic live action"
        if vr180 else
        "360 degree equirectangular panorama, high quality, detailed video"
    )
    prompt["2483"]["inputs"]["text"] = args.prompt or default_prompt
    if vr180:
        prompt["2612"]["inputs"]["text"] = args.negative or (
            "unrelated location, scene change, new subject, extra person, "
            "duplicate person, crowd, extra face, random object, outdoor "
            "landscape, daylight, fantasy environment, video game, 3d render, "
            "still, static, slow"
        )
    elif args.negative:
        prompt["2612"]["inputs"]["text"] = args.negative
    prompt["3336"]["inputs"]["img_compression"] = args.image_compression
    prompt["5011"]["inputs"].update(
        lora_name="ltx-2/360vroutpaint_v2_step07000.safetensors",
        strength_model=args.iclora_strength)
    prompt["4832"]["inputs"]["noise_seed"] = args.seed
    # Horizontal wrapping is only valid when both edges are the same 360° seam.
    prompt["5170"]["inputs"]["enabled"] = not vr180
    prompt["5176"]["inputs"]["enabled"] = not vr180
    prompt["5171"]["inputs"].update(
        enabled=not vr180, mode="random_per_step", seed=args.seed,
        feather_columns=0, start_percent=0.25)
    prompt["5177"]["inputs"].update(
        tone_match=1.0, feather_px=args.composite_feather,
        tone_equalize=args.tone_equalize,
        mask_low_res_dilation=args.blend_dilation, wrap_w=not vr180)
    prompt["5179"]["inputs"].update(
        frame_rate=float(args.fps), filename_prefix=args.prefix,
        format="video/h264-mp4", pix_fmt="yuv420p", crf=17,
        save_metadata=True, trim_to_audio=False, pingpong=False,
        save_output=True)
    return prompt


def output_files(entry, output_node="5179"):
    files = []
    node_output = (entry.get("outputs") or {}).get(output_node, {})
    for key in ("gifs", "video", "images"):
        for item in node_output.get(key) or []:
            files.append(os.path.join(
                COMFY, "output", item.get("subfolder", ""), item["filename"]))
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--trim-start", type=float, default=0.0)
    parser.add_argument("--frames", type=int, default=121)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--projection", choices=("vr360", "vr180"),
                        default="vr360")
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--fov-scale", type=float,
                        help="scale the measured source FOV; defaults to 1.65 "
                             "for VR180 to retain more source content, or 1.0 "
                             "for exact geometry and VR360")
    parser.add_argument("--camera-frame", type=int, default=60)
    parser.add_argument("--hfov-deg", type=float,
                        help="fixed source horizontal FOV; use one value for all "
                             "chunks to prevent projection-size changes")
    parser.add_argument("--prompt",
                        help="describe the source scene; specific prompts keep "
                             "large VR180 outpaint regions more closely related")
    parser.add_argument("--negative",
                        help="undesired content; VR180 gets a source-preserving "
                             "default when omitted")
    parser.add_argument("--image-compression", type=int, default=35)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--iclora-strength", type=float, default=1.0)
    parser.add_argument("--composite-feather", type=int, default=12)
    parser.add_argument("--blend-dilation", type=int, default=0,
                        help="low-resolution outpaint-mask dilation before "
                             "source compositing; 8 matches LTX dil8")
    parser.add_argument("--tone-equalize", type=float, default=0.7)
    parser.add_argument("--prefix", default="reel1_vr")
    parser.add_argument("--output")
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.fov_scale is None:
        args.fov_scale = 1.65 if args.projection == "vr180" else 1.0
    if args.width is None:
        args.width = 960 if args.projection == "vr180" else 1920
    if args.height is None:
        args.height = 960
    if args.width % 32 or args.height % 32:
        raise ValueError("output width and height must be multiples of 32")
    if not 0 <= args.image_compression <= 100:
        raise ValueError("--image-compression must be between 0 and 100")
    if args.projection == "vr360" and args.width != args.height * 2:
        raise ValueError("VR360 output must use a 2:1 canvas")
    if args.projection == "vr180" and args.width != args.height:
        raise ValueError("VR180 output must use a square canvas")
    if args.fov_scale <= 0:
        raise ValueError("--fov-scale must be positive")
    if not 0 <= args.blend_dilation <= 15:
        raise ValueError("--blend-dilation must be between 0 and 15")
    if args.hfov_deg is not None and not 0 < args.hfov_deg < 180:
        raise ValueError("--hfov-deg must be between 0 and 180")
    if args.frames < 1:
        raise ValueError("--frames must be positive")
    if args.trim_start + args.frames / args.fps > probe_duration(args.input) + 0.1:
        raise ValueError("requested chunk extends past the source duration")

    video_name = prepare_video(args.input, args.trim_start, args.frames,
                               args.fps, args.prefix)
    prompt = build_prompt(args, video_name)
    print(f"prepared {video_name}; converted {len(prompt)} active nodes")
    if args.dry_run:
        print(json.dumps(prompt, indent=1))
        return

    started = time.time()
    _, entry = submit_and_wait(prompt, timeout_s=args.timeout)
    files = output_files(entry)
    if not files:
        raise RuntimeError(f"no output file in history: {entry.get('outputs')}")
    result = files[0]
    print(f"completed in {time.time() - started:.0f}s: {result}")
    if args.output:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        shutil.copy2(result, args.output)
        print(f"copied -> {args.output}")


if __name__ == "__main__":
    main()
