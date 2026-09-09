# How to run ComfyUI video outpainting locally

A practical run-book for the square-video outpainting pipeline on this machine
(1× H100 80GB). This is the **how-to**; for the experiment history, A/B
verdicts, and metric tables see [comfyui-ltx-outpaint.md](comfyui-ltx-outpaint.md).

The pipeline turns a landscape/portrait clip into a square (or larger-canvas)
video by generating the missing top/bottom (or left/right) regions. Four
engines are wired, each a standalone script under `scripts/`:

| Engine | Script | Best for |
|---|---|---|
| **LTX-2.3 outpaint** (default) | `comfy_ltx_outpaint.py` | fast throughput, landscape clips, drafts |
| **LTX-2.5 outpaint** | `comfy_ltx_outpaint.py --template 2.5` | A/B only (softer + slower; not recommended) |
| **x2 upscale** | `comfy_ltx_upscale.py` | 2× detail pass after any outpaint |
| **H3 Ref2VA** | `comfy_h3_outpaint.py` | sub-minute small-canvas preview |
| **TwoAbove (H3)** | `comfy_h3tw_outpaint.py` | highest fidelity finals, portrait clips |
| **TwoAbove turbo** | `run_reel2_turbo.py` | same as TwoAbove, 1.64× faster (default TW config) |

> Quick decision: **portrait/near-square final → TwoAbove(-turbo); landscape
> final or speed → LTX-2.3.** Full reasoning in the companion doc.

---

## 0. Prerequisites (one-time, already done on this box)

- `comfy-venv/` — Python 3.10 venv, torch 2.7.1+cu126. All commands below use
  `comfy-venv/bin/python`.
- `ComfyUI/` — cloned with custom nodes: LTXVideo, KJNodes, VideoHelperSuite,
  Manager, **H3VideoOutpaint** (`custom_nodes/ComfyUI-H3VideoOutpaint`).
- Model weights on vol11-scratch under `ComfyUI/models/` (never on `$HOME`):
  - LTX-2.3: `checkpoints/ltx-2.3-22b-dev.safetensors` + `loras/ltxv/ltx2/`
    (`…distilled-lora-384`, `…ic-lora-in-outpainting-0.9`,
    `…pixel-spatial-upscaler-x2-0.9`) + `text_encoders/comfy_gemma_3_12B_it`.
  - LTX-2.5 (optional): `diffusion_models/ltx-2.5-22b-distilled-transformer-bf16`
    + gemma4 encoder + 2.5 VAEs + `…upscaler-x2-1.0`.
  - H3: `diffusion_models/minimax_h3_{fl2va,ref2va}_pruned_int8_convrot` +
    `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq` + 2 VAEs + turbo LoRAs.

If weights are missing, see §"Model downloads" in the companion doc — auth flow
is: drop a `.hf_token` file in the repo root; the launcher consumes and deletes it.

All caches (`HF_HOME`, `TORCH_HOME`, pip, triton) are redirected to
`$WS/.cache` — the launcher scripts export these for you. Don't run the raw
`python` binary directly for GPU work; go through the launchers or export the
same env, or downloads/caches land in your quota-limited `$HOME`.

---

## 1. Start the ComfyUI server (once per session)

The server is a long-running daemon on port 8188. It must be up before any
outpaint run. It gets killed when the workspace idle-stops, so restart it at
the start of each session.

```sh
sh scripts/launch_comfy_bg.sh          # detached (setsid+nohup), logs to logs/comfyui_server.log
```

Verify it's up (expect `0.34.0`):

```sh
comfy-venv/bin/python -c "import urllib.request,json; \
print(json.load(urllib.request.urlopen('http://127.0.0.1:8188/system_stats',timeout=10))['system']['comfyui_version'])"
```

If it fails: check `logs/comfyui_server.log`, then re-run the launcher (it
auto-kills a stale process on :8188 first).

---

## 2. Validate without touching the GPU (`--dry-run`)

Every driver converts a ComfyUI UI-graph JSON into an API prompt. `--dry-run`
runs the conversion only — no generation — so you can confirm the graph is
valid before spending GPU time:

```sh
comfy-venv/bin/python scripts/comfy_ltx_outpaint.py --dry-run              # expect "... dry-run OK"
comfy-venv/bin/python scripts/comfy_ltx_outpaint.py --template 2.5 --dry-run
comfy-venv/bin/python scripts/comfy_ltx_upscale.py --dry-run
```

