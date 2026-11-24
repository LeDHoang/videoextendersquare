# VR outpaint pipeline (180° / 360°): how to run

Scripts for the 2026-11-24 outpaint tests: ComfyUI API graphs, the pod runner, and the local quality and resource reports.
Results, numbers and verdicts are in [`docs/vr-outpaint-180-360-next-steps.md`](../../docs/vr-outpaint-180-360-next-steps.md).
Run outputs (mp4s, logs) are not committed: they stay in `runpod-abc-<date>/` and `docs/outpaint-fal-<date>/` (both gitignored).

## Layout

| path | what |
|---|---|
| `runner.py` | Runs on the pod. Starts a fresh ComfyUI per prompt, queues `/root/prompts/<name>.json`, logs VRAM/RAM/wall time |
| `abc/` | LTX-2.3 options A, B, C (5 s and 15 s). `setup.sh`, `build_prompts.py`, saved `prompts/`, `qa/` headset-view metrics |
| `ltx25/` | LTX-2.5 method-A runs a23, b25, b25L0, c (= b25 stage 2) and the 4K pass d. Setup, graph builders, reports |
| `fal/` | Local composite and metrics for the fal hosted endpoint comparison |

## Variants

| id | model / graph | canvas | built by |
|---|---|---|---|
| A, A15 | LTX-2.3 distilled + `360vroutpaint` IC-LoRA, 180° half-equirect | 1088² | `abc/build_prompts.py` |
| B, B15 | as A at a larger canvas | 1536² | `abc/build_prompts.py` |
| C | 360° canvas, seam tools on, front 180° cropped | 360/180 | saved prompt only (see note) |
| a23 | LTX-2.3 + LoRA, 1088², then ×2 refine at 2176² | 1088² / 2176² | `ltx25/build_prompts25.py` |
| b25 | LTX-2.5 + the 2.3 LoRA, same two stages | 1088² / 2176² | `ltx25/build_prompts25.py` |
| b25L0 | b25 stage 1 with LoRA strength 0 (control) | 1088² | `ltx25/build_prompts25.py` |
| c | b25's stage-2 output (`b25_s2comp`). No separate run | 2176² | (from b25) |
| d | c taken to 3840², LTX-2.5 TiledFusion + refine-details IC-LoRA | 3840² | `ltx25/build_d.py` |
| fal | `fal-ai/ltx-2.3-22b/distilled/reference-video-to-video/lora`, same LoRA and canvas as A | 1088² | fal MCP / API, then `fal/` |

Note: `abc/build_prompts.py` now lists only A15 and B15 in `RUNS`. The 5 s A/B/C/orig360 rows were not kept.
`build()` still takes C's settings: add a row with `chf`/`cvf` 360/180, `seam=True` and a front `crop`.
`abc/prompts/` holds the saved A15, B15 and B15s42 JSONs.

## Pod

- Image `runpod/comfyui:2.4.1-comfyuiv0.44.0-cuda13.2` (ComfyUI baked at `/opt/comfyui-baked`).
- GPU: RTX PRO 6000 96 GB. RAM: ≥ 160 GB for a/b/c, ≥ 192 GB for d (d peaks at ~175 GB container RAM).
- For `ltx25/`: write a Hugging Face token to `/root/.hf_token` (read by `setup25.sh`). Never pass it on a command line.
- Terminate the pod after the copy-back: a stopped pod still bills its volume disk.

## Run (on the pod)

Copy this folder to `/root/vr-outpaint/` and the input clip to ComfyUI's input dir:

```bash
cp tron15s.mp4 /opt/comfyui-baked/input/
```

### LTX-2.5 runs (a23, b25, b25L0, then d)

```bash
sh /root/vr-outpaint/ltx25/setup25.sh          # models + custom nodes, logs in /tmp/logs
python3.12 /root/vr-outpaint/ltx25/build_prompts25.py /root/prompts
cd /root/vr-outpaint && python3.12 runner.py a23 b25 b25L0
```

d takes c as input, so copy b25's stage-2 composite into `input/` first:

```bash
cp /opt/comfyui-baked/output/b25_s2comp_00001.mp4 /opt/comfyui-baked/input/
python3.12 /root/vr-outpaint/ltx25/build_d.py /root/prompts b25_s2comp_00001.mp4 1280
cd /root/vr-outpaint && python3.12 runner.py d
```

### LTX-2.3 A/B (15 s)

```bash
sh /root/vr-outpaint/abc/setup.sh
python3.12 /root/vr-outpaint/abc/build_prompts.py /root/prompts
cd /root/vr-outpaint && python3.12 runner.py A15 B15
```

Each run writes `<name>.comfy.log`, `.vram.csv`, `.ram.csv` and `.summary.json` to `/workspace/results` and prints
`RUNNER_DONE`. Videos land in `/opt/comfyui-baked/output/`.

## Copy back and report (local, from the repo root)

Copy `/workspace/results/*` into `runpod-abc-<date>/ltx25/logs/` and the output mp4s into `runpod-abc-<date>/ltx25/out/`.
Then:

```bash
.venv/bin/python scripts/vr-outpaint/ltx25/resources.py runpod-abc-2026-11-24/ltx25
```

```bash
.venv/bin/python scripts/vr-outpaint/ltx25/compare_quality.py runpod-abc-2026-11-24/ltx25
```

`resources.py` writes `resources.md` / `resources.json` into the run folder. `compare_quality.py` writes crops, full frames
and `metrics.json` into `<run folder>/compare/`.

For the A/B/C runs, render 90° headset views and score them (`IN` = folder of mp4s, `OUT` = compare dir):

```bash
bash scripts/vr-outpaint/abc/qa/views15.sh runpod-abc-2026-11-24/15s runpod-abc-2026-11-24/15s/compare
```

```bash
.venv/bin/python scripts/vr-outpaint/abc/qa/metrics_geo15.py runpod-abc-2026-11-24/15s/compare
```

`views.sh` / `metrics.py` / `metrics_geo.py` are the 5 s versions.

### fal comparison

1. `fal/mkref.py SRC OUT NFRAMES`: project the source clip onto the 1088² half-equirect canvas (the reference video).
2. Send the reference to the fal endpoint above with the `360vroutpaint` LoRA.
3. `fal/feather.py RAW REF MASK OUT`: paste the source back with a 12 px feather (same composite for every raw).
4. `fal/cmp.py FAL A_RAW REF MASK OUT`: side-by-side sheet against A.
5. `fal/metrics_geo_fal.py COMPARE_DIR`: headset-view metrics.
