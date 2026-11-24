"""Build the ComfyUI API prompt for run d: take a stage-2 composite (2176²) to 3840² with
LTX-2.5 TiledFusion and the Refine-Details IC-LoRA, following the official
LTX-2.5_V2V_TiledFusion_Upscale workflow. The sampler output goes straight to the decoder, as in the official graph.
The source is re-composited at 3840² afterwards.

Usage: build_d.py OUT_DIR SRC_VIDEO [TILE]
  SRC_VIDEO  file name in ComfyUI's input/ dir (e.g. b25_s2comp_00001.mp4)
  TILE       tile edge in pixels (default 1280, near the HD tiles the official graph uses for 4K)
"""
import json, os, sys

OUT, SRC = sys.argv[1], sys.argv[2]
TILE = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
os.makedirs(OUT, exist_ok=True)
W, FRAMES = 3840, 121


def vc(name, src):
    return {"class_type": "VHS_VideoCombine", "inputs": {
        "images": src, "frame_rate": 24, "loop_count": 0, "filename_prefix": name,
        "format": "video/h264-mp4", "pix_fmt": "yuv420p", "crf": 17, "save_metadata": True,
        "trim_to_audio": False, "pingpong": False, "save_output": True}}


p = {
    "unet": {"class_type": "UNETLoader", "inputs": {
        "unet_name": "ltx-2.5-22b-distilled-transformer-bf16.safetensors", "weight_dtype": "default"}},
    "te": {"class_type": "CLIPLoader", "inputs": {
        "clip_name": "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", "type": "ltxv", "device": "default"}},
    "vvae": {"class_type": "VAELoader", "inputs": {"vae_name": "ltx-2.5-video-vae-bf16.safetensors"}},
    "lora": {"class_type": "LTXICLoRALoaderModelOnly", "inputs": {
        "model": ["unet", 0], "lora_name": "ltx-2/ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors",
        "strength_model": 1.0}},
    # the stage-2 composite to refine
    "src": {"class_type": "VHS_LoadVideo", "inputs": {
        "video": SRC, "force_rate": 24, "custom_width": 0, "custom_height": 0,
        "frame_load_cap": FRAMES, "skip_first_frames": 0, "select_every_nth": 1, "format": "AnimateDiff"}},
    "up": {"class_type": "ImageScale", "inputs": {
        "image": ["src", 0], "upscale_method": "lanczos", "width": W, "height": W, "crop": "disabled"}},
    # original clip, re-projected at 3840² for the final source composite
    "load": {"class_type": "VHS_LoadVideo", "inputs": {
        "video": "tron15s.mp4", "force_rate": 24, "custom_width": 0, "custom_height": 0,
        "frame_load_cap": FRAMES, "skip_first_frames": 0, "select_every_nth": 1, "format": "AnimateDiff"}},
    "geo": {"class_type": "EstimateCameraGeoCalib", "inputs": {
        "image": ["load", 0], "frame_index": 0, "weights": "pinhole", "camera_model": "pinhole",
        "strip_letterbox": True, "letterbox_threshold": 0.06}},
    "r2e": {"class_type": "RectilinearToEquirect", "inputs": {
        "image": ["load", 0], "hfov_deg": 90, "fov_scale": 1, "equirect_width": W, "equirect_height": W,
        "yaw_deg": 0, "pitch_deg": 0, "roll_deg": 0, "shape": "pincushion", "fill_value": 0,
        "feather_px": 0, "strip_letterbox": True, "letterbox_threshold": 0.06,
        "focal_px": ["geo", 4], "canvas_hfov_deg": 180.0, "canvas_vfov_deg": 180.0}},
    "pos": {"class_type": "CLIPTextEncode", "inputs": {
        "clip": ["te", 0], "text": "The same scene, sharper and more detailed, fine textures, clean edges."}},
    "neg": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["te", 0], "text": ""}},
    "cond": {"class_type": "LTXVConditioning", "inputs": {
        "positive": ["pos", 0], "negative": ["neg", 0], "frame_rate": 24}},
    "empty": {"class_type": "EmptyLTXVLatentVideo", "inputs": {
        "width": W, "height": W, "length": FRAMES, "batch_size": 1}},
    "guide": {"class_type": "LTXAddVideoICLoRAGuide", "inputs": {
        "positive": ["cond", 0], "negative": ["cond", 1], "vae": ["vvae", 0], "latent": ["empty", 0],
        "image": ["up", 0], "frame_idx": 0, "strength": 1, "latent_downscale_factor": ["lora", 1],
        "crop": "disabled", "use_tiled_encode": True, "tile_size": 512, "tile_overlap": 64,
        "use_streaming": True, "tile_frames": FRAMES}},
    "samp": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    "sig": {"class_type": "ManualSigmas", "inputs": {
        "sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"}},
    "tf": {"class_type": "LTXVTiledFusionSampler", "inputs": {
        "model": ["lora", 0], "positive": ["guide", 0], "negative": ["guide", 1], "latents": ["guide", 2],
        "sigmas": ["sig", 0], "sampler": ["samp", 0], "seed": 42, "cfg": 1,
        "tile_width": TILE, "tile_height": TILE, "overlap_frac": 0.5, "blend_var": 0.05,
        "grid_cycle": 1, "tile_frames": FRAMES, "vae": ["vvae", 0], "canvas_device": "auto"}},
    "dec": {"class_type": "VAEDecodeTiled", "inputs": {
        "samples": ["tf", 0], "vae": ["vvae", 0], "tile_size": 512, "overlap": 64,
        "temporal_size": 128, "temporal_overlap": 32}},
    "comp": {"class_type": "EquirectSourceComposite", "inputs": {
        "generated": ["dec", 0], "source_equirect": ["r2e", 0], "outpaint_mask": ["r2e", 1],
        "tone_match": 1, "feather_px": 12, "tone_equalize": 0.7, "wrap_w": False}},
    "out_raw": vc("d_raw", ["dec", 0]),
    "out_comp": vc("d_comp", ["comp", 0]),
}

json.dump(p, open(os.path.join(OUT, "d.json"), "w"), indent=1)
print("built d from", SRC, "tile", TILE)
