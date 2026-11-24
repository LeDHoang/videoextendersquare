# VR outpaint (180° / 360°): next steps for the outpainting pipeline

Date: 2026-11-24. Status: research note. One test run on 2026-11-24 measured the example workflow and options A, B and C (see "Measured on a 96 GB card"). The other memory and time figures are still estimates from model file sizes and token counts.

## Repos reviewed

- [Burgstall-labs/ComfyUI-VR-Outpaint-Tools](https://github.com/Burgstall-labs/ComfyUI-VR-Outpaint-Tools): projects a flat video into an equirect canvas, then pastes the source back after generation.
  - `EstimateCameraGeoCalib` estimates the camera.
  - `RectilinearToEquirect` (with `canvas_hfov_deg` / `canvas_vfov_deg`) does the projection.
  - `EquirectSourceComposite` tone-matches the source and pastes it back. Its `wrap_w` option must be off for partial canvases.
- [Burgstall-labs/ComfyUI-Seamless-Equirectangular](https://github.com/Burgstall-labs/ComfyUI-Seamless-Equirectangular): model patches that hide the left/right seam of a 360° video.
  - `EquirectPerStepRoll`, `EquirectCircularVAE` and `EquirectWrappedNoise` handle the seam.
  - EquiRoPE and EquiRoPEGeometricCFG are geometry refinements.

Neither repo states a minimum VRAM or RAM. The only memory figures in the code are for `EquirectSourceComposite`:
- 84.4 MiB per 3840×1920 float32 frame.
- A floor of about 253 MiB per frame.
- Work is chunked at 8 Mpx.

## Blockers before anything ships

1. **Licence.**
   - Both node packs are PolyForm Noncommercial.
   - The IC-LoRA (`360vroutpaint_v2_step07000`) needs a commercial licence from Burgstall Labs Oy.
   - The LTX-2 Community licence applies separately.
   - ECHO is commercial, so all of this must be cleared first.
2. **Hosting.** Our current path is fal `fal-ai/ltx-2.3-quality/outpaint[/lora]`, which has these limits:
   - Aspect ratios 1:1, 16:9 and 9:16 only.
   - 480p, 720p and 1080p.
   - At most 481 frames.

   It cannot produce a 2:1 equirect canvas, take the IC-LoRA guide, or apply the seam patches. This work needs self-hosted ComfyUI on our own GPU.
3. **Playback.**
   - Equirect output must be rendered on a sphere or hemisphere in the player, which is a new path next to the flat reel player.
   - Output is mono, not stereo VR180.

## Model stack (from the example workflow)

| Part | File | Size |
|---|---|---|
| Transformer | LTX-2.3 22B distilled-1.1 `mxfp8_block32` (Blackwell-native) | ~25 GB (`fp8_scaled` 25.23 GB, `int8_convrot` 21.5 GB) |
| Text encoder | Gemma 3 12B | 24.38 GB bf16 / 13.21 GB fp8_scaled |
| Text projection | loaded from `ltx-2.3-22b-dev.safetensors` | 46 GB on disk; swap for `ltx-2.3_text_projection_bf16` (2.3 GB) |
| IC-LoRA | `360vroutpaint_v2_step07000` | 1.31 GB |
| VAEs + upscaler | video VAE / audio VAE / spatial x2 | 1.45 / 0.36 / 1.0 GB |

Disk is about 100 GB, or about 55 GB with the projection swap.

### How the token count is worked out

- The latent is 32× smaller in each spatial direction and 8× smaller in time.
- The frame count must be 8n+1. For example, 149 loaded frames give 19 latent frames, which is 145 frames used.
- The IC-LoRA guide is the projected flat video, placed on the canvas and fed as a reference. Its tokens sit next to the output tokens, so the token count roughly doubles.
- The full-size guide is inferred from the workflow value `1`. It was not checked by a run.

## Measured on a 96 GB card (2026-11-24)

Setup:
- Runpod RTX PRO 6000 Blackwell (96 GB), 251 GB RAM, image `runpod/comfyui:2.4.1-comfyuiv0.44.0-cuda13.2`, `--use-sage-attention`.
- Input: 5 s tron clip, 121 frames at 24 fps. Sampler `euler_ancestral`, 8 steps, the example workflow's values otherwise.
- Text projection swapped for `ltx-2.3_text_projection_bf16`.
- A fresh ComfyUI process per run, so every run includes model loading.
- A and B: canvas 180/180, seam tools off. C and the example: 360/180, seam tools on. C also crops the front 1088×1088.

| Run | Canvas | Total time | Sampling | Load, decode, composite | VRAM peak | RAM peak (VmHWM) |
|---|---|---|---|---|---|---|
| Example workflow | 2560×1280 | 378 s | 283 s (35.5 s/step) | 95 s | 67.3 GB | 81.3 GB |
| **C** 360° then crop | 2176×1088 | 254 s | 170 s (21.3 s/step) | 83 s | 62.0 GB | 76.0 GB |
| **A** 180° small | 1088×1088 | 101 s | 36 s (4.5 s/step) | 65 s | 57.5 GB | 68.9 GB |
| **B** 180° large | 1536×1536 | 176 s | 96 s (12.1 s/step) | 80 s | 61.8 GB | 75.9 GB |

Seconds of compute per second of input video:

| Run | Total | Sampling only |
|---|---|---|
| Example workflow | ~75 | ~56 |
| C | ~50 | ~34 |
| A | ~20 | ~7 |
| B | ~35 | ~19 |

Caveats:
- VRAM and RAM are upper bounds. On a 96 GB card ComfyUI keeps every model resident and offloads nothing. A 48 GB card would offload and still run, but slower.
- The RAM peak includes memory-mapped model files.
- The load column is paid again on every cold start. A warm worker with the models loaded skips most of it, so the per-second cost falls toward the sampling column.
- C and B have nearly the same pixel count, but C samples about 1.8× slower per step. The likely cause is the seam tools, which are on in C and off in B. This was not isolated.
- A 15 s single pass costs more than 3× a 5 s run, because attention cost grows faster than the token count. 3 × 5 s chunks cost about 3×.
- Quality has not been judged yet. The outputs need review in a Quest 3.

## 360° estimates

| Case | Canvas, frames | Tokens | VRAM | System RAM |
|---|---|---|---|---|
| Example workflow | 2560×1280, 145 | ~122k | ~33–36 GB | 96 GB realistic, 128 GB comfortable |
| IC-LoRA training size | 1920×960, 121 | ~58k | ~29–31 GB | 64 GB floor, 96 GB comfortable |
| 15 s reel, one pass | 2176×1088, 361 | ~213k | ~41–45 GB | 128 GB min, 192 GB comfortable (~3× time) |
| 15 s reel, 3 × 5 s chunks | 2176×1088, ~121 each | ~70k each | ~31–33 GB | 64–96 GB |

- On a 24 GB card, use fp8 Gemma plus offload, or GGUF.
- The example workflow has no chunk handover. Joining the chunks would be our own work.
- Detail is limited. At 2176 px wide, a 90° shot spans only about 544 px. Keeping a full 1920 px source needs a canvas about 7680 px wide.

## 180° options (15 s, "1080p" target)

The IC-LoRA was trained only on full 2:1 360° video (1920×960, 121 frames, 24 fps).

| Option | Canvas | Detail | Footage spans | Tokens | VRAM | RAM |
|---|---|---|---|---|---|---|
| **A** 180° direct, small | 1088×1088 | ~6 px/° | 544 px | ~106k | ~32–35 GB | 96 GB |
| **B** 180° direct, large | 1536×1536 | ~8.5 px/° | 768 px | ~212k | ~41–45 GB | 128 GB |
| **C** 360° then crop front half | 2176×1088 → 1088×1088 | ~6 px/° | 544 px | ~213k | ~41–45 GB | 128 GB |

### Option A and option B (180° direct)

- A square 180° canvas is out of distribution for the IC-LoRA, so quality is unknown until tested.
- Set `RectilinearToEquirect` to 180/180 on a square canvas.
- Turn off the seam tools, because a 180° frame does not wrap:
  - `EquirectPerStepRoll`
  - `EquirectCircularVAE`
  - `EquirectWrappedNoise`
  - `wrap_w`
- B is sharper, but costs as much as a full 360° run.

### Option C (360° then crop)

- Stays inside the IC-LoRA training distribution, so it is the safe-quality fallback.
- It costs the same as a 360° run, and the back half of the canvas is thrown away.
- The Domemaster README says that cropping from a full 2:1 equirect is useful when the LoRA does better on full 2:1.

### All three options

- The source needs an upscale and a paste-back with `EquirectSourceComposite`.
- At ~6 px/° the footage looks soft in a Quest 3, which shows about 25 px/°.

## How 180° output differs from our square extend

| | Square extend (today) | 180° direct |
|---|---|---|
| Output | 1080×1080 flat MP4 | 1088×1088 equirect MP4, VR180 mono |
| Real footage share of pixels | ~56% | ~18% (curved patch ~544 × ~360 px) |
| Model invents | Top/bottom bands (sides for 9:16) | Everything out to 90° each way, including ceiling and floor |
| Geometry | Normal perspective | Lines bow, top and bottom rows stretch toward the poles; correct only on a hemisphere |
| In the headset | Flat window, ~50° of view | Surrounds the viewer over 180°, footage in the middle ~90° |
| Compute | fal API | Self-hosted GPU |

```
Square extend                          180° direct
input 16:9      output 1:1 flat        input 16:9      output 1:1 equirect
+---------+     +-----------+          +---------+     +-----------+
| footage | --> | generated |          | footage | --> | generated |
+---------+     |  footage  |          +---------+     |   (~~~)   |  <- curved patch,
                | generated |                          | generated |     ~half width
                +-----------+                          +-----------+
```

## Recommended next steps

1. Ask Burgstall Labs Oy for commercial licence terms for the IC-LoRA and both node packs. Without it, stop here.
2. Done 2026-11-24: the example workflow and options A, B and C ran on a 96 GB card. See "Measured on a 96 GB card".
3. Judge the A, B and C outputs in a Quest 3, not on a flat screen. Look for warped or repeated content in the invented regions of A and B, which are outside the IC-LoRA training distribution.
4. Pick the option from that review. If A or B holds up, it is the cheapest path. If neither does, use C.
5. Decide on 15 s handling: one pass (≥48 GB, 128 GB RAM) or 3 × 5 s chunks with our own handover.
6. Scope the player work: equirect hemisphere rendering in the WebXR reel player, and a flag on the reel record for the projection type.
