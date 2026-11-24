# VR outpaint (180° / 360°): next steps for the outpainting pipeline

Date: 2026-11-24. Status: research note. One test run on 2026-11-24 measured the example workflow and options A, B and C (see "Measured on a 96 GB card" and "Quality comparison"). A second run the same day made full 15 s clips with A and B (see "15 s runs"). The other memory and time figures are still estimates from model file sizes and token counts.

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
- VRAM and RAM are upper bounds. On a 96 GB card ComfyUI keeps every model resident and offloads nothing. A 15 s A run capped at 48 GB sampled at the same speed (see "15 s runs").
- The RAM peak includes memory-mapped model files.
- The load column is paid again on every cold start. A warm worker with the models loaded skips most of it, so the per-second cost falls toward the sampling column.
- C and B have nearly the same pixel count, but C samples about 1.8× slower per step. The likely cause is the seam tools, which are on in C and off in B. This was not isolated.
- A 15 s single pass costs more than 3× a 5 s run, because attention cost grows faster than the token count. 3 × 5 s chunks cost about 3×.
- Quality was compared on a flat screen only (see "Quality comparison"). The outputs still need review in a Quest 3.

## Quality comparison (5 s tron, 2026-11-24)

### Where the footage lands

GeoCalib estimates the source focal length, and that estimate overrides `hfov_deg` 90. On the tron clip the footage covers only about **48.5° × 28.4°**, not 90°. The model invents everything else, about 132° of the 180° width.

| Option | px/° | Footage patch on the canvas |
|---|---|---|
| A 1088² 180° | ~6.0 | ~293 × ~172 px |
| B 1536² 180° | ~8.5 | ~414 × ~242 px |
| C 2176×1088 360°, front crop | ~6.0 | ~293 × ~172 px |
| Example workflow 2560×1280 360° | ~7.1 | ~345 × ~202 px |

A and C put the footage on the same pixels. They differ only in how the model fills the rest: A sees a square 180° canvas, C sees the full 2:1 360° canvas it was trained on.

### File sizes (5.04 s, h264 crf 19, 24 fps)

| File | Size | Bitrate |
|---|---|---|
| Source 5 s cut (1280×720) | 1.28 MB | |
| A composite | 1.88 MB | 2.98 Mb/s |
| A raw | 1.54 MB | |
| B composite | 2.88 MB | 4.57 Mb/s |
| B raw | 2.32 MB | |
| C front 180° crop | 1.55 MB | |
| C composite (full 360°) | 3.14 MB | |
| C raw (full 360°) | 2.50 MB | |
| Example composite | 2.61 MB | |
| Example raw | 1.99 MB | |

A 15 s clip is roughly 3× these sizes.

### Metrics

Method:
- Each output was reprojected to five 90° perspective views (front, left, right, up, down) at 960×960.
- Footage and generated regions were split with geometric masks from the projection, not from pixel differences.
- Sharpness is the variance of the Laplacian. Higher is sharper.
- Warp error is the mean absolute error after warping frame t onto frame t+1 with optical flow. Lower is steadier.
- Seam ΔE is the CIEDE2000 colour step across the footage border.
- Scripts and outputs are in `runpod-abc-2026-11-24/compare/` (not committed). `metrics_geo.json` holds the numbers.

Generated region, mean of the five views:

| Option | Sharpness | Warp error |
|---|---|---|
| A | 355 | 2.87 |
| B | 596 | 2.63 |
| C | 242 | 2.28 |
| Example workflow | 217 | 1.69 |

- Seam ΔE is 1.3–3.4 for A, B and C. The example workflow reaches 5.1 in the up view.
- Raw-vs-source PSNR is 27–33 dB for every option.
- Footage-region warp error is 5.6–8.1 for every option. That is the source motion, not a defect.

### What the frames show

- **A:** the horizon bends like a fisheye. The invented areas have blocky smear.
- **B:** the sharpest option, with a level horizon. It adds yellow streaks, and the down view has curved tracks.
- **C:** soft and blotchy, with some doubled structures.
- **Example workflow:** the most natural and the steadiest, but also the softest.

### Verdict

- B is the best of the three 180° options on a flat screen.
- C is steadier than B but softer, and costs about the same.
- A is the weakest.
- Not checked yet: viewing in a Quest 3, and a learned image-quality model.

## 15 s runs (2026-11-24)

Setup:
- Same card, image and settings as "Measured on a 96 GB card".
- Input: 15 s tron clip, 361 frames at 24 fps (`-ss 20`, scaled to 1280×720).
- A fresh ComfyUI process per run.
- A15cap48 is A15 with a second process holding 48.2 GB of the card, so ComfyUI had about 48 GB left. This stands in for a 48 GB card.

| Run | Canvas | Total time | Sampling | VRAM peak | RAM peak (VmHWM) | Cost at $2.69/h |
|---|---|---|---|---|---|---|
| A15 | 1088×1088 | 282 s | 175 s (21.9 s/step) | 67.6 GB | 85.4 GB | ~$0.21 |
| A15cap48 | 1088×1088 | 304 s | 175 s (21.9 s/step) | ~48.1 GB (all it was given) | 86.0 GB | ~$0.23 |
| B15 | 1536×1536 | 727 s | 562 s (70.4 s/step) | 86.6 GB | 119.3 GB (cgroup 123.6 GB) | ~$0.54 |

