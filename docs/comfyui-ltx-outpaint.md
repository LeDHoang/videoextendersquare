# ComfyUI LTX-2.3 IC-LoRA In/Outpainting — Local H100 Walkthrough

> Live progress log for local ComfyUI video outpainting (1× H100 80GB):
> LTX-2.3 IC-LoRA first, then LTX-2.5 A/B, pixel-spatial x2 A/B, MiniMax-H3
> (Ref2VA dialect+composite), and TwoAbove latent-masked H3 outpainting.
> Decisions: **standalone script first**, **distilled two-stage**, **runtime output metrics**,
> **KEEP 2.3 over 2.5** (2.5 softer bands + 16–25% slower, no quality win on any of 5 A/Bs),
> **2.3 x2 for upscale** (2.02× vs 1.44× detail gain),
> **blend-dilation is canvas-dependent** (dil15 for ≥1728²/portrait, dil8 more faithful
> at 1280² narrow-band landscape — LPIPS 0.092 vs 0.127),
> **H3-Ref2VA recipe = dialect prompt + post composite** (mask paths shelved),
> **TwoAbove recipe = empty prompt, 8-step+FL2VA-turbo LoRA now DEFAULT (1.64× free),
> 14/20-step fallback**, clean staging + mirror-probe assert, CPU finish = decrush + auto
> tail-trim, NO center paste (paste breaks VAE tone; center NCC 0.997+).
> **Perceptual verdict (LPIPS/SSIM/PSNR, 2026-09-09): TwoAbove fidelity win is
> CONTENT-DEPENDENT — TW ~2.9× closer on PORTRAIT, LTX ~2.1× closer on LANDSCAPE;
> LTX ~30% calmer temporally everywhere.** Pick TW for portrait finals, LTX for landscape/throughput.
> Updated by the agent as each step completes — read top-to-bottom for current status.

## Status board

| # | Step | Status | Notes |
|---|------|--------|-------|
| 0 | Prior-work recovery | DONE 2026-09-03 | No prior plan file found. Recovered state: `ComfyUI/` cloned + `ComfyUI-LTXVideo`/`Manager`/`VideoHelperSuite` installed, `comfy-venv` (py3.10, torch 2.7.1+cu126) works, `models/` empty, `.cache/huggingface` empty. Branch `comfyuipipeline`. |
| 1 | HF auth + model downloads | DONE 2026-09-03 ~07:20 UTC | Token OK (`Leduchoang`, both gated repos accessible). All 4 files on vol11-scratch (NOT usr2): `checkpoints/ltx-2.3-22b-dev.safetensors` 46.1GB, `loras/ltxv/ltx2/ltx-2.3-22b-distilled-lora-384-1.1.safetensors` 7.6GB, `loras/ltxv/ltx2/ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors` 1.3GB, `text_encoders/comfy_gemma_3_12B_it.safetensors` 24.4GB (from `Comfy-Org/ltx-2:split_files/text_encoders/gemma_3_12B_it.safetensors`, renamed per workflow). Full log: `logs/comfy_models_download.log`. Stray `.cache` staging dirs removed. |
| 2 | comfy-venv deps + headless boot (:8188) | DONE 2026-09-03 | Installed `gguf`, `ninja`, `timm` into `comfy-venv` (pip cache → `$WS/.cache/pip`, satisfies usr2 constraint). Full `-r requirements.txt` otherwise already satisfied; torch stays 2.7.1+cu126. Gotcha fixed: double-fork launcher must pass full venv path as `argv[0]` or `pyvenv.cfg` is missed and venv site-packages vanish (`sqlalchemy` ghost). Server up: `http://127.0.0.1:8188`, ComfyUI v0.34.0, all custom nodes import clean (Manager, VideoHelperSuite, LTXVideo). API verified: checkpoint/gemma/LoRA dropdowns list exactly the 4 downloaded files. Launcher: `scripts/launch_comfy_bg.sh` (workspace-persistent; the earlier `/tmp/opencode` path gets wiped on idle-stop), log: `logs/comfyui_server.log`. |
| 3 | Smoke-test stock `LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json` | DONE 2026-09-03 ~07:50 UTC | `scripts/comfy_ltx_outpaint.py --stock --prefix smoke_stock --output output/smoke_stock.mp4` → done in **196 s** end-to-end (cold model load incl.). Output `output/smoke_stock.mp4`: 1920×1088 h264 + aac, 3.88 s, 97 frames, 1.5 MB (ffprobe-verified). Log: `logs/comfy_smoke.log`. |
| 4 | Standalone `scripts/comfy_ltx_outpaint.py` + runtime CLI | DONE 2026-09-03 | Converter green on 55 nodes (`--dry-run` OK); `LoadVideo/CLIP/pad/seed/sigmas/LoRA/guide/fps/prefix` overrides wired; pre-processing (trim+ref) + submit/poll/download wired; CLI reconciled with graph (§Step 4); E2E proven (§Step 5). |
| 5 | E2E verify on real clip (square, ffprobe, timing) | DONE 2026-09-03 ~07:54 UTC | Real-clip path proven with stock mp4 as stand-in input: trim 0–4 s → stage → 1280×1280 pad override + custom prompt + seed 42 → done in **85 s** (warm models). `output/e2e_square.mp4`: 1280×1280 h264+aac, 3.88 s, 97 frames (ffprobe-verified). Log: `logs/comfy_e2e.log`. Genuine user clips tested later same day (battlefield/title/conf — see Runs). |
| 6 | Band-drift A/B (feather/prompt/guide/color-match/combo) | DONE 2026-09-03 | Feather 32 identical; decolored prompt no effect; guide 0.5 marginally worse (1.5 rejected, max 1.0); mean-shift-only postpass blunt; combo no synergy. Drift = inherent sampler exposure wander, not seam defect. |
| 7 | Phase-0 blend-dilation (dil0 vs dil15) | DONE 2026-09-04 | `output/battlefield_dil0.mp4` 205 s vs `output/battlefield_dil15.mp4` 190 s. User visual verdict: dil15 best, dil0 worst. `--blend-dilation` default 15. |
| 8 | LTX-2.5 phases 1–5 (flattener, adapter, battlefield A/B, 3-clip extend) | DONE 2026-09-04 | 5 bf16 files ~71GB; `scripts/comfy_subgraph.py` 80 nodes; drift NOT fixed; +21% slower @1728²; **DECISION: KEEP 2.3+dil15**. No 2.5-native outpaint LoRA exists. |
| 9 | Pixel-spatial x2 upscaler A/B (2.3 vs 2.5) | DONE 2026-09-04 | 2.3 x2 LoRA 654MB + 2.5 x2 LoRA 327MB. Battlefield 1728²→3456²: 1457 s vs 1823 s. Detail gain 2.02x vs ~1.5x. **2.3 x2 wins.** Operating point 1280²→2560² (~7 min). |
| 10 | MiniMax-H3 Ref2VA outpaint (mask probe → dialect+composite) | DONE 2026-09-04 | Mask path = black-band collapse (shelved); harmonize ladder tiles (shelved). Recipe: dialect retention prompt + `--feather 40` composite. `output/bf_h3dialect2.mp4` viewed OK, NCC 0.93–0.98. |
| 11 | TwoAbove latent-masked H3 outpaint (v1–v8, prompt/seam/tail saga) | DONE 2026-09-07 | Node as-is + `1:1 square` patch + mask-feather edit. v2 input poisoned (mirror-pad) — post-mortem by isolation. Short prompt recovered tw2-class (v6); empty prompt same quality (v7, prompt eliminated). Seam = bottom V-crush (luma 23) → decrush + latent mask feather. Tail = 17k+5 snap inventions → driver auto-trim. Paste RETRACTED (NCC 0.997+, VAE tone). |
| 12 | TwoAbove cross-clip (title/conf, seam objectivity) | DONE 2026-09-07 | Same v8 config, content-only variable. NO black line on either (crush is content-triggered). Conf tail = invented desert portrait → auto-trim now in driver. `title_tw60`/`conf_tw60` shipped. |
| 13 | Instagram reels full-length compare (LTX→x2→TW, chunked) | DONE 2026-09-08 | 3 reels × 3 phases, sequential 1×H100, ~10.4 h productive. Finals in `output/reels/` (9 files). Recipe: LTX 6s/1s + UP 3s/0.5s + TW 3s/1s (90f exact), seed 7, time-based crossfade stitch + orientation-aware decrush. Bugs fixed en route: fixed-overlap stitch duplicated footage (rewrote time-based), tail-frame VAE snaps (short-tail accept rule), mirror-probe false positives (warn-only), EOF keyframe shortfall (asymmetric stage tolerance). See §Reels. |
| 14 | Reel2 H3-turbo A/B (FL2VA 8-step LoRA, chunked) | DONE 2026-09-09 | `scripts/run_reel2_turbo.py` (`logs/comfy_reel2_turbo.log`), 18 chunks, seed 7, ALLDONE 03:50:48–05:27:19 UTC (~96.5 min) vs stock TW ~158 min → **1.64× end-to-end**. `output/reels/reel2_turbofull.mp4` 1057f 1216×1248 OK. Stock-vs-turbo compare CLOSED: cNCC 0.993 both, bands slightly crisper on turbo, seams/flicker tied, stills indistinguishable → **8-step+LoRA is the new TW default**. See §Reels turbo note. |
| 15 | Perceptual test battery (LPIPS/SSIM/PSNR full-reference) | DONE 2026-09-09 | `scripts/fidelity.py` (LPIPS-alex/SSIM/PSNR, tone-matched) + `scripts/compare_turbo.py`. Center-vs-source across 4 clips: **TW fidelity win is CONTENT-DEPENDENT** — TW ~2.9× closer on portrait (reel2/3), LTX ~2.1× closer on landscape (reel1); battlefield trim-confounded/dropped. Temporal LPIPS: LTX ~30% calmer everywhere. Ruled out timing/geometry/motion artifacts. See §Extensive perceptual test battery. |
| 16 | reel1 LTX A/B: 2.3 vs 2.5 × dil8 vs dil15 | DONE 2026-09-09 | `scripts/run_r1_dil8.py` (`logs/comfy_r1_dil8.log`). **2.3 wins again** (5th confirm): fidelity tied but 2.5 bands softer + ~16% slower/chunk. **dil8 more faithful than dil15 at 1280² landscape** (LPIPS 0.092 vs 0.127) — blend-dilation is canvas-size dependent, not a global constant. See §reel1 LTX A/B. |

## Environment (verified 2026-09-03, still current 2026-09-07)

- GPU: `NVIDIA H100 80GB HBM3`, ~81 GB free, driver 575.57.08
- Python: 3.10.12 · torch in `comfy-venv`: `2.7.1+cu126`
- Disk: NFS 90T @ 97% — ~3.1T free; weights now ~46+7.6+1.3+24 (2.3) + ~71 (2.5) + ~21+Qwen/VAEs (H3) + FL2VA INT8 (TwoAbove) — all on vol11-scratch
- ComfyUI: `ComfyUI/main.py` present; custom nodes: Manager, VideoHelperSuite, LTXVideo, KJNodes, H3VideoOutpaint; `models/*` populated per §Model files
- Server: `http://127.0.0.1:8188` v0.34.0 via `scripts/launch_comfy_bg.sh` (`setsid`+`nohup`, `python -u`); HF auth flow = user drops `.hf_token`, launcher consumes+deletes, env only
- App pipeline (untouched in this phase): `pipeline/video_worker.py` = fal.ai outpaint (`fal-ai/ltx-2.3-quality/outpaint`) + fast/studio/fal upscale → 3840×3840 HEVC. New work does **not** modify it yet.

