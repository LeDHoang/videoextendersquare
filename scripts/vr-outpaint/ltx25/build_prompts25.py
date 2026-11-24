"""Build ComfyUI API prompts for the LTX-2.5 / native-4K method-A tests on the 5 s clip.

Runs (all 180°, 121 frames, seed 668):
  a23   LTX-2.3 stage 1 at 1088² (= A-baseline), then x2 refine at 2176²
  b25   LTX-2.5 stage 1 at 1088² with the 2.3 360vroutpaint IC-LoRA, then x2 refine at 2176²
  b25L0 same as b25 stage 1 with the LoRA at strength 0 (control), stage 1 only

Stage 2 follows the official LTX-2.5 two-stage outpaint graph: upscale stage-1 pixels x2,
re-composite the source (here at 2176², so the source keeps more of its own pixels),
VAE-encode, re-noise to sigma 0.725 and denoise 2 euler steps (0.725, 0.4219, 0).
"""
import json, os, sys

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
FRAMES = 121

STACKS = {
    "23": {
        "unet": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "ltx-2.3-22b-distilled-1.1_transformer_only_mxfp8_block32.safetensors", "weight_dtype": "default"}},
        "te": {"class_type": "LTXAVTextEncoderLoader", "inputs": {
            "text_encoder": "gemma_3_12B_it.safetensors", "ckpt_name": "ltx-2.3_text_projection_bf16.safetensors",
            "device": "default"}},
        "vvae": {"class_type": "VAELoaderKJ", "inputs": {
            "vae_name": "LTX23_video_vae_bf16.safetensors", "device": "main_device", "weight_dtype": "bf16"}},
        "avae": {"class_type": "VAELoaderKJ", "inputs": {
            "vae_name": "LTX23_audio_vae_bf16.safetensors", "device": "main_device", "weight_dtype": "bf16"}},
    },
    "25": {
        "unet": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "ltx-2.5-22b-distilled-transformer-bf16.safetensors", "weight_dtype": "default"}},
        "te": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", "type": "ltxv", "device": "default"}},
        "vvae": {"class_type": "VAELoader", "inputs": {"vae_name": "ltx-2.5-video-vae-bf16.safetensors"}},
        "avae": {"class_type": "VAELoader", "inputs": {"vae_name": "ltx-2.5-audio-vae-bf16.safetensors"}},
    },
}

RUNS = {
    "a23": ("23", 1.0, True),
    "b25": ("25", 1.0, True),
    "b25L0": ("25", 0.0, False),
}


def vc(name, src):
    return {"class_type": "VHS_VideoCombine", "inputs": {
        "images": src, "frame_rate": 24, "loop_count": 0, "filename_prefix": name,
        "format": "video/h264-mp4", "pix_fmt": "yuv420p", "crf": 17, "save_metadata": True,
        "trim_to_audio": False, "pingpong": False, "save_output": True}}


def r2e(W):
    return {"class_type": "RectilinearToEquirect", "inputs": {
        "image": ["load", 0], "hfov_deg": 90, "fov_scale": 1, "equirect_width": W, "equirect_height": W,
        "yaw_deg": 0, "pitch_deg": 0, "roll_deg": 0, "shape": "pincushion", "fill_value": 0,
        "feather_px": 0, "strip_letterbox": True, "letterbox_threshold": 0.06,
        "focal_px": ["geo", 4], "canvas_hfov_deg": 180.0, "canvas_vfov_deg": 180.0}}


def comp(gen, src, mask):
    return {"class_type": "EquirectSourceComposite", "inputs": {
        "generated": gen, "source_equirect": src, "outpaint_mask": mask,
        "tone_match": 1, "feather_px": 12, "tone_equalize": 0.7, "wrap_w": False}}