---

## 3. LTX outpaint — the default engine

### Smoke test (bundled sample, proves the whole path)

```sh
comfy-venv/bin/python -u scripts/comfy_ltx_outpaint.py --stock \
  --prefix smoke_stock --output output/smoke_stock.mp4 --timeout 5400
# ~196 s cold / ~85 s warm → output/smoke_stock.mp4 (1920×1088)
```

### Real clip (trim → outpaint to square)

```sh
comfy-venv/bin/python -u scripts/comfy_ltx_outpaint.py \
  --input /path/to/clip.mp4 --trim-start 0 --trim-duration 5 \
  --target-width 1920 --target-height 1920 \
  --prompt "describe ONLY the new top/bottom regions" --seed 7 \
  --prefix myclip --output output/myclip.mp4 --timeout 5400
```

**Sizing rule:** the pad node *expands* the canvas to the target. From a
1920×1080 landscape source, `--target-width 1920 --target-height 1920` keeps the
full frame and outpaints top/bottom (true 1:1). Asking for a *smaller* width
than the source crops the sides instead of outpainting. Keep targets multiples
of 64.

**Prompt rule:** describe only the new region; an empty/minimal prompt also
works. No mask dilation needed.

**Key flags** (`--help` lists all):
- staging: `--stock --input --trim-start --trim-duration`
- canvas: `--target-width --target-height --feathering`
- text: `--prompt --negative`
- sampling: `--seed --cfg --sampler --sigmas-s1 --sigmas-s2`
- LoRA/guide: `--distilled-strength --iclora-strength --guide-strength --attention-strength`
- **blend:** `--blend-dilation` (default 15). Use **15** for ≥1728² / portrait,
  **8** for 1280²-class narrow-band landscape (measurably more faithful there).
- template: `--template {2.3,2.5}` (2.3 default; 2.5 needs `--video-vae {diff,conv}`)
- misc: `--fps --prefix --output --timeout`

Output lands in `ComfyUI/output/<prefix>_*.mp4` and is copied to `--output`.
Cost ≈ 2 Mpx/s → ~22 s per source-second at 1280², ~46 s at 1728².

---

## 4. x2 upscale (optional detail pass)

Chains after any outpaint. Doubles the canvas (2560² from 1280², etc.). **2.3
upscaler wins** (2.02× vs 1.44× detail gain) — keep `--template 2.3`.

```sh
comfy-venv/bin/python -u scripts/comfy_ltx_upscale.py --template 2.3 \
  --input output/myclip.mp4 --scale 2 \
  --prompt "cinematic background, soft glow, film grain" --seed 7 \
  --prefix myclip_up2 --output output/myclip_up2.mp4 --timeout 7200
```

Cost is super-linear: ~180 s/source-s at 2560², ~490 s at 3456² (VRAM ~70 GB,
tiled decode). Practical operating point: **1280²→2560² (~7 min per 3 s chunk)**.

---

## 5. TwoAbove (H3) — highest-fidelity engine

Preserves the source pixels exactly (masked-latent inpaint) and generates the
surround. **Best for portrait finals.** Use empty prompt, seed 7, and either
the 14-step stock config or — preferred — the **turbo** config.