## Model files required (distilled two-stage path)

Source of truth: `ComfyUI/custom_nodes/ComfyUI-LTXVideo/README.md` (§Required Models)
+ `example_workflows/2.3/LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json`.
Exact filenames are extracted from the workflow JSON at implementation time (no guessing).

| Artifact | Dest under `ComfyUI/models/` | Source |
|---|---|---|
| `ltx-2.3-22b-distilled-1.1.safetensors` (22B distilled base) | `checkpoints/` | `Lightricks/LTX-2.3` |
| `ltx-2.3-22b-distilled-lora-384-1.1.safetensors` (two-stage LoRA) | `loras/` | `Lightricks/LTX-2.3` |
| `ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors` (**target model**) | `loras/` | `Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting` |
| `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` (+ x1.5 if referenced) | `latent_upscale_models/` | `Lightricks/LTX-2.3` |
| `ltx-2.3-temporal-upscaler-x2-1.0.safetensors` | `latent_upscale_models/` | `Lightricks/LTX-2.3` |
| Gemma-3 12B IT QAT repo (full file set) | `text_encoders/gemma-3-12b-it-qat-q4_0-unquantized/` | `google/gemma-3-12b-it-qat-q4_0-unquantized` |
| Audio VAE / AV-encoder refs (`LTXAVTextEncoderLoader`, `LTXVAudioVAELoader` widgets) | as resolved from JSON | bundled or same repos |

Model-card notes (from HF page): single released LoRA file; mask-conditioned
(reference video + binary mask); empty/minimal prompt OK — prompt should describe
**only the new region**; outpaint mask = new canvas region, no dilation needed;
two-stage = coarse gen → refine + Laplacian blend.

Additional stacks (all vol11-scratch, see Status board for verdicts):
- LTX-2.5 (~71GB bf16): `diffusion_models/ltx-2.5-22b-distilled-transformer-bf16`
  + `text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16` + `vae/ltx-2.5-video-vae-bf16`
  + `vae/ltx-2.5-audio-vae-bf16` + `latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0`
  (IC-LoRA reused). No 2.5-native outpaint LoRA exists (checked 2026-09-04: 43 Lightricks repos).
- Upscalers: 2.3 `ltx-2.3-spatial-upscaler-x2` 654MB + 2.5 `...-x2-1.0` 327MB
  (needed separate access request).
- H3: `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot` 21GB +
  `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq` + 2 VAEs +
  `loras/minimax_h3_ref2v_turbo_4step` + Kijai Fun-ControlNet int8 (mask path shelved anyway).
- TwoAbove: `ComfyUI-H3VideoOutpaint` custom node + FL2VA INT8 (`--min-src-mp` keeps canvas in budget).

## Implementation steps (standalone-first)

### Step 1 — HF auth + downloads
1. `export HF_TOKEN=...` (or `huggingface-cli login`), `hf download` each artifact above.
2. Log exact byte sizes + dest paths here when done.

Progress:
- [x] token verified (`hf whoami` → `Leduchoang`; gated file list succeeds)
- [x] base checkpoint downloaded (46,149,344,974 B)
- [x] distilled LoRA downloaded (7,605,507,256 B)
- [x] in/outpainting IC-LoRA downloaded (1,308,778,338 B)
- [x] Gemma encoder downloaded (24,379,468,890 B, renamed to `comfy_gemma_3_12B_it.safetensors`)
- [x] audio-VAE refs resolved — none extra needed (`LTXVAudioVAELoader` reuses the dev checkpoint)
- [x] no spatial/temporal upscaler files needed — this workflow does pixel-space 2× (`ResizeImageMaskNode` ×2 + `VAEEncodeTiled`), no `*UpscalerModelLoader` nodes in graph (verified by node scan)

Storage rule (user constraint): usr2/hleduc is quota-limited (8.4T @ 93%).
Everything heavy lives on vol11-scratch: `ComfyUI/models/*`, HF cache via
`HF_HOME=$WS/.cache/huggingface`, torch/triton caches under `$WS/.cache`.
Never write model/blob data to `$HOME` or `/tmp`.

### Step 2 — venv + headless boot
1. Install missing deps: `comfy-venv/bin/pip install -r ComfyUI/requirements.txt -r ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt` (only what’s missing).
2. `comfy-venv/bin/python ComfyUI/main.py --listen 127.0.0.1 --port 8188 --reserve-vram 5`
3. Expect: boots, `http://127.0.0.1:8188/system_stats` OK, custom nodes load (check log for `ComfyUI-LTXVideo` import errors).

Progress:
- [x] deps installed, import errors resolved (gguf/ninja/timm; KJNodes reqs; H3 node reqs)
- [x] ComfyUI responds on :8188 (v0.34.0, all custom nodes import clean)

### Step 3 — stock workflow smoke test
1. `cp` the stock sample into ComfyUI input (see Runs).
2. Convert the UI-graph JSON to API prompt with `scripts/comfy_ltx_outpaint.py --dry-run` (validates converter), then submit for real.
3. Expect output in `ComfyUI/output/`. If OOM on 80GB: raise `--reserve-vram`, then `low_vram_loaders.py` nodes, then Q8 path.

Blocker found + fixed 2026-09-03: the workflow references
`ImagePadForOutpaintTargetSize`, which exists in NEITHER ComfyUI core (only
`ImagePadForOutpaint`) NOR `ComfyUI-LTXVideo@15d09ab` (upstream master has the
same gap — node only appears in example JSONs). It is kijai's
**ComfyUI-KJNodes** (`nodes/image_nodes.py`: image/target_width/target_height/
feathering/upscale_method/mask → IMAGE,MASK — exactly the workflow's widgets
`[1920,1088,0,"nearest-exact"]`). Fixed by `git clone --depth 1
kijai/ComfyUI-KJNodes` into `custom_nodes/` + its 5 requirements
(`color-matcher`, `mss`, …) + server restart. Verified via
`/object_info/ImagePadForOutpaintTargetSize`.

Progress:
- [x] stock workflow completes, output verified with `ffprobe`

### Step 4 — standalone script
New file: `scripts/comfy_ltx_outpaint.py` (template-driven, graph is never hand-authored):
- Loads the example JSON, patches by node-type lookup: `LoadVideo`, `CheckpointLoaderSimple`, LoRA loaders, `CLIPTextEncode` (pos/neg), seed/`RandomNoise`, `ImagePadForOutpaintTargetSize` (target W/H), stage sigmas/samplers, `LTXAddVideoICLoRAGuideAdvanced` strengths, upscaler toggle, video-saver prefix.
- Pre: `pipeline/utils.calculate_square_padding` + ffmpeg trim (≤15 s convention) → centered reference + mask.
- Submit `POST /prompt` → poll `/history` → download → ffmpeg HEVC master via existing `pick_encoder()` logic (copied pattern, no import coupling yet).
- CLI (all runtime-decided, as implemented — reconciled 2026-09-03 with the
  actual graph; no `steps` widget exists — stage length = sigma count —
  and no `*UpscalerModelLoader` nodes exist — pixel-space 2× path):
  `--input --stock --dry-run --trim-start --trim-duration --target-width --target-height --feathering --fps --prompt --negative --seed --cfg --sampler --sigmas-s1 --sigmas-s2 --distilled-strength --iclora-strength --guide-strength --attention-strength --prefix --output --timeout`
  (plan-draft names `--steps-s1/s2` → `--sigmas-s1/s2`, `--guidance` → `--cfg`,
  `--lora-strength` → `--distilled-strength`/`--iclora-strength`, `--upscaler` → n/a)

Progress:
- [x] template loads + patches without hardcoded node IDs (`--dry-run`: 55 nodes, 8 muted/note skipped)
- [x] `/prompt` submit/poll/download works (proven by smoke + E2E runs)
- [x] `--help` documents every flag (reconciled with graph — see CLI note in §Step 4)

## Usage — how to run LTX outpainting in this workspace

### 1. Start the server (once per session / after idle-stop)
```sh
sh scripts/launch_comfy_bg.sh
comfy-venv/bin/python -c "import urllib.request,json; print(json.load(urllib.request.urlopen('http://127.0.0.1:8188/system_stats',timeout=10))['system']['comfyui_version'])"
# expect 0.34.0 — log: logs/comfyui_server.log
```
The server is detached (`setsid`+`nohup`) so it survives shell exit.
Keep launchers in `scripts/` — `/tmp` is wiped when the workspace idles.

### 2. Validate the template conversion (no GPU work)
```sh
comfy-venv/bin/python scripts/comfy_ltx_outpaint.py --dry-run
# expect: "converted 55 nodes (skipped 8 muted/note)" + "... dry-run OK"
```

### 3. Stock smoke test (bundled 1080×1920 portrait → 1920×1088)
```sh
sh scripts/launch_smoke_bg.sh   # background → output/smoke_stock.mp4, log logs/comfy_smoke.log
# foreground equivalent:
comfy-venv/bin/python -u scripts/comfy_ltx_outpaint.py --stock --prefix smoke_stock \
  --output output/smoke_stock.mp4 --timeout 5400
# ~196 s cold (model load), ~85 s warm. Verify:
ffprobe -v error -show_entries stream=width,height,codec_name,duration output/smoke_stock.mp4
```

### 4. Real clip (trim → outpaint → save)
```sh
comfy-venv/bin/python -u scripts/comfy_ltx_outpaint.py \
  --input /path/to/clip.mp4 --trim-start 0 --trim-duration 4 \
  --target-width 1920 --target-height 1920 \
  --prompt "describe ONLY the new regions" --seed 42 \
  --prefix my_outpaint --output output/my_outpaint.mp4 --timeout 5400
# background variant: copy scripts/launch_e2e_bg.sh and point --input at the clip.
```

Sizing rule: the pad node *expands* the canvas to the target. From a
1920×1080 landscape source, `--target-width 1920 --target-height 1920`
keeps the full frame and outpaints top/bottom (true 1:1). Asking for
1080×1080 would *shrink* the width — sides get cropped, not outpainted.
Keep targets multiples of 64 (the graph snaps to ×64 internally anyway).

Prompt rule (model card): describe **only the new region**; an
empty/minimal prompt also works. No mask dilation needed.

Flag groups (`--help` lists all): input/staging
(`--stock --input --trim-start --trim-duration`), canvas
(`--target-width --target-height --feathering`), text
(`--prompt --negative`), sampling
(`--seed --cfg --sampler --sigmas-s1 --sigmas-s2`), LoRA+guide
(`--distilled-strength --iclora-strength --guide-strength
--attention-strength`), blend (`--blend-dilation`, default 15/15 both stages — template ships
5/2, but 15 = max/widest blend = least visible seam per Phase-0 visual
verdict; pass an explicit value to override),
misc (`--fps --prefix --output --timeout --dry-run`).

Where things land: generations in `ComfyUI/output/<prefix>_*.mp4` (+ copy
to `--output`); staged trims in `ComfyUI/input/<prefix>_src.mp4`; all
heavy data stays on vol11-scratch, never `$HOME`/`/tmp`.

