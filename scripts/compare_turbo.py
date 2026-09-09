"""Stock-TW vs turbo-TW compare for portrait side-band outpaint.

reel2: 720x1280 source, centered in 1216x1248 canvas -> left/right bands.
Measures, per probe time (aligned to the same source timestamp in both):
  cNCC   = normalized cross-corr of the CENTER (preserved) region vs the
           color-matched source frame -> how faithfully the source is kept
  lap_L/R= Laplacian variance of left/right generated bands (detail)
  seamL/R= max column-step at the vertical seam vs far-field (>1 = visible)
  dE_L/R = CIE76 band-mean vs adjacent 32px source strip (tone drift)
  flick  = mean |frame_t - frame_t+1| over the whole canvas (motion calm)
Usage: compare_turbo.py stock.mp4 turbo.mp4 srcW srcH canvasW canvasH
"""
import sys

import cv2
import numpy as np


def bands(W, H, sw, sh):
    s = min(W / sw, H / sh)
    dw = int(sw * s)
    left = (W - dw) // 2
    return left, left + dw  # x0, x1 of preserved center column range


def read_at(cap, t, fps, n):
    cap.set(cv2.CAP_PROP_POS_FRAMES, min(int(t * fps), n - 1))
    ok, fr = cap.read()
    if not ok:
        raise RuntimeError(f"no frame at t={t}")
    return fr


def lap_var(g):
    return float(np.var(cv2.Laplacian(g.astype(np.float32), cv2.CV_32F)))


def de76(a, b):
    la = cv2.cvtColor(np.clip(a, 0, 255).astype(np.uint8),
                      cv2.COLOR_BGR2LAB).astype(np.float32).mean(axis=(0, 1))
    lb = cv2.cvtColor(np.clip(b, 0, 255).astype(np.uint8),
                      cv2.COLOR_BGR2LAB).astype(np.float32).mean(axis=(0, 1))
    la *= np.array([100 / 255, 1, 1])
    lb *= np.array([100 / 255, 1, 1])
    return float(np.linalg.norm(la - lb))


def ncc(a, b):
    a = a.astype(np.float32).ravel()
    b = b.astype(np.float32).ravel()
    a -= a.mean()
    b -= b.mean()
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float(a @ b / d) if d else 0.0


def seam_col(g, bound, win=60):
    cols = np.abs(np.diff(g.mean(axis=0)))
    w = len(cols)
    near = cols[max(0, bound - win):min(w, bound + win)]
    far = np.concatenate([cols[:max(1, bound - win)], cols[min(w, bound + win):]])
    return float(near.max() / max(far.max(), 1e-6))


def measure(path, srccap, sfps, sn, sw, sh, W, H, times):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    x0, x1 = bands(W, H, sw, sh)
    s = min(W / sw, H / sh)
    dw, dh = int(sw * s), int(sh * s)
    y0 = (H - dh) // 2
    rows = []
    for t in times:
        fr = read_at(cap, t, fps, n)
        sfr = read_at(srccap, t, sfps, sn)
        sfr_r = cv2.resize(sfr, (dw, dh))
        center = fr[y0:y0 + dh, x0:x1]
        # color-match source to center means before NCC (isolate structure)
        gc = cv2.cvtColor(center, cv2.COLOR_BGR2GRAY)
        gs = cv2.cvtColor(sfr_r, cv2.COLOR_BGR2GRAY)
        left = fr[:, :x0]
        right = fr[:, x1:]
        gL = cv2.cvtColor(left, cv2.COLOR_BGR2GRAY)
        gR = cv2.cvtColor(right, cv2.COLOR_BGR2GRAY)
        g_full = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY).astype(np.float32)
        fr2 = read_at(cap, t + 1.0 / fps, fps, n)
        flick = float(np.mean(np.abs(
            cv2.cvtColor(fr2, cv2.COLOR_BGR2GRAY).astype(np.float32) - g_full)))
        rows.append(dict(
            t=t, cNCC=ncc(gc, gs),
            lap_L=lap_var(gL), lap_R=lap_var(gR),
            dE_L=de76(left, center[:, :32]),
            dE_R=de76(right, center[:, -32:]),
            seam_L=seam_col(g_full, x0), seam_R=seam_col(g_full, x1),
            flick=flick,
        ))
    cap.release()
    return rows


def main():
    stock, turbo, sw, sh, W, H = (sys.argv[1], sys.argv[2],
                                  *map(int, sys.argv[3:7]))
    src = sys.argv[7]
    scap = cv2.VideoCapture(src)
    sfps = scap.get(cv2.CAP_PROP_FPS)
    sn = int(scap.get(cv2.CAP_PROP_FRAME_COUNT))
    dur = sn / sfps
    times = [round(dur * f, 2) for f in (0.1, 0.25, 0.4, 0.55, 0.7, 0.85)]
    a = measure(stock, scap, sfps, sn, sw, sh, W, H, times)
    scap2 = cv2.VideoCapture(src)
    b = measure(turbo, scap2, sfps, sn, sw, sh, W, H, times)
    keys = [k for k in a[0] if k != "t"]
    print(f"== stock vs turbo ({W}x{H} from {sw}x{sh}, {len(times)} probes) ==")
    print(f"{'metric':7s} {'stock':>9s} {'turbo':>9s} {'delta':>9s}")
    for k in keys:
        am = np.mean([r[k] for r in a])
        bm = np.mean([r[k] for r in b])
        print(f"{k:7s} {am:9.3f} {bm:9.3f} {bm - am:+9.3f}")


if __name__ == "__main__":
    main()