Constraints (baked into the driver): 1280-class canvas (1728² exceeds the
node's 90M-px window budget); `--min-src-mp 0.5`; stable inside ~2 s windows.

### Stock (14-step)

```sh
comfy-venv/bin/python -u scripts/comfy_h3tw_outpaint.py \
  --input /path/to/clip.mp4 --trim-start 1 --trim-duration 2 \
  --aspect '1:1 square' --min-src-mp 0.5 --seed 7 --steps 14 --frame-cap 120 \
  --prefix myclip_tw --output output/myclip_tw.mp4 --timeout 7200
```

The driver auto-trims the invented pad-tail (raw kept as `*_73f.mp4`) and does a
CPU decrush finish. **Do not paste the staged center back** — the VAE round-trip
shifts tone and pasting manufactures a visible step.

Cost ≈ 175–180 s per source-second (8–15× LTX). See §"Timing ledger" in the
companion doc.

---

## 6. TwoAbove turbo — the recommended TW config (1.64× faster)

Same output quality as stock TW (verified indistinguishable), 8 steps +
`res_multistep` + FL2VA 8-step turbo LoRA. `run_reel2_turbo.py` is the chunked
full-length runner (staging, LoRA splice, stitch, decrush baked in):

```sh
comfy-venv/bin/python -u scripts/run_reel2_turbo.py \
  --steps 8 --sampler res_multistep --lora-strength 1.0 --seed 7 \
  --frame-cap 120 --timeout 3600
# reel2-hardcoded input; edit SRC/TAG in the script for other clips.
# → output/reels/reel2_turbofull.mp4 (~104 s per source-second)
```

For a single short clip you can instead run `comfy_h3tw_outpaint.py --steps 8`
(the turbo LoRA splice lives in the runner, so stock 8-step is close but not
identical — use the runner for the true turbo config).

---

## 7. H3 Ref2VA — fast small-canvas preview

Sub-minute iterations at 768². Reimagines the whole canvas, so it needs a full
retention prompt + a post-composite to keep the center. Fallback / preview only:

```sh
comfy-venv/bin/python -u scripts/comfy_h3_outpaint.py \
  --input /path/to/clip.mp4 --trim-start 1 --canvas 768 --feather 40 \
  --prompt "<full 6-section retention prompt>" --seed 7 \
  --prefix myclip_h3 --output output/myclip_h3.mp4 --timeout 7200
```

---

## 8. Full-length production chain (chunked, all engines)

`full_reels.py` orchestrates LTX → x2 upscale → TwoAbove over long clips in
overlapping chunks with time-based crossfade stitching and orientation-aware
decrush. Edit the `SOURCES` list at the top of the script, then:

```sh
sh scripts/launch_reels_full_bg.sh     # → logs/comfy_reels_full.log, finals in output/reels/
```

Recipe per clip: LTX 6 s/1 s → x2 3 s/0.5 s → TW 3 s/1 s (90f exact), seed 7.
Budget ~2–5 h per 12–35 s clip on one H100. Watch the log for per-phase
`VALIDATE … OK/MISMATCH` frame-count checks.

---

## 9. Quality comparison tools

After a run, score it objectively (all read frames with OpenCV, no server):

```sh
# Full-reference perceptual fidelity of preserved center vs true source:
comfy-venv/bin/python scripts/fidelity.py SOURCE.mp4 <srcW> <srcH> \
  out.mp4 <W> <H> label            # LPIPS↓ / SSIM↑ / PSNR↑ / NCC↑ (needs TORCH_HOME set)

# Region quality A/B (sharpness, banding, seam, tone drift) between two outputs:
comfy-venv/bin/python scripts/compare_25.py A.mp4 B.mp4 <W> <H> <srcW> <srcH> labelA labelB

# Portrait side-band stock-vs-turbo compare:
comfy-venv/bin/python scripts/compare_turbo.py stock.mp4 turbo.mp4 <srcW> <srcH> <W> <H> SOURCE.mp4
```

Export `TORCH_HOME="$PWD/.cache/torch"` before `fidelity.py` so LPIPS weights
cache on vol11, not `$HOME`.

---

## 10. Troubleshooting quick table

| Symptom | Fix |
|---|---|
| Server down after idle-stop | `sh scripts/launch_comfy_bg.sh` |
| `moov atom not found` on `--stock` | git-lfs pointer; `--stock` auto-refetches, or delete `ComfyUI/input/outpainting_input.mp4` |
| `VAEEncodeAudio: input audio is None` | silent source; driver auto-muxes silent AAC (pull current script) |
| Background log empty | child must run under `python -u` (all launchers do) |
| OOM on 80 GB | raise `--reserve-vram`, chunk clips > 8 s, or drop canvas |
| `ImagePadForOutpaintTargetSize` unknown | KJNodes missing; `git clone kijai/ComfyUI-KJNodes` into `custom_nodes/` + reqs + restart |
| Frame counts look wrong | never trust container counts; scripts read-until-exhaust + assert — check the `VALIDATE` log line |
| TwoAbove 1728² hard-fails | exceeds 90M-px window budget → use 1280-class + `--min-src-mp 0.5` |

Full detail on any of these: [comfyui-ltx-outpaint.md](comfyui-ltx-outpaint.md) §5 Troubleshooting.