Template + upscale:
```sh
comfy-venv/bin/python -u scripts/comfy_ltx_outpaint.py --template 2.5 ...   # 2.5 stack, one flag
sh scripts/launch_upscale_bg.sh        # 2.3 x2, title 1280²→2560² (~7 min)
sh scripts/launch_upscale_bf_bg.sh     # battlefield 1728²→3456² both upscalers (~25–30 min, 69.9GB peak)
```
2.5 needs nothing else (IC-LoRA reused, enhancer pruned, `ltxv/ltx2/` prefix + `--video-vae` handled).

H3 / TwoAbove (current recipe 2026-09-07):
```sh
sh scripts/launch_h3v2_bg.sh     # Ref2VA dialect retention prompt + feather-40 composite → output/bf_h3dialect2.mp4
sh scripts/launch_h3tw_bg.sh     # TwoAbove: empty prompt, seed 7, 14 steps, 2 s window → output/bf_h3tw8.mp4
sh scripts/launch_h3tw_xclip_bg.sh  # same config on title/conf → output/title_tw.mp4, output/conf_tw.mp4
```
TwoAbove contributory settings: `--aspect '1:1 square'` (2-line node patch),
`--min-src-mp 0.5`, `--frame-cap 120`, `--timeout 7200`. Driver auto-trims
output to staged length (raw 73f kept as `*_73f.mp4`). CPU finish (no paste!):
3px decrush interpolation at both mask edges + trim — see `.cache/comp_tw7.py`.
H3 rules learned the hard way: source clip's first ~1 s shows YouTube player UI
(`--trim-start 1.0`); never trust container frame counts (read-until-exhaust +
duration trims); stage with explicit fps + exact counts and assert post-encode
(dims/fps/count + mirror-probe edge MAD, refuse <15); 1248×704 direct scale
(zero synthetic pixels — pad/mirror fillers get pinned as truth); 1280-class
canvas for TwoAbove (1728-class exceeds the node's 90M-px auto temporal-window
budget); node unloads all models after each save (~1–2 min reload, 100% util
while sampling, ~52GB); node snaps frames UP to 17k+5 and denoises the pad
tail into invented content (auto-trim handles it).

### 5. Troubleshooting
- `moov atom not found` on the stock sample → git-lfs pointer file.
  `--stock` now auto-refetches the real bytes; or delete
  `ComfyUI/input/outpainting_input.mp4` and rerun.
- `no value for 'codec'` on `--dry-run` → stale script; pull the version
  with the `is_hidden()` fix.
- `FileNotFoundError` copying `ComfyUI/output/<prefix>_src.mp4` → stale
  script; pull the version with SaveVideo-only `resolve_outputs()`.
- `VAEEncodeAudio: input audio is None` → source clip is silent; current
  script auto-muxes a silent AAC track at staging. (Fixed 2026-09-03 in
  `prepare_inputs()`.)
- Background log stays empty → the child must run under `python -u`
  (all `scripts/launch_*_bg.sh` already do).
- OOM on 80GB → raise `--reserve-vram`, then `low_vram_loaders.py`
  nodes, then the Q8 path.
- Server down after idle-stop → `sh scripts/launch_comfy_bg.sh`.
- `ImagePadForOutpaintTargetSize` unknown → `ComfyUI-KJNodes` missing;
  `git clone --depth 1 kijai/ComfyUI-KJNodes` into `custom_nodes/` +
  install its requirements + restart (see §Step 3 blocker).
- Frame counts lie: `-shortest` truncates against muxed-silence timestamps;
  cv2 `nb_frames` truncates composites. Read-until-exhaust + duration trims
  everywhere; scripts assert output counts.
- TwoAbove specifics: 1728-class canvas exceeds the node's 90M-px auto window
  budget (hard-fail) → 1280-class + `--min-src-mp`; dynamic-combo widget refs
  need positional-index shift (nested structure); node unloads models per run;
  node snaps counts to 17k+5 and invents pad-tail content → driver auto-trims
  to staged length (check `*_73f.mp4` raw if tail looks odd); NEVER paste
  staged center over TwoAbove output (center NCC 0.997+ but 2–3.5 levels
  brighter pre-VAE — paste manufactures a tone step); verify STAGED pixels
  by eye before any GPU run (mirror-probe assert catches edge mirroring).

### Step 5 — E2E verify
- Run script on a real portrait + landscape clip → `ffprobe` square dims, duration, A/V sync → record wall-time/VRAM.
- Known-good command lines will be pasted here.

Runs:
- `comfy-venv/bin/python scripts/comfy_ltx_outpaint.py --stock --prefix smoke_stock --output output/smoke_stock.mp4 --timeout 5400` → 196 s, 1920×1088 h264+aac 3.88 s (`logs/comfy_smoke.log`)
- E2E (background, warm models): `sh scripts/launch_e2e_bg.sh` (trim 0–4 s of stock mp4 → 1280×1280 square, custom prompt, seed 42 → `output/e2e_square.mp4`, log `logs/comfy_e2e.log`) — DONE in 85 s, 1280×1280 verified.
- E2E bug found + fixed: `resolve_outputs()` collected **every** node's history outputs, so `files[0]` was the `LoadVideo` passthrough (a path in `ComfyUI/input/`) → `FileNotFoundError` on copy. Now restricted to `SaveVideo` node ids (signature `resolve_outputs(prompt, entry)`).
- Battlefield user clip (background): `sh scripts/launch_battlefield_bg.sh` (1726×970 60 fps h264, full 4.77 s, trim 0–5 s → 1728×1728 bigger-dim square, battlefield prompt, seed 7 → `output/battlefield_sq.mp4`, log `logs/comfy_battlefield.log`) — DONE in 210 s, `outputs:` contained only the SaveVideo file (fix confirmed). `output/battlefield_sq.mp4`: 1728×1728 h264+aac, 4.58 s, 137 frames @~29.9 fps (source 143 frames @60 fps → LTX temporal packing drops a few; same pattern as stock runs).
- Batch of 2 silent user clips (background, one launcher): `sh scripts/launch_batch2_bg.sh` (`logs/comfy_batch2.log`). Both 1280×720 landscape → 1280×1280, trim 0–5 s. First attempt failed in ~10 s on BOTH: `VAEEncodeAudio: input audio is None` — neither clip carries an audio track and the stock graph always runs the audio-VAE path. Fixed in `prepare_inputs()` (`_ensure_audio_track()`: mux silent AAC via `anullsrc`, video copied) and reran: `output/title_sq.mp4` DONE in 101 s (1280×1280, 4.84 s, 121 frames, seed 11), `output/conf_sq.mp4` DONE in 120 s (1280×1280, 4.84 s, 145 frames, seed 12).
- Timing rule (warm server; cold first run adds ~110 s model load): throughput
  is linear at **~2M output-px/s** — 97f×1280²→85 s, 121f×1280²→101 s,
  145f×1280²→120 s, 137f×1728²→210 s. Estimate:
  `t ≈ frames × W × H / 2e6 + 10 s`. E.g. 15 s@25 fps→1280² ≈ 5 min;
  →1728² ≈ 9–10 min. Output frame rate settles at ~25–30 fps regardless of
  source fps (60 fps in → ~30 out; frame counts shrink accordingly). Peak
  VRAM seen: ~52 GB @1728²×137f — chunk clips >8 s if OOM threatens.
- Known issue (2026-09-03, `scripts/scan_video.py`): **broad tone drift in
  generated bands, no hard edge**. Row-luma scans show no 1-px step at the
  seam (edge ratios <1 — Laplacian blend is smooth) but the outpainted bands
  drift in exposure/tint over time: conf top band −2→+16 luma across 4 s,
  title top band grows a red tint (R+8 @t=4s), battlefield ±10 R drift.
  Reads as a discolored band at the boundary. Suspects: stage-1 exposure
  drift + prompt color bias. Next mitigations to A/B: `--feathering 32/64`
  (wider blend), toned-down color words in prompt, per-frame band→source
  color-match postpass.
- A/B result (2026-09-03): battlefield rerun with `--feathering 32`
  (`output/battlefield_f32.mp4`, 195 s, seed 7, log
  `logs/comfy_battlefield_f32.log`) is **indistinguishable** from
  feathering 0 — same drift pattern/magnitudes at all 4 probe times
  (e.g. t=4 top R−10/G−8/B−4 both runs). Verdict: pad feather is NOT the
  lever; drift comes from the generation itself, not the seam blend.
  Remaining options: prompt de-coloring, guide-strength tuning, or a
  deterministic per-frame band→source color-match postpass.
- Fixes 1/2/3 run isolated, same source + seed 7 (`sh
  scripts/launch_fixes123_bg.sh` → `logs/comfy_fixes123.log`,
  `scripts/launch_fix3_bg.sh` → `logs/comfy_fix3.log`). Top-band luma
  deltas @t=1/2/3/4s — base: −2.9/−0.2/+3.4/−7.5 · feather32:
  −3.6/−0.5/+3.2/−6.9 · fix2 decolored prompt (215 s):
  −3.2/−0.1/+3.7/−7.7 · fix3 guide 0.5 (200 s):
  −2.9/+0.4/+3.5/−9.7 (guide 1.5 was server-rejected: strength max is
  1.0). **Verdict: no generation-side knob moves the drift** — prompt
  color words and guide strength leave the pattern intact (fix3 marginally
  worse @t=4, consistent with less reference pinning). Drift is inherent
  sampler exposure wander, not a seam defect (all edge ratios <1).
- Fix 1 (`scripts/color_match_bands.py`, CPU): two iterations. v1 global
  Reinhard transfer blew bright spots to white (std-gain on flat bands)
  and corrected the already-blended seam zone (→ white edge). v2 =
  **mean-shift only + 24px smoothstep ramp to 0 at the seam**; structure
  preserved, global band means match src. Caveat found via
  `scripts/profile_seam.py`: the mismatch is spatially non-uniform (dark
  far-sky vs bright near-seam content), so any global correction is blunt
  — near-seam tone is content-dominated. Debugging side-quests fixed in
  passing: ffmpeg `-shortest` silently truncates against muxed-silence
  audio timestamps (137→39 frames; dropped, durations already match) and
  the script now asserts output frame count.
- Visual-compare set (all 1728×1728, same seed/content):
  `output/battlefield_sq.mp4` (base) ·
  `output/battlefield_f32.mp4` (feather 32) ·
  `output/battlefield_fix1_colormatch.mp4` (postpass) ·
  `output/battlefield_fix2_prompt.mp4` (neutral prompt) ·
  `output/battlefield_fix3_guide.mp4` (guide 0.5).
- Why base looks less noticeable than fix1 at the seam, even though fix1's
  global color is closer (`profile_seam.py` @t=3s, src mean [141,129,113]):
  base's near-seam rows already match src ([126,128,113]) with a smooth
  gradient outward — the eye reads continuity. Fix1's shift is set by the
  GLOBAL band mean, dragged down by the huge dark far-sky, so the same
  near-seam rows get pushed to [151,147,128]: locally MORE different from
  src than base. Eye cares about the local step, not the global average.
- Combo run (2026-09-03, `sh scripts/launch_combo_bg.sh` → 
  `logs/comfy_combo.log`, `output/battlefield_combo.mp4`): decolored
  prompt + guide 0.5 fresh gen (356 s incl. cold model reload — server had
  died after fix3, restarted via `launch_comfy_bg.sh`) + mean-shift
  postpass. Result: same drift pattern (t=4 top −9.9, tracks the guide-0.5
  run), no synergy. Confirms drift is inherent sampler wander; postpass
  only re-centers global tone.

## Deferred (not this phase)

