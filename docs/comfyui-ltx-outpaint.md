# ComfyUI LTX-2.3 IC-LoRA In/Outpainting — Local H100 Walkthrough

> Live progress log for wiring `Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting`
> into this workspace via a local ComfyUI pipeline (1× H100 80GB).
> Decisions: **standalone script first**, **distilled two-stage**, **runtime output metrics**.
> Updated by the agent as each step completes — read top-to-bottom for current status.

## Status board

| # | Step | Status | Notes |
|---|------|--------|-------|
| 0 | Prior-work recovery | DONE 2026-09-03 | No prior plan file found. Recovered state: `ComfyUI/` cloned + `ComfyUI-LTXVideo`/`Manager`/`VideoHelperSuite` installed, `comfy-venv` (py3.10, torch 2.7.1+cu126) works, `models/` empty, `.cache/huggingface` empty. Branch `comfyuipipeline`. |
| 1 | HF auth + model downloads | DONE 2026-09-03 ~07:20 UTC | Token OK (`Leduchoang`, both gated repos accessible). All 4 files on vol11-scratch (NOT usr2): `checkpoints/ltx-2.3-22b-dev.safetensors` 46.1GB, `loras/ltxv/ltx2/ltx-2.3-22b-distilled-lora-384-1.1.safetensors` 7.6GB, `loras/ltxv/ltx2/ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors` 1.3GB, `text_encoders/comfy_gemma_3_12B_it.safetensors` 24.4GB (from `Comfy-Org/ltx-2:split_files/text_encoders/gemma_3_12B_it.safetensors`, renamed per workflow). Full log: `logs/comfy_models_download.log`. Stray `.cache` staging dirs removed. |
| 2 | comfy-venv deps + headless boot (:8188) | DONE 2026-09-03 | Installed `gguf`, `ninja`, `timm` into `comfy-venv` (pip cache → `$WS/.cache/pip`, satisfies usr2 constraint). Full `-r requirements.txt` otherwise already satisfied; torch stays 2.7.1+cu126. Gotcha fixed: double-fork launcher must pass full venv path as `argv[0]` or `pyvenv.cfg` is missed and venv site-packages vanish (`sqlalchemy` ghost). Server up: `http://127.0.0.1:8188`, ComfyUI v0.34.0, all custom nodes import clean (Manager, VideoHelperSuite, LTXVideo). API verified: checkpoint/gemma/LoRA dropdowns list exactly the 4 downloaded files. Launcher: `scripts/launch_comfy_bg.sh` (workspace-persistent; the earlier `/tmp/opencode` path gets wiped on idle-stop), log: `logs/comfyui_server.log`. |
| 3 | Smoke-test stock `LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json` | DONE 2026-09-03 ~07:50 UTC | `scripts/comfy_ltx_outpaint.py --stock --prefix smoke_stock --output output/smoke_stock.mp4` → done in **196 s** end-to-end (cold model load incl.). Output `output/smoke_stock.mp4`: 1920×1088 h264 + aac, 3.88 s, 97 frames, 1.5 MB (ffprobe-verified). Log: `logs/comfy_smoke.log`. |
| 4 | Standalone `scripts/comfy_ltx_outpaint.py` + runtime CLI | DONE 2026-09-03 | Converter green on 55 nodes (`--dry-run` OK); `LoadVideo/CLIP/pad/seed/sigmas/LoRA/guide/fps/prefix` overrides wired; pre-processing (trim+ref) + submit/poll/download wired; CLI reconciled with graph (§Step 4); E2E proven (§Step 5). |
| 5 | E2E verify on real clip (square, ffprobe, timing) | DONE 2026-09-03 ~07:54 UTC | Real-clip path proven with stock mp4 as stand-in input: trim 0–4 s → stage → 1280×1280 pad override + custom prompt + seed 42 → done in **85 s** (warm models). `output/e2e_square.mp4`: 1280×1280 h264+aac, 3.88 s, 97 frames (ffprobe-verified). Log: `logs/comfy_e2e.log`. Genuine user clip still untested — rerun `sh scripts/launch_e2e_bg.sh` after pointing it at a real file. |

