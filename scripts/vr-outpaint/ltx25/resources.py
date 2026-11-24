"""Resource log for the LTX-2.5 method-A runs: VRAM, RAM and time per run.

Reads, for each run in logs/ and out/:
  <run>.vram.csv     nvidia-smi every 1 s: timestamp, MiB used, GPU util %
  <run>.ram.csv      every 1 s: t seconds, ComfyUI RSS (kB), container cgroup memory (bytes, includes page cache)
  <run>.comfy.log    sampler progress lines (s/it) and "Prompt executed in"
  <run>.summary.json runner summary (wall_s, vmhwm_gb = peak RSS of the ComfyUI process)
Writes resources.md and resources.json into the run folder.

Run from the repo root:  .venv/bin/python scripts/vr-outpaint/ltx25/resources.py runpod-abc-2026-11-24/ltx25
"""
import json
import sys
import re
from datetime import datetime
from pathlib import Path

HERE = Path(sys.argv[1]).resolve()  # run folder holding out/ and logs/
LOGS, OUT = HERE / "logs", HERE / "out"
RUNS = [
    ("a23", "LTX-2.3 + 360vroutpaint LoRA, 1088² then x2 refine 2176²"),
    ("b25", "LTX-2.5 + 2.3 LoRA, 1088² then x2 refine 2176² (stage 2 = c)"),
    ("b25L0", "LTX-2.5, LoRA strength 0, 1088² only (control)"),
    ("d", "c taken to 3840², TiledFusion 1280 tiles + Refine-Details IC-LoRA"),
]
PRICE_PER_H = 2.69  # RTX PRO 6000, community cloud


def vram(run):
    rows = []
    for line in (LOGS / f"{run}.vram.csv").read_text().splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) == 3 and p[1].isdigit():
            rows.append((datetime.strptime(p[0], "%Y/%m/%d %H:%M:%S.%f"), int(p[1]), int(p[2])))
    busy = [r for r in rows if r[2] >= 50]
    return {
        "vram_peak_gb": round(max(r[1] for r in rows) / 1024, 2),
        "vram_mean_busy_gb": round(sum(r[1] for r in busy) / len(busy) / 1024, 2) if busy else None,
        "gpu_busy_s": len(busy),  # one sample per second
        "gpu_busy_utc": f"{busy[0][0]:%H:%M:%S}-{busy[-1][0]:%H:%M:%S}" if busy else None,
        "samples_s": len(rows),
    }


def ram(run):
    rss, cg = [], []
    for line in (LOGS / f"{run}.ram.csv").read_text().splitlines():
        p = line.split(",")
        if len(p) == 3:
            rss.append(int(p[1]))
            cg.append(int(p[2]))
    return {"rss_peak_gb": round(max(rss) / 1024 ** 2, 2), "cgroup_peak_gb": round(max(cg) / 1024 ** 3, 2)}


def log(run):
    text = (LOGS / f"{run}.comfy.log").read_text(errors="replace").replace("\r", "\n")
    done = {}
    for m in re.finditer(r"100%\|[^|]*\|\s*(\d+)/\d+ \[([\d:]+)<[^,]*,\s*([\d.]+)(s/it|it/s)\]", text):
        steps, el, rate, unit = int(m[1]), m[2], float(m[3]), m[4]
        s_it = rate if unit == "s/it" else 1 / rate
        done.setdefault((steps, el), round(s_it, 2))  # tqdm prints each bar twice
    ex = re.search(r"Prompt executed in ([\d:.]+)", text)
    return {"sampler_bars": [f"{k[0]} steps in {k[1]} ({v} s/it)" for k, v in done.items()],
            "prompt_executed": ex[1] if ex else None}


res = {}
for run, desc in RUNS:
    if not (LOGS / f"{run}.vram.csv").exists():
        continue
    s = json.loads((OUT / f"{run}.summary.json").read_text())
    r = {"desc": desc, "status": s["status"], "wall_s": s["wall_s"], "vmhwm_gb": s["vmhwm_gb"]}
    r.update(vram(run))
    r.update(ram(run))
    r.update(log(run))
    r["gpu_cost_usd"] = round(s["wall_s"] / 3600 * PRICE_PER_H, 3)
    res[run] = r

json.dump(res, open(HERE / "resources.json", "w"), indent=1)

md = ["# Resource log: LTX-2.5 method-A runs (RTX PRO 6000 96 GB, 121 frames)", "",
      "| run | what | wall | GPU busy | VRAM peak | VRAM mean busy | RAM peak (RSS) | container RAM peak | cost |",
      "|---|---|---|---|---|---|---|---|---|"]
for run, r in res.items():
    md.append(f"| {run} | {r['desc']} | {r['wall_s'] / 60:.1f} min | {r['gpu_busy_s'] / 60:.1f} min | "
              f"{r['vram_peak_gb']} GB | {r['vram_mean_busy_gb']} GB | {max(r['vmhwm_gb'], r['rss_peak_gb'])} GB | "
              f"{r['cgroup_peak_gb']} GB | ${r['gpu_cost_usd']} |")
md += ["", "Sampler progress per run (from the ComfyUI log):", ""]
for run, r in res.items():
    bars = "; ".join(r["sampler_bars"]) or "TiledFusion prints no per-step progress"
    md.append(f"- **{run}**: {bars}; GPU busy {r['gpu_busy_utc']} UTC; prompt executed in {r['prompt_executed']}")
md += ["",
       "Notes:",
       "- wall = runner wall time per prompt (models already on disk; includes model loading, VAE encode/decode and composites).",
       "- GPU busy = seconds with GPU util >= 50 %. The gap to wall is CPU work: loading, lanczos resize, "
       "the EquirectSourceComposite (CPU, chunk=1 at 2176²/3840²) and the mp4 encode.",
       "- RAM peak = peak resident memory of the ComfyUI process. Container RAM includes page cache, "
       "so it shows what the box needs, not what the process holds.",
       f"- cost = wall x ${PRICE_PER_H}/h, GPU only.",
       ]
(HERE / "resources.md").write_text("\n".join(md) + "\n")
print("\n".join(md))
