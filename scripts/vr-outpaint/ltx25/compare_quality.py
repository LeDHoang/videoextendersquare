"""Quality comparison for the LTX-2.5 method-A runs (a23, b25, b25L0, c = b25 stage 2, d).

Every composite is scaled to 3840² (lanczos) so the same crop shows the same patch of the sphere.
Outputs, written to <run folder>/compare/:
  crops_f060.jpg   rows = regions (outpaint stadium, source figures, outpaint floor), cols = runs
  full_f060.jpg    whole frame 60 of each run, side by side at 960²
  metrics.json     per run: detail (mean |Laplacian| at 3840²) and flicker (mean |frame diff|),
                   split into the source region and the outpainted region

Run from the repo root:  .venv/bin/python scripts/vr-outpaint/ltx25/compare_quality.py runpod-abc-2026-11-24/ltx25
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(sys.argv[1]).resolve()  # run folder holding out/ and logs/
OUT = HERE / "out"
CMP = HERE / "compare"
CMP.mkdir(exist_ok=True)
W = 3840
FRAMES = [0, 30, 60, 90, 120]

RUNS = [
    ("a23 s1 1088²", "a23_s1comp_00001.mp4"),
    ("b25 s1 1088²", "b25_s1comp_00001.mp4"),
    ("a23 s2 2176²", "a23_s2comp_00001.mp4"),
    ("c = b25 s2 2176²", "b25_s2comp_00001.mp4"),
    ("d 3840²", "d_comp_00001.mp4"),
]
# (label, x, y, size) in fractions of the frame
REGIONS = [
    ("outpaint: stadium", 0.03, 0.27, 0.16),
    ("source: figures", 0.42, 0.44, 0.12),
    ("outpaint: floor", 0.30, 0.66, 0.16),
]
TILE = 640


def frames(path, idx):
    cap = cv2.VideoCapture(str(path))
    out = {}
    for i in idx:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, f = cap.read()
        if ok:
            out[i] = cv2.resize(f, (W, W), interpolation=cv2.INTER_LANCZOS4) if f.shape[0] != W else f
    cap.release()
    return out


# source mask: the non-black area of the LoRA-off control composite (only the source is drawn there)
ctrl = frames(OUT / "b25L0_s1comp_00001.mp4", [60])[60]
src_mask = cv2.erode((ctrl.max(axis=2) > 12).astype(np.uint8), np.ones((25, 25), np.uint8)) > 0
out_mask = ~cv2.dilate(src_mask.astype(np.uint8), np.ones((61, 61), np.uint8)).astype(bool)

runs = [(lbl, OUT / f) for lbl, f in RUNS if (OUT / f).exists()]
metrics, crops, fulls = {}, [], []
for lbl, path in runs:
    fr = frames(path, FRAMES + [61])
    lap = {k: np.abs(cv2.Laplacian(cv2.cvtColor(v, cv2.COLOR_BGR2GRAY), cv2.CV_32F)) for k, v in fr.items()}
    diff = np.abs(fr[61].astype(np.float32) - fr[60].astype(np.float32)).mean(axis=2)
    metrics[lbl] = {
        "file": path.name,
        "native_px": int(cv2.VideoCapture(str(path)).get(cv2.CAP_PROP_FRAME_WIDTH)),
        "detail_source": round(float(np.mean([lap[i][src_mask].mean() for i in FRAMES])), 3),
        "detail_outpaint": round(float(np.mean([lap[i][out_mask].mean() for i in FRAMES])), 3),
        "flicker_source_f60_61": round(float(diff[src_mask].mean()), 3),
        "flicker_outpaint_f60_61": round(float(diff[out_mask].mean()), 3),
    }
    col = []
    for _, x, y, s in REGIONS:
        x0, y0, n = int(x * W), int(y * W), int(s * W)
        col.append(cv2.resize(fr[60][y0:y0 + n, x0:x0 + n], (TILE, TILE), interpolation=cv2.INTER_NEAREST))
    crops.append((lbl, col))
    fulls.append((lbl, cv2.resize(fr[60], (960, 960), interpolation=cv2.INTER_AREA)))


def label(img, text):
    img = img.copy()
    cv2.rectangle(img, (0, 0), (img.shape[1], 44), (0, 0, 0), -1)
    cv2.putText(img, text, (12, 31), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
    return img


grid = np.vstack([np.hstack([label(col[r], f"{lbl} | {REGIONS[r][0]}") for lbl, col in crops])
                  for r in range(len(REGIONS))])
cv2.imwrite(str(CMP / "crops_f060.jpg"), grid, [cv2.IMWRITE_JPEG_QUALITY, 92])
cv2.imwrite(str(CMP / "full_f060.jpg"), np.hstack([label(f, l) for l, f in fulls]), [cv2.IMWRITE_JPEG_QUALITY, 90])
json.dump(metrics, open(CMP / "metrics.json", "w"), indent=1)
for k, v in metrics.items():
    print(f"{k:18s} {v}")