## Environment (verified 2026-09-03)

- GPU: `NVIDIA H100 80GB HBM3`, ~81 GB free, driver 575.57.08
- Python: 3.10.12 · torch in `comfy-venv`: `2.7.1+cu126`
- Disk: NFS 90T @ 97% — ~3.1T free, need ~100GB+ for weights
- ComfyUI: `ComfyUI/main.py` present; custom nodes present; `models/*` empty (see §1)
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
- [ ] deps installed, import errors resolved
- [ ] ComfyUI responds on :8188

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
--attention-strength`), misc (`--fps --prefix --output --timeout --dry-run`).

Where things land: generations in `ComfyUI/output/<prefix>_*.mp4` (+ copy
to `--output`); staged trims in `ComfyUI/input/<prefix>_src.mp4`; all
heavy data stays on vol11-scratch, never `$HOME`/`/tmp`.

### 5. Troubleshooting
- `moov atom not found` on the stock sample → git-lfs pointer file.
  `--stock` now auto-refetches the real bytes; or delete
  `ComfyUI/input/outpainting_input.mp4` and rerun.
- `no value for 'codec'` on `--dry-run` → stale script; pull the version
  with the `is_hidden()` fix.
- `FileNotFoundError` copying `ComfyUI/output/<prefix>_src.mp4` → stale
  script; pull the version with SaveVideo-only `resolve_outputs()`.
- Background log stays empty → the child must run under `python -u`
  (all `scripts/launch_*_bg.sh` already do).
- OOM on 80GB → raise `--reserve-vram`, then `low_vram_loaders.py`
  nodes, then the Q8 path.
- Server down after idle-stop → `sh scripts/launch_comfy_bg.sh`.
- `ImagePadForOutpaintTargetSize` unknown → `ComfyUI-KJNodes` missing;
  `git clone --depth 1 kijai/ComfyUI-KJNodes` into `custom_nodes/` +
  install its requirements + restart (see §Step 3 blocker).

### Step 5 — E2E verify
- Run script on a real portrait + landscape clip → `ffprobe` square dims, duration, A/V sync → record wall-time/VRAM.
- Known-good command lines will be pasted here.

Runs:
- `comfy-venv/bin/python scripts/comfy_ltx_outpaint.py --stock --prefix smoke_stock --output output/smoke_stock.mp4 --timeout 5400` → 196 s, 1920×1088 h264+aac 3.88 s (`logs/comfy_smoke.log`)
- E2E (background, warm models): `sh scripts/launch_e2e_bg.sh` (trim 0–4 s of stock mp4 → 1280×1280 square, custom prompt, seed 42 → `output/e2e_square.mp4`, log `logs/comfy_e2e.log`) — DONE in 85 s, 1280×1280 verified.
- E2E bug found + fixed: `resolve_outputs()` collected **every** node's history outputs, so `files[0]` was the `LoadVideo` passthrough (a path in `ComfyUI/input/`) → `FileNotFoundError` on copy. Now restricted to `SaveVideo` node ids (signature `resolve_outputs(prompt, entry)`).
- Battlefield user clip (background): `sh scripts/launch_battlefield_bg.sh` (1726×970 60 fps h264, full 4.77 s, trim 0–5 s → 1728×1728 bigger-dim square, battlefield prompt, seed 7 → `output/battlefield_sq.mp4`, log `logs/comfy_battlefield.log`) — DONE in 210 s, `outputs:` contained only the SaveVideo file (fix confirmed). `output/battlefield_sq.mp4`: 1728×1728 h264+aac, 4.58 s, 137 frames @~29.9 fps (source 143 frames @60 fps → LTX temporal packing drops a few; same pattern as stock runs).

## Deferred (not this phase)

- `comfy` as 4th `upscale_engine` in `server/routers/video.py` + `pipeline/video_worker.py` + VideoPage UI.
- Direct-4K-from-ComfyUI vs ComfyUI-square + ffmpeg-upscale comparison.
- Docker/RunAI packaging.

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