- `comfy` as 4th `upscale_engine` in `server/routers/video.py` + `pipeline/video_worker.py` + VideoPage UI.
- Docker/RunAI packaging.
- (done 2026-09-04) Direct-4K vs square+upscale comparison → operating point 1280²→2560² x2.

## LTX-2.5 evaluation (DONE 2026-09-04 — KEEP 2.3; stack on disk, one flag away)

Q: would 2.5 fix the band drift? Plausible but unproven. For: new
distilled transformer ("higher-quality"), "better video decoder for
cleaner motion", latent-space 2× upscale path (vs 2.3 pixel-space), and a
documented blend-dilation knob for low-frequency bleed (our symptom
class). Against: the **same** `ltx-2.3-22b-ic-lora-in-outpainting-0.9`
IC-LoRA is reused, same two-stage design (the likely drift source).
Only a battlefield A/B decides.

Gap analysis (2.5 does NOT run on the current script as-is):
1. Workflow format: `example_workflows/2.5/LTX-2.5_ICLoRA_Outpaint_Two_Stage_Distilled.json`
   (already in our clone) uses **subgraphs** (`definitions.subgraphs`,
   UUID node types, 23 top-level nodes); our converter only handles flat
   graphs → needs a recursive subgraph flattener (remap node/link IDs,
   rewire boundary I/O), then type-lookup patching works unchanged.
2. Model stack: 7 new files (~72.7 GB bf16): `diffusion_models/ltx-2.5-22b-distilled-transformer-bf16`
   + `text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16` + `text_encoders/gemma4_e2b_it_bf16`
   (Comfy-Org/gemma-4) + `vae/ltx-2.5-video-vae-bf16` + `vae/ltx-2.5-audio-vae-bf16`
   (+`vae/ltx-2.5-video-vae-conv-bf16`, verify if wired) +
   `latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0`
   (all `Lightricks/LTX-2.5` except noted). IC-LoRA + dev checkpoint reused. VRAM ≈ same as 2.3.
3. Loader adapters: UNETLoader + separate video/audio VAELoaders + Gemma4
   CLIP loader replace CheckpointLoaderSimple/LTXAVTextEncoderLoader/LTXVAudioVAELoader
   → new override mappings + `--template {2.3,2.5}` flag.

Phases: **0 (cheap, first)** — 2.3 `--blend-dilation` override for the 2
`LTXVLaplacianPyramidBlend` nodes (template runs 5/2, range 0–15);
battlefield seed 7 @ 0/0 vs 15/15 + scan (~15 min, zero downloads).
**DONE 2026-09-04: no effect** — `output/battlefield_dil0.mp4` (205 s)
vs `output/battlefield_dil15.mp4` (190 s), same drift pattern/magnitudes
(t=4 top −6.9 vs −8.8; t=3 +3.6 both; log `logs/comfy_dilation.log`,
launcher `scripts/launch_dilation_bg.sh`). Blend dilation, like pad
feather / prompt / guide, does not move the drift. Phase 0 closed without
needing 2.5 for this question.
**Visual verdict (user, 2026-09-04): dil0 worst, dil15 best of all runs
so far — no color distortion.** Scanner missed it: row-mean deltas are
content-confounded, but max row-step near seam is lower for dil15 in 6/8
probes (e.g. t3 top 0.48 vs 0.62). Mechanism: `mask_low_res_dilation`
dilates in 64px-mask space, so 15 ≈ 400px blend zone at 1728 — covers
nearly the whole 379px band. The tone step becomes a slow gradient (eye
sees steps, not gradients) and band low-frequencies get pulled toward
source across the full band. Lesson: perceptual quality lives in the
transition gradient, not regional means — future scans should measure
edge sharpness, not band deltas. **dil15 is the recommended setting for
outpainting runs until 2.5 A/B says otherwise.**
**1** — `hf download` the 7 files to vol11 model dirs. **2** — subgraph
flattener + `--dry-run` green. **3** — 2.5 loader adapter. **4** — stock
smoke + battlefield 1728² seed-7 A/B + scan compare → keep/migrate
decision. Also `git pull` ComfyUI-LTXVideo first (ours @15d09ab/08-20;
take latest 2.5 node fixes).

Execution (2026-09-04, choices locked: bf16 / skip enhancer /
`--template 2.3/2.5`):
- **1 DONE**: `git pull` = already current (@15d09ab, no newer fixes).
  5 files, all rc=0 (`logs/comfy_models25_download.log`,
  `scripts/launch_models25_bg.sh`): `diffusion_models/ltx-2.5-22b-
  distilled-transformer-bf16` 42.0GB + `text_encoders/gemma4-12b-
  with-proj-ltx-2.5-bf16` 26.3GB + `vae/ltx-2.5-video-vae-bf16` 1.47GB
  + `vae/ltx-2.5-audio-vae-bf16` 0.36GB + `latent_upscale_models/
  ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0` 1.0GB = ~71GB.
  IC-LoRA reused, no download. (Auth note: session env loses
  `HF_TOKEN`; flow is user drops `.hf_token`, launcher consumes +
  deletes it, token via env only, never in logs.)
- **2 DONE**: `scripts/comfy_subgraph.py` — two-phase flattener
  (Phase A expands all 8 instances with remapped ids; Phase B wires
  inner→inner + outer links with recursive instance→instance resolution,
  Reroute synthesis, boundary widget values as literals). 23 outer + 66
  inner − 8 instances − 1 Reroute = **80 nodes**, 24 literals.
  `--template {2.3,2.5}` (default 2.3). 2.3 path untouched, still 55.
- **3 DONE**: `prune_enhancer()` (11 nodes: e2b CLIP ~10GB + 2
  TextGenerate + 2 GemmaAPI + 4 switches + 2 helpers) — template default
  Enhance=false reproduced exactly (raw prompt → main CLIP →
  conditioning → guide); nothing references missing files. 2.5 template
  quirks fixed: IC-LoRA needs `ltxv/ltx2/` prefix (bare name 400s),
  `--video-vae {diff,conv}` swap flag, 400 bodies now surface in errors.
  No distilled-LoRA handling (correctly absent in 2.5).
- **4 DONE** (`sh scripts/launch_25battlefield_bg.sh` →
  `logs/comfy_battlefield25.log`, VRAM trace `logs/vram_25.log`):
  `output/battlefield_25sanity.mp4` 1280² 248 s cold (valid h264+aac,
  137f) + `output/battlefield_25.mp4` 1728² seed 7 **230 s warm**.
  Peak VRAM **53.2GB** — parity with 2.3 (52GB), fits 80GB comfortably.
- **A/B vs 2.3 dil15 champion** (same seed/content/canvas): drift NOT
  fixed — same pattern/magnitudes (t4 top −8.0 vs −8.8, t3 +3.8/+3.5 vs
  +3.6/+2.6, all smooth seams except one 1.1x probe). As predicted: same
  IC-LoRA + same two-stage design = same wander; new decoder doesn't
  touch it. 2.5 is ~21% slower warm (230 s vs 190 s, DiffVAE cost),
  same VRAM. Remaining question is purely visual (decoder
  sharpness/detail) — **awaiting user visual verdict** → then
  keep (2.3+dil15 default, zero cost) or migrate default.
- **Phase 5 DECISION 2026-09-04: KEEP 2.3+dil15** (user sees no
  difference; metrics agree). Timing (warm, 1728²×137f): 2.3 base 210 s,
  dil0 205 s, dil15 190 s vs 2.5 230 s → 2.5 is +21% vs dil15 (+40 s,
  1.78 vs 2.15 Mpx/s; 1280² cold 248 s). `scripts/compare_25.py`
  (sharpness = Laplacian variance, flicker = inter-frame MAD, grain =
  hf-residual std; bands vs source-center control): no 2.5 win —
  band sharpness 7/8 probes lower on 2.5 (top avg 1.8 vs 2.2, bot avg
  4.0 vs 5.4), flicker/grain tied, seam drift tied (§above). Caveat:
  single clip/seed, band-level proxies, not perceptual ground truth.
  LoRA check (HF API 2026-09-04): **no 2.5-native outpainting LoRA
  exists** — 43 Lightricks repos, only 2.5 IC-LoRA is
  Pixel-Spatial-Upscaler (detailer); `LTX-2.5/loras/` holds only
  `distilled-lora-450` (dev-path, not outpainting). 2.3 IC-LoRA 0.9
  remains the only option. 2.5 stack stays on disk; `--template 2.5`
  one flag away. Revisit if Lightricks ships a 2.5 outpaint LoRA.
- **Extensive 3-clip comparison (2026-09-04)**: `sh
  scripts/launch_cmp_bg.sh` → `logs/comfy_cmp.log`: title/conf @1280²
  seeds 11/12, same prompts as batch2, 2.3-dil15 vs 2.5 —
  `title_dil15` 155 s / `title_25` 140 s / `conf_dil15` 140 s /
  `conf_25` 160 s (model-switch reloads incl.; 2.5 NOT slower here —
  the 1728 gap was DiffVAE at high res). Extended
  `scripts/compare_25.py` (7 probes, auto regions):
  conf bands **much** softer on 2.5 (lap −44%/−54%, ten −60%+, while
  source control is +8% SHARPER on 2.5 — opposite directions, so this
  is generator difference, not VAE); dE ~45 BOTH (both drift badly on
  dark conf); title essentially tied except 2.5 globally less
  saturated incl. control (−25 sat_src: VAE tone difference).
  3-clip tally: nothing favors 2.5 on any axis; detail axis favors 2.3
  (battlefield mild, conf strong, title tied). Caveat stands (different
  pixels per model), but direction is consistent.

## MiniMax-H3 outpainting (2026-09-04, implement + battlefield test)

- Stack (all vol11): `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot`
  21GB + `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq` + 2 VAEs +
  `loras/minimax_h3_ref2v_turbo_4step` + Kijai pruned-int8 Fun-ControlNet
  (`model_patches/controlnet/`, key-compatible with native loader —
  verified, no warnings). Template: official r2v (`templates/minimax_h3_r2v.json`).
- New `scripts/comfy_h3_outpaint.py`: Ref2VA + full-clip `ref_videos`
  dict (video-to-video, not frames), stock LoadImages deleted, turbo
  4-step on, canvas literals, 17k+5 snap, FunControl mask insert,
  source composite. Staging: 24fps, edge-replicate canvas (NOT black —
  black control collapses inpaint bands), static mask PNG.
- Measured behavior (battlefield seed 7, `h3what.py` center-NCC/surround):
  prompt-only = new video (NCC~0, bright surround); mask patch scales
  center-lock 0→0.9 with strength BUT bands collapse to black at any
  strength>0 (control reproduces zeroed masked-latent; late-only
  schedule ≈ no control). Mask path shelved for outpainting.
- **Working recipe: prompt-only gen + post composite** (pixel-exact
  center, H3 surround): `output/bf_h3final.mp4` 768²×107f, center NCC
  0.96–0.99 all probes, surround live; 1080 redo DONE as
  `output/bf_h3c1080.mp4` 1072²×107f (model snaps 1080→1072 grid).
- Pipeline bug class found twice: never trust container frame counts
  for loop bounds (`-shortest` + slow-pipe race truncated staging;
  cv2 nb_frames truncated composite) — read-until-exhaust + duration
  trims everywhere now. Server execution-cache also serves identical
  restagings in ~5s (deterministic staging + same seed = same tensors).