def build(name, stack, lora_strength, stage2, W=1088):
    p = {k: json.loads(json.dumps(v)) for k, v in STACKS[stack].items()}
    p.update({
        "load": {"class_type": "VHS_LoadVideo", "inputs": {
            "video": "tron15s.mp4", "force_rate": 24, "custom_width": 0, "custom_height": 0,
            "frame_load_cap": FRAMES, "skip_first_frames": 0, "select_every_nth": 1, "format": "AnimateDiff"}},
        "geo": {"class_type": "EstimateCameraGeoCalib", "inputs": {
            "image": ["load", 0], "frame_index": 0, "weights": "pinhole", "camera_model": "pinhole",
            "strip_letterbox": True, "letterbox_threshold": 0.06}},
        "r2e": r2e(W),
        "size": {"class_type": "GetImageSize", "inputs": {"image": ["r2e", 0]}},
        "empty": {"class_type": "EmptyLTXVLatentVideo", "inputs": {
            "width": ["size", 0], "height": ["size", 1], "length": ["size", 2], "batch_size": 1}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {
            "clip": ["te", 0], "text": "360 degree equirectangular panorama, high quality, detailed video "}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {
            "clip": ["te", 0], "text": "pc game, console game, video game, ugly, 3d render, photo, still, static, slow"}},
        "cond": {"class_type": "LTXVConditioning", "inputs": {
            "positive": ["pos", 0], "negative": ["neg", 0], "frame_rate": 24}},
        "cvae": {"class_type": "EquirectCircularVAE", "inputs": {
            "vae": ["vvae", 0], "patch_encoder": True, "patch_decoder": True, "enabled": False}},
        "pre": {"class_type": "LTXVPreprocess", "inputs": {"image": ["r2e", 0], "img_compression": 35}},
        "i2v": {"class_type": "LTXVImgToVideoConditionOnly", "inputs": {
            "vae": ["cvae", 0], "image": ["pre", 0], "latent": ["empty", 0], "strength": 0.7, "bypass": True}},
        "guide": {"class_type": "LTXAddVideoICLoRAGuide", "inputs": {
            "positive": ["cond", 0], "negative": ["cond", 1], "vae": ["cvae", 0], "latent": ["i2v", 0],
            "image": ["r2e", 0], "frame_idx": 0, "strength": 1, "latent_downscale_factor": 1,
            "crop": "disabled", "use_tiled_encode": False, "tile_size": 256, "tile_overlap": 64}},
        "alat": {"class_type": "LTXVEmptyLatentAudio", "inputs": {
            "frames_number": ["load", 1], "frame_rate": 24, "batch_size": 1, "audio_vae": ["avae", 0]}},
        "cat": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["guide", 2], "audio_latent": ["alat", 0]}},
        "lora": {"class_type": "LTXICLoRALoaderModelOnly", "inputs": {
            "model": ["unet", 0], "lora_name": "ltx-2/360vroutpaint_v2_step07000.safetensors",
            "strength_model": lora_strength}},
        "nag": {"class_type": "LTX2_NAG", "inputs": {
            "model": ["lora", 0], "nag_scale": 11, "nag_alpha": 0.25, "nag_tau": 2.5,
            "nag_cond_video": ["guide", 1], "nag_cond_audio": ["guide", 1], "inplace": True}},
        "guider": {"class_type": "CFGGuider", "inputs": {
            "model": ["nag", 0], "positive": ["guide", 0], "negative": ["guide", 1], "cfg": 1}},
        "noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": 668}},
        "samp": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral"}},
        "sig": {"class_type": "ManualSigmas", "inputs": {
            "sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"}},
        "sca": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["noise", 0], "guider": ["guider", 0], "sampler": ["samp", 0], "sigmas": ["sig", 0],
            "latent_image": ["cat", 0]}},
        "sep": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["sca", 0]}},
        "cropg": {"class_type": "LTXVCropGuides", "inputs": {
            "positive": ["guide", 0], "negative": ["guide", 1], "latent": ["sep", 0]}},
        "dec": {"class_type": "VAEDecodeTiled", "inputs": {
            "samples": ["cropg", 2], "vae": ["cvae", 0], "tile_size": 512, "overlap": 64,
            "temporal_size": 128, "temporal_overlap": 32}},
        "comp": comp(["dec", 0], ["r2e", 0], ["r2e", 1]),
        "out_raw": vc(f"{name}_s1raw", ["dec", 0]),
        "out_comp": vc(f"{name}_s1comp", ["comp", 0]),
    })
    if stage2:
        W2 = 2 * W
        p.update({
            "r2e2": r2e(W2),
            "up": {"class_type": "ImageScale", "inputs": {
                "image": ["dec", 0], "upscale_method": "lanczos", "width": W2, "height": W2, "crop": "disabled"}},
            "comp2in": comp(["up", 0], ["r2e2", 0], ["r2e2", 1]),
            "enc2": {"class_type": "VAEEncodeTiled", "inputs": {
                "pixels": ["comp2in", 0], "vae": ["cvae", 0], "tile_size": 512, "overlap": 64,
                "temporal_size": 500, "temporal_overlap": 64}},
            "cat2": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["enc2", 0], "audio_latent": ["alat", 0]}},
            "guider2": {"class_type": "CFGGuider", "inputs": {
                "model": ["nag", 0], "positive": ["cropg", 0], "negative": ["cropg", 1], "cfg": 1}},
            "noise2": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42}},
            "samp2": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
            "sig2": {"class_type": "ManualSigmas", "inputs": {"sigmas": "0.7250, 0.4219, 0.0"}},
            "sca2": {"class_type": "SamplerCustomAdvanced", "inputs": {
                "noise": ["noise2", 0], "guider": ["guider2", 0], "sampler": ["samp2", 0], "sigmas": ["sig2", 0],
                "latent_image": ["cat2", 0]}},
            "sep2": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["sca2", 0]}},
            "dec2": {"class_type": "VAEDecodeTiled", "inputs": {
                "samples": ["sep2", 0], "vae": ["cvae", 0], "tile_size": 512, "overlap": 64,
                "temporal_size": 128, "temporal_overlap": 32}},
            "comp2": comp(["dec2", 0], ["r2e2", 0], ["r2e2", 1]),
            "out_raw2": vc(f"{name}_s2raw", ["dec2", 0]),
            "out_comp2": vc(f"{name}_s2comp", ["comp2", 0]),
        })
    return p


for name, args in RUNS.items():
    json.dump(build(name, *args), open(os.path.join(OUT, f"{name}.json"), "w"), indent=1)
print("built", list(RUNS))