- **A fits a 48 GB card at the same sampling speed.** ComfyUI's dynamic VRAM loading filled the ~48 GB it had. Only loading took longer (+22 s). The capped output is not bit-identical to the uncapped one (PSNR ~28 dB), but it is the same scene.
- **B15 is about 2.6× slower than A15.** B has ~2× the tokens, and attention cost grows faster than the token count. 15 s vs 5 s: A went from 4.5 to 21.9 s/step (4.9×), B from 12.1 to 70.4 s/step (5.8×).
- **B15 needs a 192 GB RAM host.** Its 123.6 GB cgroup peak is too close to a 128 GB host.

Files (15.04 s, h264 crf 19):

| File | Size |
|---|---|
| A15 composite | 3.87 MB |
| A15 raw | 3.01 MB |
| B15 composite | 4.77 MB |
| B15 raw | 3.51 MB |

### B15 output is broken

- From about 2 s on, the left ~30% of the B15 canvas and most of the sky decode to pure black (pixel value 0). A hard vertical edge separates it from the generated scene.
- The first frames are fine. The black area stays for the rest of the clip.
- B at 5 s (same settings, 121 frames) and A15 do not show this.
- The composite hides part of it, because the tone match lifts the black to dark grey, but the edge stays visible.
- Cause not isolated. Candidates: the 1536² × 361-frame token count (~212k) is far outside what the IC-LoRA saw in training, or a decode problem at that size. A rerun with another seed, or B as 3 × 5 s chunks, would tell them apart.

### A15 quality

Same method as the 5 s comparison. Scripts `scripts/qa/views15.sh` and `metrics_geo15.py`, outputs in `runpod-abc-2026-11-24/15s/compare/` (not committed). Contact sheets at frames 60, 180 and 300.

| Metric (mean of five views) | A15 | A 5 s |
|---|---|---|
| Generated-region sharpness | 383 | 355 |
| Generated-region warp error | 1.36 | 2.87 |
| Seam ΔE | 3.0 (1.6–4.2) | 1.5–3.4 |
| Raw-vs-source PSNR | 29–33 dB | 27–32 dB |

- At frames 60, 180 and 300, A15 shows no black areas, the stadium and track stay consistent, and the close-up at frame 300 is clean. The full clip was not watched frame by frame.
- The fisheye-bent horizon from A at 5 s is still there.
- The two clips have different shots, so the warp errors are not directly comparable. The lower A15 figure does not prove A got steadier.
- B15 numbers are left out. The black area makes them look better than they are (black is perfectly steady).

## 360° estimates

| Case | Canvas, frames | Tokens | VRAM | System RAM |
|---|---|---|---|---|
| Example workflow | 2560×1280, 145 | ~122k | ~33–36 GB | 96 GB realistic, 128 GB comfortable |
| IC-LoRA training size | 1920×960, 121 | ~58k | ~29–31 GB | 64 GB floor, 96 GB comfortable |
| 15 s reel, one pass | 2176×1088, 361 | ~213k | ~41–45 GB | 128 GB min, 192 GB comfortable (~3× time) |
| 15 s reel, 3 × 5 s chunks | 2176×1088, ~121 each | ~70k each | ~31–33 GB | 64–96 GB |

- On a 24 GB card, use fp8 Gemma plus offload, or GGUF.
- The example workflow has no chunk handover. Joining the chunks would be our own work.
- Detail is limited. At 2176 px wide, a 90° shot would span only about 544 px. The measured tron footage spans only ~48° (~293 px), because GeoCalib sets the focal length. Keeping a full 1920 px source needs a canvas about 7680 px wide.

## 180° options (15 s, "1080p" target)

The IC-LoRA was trained only on full 2:1 360° video (1920×960, 121 frames, 24 fps).

| Option | Canvas | Detail | Footage spans | Tokens | VRAM | RAM |
|---|---|---|---|---|---|---|
| **A** 180° direct, small | 1088×1088 | ~6 px/° | ~293 px (measured, ~48°) | ~106k | 48 GB card works (measured) | ~86 GB peak (measured), 128 GB host |
| **B** 180° direct, large | 1536×1536 | ~8.5 px/° | ~414 px (measured, ~48°) | ~212k | 86.6 GB peak on 96 GB (measured); 15 s output broken | ~124 GB peak (measured), 192 GB host |
| **C** 360° then crop front half | 2176×1088 → 1088×1088 | ~6 px/° | ~293 px (measured, ~48°) | ~213k | ~41–45 GB | 128 GB |

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
| Real footage share of pixels | ~56% | ~4% on the tron clip (curved patch ~293 × ~172 px) |
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
3. Judge the outputs in a Quest 3, not on a flat screen. The flat-screen comparison favours B among the 180° options (see "Quality comparison"). Look for warped or repeated content in the invented regions, and for the bent horizon in A.
4. Pick the option from that review. B led at 5 s, but its 15 s single pass came out broken (see "15 s runs"). Rerun B15 with another seed before ruling it out. A15 works; C is the in-distribution fallback.
5. Decide on 15 s handling. A in one pass runs on a 48 GB card with a 128 GB RAM host. B in one pass needs a 192 GB RAM host and failed once. The other route is 3 × 5 s chunks with our own handover.
6. Scope the player work: equirect hemisphere rendering in the WebXR reel player, and a flag on the reel record for the projection type.