- **Battlefield A/B vs LTX (2026-09-04)**: `output/bf_h3final.mp4`
  768²×107f + `output/bf_h3c1080.mp4` 1072²×107f (model snaps 1080→1072),
  gen 45–130 s warm. Center NCC 0.96–0.99 all probes (vs LTX dil15
  center only 0.61–0.72 — LTX regenerates everything). Size-matched
  768² metrics (dil15 Lanczos-downscaled: softens LTX detail, caveat):
  H3 surround sharpness an order up (lap +16/+94, ten +831/+2312;
  control gaps smaller so bands genuinely lead); dE mixed (top H3
  better −10, bottom worse +20); seam ~1 both (H3 composite edge
  slightly more visible at bottom — feather tuning knob); flicker H3
  +2.8. Verdict: H3+composite wins center (by construction) and
  surround detail; watch bottom drift/seam. Your viewing decides.
- **Viewed frames — user caught a real defect (2026-09-04)**: metrics
  were center-blind. Seen: surround painted for a hallucinated center
  (hard edge + smudge + murky ground), because prompt-only Ref2VA
  reimagines the whole canvas (raw gen = soldier-face close-up, NCC~0
  vs source). Red-clip test proved refs DO flow (red bg kept) but the
  model renders `<Video 1>` tags as literal text and needs Context-IR
  dialect. Fix that worked: full 6-section retention prompt
  (`.cache/h3prompt_dialect2.txt`: subject_definitions/summary/
  retention_analysis/detailed_description/soundscape, `fully_preserved`,
  no-new-subjects hardening) + `--feather 40` composite.
  `output/bf_h3dialect2.mp4` (768²×107f, 45 s): viewed t=0.5/2.2/3.9 —
  sky continues with sun glow, ground continues dusty, no tents/blobs/
  text; center NCC 0.93–0.98. Remaining: mild seam tone step, small
  ember glints near seam. NOTE: source clip's first ~1 s shows YouTube
  player UI — use `--trim-start 1.0` for clean future A/B.
   Harmonize ladder also tested (denoise 0.25/0.5 turbo + 0.5 base):
   all tile the bands — SDEdit path shelved; dialect+composite is the
   recipe. Mask-patch path shelved earlier (black-band collapse).

## TwoAbove latent-masked H3 outpaint (2026-09-07, DONE — recipe frozen, see Status board)

- NOT a reimplementation: `ComfyUI-H3VideoOutpaint` node (`TwoAbove/ComfyUI-
  H3VideoOutpaint`) runs as-is — source VAE-encoded into larger canvas latent,
  `noise_mask` keeps source / generates surround, sliding temporal windows.
  Only additions: `1:1 square` in the node's aspect options (2-line patch),
  `scripts/comfy_h3tw_outpaint.py` driver (example-workflow converter, staging,
  overrides, submit/poll/download), `scripts/launch_h3tw_bg.sh`.
- Constraints found: 1280-class canvas required (1728-class exceeds the node's
  90M-px auto temporal-window budget, hard-fail); `--min-src-mp 0.5` for
  near-square; mirror-filled `%32` pad (black pad = black bars at mask
  boundary); layout-explicit prompt; FL2VA INT8 required.
- Timeline saga (all my-plumbing bugs, now fixed): staging never set fps
  explicitly (60f staged, not 120f) and composite mapped frames by index
  across 30/60fps — v2 output matched source ~1 s then drifted (content NCC
  0.94→0.46, caught by `.cache/timemap.py` per-frame content search).
  Fix: staging forces 30fps exact + asserts dims/fps/count post-encode
  (fails loud, e.g. caught trim overrunning the 4.77 s source); compositing
  maps by timestamp. v3: trim-start 1, 3.7 s → 111f@30fps, frame-cap 124
  (node 17k+5-snaps), seed 7 → `output/bf_h3tw3.mp4` 1217 s, 124f.
  Outcome: SHELVED — 2-window drift (matches source ~1 s, content NCC
  0.94→0.46), mirror-pad kaleidoscope amplification, tail content.
  Longer clips need window-drift handling first; 2 s window is the
  stable operating point.
- Outputs: `output/bf_h3tw.mp4` 1280×992 721 s (black bars, beige top —
  pre-mirror-pad) · `output/bf_h3tw2.mp4` 1280×1248 881 s (timeline-drifted
  AND mirror-poisoned input — historic interest only) · `output/bf_h3tw2c.mp4`
  (index-mapped composite, superseded) · `output/bf_h3tw3.mp4` 1280×1248
  124f 1217 s (2-window drift, shelved) · `output/bf_h3tw4.mp4` 1248×1216
  826 s (clean input, 20 steps; surround drifted sepia — prompt
  underspecified) · `output/bf_h3tw5.mp4` 596 s (14 steps; layout prompt
  collapsed sky + hallucinated soldiers — layout-prompt family DEAD) ·
  `output/bf_h3tw6.mp4` (tw2 short prompt verbatim, 14 steps, clean —
  tw2-class surround, hypothesis CONFIRMED) + `bf_h3tw6c.mp4` (60f trim) ·
  `output/bf_h3tw7.mp4` (EMPTY prompt, same quality — prompt eliminated as
  variable) + `bf_h3tw7c2.mp4` (decrush + 60f trim, no paste — final form) ·
  `output/bf_h3tw8.mp4` (mask-feather edit test, no clear gain — edit stays
  as harmless constant, revertible in `nodes.py:_spatial_generation_mask`).
  Measured GPU times: v1 721 s / v2 881 s / v3 1217 s / v4 826 s /
  v5+v6+v7 ~596 s @14 steps (0.73× of 20-step pace — linear) /
  per-frame 8–12 s. Composites are CPU ~1–2 min each.
- **Cross-clip objectivity (title/conf, 2026-09-07,
  `scripts/launch_h3tw_xclip_bg.sh`)**: same v8 config, content-only
  variable → `output/title_tw.mp4` + `output/conf_tw.mp4` (73f) →
  `output/title_tw60.mp4` + `output/conf_tw60.mp4` (60f trim + decrush).
  NO black line on either clip (seam strips continuous) — the crush is
  content-triggered (dark detailed boundaries), not universal. Conf tail
  frames 60–72 = fully invented desert portrait (pad region denoised
  with zero conditioning) → driver auto-trim added
  (`scripts/comfy_h3tw_outpaint.py`: cut to staged count post-download,
  raw kept as `*_73f.mp4`). Verdict: geometry solved on all 3 clips;
  remaining floor is surround tone (~19 luma step at battlefield bottom
  edge vs smooth top gradient) — generation-side, same beast as LTX
  drift, smaller.
- **v2 post-mortem (2026-09-07): staged input was POISONED — all tw2
  derivatives suspect.** Isolation by measurement: source frame clean
  (`.cache/frames/probe_t_scale.png`), current vf chain clean at every
  stage (scale/pad/fillborders probes, edge-mirror MAD ~42 = real), but
  `ComfyUI/input/bf_h3tw2_src.mp4` has ~128px left-right mirrored edges
  (edge-mirror MAD would be <15). Cause: v2-era pad-then-mirror staging
  (script untracked, exact line unrecoverable — no guess recorded as
  fact). Effect: node pinned mirrored pixels as source truth AND grew
  surround from fake edges (kaleidoscope bands). Retracted: tw2c2
  wide-feather (smeared the dip into gray bands — worse) and tw2c3 gain
  correction (was fitting content deltas, not an artifact; top "dip"
  2.24× was sun-glow vs cloud content). Lesson: composite tricks can't
  fix poisoned input; verify STAGED pixels by eye before any GPU run.
- **v6/v7 + recipe correction (2026-09-07)**: v6 (tw2's short prompt
  verbatim, clean staging, 14 steps) recovered tw2-class surround —
  prompt hypothesis CONFIRMED, mirrors incidental. v7 (empty prompt)
  same quality: prompt eliminated as a variable permanently. Raw
  center vs staged NCC 0.997–0.999 AND raw center is 2–3.5 levels
  darker per channel (VAE round-trip) — the surround is generated to
  THAT tone, so pasting staged pixels (tw7c) created the tone step the
  eye saw. **Center paste RETRACTED for TwoAbove** (it was a Ref2VA
  habit where the center was reimagined, NCC~0). Recipe: decrush only
  (3px vertical interpolation across both mask edges — the bottom
  black line was a 1–3px V-dip to luma 23 at the exact boundary row)
  + tail-trim 73→60f, no paste. `output/bf_h3tw7c2.mp4` = final form;
  tw7c (paste) superseded. Comparability note: all tw versions share
  seed 7 / 2s window / 1280-class; steps 14 (iter) / 20 (final).

## Pixel-spatial upscaler x2 (DONE 2026-09-04 — 2.3 x2 wins, operating point 1280²→2560²)

- Upstream ships only the 2.3 workflow
  (`2.3/LTX-2.3_ICLoRA_Pixel_Spatial_Upscaler_Distilled.json`, flat 37
  nodes, 8-step euler_cfg_pp); no 2.5 workflow exists. Both repos have
  x2 LoRAs: 2.3 `...-x2-0.9` (654MB, downloaded 2026-09-04) + 2.5
  `...-x2-1.0` (**still 403** — needs a separate access request:
  `Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler`).
- New `scripts/comfy_ltx_upscale.py`: chains after outpaint
  (`--input` outpainted mp4, `--scale` sets IC-LoRA + final canvas =
  input×scale via the ResizeImageMaskNode feeding VAEEncode,
  `--template {2.3,2.5}` with on-the-fly 2.5 adapter = UNET/CLIP/VAE
  swap, distilled-LoRA dropped, x2 IC-LoRA). Both `--dry-run` green
  (31 nodes). GemmaAPI dead nodes execute keyless (no prune needed).
- Test: `sh scripts/launch_upscale_bg.sh` → `logs/comfy_upscale.log`:
  UP1 = 2.3 x2 on `title_dil15` 1280²→2560² trim 3s; UP2 = 2.5 x2 same
  input once access granted.
- UP1 DONE 2026-09-04: `output/title_up2_23.mp4` = 2560×2560 h264+aac,
  73f/2.92 s, **416 s** (incl. 2.3-stack reload). x2 chain works.
- 2.5 x2 LoRA downloaded 2026-09-04 (327MB, access granted).
- Battlefield A/B (`sh scripts/launch_upscale_bf_bg.sh` →
  `logs/comfy_upscale_bf.log`, VRAM `logs/vram_upbf.log`): SAME input
  `battlefield_dil15` 1728² x2 → 3456² trim 3s through both upscalers
  (UP2 = 2.3, UP3 = 2.5, seed 7) → `output/bf_up2_23.mp4` vs
  `output/bf_up2_25.mp4` for user A/B.
- Both DONE 2026-09-04: 3456×3456, 89f/2.98 s, verified. UP2 (2.3)
  **1457 s**, UP3 (2.5) **1823 s** (+25%). Peak VRAM **69.9GB** —
  fits 80GB but near-ceiling (tiled decode + weight shuffling explain
  the worse-than-linear scaling vs 2560²'s 416 s). Practical x2
  operating point: 1280²→2560² (~7 min); 1728²→3456² (~25-30 min).
  Quality A/B of the pair: verdict below (2.3 x2 wins).
- **Upscale A/B numbers (2026-09-04)**: extended `compare_25.py`
  (+seam ratio, +detail-gain vs Lanczos-upscaled input; auto probes —
  note: both clips are 3 s trims, 5 probes @0.3–2.7 s). Same input, so
  this is the cleanest comparison of the project. **2.3 x2 wins**:
  detail gain 2.02x both bands (all probes >1.4) vs 2.5's 1.44/1.61x
  (~30–40% less added detail); band sharpness lower on 2.5
  (lap −0.49/−0.34); drift larger on 2.5 (dE +2.7/+2.3); bottom-band
  banding worse on 2.5 (levels 1.6 vs 3.4). Seams stay smooth both
  (<0.4 ratio — x2 does not expose the seam). Nuance: 2.5 sharpens
  PRESERVED source more (lap_src +6.5, ten_src +249) while adding less
  in generated bands — reads as more faithful / less hallucinating,
  but for an upscaler whose job is detail, 2.3 wins. 2.5 also +25%
  slower (1823 s vs 1457 s). Flicker tied.

## Extensive perceptual test battery (2026-09-09 — LPIPS/SSIM/PSNR)

Added full-reference perceptual metrics (`scripts/fidelity.py`: LPIPS-alex on
CUDA + SSIM + PSNR, tone-matched so it scores STRUCTURE not exposure) to turn
the NCC fidelity claim into perceptual ground truth. Also `scripts/compare_turbo.py`
(portrait side-band aware). Libs `scikit-image`+`lpips` installed into comfy-venv
(caches on vol11: `TORCH_HOME=$WS/.cache/torch`). All three reel phases read the
ORIGINAL source independently (verified `full_reels.py:257` — TW `--input src`,
not the LTX output), so center-vs-source is a valid apples-to-apples comparison.

**CORRECTION to the 09-07 "TwoAbove wins fidelity" claim — it is CONTENT-
DEPENDENT, not universal.** Full battery, center region vs true source, 24
probes, LPIPS↓:

| clip | orientation | LTX-2.3 | TW-stock | winner |
|---|---|---|---|---|
| reel2 | portrait | 0.302 | **0.103** | TW by ~2.9× |
| reel3 | portrait | 0.192 | **0.066** | TW by ~2.9× |
| reel1 | landscape | **0.127** | 0.267 | **LTX by ~2.1×** |
| battlefield* | landscape | **0.304** | 0.517 | LTX (*trim-confounded, drop) |

The reel2-only result I first reported was NOT representative. TW crushes LTX on
the two PORTRAIT clips (source ~2.9× closer, NCC 0.99+ rock-steady across the
whole clip) but LOSES on the LANDSCAPE clips. Ruled out as artifacts: ±3 and
±15-frame best-match alignment barely moves it (not timing/stitch-drift);
brute-forced TW crop geometry (reel1 best NCC 0.81 @ y0=352 ≈ my y0=348, so
geometry correct); reel1 has the LOWEST source motion (1.48 vs reel2 15.6) so
it is not a motion-smear effect. reel1 TW center NCC wanders 0.52–0.90 over the
23 s clip vs reel2's flat 0.99+ — the deficit is a genuine per-window content
mismatch on wide/landscape framing, likely because a landscape subject in a
1248×1216 near-square canvas leaves narrow top/bottom bands and the node's
temporal windows re-solve the tall preserved strip less stably. **Battlefield
is not usable evidence** (its TW final is a 2 s `--trim-start 1.0` window; LTX
final is the full 4.58 s from t=0 — different content, not comparable).

Turbo re-confirmed ≈ stock on reel2 (LPIPS 0.134 vs 0.103; Δ0.03, within
content noise) — the 1.64× speedup remains free where TW is the right tool.

**Temporal consistency (adjacent-frame LPIPS, whole canvas, reel2, n=40):**
LTX **0.206** vs TW-stock **0.305** / TW-turbo 0.306 — LTX is ~30% CALMER
frame-to-frame (coherent full-canvas regen; TW per-window sampling jitters the
generated bands). Holds independent of the fidelity axis.

**LTX-2.3 vs 2.5 (re-verified 2026-09-09, same seed/canvas):** 2.3 wins on
detail, no axis favors 2.5, and 2.5 is slower — matches the 09-04 decision.
- conf 1280² bands: 2.5 is **~45% less sharp** (lap_top 26.4 vs 48.1, ten_top
  2686 vs 6829) while sharpening the PRESERVED source MORE (lap_src +25) → genuine
  generator softening, not VAE. seam_top worse on 2.5 (2.85 vs 1.02). dE/flicker tied.
- battlefield 1728² bands: 2.5 slightly softer (lap −0.3/−0.5, levels −2.4/−3.4 =
  more banding), dE_top +2.6 worse; flicker tied.
- upscaler 2.3-x2 vs 2.5-x2 (3456², same input): detail-gain vs Lanczos **2.02×
  both bands (2.3)** vs **1.44/1.61× (2.5)** — 2.3 adds ~30–40% more real detail;
  2.5 banding worse (levels 1.6 vs 3.4).
- **Timing (from ledger, warm):** outpaint 1728²×137f = 2.3 **190 s** vs 2.5 **230 s
  (+21%)**; upscale 3456²×89f = 2.3-x2 **1457 s** vs 2.5-x2 **1823 s (+25%)**.
  2.5 is both slower AND softer. **KEEP 2.3 confirmed; 2.5 stays shelved.**

Open: WHY landscape TW under-performs (narrow-band geometry vs window
re-solve) — worth a controlled square-vs-landscape single-window A/B before
trusting TW for landscape finals.

## reel1 LTX A/B: 2.3 vs 2.5 × dil8 vs dil15 (2026-09-09, `run_r1_dil8.py`)

Same reel1 source/seed-7/1280²/6s-1s recipe, LTX stage only, 5 chunks each.
`r1_23_dil8full` / `r1_25_dil8full` (both 702f) vs existing `reel1_23full`
(=2.3-dil15). Warm per-6s-chunk from `logs/comfy_r1_dil8.log` (f0 excluded —
cold/model-reload 306 s both):

| variant | warm chunk | 5-chunk wall | LPIPS↓ (center) | SSIM↑ | temporal↓ | band detail |
|---|---|---|---|---|---|---|
| 2.3-dil8 | ~134 s | 856 s | **0.092** | **0.912** | 0.0238 | baseline (crispest) |
| 2.5-dil8 | ~156 s (+16%) | 946 s (+11%) | 0.096 | 0.912 | 0.0220 | lap_bot −2.45, ten_bot −30, sat −25 = softer |
| 2.3-dil15 | ~131 s | — | 0.127 | 0.899 | 0.0231 | ≈dil8 (bands tied) |

Findings:
- **2.3 vs 2.5 (at dil8): 2.3 wins again.** Fidelity tied (LPIPS 0.092 vs
  0.096, SSIM identical, temporal tied), but 2.5 bands measurably softer
  (lap_bot −2.45, ten_bot/top −30/−9, saturation −14/−26) AND 2.5 is **~16%
  slower per warm chunk / +11% wall**. No axis favors 2.5. Fifth independent
  confirmation of KEEP-2.3.
- **dil8 vs dil15 (at 2.3): dil8 measurably MORE faithful here** — LPIPS
  **0.092 vs 0.127** (−28%), SSIM 0.912 vs 0.899, seam_top actually lower
  (0.27 vs 0.46). Band detail/flicker tied. This is landscape reel1
  (narrow ~373px bands); the 09-04 dil15 verdict was on battlefield 1728²
  where the band was ~379px of a bigger canvas and dil15's ~400px blend
  covered the whole band. At 1280² landscape, dil15's wider blend zone
  slightly over-softens the center transition (lower fidelity) with no
  detail payoff. **Lesson: optimal blend-dilation is canvas/band-size
  dependent — dil8 for 1280²-class narrow-band landscape, dil15 stays the
  default for larger canvases / portrait. Not a global winner either way.**
  Caveat: single clip/seed, center-LPIPS is dominated by the preserved
  region so the dil delta partly reflects how much blend bleeds INTO the
  center — which is exactly the perceptual seam the eye reads.

## Final results & path recommendation (2026-09-07, perceptual update 2026-09-09)

Three paths, three frozen finals — same seed-7 / 2 s-window discipline
where comparable. Pick by constraint, not by loyalty:

| Path | Final artifact(s) | Center fidelity (LPIPS↓ vs source) | Seam state | Cost (this H100) |
|---|---|---|---|---|
| LTX-2.3 (dil canvas-tuned) | `battlefield_dil15.mp4` 1728² · `title_dil15`/`conf_dil15` 1280² · `reel1_23full` · x2 finals `bf_up2_23` 3456² / `title_up2_23` 2560² | Regenerates everything; **but WINS on landscape** (reel1 0.13 vs TW 0.27). ~30% calmer temporally everywhere. Broad tone drift inherent, unfixable by any knob | Smooth (ratios <1); dil gradient hides the step | ~2 Mpx/s: 1280² ~6 min / 1728² ~11 min per 15 s |
| H3-Ref2VA dialect+composite | `bf_h3dialect2.mp4` 768² | Composite-locked (NCC 0.93–0.98) | Mild tone step + ember glints near seam | 45 s/gen; needs prompt craft (hallucinates freely) |
| TwoAbove (empty prompt, 8-step+FL2VA-turbo, decrush, trim, no paste) | `reel2_turbofull` 1216×1248 · `bf_h3tw7c2.mp4` · `title_tw60`/`conf_tw60` | Pinned by construction; **WINS on portrait** (reel2 0.10 / reel3 0.07 vs LTX 0.30/0.19). Cross-window drift on landscape (NCC wanders 0.52–0.90) | No defect line on any clip; ~19-luma tone step at dark detailed edges only | ~6 min @8-step turbo (default) / ~10 min @14 / ~14 min @20 per 2 s window (5–15× LTX) |

- **Pick by content orientation, not loyalty** — the perceptual battery
  (§Extensive perceptual test battery) shows the fidelity winner FLIPS:
  **TwoAbove-turbo for portrait/near-square finals** (~2.9× closer to source),
  **LTX-2.3 for landscape finals** (~2.1× closer AND 5–15× faster — TW has no
  advantage to justify its cost on wide framing).
- Use **LTX** also whenever speed/throughput or motion-calm matters, or a
  full-canvas restyle is acceptable; drift is the price. Tune blend-dilation to
  canvas (dil15 ≥1728²/portrait, dil8 at 1280² narrow-band landscape).
- Use **Ref2VA dialect** as the fast H3 fallback (sub-minute iterations,
  small canvas, prompt babysitting required).
- **Turbo (8-step + FL2VA LoRA) is the TwoAbove default now** — proven a free
  1.64× on reel2 (quality indistinguishable from 14/20-step stock).
- Open: WHY landscape TW drifts (cross-window anchor decay — the reference is
  lost temporally, not spatially; fixable via overlap width or a persistent
  keyframe, tabled by user); dil8-vs-dil15 on a portrait reel to confirm the
  canvas-dependence; 15 s production path (chunked LTX vs windowed TwoAbove —
  VRAM untested for 450f single pass).

## Timing ledger (all measured on this 1×H100 80GB, queue → file on disk)

Model stacks: **LTX-2.3** = 22B distilled base (46GB) + distilled LoRA (7.6GB)
+ IC-LoRA in/outpaint 0.9 (1.3GB) + Gemma-3 12B IT (24GB) · **LTX-2.5** =
2.5-22B distilled transformer bf16 (42GB) + Gemma4-12B-proj (26GB) + 2.5
video/audio VAEs + 2.5 latent x2 upscaler (1GB), IC-LoRA 0.9 reused ·
**Upscalers** = 2.3 x2 LoRA (654MB) / 2.5 x2 LoRA (327MB) · **H3-Ref2VA** =
Ref2VA INT8 (21GB) + Qwen3VL-32B NVFP4 + 2 VAEs + turbo 4-step LoRA ·
**TwoAbove** = H3VideoOutpaint node (FL2VA INT8 + Qwen/CLIP/VAE stack,
`1:1 square` patch + mask-feather edit), 1280-class canvas unless noted.
GPU behavior: 98–100% util + ~48–53GB while sampling on every pipeline;
transient dips between windows are phase transitions, not headroom.
Cold model load: LTX +~110 s, H3/TwoAbove +~60–120 s (node unloads per run).

| Pipeline / run | Output (frames × canvas) | Measured |
|---|---|---|
| LTX-2.3 smoke (cold) | 97f × 1920×1088 | 196 s |
| LTX-2.3 e2e (warm) | 97f × 1280² | 85 s |
| LTX-2.3 battlefield | 137f × 1728² | 210 s |
| LTX-2.3 title / conf | 121f / 145f × 1280² | 101 s / 120 s |
| LTX-2.3 feather32 / decolor / guide0.5 | 137f × 1728² | 195 s / 215 s / 200 s |
| LTX-2.3 combo (cold reload incl.) | 137f × 1728² | 356 s |
| LTX-2.3 dil0 / dil15 | 137f × 1728² | 205 s / 190 s |
| LTX-2.3 vs 2.5 title (reloads incl.) | 121f × 1280² | 155 s / 140 s |
| LTX-2.3 vs 2.5 conf (reloads incl.) | 145f × 1280² | 140 s / 160 s |
| LTX-2.5 sanity (cold) | 137f × 1280² | 248 s |
| LTX-2.5 battlefield (warm) | 137f × 1728² | 230 s (+21% vs dil15) |
| 2.3 x2 title (reload incl.) | 73f × 2560² | 416 s |
| 2.3 x2 / 2.5 x2 battlefield | 89f × 3456² | 1457 s / 1823 s (+25%) |
| H3-Ref2VA (turbo 4-step, warm) | 107f × 768²–1072² | 45–130 s (dialect2: 45 s) |
| TwoAbove v1 (20 steps) | 73f × 1280×992 | 721 s |
| TwoAbove v2 (20 steps) | 73f × 1280×1248 | 881 s |
| TwoAbove v3 (20 steps, 2 windows) | 124f × 1280×1248 | 1217 s |
| TwoAbove v4 (20 steps) | 73f × 1248×1216 | 826 s |
| TwoAbove v5/v6/v7/v8 (14 steps) | 73f × 1248×1216 | 596 / 596 / 591 / 591 s |
| TwoAbove title_tw / conf_tw (14 steps) | 73f × 1248×1216 | 591 s / 591 s |
| Reels LTX-full (chunked 6s/1s, warm chunks) | 342f / 702f / 1046f × 1280² | ~10 / ~12 / ~16 min (131–136 s/chunk + reload) |
| Reels UP-full (chunked 3s/0.5s, 2.3 x2) | 336f / 696f / 1040f × 2560² | ~52 / ~88 / ~123 min (536–547 s/chunk) |
| Reels TW-full (chunked 3s/1s, 14 steps) | 343f / 709f / 1053f | ~59 / ~106 / ~158 min (522–557 s/chunk) |
| Reel2 TW-turbo (chunked 3s/1s, 8 steps + LoRA) | 1057f × 1216×1248 | 5791 s total (417 cold + 17×307–317 + stitch) = 1.64× stock |
| reel1 LTX 2.3-dil8 (warm 6s chunk) | ~180f × 1280² | ~134 s/chunk (856 s/5-chunk wall) |
| reel1 LTX 2.5-dil8 (warm 6s chunk) | ~180f × 1280² | ~156 s/chunk (+16%; 946 s wall, +11%) |
| CPU finishes (composites, trims) | ≤124f × ≤1280×1248 | ~1–2 min each (not precisely logged) |

### Per-input-second cost by pipeline version (the headline "how long per 1 s of source")

Two views. **Steady (warm chunk)** = GPU-seconds per source-second inside a
warm chunk, model already resident — the marginal cost, best for projecting a
long clip. **End-to-end** = total wall (cold load + all chunks + overlap waste
+ stitch) ÷ true source duration, from the measured full-length reels — what
you actually wait. All 1×H100 80GB, seed 7.

| Pipeline version | Canvas | Steady s/input-s (warm) | End-to-end s/input-s | Source |
|---|---|---|---|---|
| **LTX-2.3** outpaint | 1280² | **~22** (131–136 s / 6 s) | ~27–30 (reel1/2) | reels + dil8 |
| LTX-2.3 outpaint | 1728² | ~46 (210 s / 4.58 s) | — | battlefield single-clip |
| LTX-2.5 outpaint | 1280² | ~26 (156 s / 6 s, +16%) | — | reel1 dil8 |
| LTX-2.5 outpaint | 1728² | ~50 (230 s / 4.58 s, +21%) | — | battlefield |
| **2.3 x2** upscale | 2560² | **~180** (536–547 s / 3 s) | ~210–271 (reels) | reels UP |
| 2.3 x2 upscale | 3456² | ~489 (1457 s / 2.98 s) | — | battlefield |
| 2.5 x2 upscale | 3456² | ~612 (1823 s / 2.98 s, +25%) | — | battlefield |
| **TwoAbove stock** (14-step) | 1216×1248 | **~180** (522–557 s / 3 s) | ~269 (reel2) | reels TW |
| **TwoAbove turbo** (8-step+LoRA) | 1216×1248 | **~104** (307–317 s / 3 s) | **~164** (reel2, 1.64× faster) | reel2 turbo |
| H3-Ref2VA (turbo 4-step, +composite) | 768² | ~10 (45 s / 4.46 s) | — | dialect2 single-clip |

Reading it: at 1280² the **full LTX→x2→TW-turbo chain ≈ 22 + 180 + 104 ≈ 306
steady s per source-second** (~5 min per 1 s finished); swapping TW-turbo→stock
adds ~76 s/s. The x2 upscale and TwoAbove dominate — LTX outpaint is <10% of the
chain. End-to-end runs higher than steady on short clips (cold load + overlap
amortize poorly): reel3 @11.5 s paid ~52/271/307 s/s LTX/UP/TW vs reel2 @35 s
paying ~27/210/269 (longer clip = closer to steady).

**Does time scale by canvas size? Depends on the stage:**
- **LTX outpaint (and TwoAbove) = linear in TOTAL output pixels** (frames × W × H),
  NOT canvas alone. Throughput is flat at ~1.9 out-Mpx/s across 1280² and 1728²
  (title/conf/e2e 1.87–1.98, battlefield 1.95). Scale by `frames × W × H`; per-
  input-second then rises with area only because bigger canvas = more pixels/frame
  (1728²/1280² area 1.82× → ~46/22 ≈ 2.1× per-input-s, the extra bit is battlefield's
  higher frame count, not super-linear pixel cost).
- **x2 upscaler = SUPER-linear in area** — throughput DROPS as canvas grows:
  2.3-x2 is 1.15 out-Mpx/s @2560² but only **0.73 @3456²** (2.5-x2: 0.58). Cause:
  at 3456² VRAM peaks 69.9 GB → tiled VAE decode + weight shuffling add overhead
  that grows with size. Do NOT extrapolate the upscaler by pure area; use the
  measured point closest to your target resolution.

Rules derived from the above (marked as derived, not measured):
LTX-2.3 throughput ≈ 2.0 output-Mpx/s (`t ≈ frames×W×H/2e6 + 10 s` warm);
per finished video-second ≈ 25 s/s @1280², 45 s/s @1728²; 2.5 ≈ 55 s/s
@1728²; TwoAbove ≈ 375 s/s (~6 min per 1 s, 8–15× LTX). 15 s@30fps
projection: LTX-2.3 ~6 min @1280² / ~11 min @1728² (VRAM for 450f single
pass UNTESTED — 52GB peak was 137f); +2.3 x2 → ~40 min @2560²;
TwoAbove ~1.5–2 h (4 windows + overlap waste). Step scaling is linear
(14/20 steps = 0.73× wall: 591/826 s).

## Instagram reels full-length compare (DONE 2026-09-08 — finals in `output/reels/`)

Sources (user-supplied): `input/reels/Video-57715.mp4` (reel1, neon street,
1280×534, 23.752 s) · `input/reels/Video-87640.mp4` (reel2, city aerial,
720×1280 portrait, 35.224 s) · `input/reels/Video-96468.mp4` (reel3, night,
1280×534, 11.515 s). Orchestrator `scripts/full_reels.py`
(`scripts/launch_reels_full_bg.sh` → `logs/comfy_reels_full.log`), sequential
on 1×H100, shortest first. Recipe per reel: LTX-2.3 outpaint 1280² in 6 s
chunks / 1 s overlap → stitch → 2.3 x2 upscale 2560² in 3 s chunks / 0.5 s
overlap → stitch → TwoAbove (empty prompt, 14 steps, seed 7) in 3 s chunks /
1 s overlap (90f = 17×5+5 exact, zero pad) → stitch + decrush. Stitch is
time-based compositing (each output frame maps to source time; overlap zones
crossfade across the whole zone — exact union, no double-count). Decrush is
orientation-aware (landscape 1248×704 → horizontal edges; portrait 704×1248
→ vertical edges). Every phase logs stitched-vs-expected frames with OK/
MISMATCH flag (tolerance ±8 LTX/TW, ±12 UP).

| Reel | `*_23full` (1280²) | `*_upfull` (2560²) | `*_twfull` | Phases wall (gen+stitch) | Total |
|---|---|---|---|---|---|
| reel3 11.515 s | 342f OK | 336f (tail snap −9) | 343f, 1216×1248 portrait OK | LTX ~10 min (326+131+131) · UP ~52 min (987+546+547+546+481, first incl. reload) · TW ~59 min (~600+552+817+527+527+528, 817 spanned a relaunch) | ~2.0 h |
| reel1 23.752 s | 702f (−11 tail) | 696f (−17) | 709f, 1248×1216 OK | LTX ~12 min (201+136×4) · UP ~88 min (9×~541 + 411 tail) · TW ~106 min (12×522–557) | ~3.4 h |
| reel2 35.224 s | 1046f (−11) | 1040f (−17) | 1053f, 1216×1248 portrait OK | LTX ~16 min (171+131×5+136) · UP ~123 min (13×~540 + 417 tail) · TW ~158 min (18×522–543) | ~5.0 h |

Steady per-source-second: LTX ~22–27 s (warm chunks 131–136 s/6 s; first
chunk 171–326 s with model reload) · UP ~180 s (536–547 s/3 s; tails snap
to LTX-native 16k+1 e.g. 81f/73f) · TW ~175–180 s (522–557 s/90f @14 steps).
Productive total ≈ 10.4 h over session 03:09–14:52 UTC (restarts/repairs
excluded). No phase failures after the short-tail patch; single worker, no
contention. Intermediates (`*_23f*`, `*_upf*`, `*_twf*`, `.cache/*_n30.mp4`)
stay in `output/`/`.cache/`; only `*full` finals moved to `output/reels/`.

Bugs found + fixed during this run (all in-repo, all protect future runs):
1. Fixed-overlap stitch blended 30f/joint while tail chunks overlap by
   ~5.5 s → 11.5 s reel came out 15.7/17.8 s with repeated footage, and the
   wrong length cascaded into next-phase chunking. Rewrote stitch as
   time-based composite; chunking now always uses true source duration.
2. Upscaler snaps tail lengths DOWN to 16k+1 (81f/73f for 90f requests) →
   strict checker aborted whole phases. Short-tail accept rule (last chunk
   ≥60% nominal; stitch absorbs it). Same for LTX tails (169f/180f).
3. Mirror-probe false positives on flat content (reel1 neon 12.4, reel2
   night 7.1 — verified genuine by viewing frames). Probe is warn-only now;
   scale-only staging cannot mirror by construction.
4. Input `-ss` snaps forward to keyframes at EOF (reel2 tail staged 86f/90f).
   Stage tolerance asymmetric (over-count fails, shortfall to −8 accepted)
   + end-anchored corrected stitch bounds.
5. Orientation: hardcoded 1248×704 staging squished portrait reels —
   orientation-aware staging everywhere (this run's portrait TW outputs prove it).

**H3-turbo A/B on reel2 (DONE 2026-09-09 — `output/reels/reel2_turbofull.mp4`)**:
`scripts/run_reel2_turbo.py` (`scripts/launch_turbo_bg.sh` →
`logs/comfy_reel2_turbo.log`), same 18-chunk geometry as stock reel2 TW
(3 s/1 s, seed 7) but `--steps 8` + `res_multistep` + FL2VA 8-step LoRA
(`LoraLoaderModelOnly` spliced after the chunk-feedforward node, strength
1.0). Run 03:50:48–05:27:19 UTC = **5791 s (~96.5 min)** end-to-end:
chunk 0 417 s (cold load) + chunks 1–16 steady 307–317 s + tail chunk 17
307 s (= 5715 s gen) + ~76 s stitch/validate. VALIDATE
`(1057, 1216, 1248) OK`; final 1216×1248, 1057f, 35.23 s, 46.1 MB.
vs stock reel2 TW ~158 min → **1.64× end-to-end** (~1.7× per-chunk:
~311 s vs ~530 s avg). Zero chunk failures — bf16 LoRA × pruned-int8
base is compatible. RunAI offload abandoned (no CLI on host, in-pod SA
RBAC-denied); local sequential was the right call.
- **Stock-vs-turbo compare CLOSED 2026-09-09** (`scripts/compare_turbo.py`,
  portrait side-band aware: center-NCC vs source, L/R band Laplacian,
  vertical seam ratio, band dE, whole-canvas flicker; 6 probes 10–85%,
  each aligned to the same source timestamp in both clips). Result —
  **turbo is a free 1.64× with no measurable quality cost**: center
  fidelity identical (cNCC 0.993 both), band detail slightly HIGHER on
  turbo (lap_L +0.77, lap_R +1.79 — res_multistep is marginally crisper),
  seams stay smooth both (ratios <0.52, turbo +0.02–0.12 = still far below
  the >1 visible-step threshold), tone drift tied (dE_R −0.04, dE_L +0.64
  both small), flicker tied (+0.21 on ~15 baseline). Visual confirm:
  side-by-side stills at t=8/20/30 s (`.cache/cmp_turbo/sbs_*.png`)
  indistinguishable on both the exposed-balcony and glass-tower scenes,
  seam and center clean on both. **Verdict: adopt 8-step + FL2VA LoRA as
  the default TwoAbove config; the 20/14-step stock path is now the
  fallback, not the baseline.**

## Log

- 2026-09-03: walkthrough created; prior work recovered (no plan file existed); awaiting HF token + download step.
- 2026-09-03 ~07:42 UTC: session resumed after idle-stop. Server was down + `/tmp/opencode` launcher wiped → recreated launcher as `scripts/launch_comfy_bg.sh` (workspace-persistent, setsid+nohup, vol11 caches) and restarted :8188 (v0.34.0 OK).
- 2026-09-03 ~07:44 UTC: `--dry-run` exposed converter bug — `SaveVideo`'s top-level `codec` is a hidden (`hidden:true`) legacy dynamic combo with no widget slot; converter consumed it positionally and died. Fixed by skipping hidden inputs unless linked (`is_hidden()` in `scripts/comfy_ltx_outpaint.py`). Dry-run green: 55 nodes converted.
- 2026-09-03 ~07:44 UTC: stock smoke queued in background (`scripts/launch_smoke_bg.sh` → `logs/comfy_smoke.log`, `output/smoke_stock.mp4`). First attempt failed in ~10 s: `ComfyUI/input/outpainting_input.mp4` was a 132-byte **git-lfs pointer** (shallow clone, no git-lfs on host; `example.png` is real). Fetched real bytes (2,738,806 B, 1080×1920 h264, 104 frames, 4.17 s) from `media.githubusercontent.com/.../master/...` (branch is `master`, not `main`). Hardened `--stock` staging to detect LFS pointers / ffprobe-invalid files and re-fetch. Requeued.
- 2026-09-03 ~07:50 UTC: **Step 3 DONE** — stock smoke `--stock --prefix smoke_stock` finished in 196 s cold (model load incl.); `output/smoke_stock.mp4` = 1920×1088 h264+aac, 3.88 s, 97 frames, ffprobe-verified.
- 2026-09-03 ~07:54 UTC: **Step 5 DONE (stand-in clip)** — E2E via `scripts/launch_e2e_bg.sh` finished in 85 s warm; `output/e2e_square.mp4` = 1280×1280 verified. Fixed `resolve_outputs()` to only take `SaveVideo` outputs (was picking up `LoadVideo` passthrough → FileNotFoundError). All background work uses `setsid`+`nohup` with `-u` (unbuffered) logging: server → `logs/comfyui_server.log`, smoke → `logs/comfy_smoke.log`, e2e → `logs/comfy_e2e.log`. Launchers live in `scripts/` (workspace-persistent, `/tmp` gets wiped on idle-stop).
- 2026-09-03 ~08:00 UTC: doc pass — Step 4 marked DONE, added **Usage**
  section (server boot, dry-run, stock smoke, real-clip command, sizing +
  prompt rules, flag groups, output locations, troubleshooting), fixed stale
  `/tmp/opencode` launcher path. Next: user-supplied 2 s 1080p landscape
  clip → outpaint to 1920×1920 (see Runs when it lands).
- 2026-09-03: user clips (battlefield/title/conf) + full band-drift A/B
  (feather32 / decolored prompt / guide 0.5 / mean-shift postpass v1+v2 /
  combo) — no generation-side knob moves drift; scanner lesson (edge
  sharpness > band means); `scripts/scan_video.py`, `profile_seam.py`,
  `color_match_bands.py` landed.
- 2026-09-04: Phase-0 dilation (dil0 vs dil15, user verdict dil15 best) →
  `--blend-dilation` default 15. LTX-2.5 phases 1–5 (downloads ~71GB,
  `comfy_subgraph.py` 80-node flattener, enhancer prune, `--template`,
  battlefield A/B + 3-clip extend, `compare_25.py` 7-probe metrics) →
  **KEEP 2.3+dil15**. x2 upscaler (`comfy_ltx_upscale.py`, both LoRAs,
  battlefield 3456² A/B) → **2.3 x2 wins**.
- 2026-09-04: MiniMax-H3 (stack downloads, `comfy_h3_outpaint.py`,
  mask-collapse finding, prompt-only+composite recipe, `bf_h3final` /
  `bf_h3c1080`, dialect2 prompt + feather-40 composite viewed OK,
  harmonize ladder shelved, frame-count bug class documented).
- 2026-09-07: TwoAbove (`ComfyUI-H3VideoOutpaint` clone + `1:1 square`
  patch + FL2VA INT8 + `comfy_h3tw_outpaint.py`): v1 90M-px budget fail →
  1280-class; widget-ref positional-shift fix; v2 timeline-drift diagnosed
  via content-map (staging fps + index-mapping bugs) → explicit-30fps
  staging with asserts + timestamp compositing; v3 (111f/124f, 1217 s)
  shelved on 2-window drift; v2 post-mortem (mirror-poisoned input,
  isolated probe-clean-chain vs mirrored file); v4 clean 1248×704 staging
  + mirror-probe assert (826 s, sepia drift); v5 layout prompt dead end
  (596 s @14 steps, flat sky + hallucinated subjects); v6 tw2 short
  prompt recovered tw2-class (prompt hypothesis CONFIRMED); v7 empty
  prompt same quality (prompt eliminated); paste RETRACTED (NCC 0.997+,
  VAE −2/−3.5 tone); bottom V-crush (luma 23) → decrush + latent mask
  feather (v8, no clear gain); conf desert-portrait tail → driver
  auto-trim; cross-clip title/conf show NO black line (content-triggered
   crush); final recipe frozen (Status board).
- 2026-09-08: reels full-length compare DONE (`scripts/full_reels.py`,
  03:09–14:52 UTC, ALLDONE, ~10.4 h productive): reel3 ~2.0 h, reel1 ~3.4 h,
  reel2 ~5.0 h; 9 finals in `output/reels/`. Five bugs fixed en route
  (time-based stitch rewrite, short-tail accept, mirror-probe warn-only,
  asymmetric stage tolerance, orientation-aware staging) — see §Reels.
   Turbo A/B queued next: `scripts/run_reel2_turbo.py` (FL2VA 8-step LoRA,
   dry-run green incl. EOF short-stage handling) runs reel2 TW-turbo locally
   after ALLDONE → `output/reel2_turbofull.mp4` for stock-vs-turbo compare.
- 2026-09-09: reel2 turbo DONE (03:50:48–05:27:19 UTC, 5791 s, VALIDATE
  1057f OK): `output/reels/reel2_turbofull.mp4` (1216×1248, 35.23 s,
  46.1 MB). 1.64× stock TW end-to-end (per-chunk ~311 s vs ~530 s), zero
  failures. Server had died overnight → restarted :8188 before launch.
  Remaining: stock-vs-turbo visual compare.
- 2026-09-09: extensive-comparison phase (this session). Added
  `scripts/compare_turbo.py` + `scripts/fidelity.py` (LPIPS-alex/SSIM/PSNR
  on CUDA, `scikit-image`+`lpips` into comfy-venv, `TORCH_HOME=$WS/.cache/torch`).
  (a) Stock-vs-turbo CLOSED — indistinguishable, 8-step+LoRA now TW default.
  (b) Full-reference battery over 4 clips → **TW fidelity win is
  CONTENT-DEPENDENT** (TW wins portrait ~2.9×, LTX wins landscape ~2.1×);
  corrected the earlier reel2-only over-claim; ruled out timing/geometry/motion
  artifacts (±15f align, geometry brute-force, verified `full_reels.py:257`
  feeds TW the true source). LTX ~30% calmer temporally.
  (c) TwoAbove node review (`nodes.py`): masked-latent + 5-frame-overlap
  windows, generic `("MODEL",)` input, no reference-image slot — Ref2VA swap
  would change the prior (hallucination-prone) not the conditioning; drift is
  cross-window anchor decay. Tabled by user.
  (d) reel1 LTX A/B (`run_r1_dil8.py`): 2.3 beats 2.5 (5th confirm; 2.5 softer
  bands + 16% slower); dil8 more faithful than dil15 at 1280² landscape
  (LPIPS 0.092 vs 0.127) → blend-dilation is canvas-size dependent.
  Header/Status-board/Final-table/ledger all updated to match.
