"""Extended visual-difference metrics for outpaint comparisons.

Pixels across models are NOT aligned (different gens), so this measures
quality PROPERTIES per region with the preserved source as control:
  lap    = variance of Laplacian (detail/sharpness, higher = crisper)
  ten    = Tenengrad: mean Sobel-gradient energy (edge strength)
  levels = distinct gray levels in the flattest 64x64 patch of the band
           (smooth-gradient fidelity; higher = less banding/posterization)
  sat    = mean saturation (color richness)
  dE     = CIE76 band-mean vs adjacent-source-mean (tone drift magnitude)
  flick  = mean abs inter-frame diff (temporal stability, lower = calmer)
  tshstd = std of laplacian-sharpness across probes (detail stability)
Regions auto-derived from canvas + source dims (like scan_video).
Probes every 0.5s over 1-4s. Prints per-clip table + paired summary.
Usage: compare_25.py A.mp4 B.mp4 <W> <H> <srcW> <srcH> [labelA labelB]
"""
import sys

import cv2
import numpy as np


def regions(W, H, sw, sh):
    s = min(W / sw, H / sh)
    dw, dh = sw * s, sh * s
    top = int((H - dh) / 2)
    return {"top": (0, top), "bot": (top + int(dh), H),
            "src": (top, top + int(dh))}


def grab(path, times):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    nfr = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    dur = nfr / fps if fps else 0
    if times is None:  # spread 5 probes across 10%-90% of duration
        times = [round(dur * f, 2) for f in (0.1, 0.3, 0.5, 0.7, 0.9)]
    frames, color, flick = {}, {}, {}
    for t in times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, fr = cap.read()
        if not ok:
            raise RuntimeError(f"{path} t={t}: no frame")
        color[t] = fr
        frames[t] = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    for t in times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        _, a = cap.read()
        cap.set(cv2.CAP_PROP_POS_FRAMES, min(int(t * fps) + 1, nfr - 1))
        ok, b = cap.read()
        if not ok:
            raise RuntimeError(f"{path} t={t}: flick pair missing")
        ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float32)
        gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY).astype(np.float32)
        flick[t] = float(np.mean(np.abs(ga - gb)))
    cap.release()
    return frames, color, flick, times


def lap_var(g):
    return float(np.var(cv2.Laplacian(g, cv2.CV_32F)))


def tenengrad(g):
    sx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    sy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return float(np.mean(sx ** 2 + sy ** 2))


def flat_levels(g):
    """Distinct levels in the flattest 64x64 patch (banding proxy)."""
    h, w = g.shape
    best, bv = None, 1e18
    for y in range(0, h - 64, 32):
        for x in range(0, w - 64, 32):
            p = g[y:y + 64, x:x + 64]
            v = float(np.var(cv2.Laplacian(p, cv2.CV_32F)))
            if v < bv:
                bv, best = v, p
    return len(np.unique(best.astype(np.uint8)))


def sat_mean(bgr):
    hsv = cv2.cvtColor(np.clip(bgr, 0, 255).astype(np.uint8),
                       cv2.COLOR_BGR2HSV)
    return float(np.mean(hsv[:, :, 1]))


def de76(bgr_a, bgr_b):
    la = cv2.cvtColor(np.clip(bgr_a, 0, 255).astype(np.uint8),
                      cv2.COLOR_BGR2LAB).astype(np.float32).mean(axis=(0, 1))
    lb = cv2.cvtColor(np.clip(bgr_b, 0, 255).astype(np.uint8),
                      cv2.COLOR_BGR2LAB).astype(np.float32).mean(axis=(0, 1))
    la *= np.array([100 / 255, 1, 1])
    lb *= np.array([100 / 255, 1, 1])
    return float(np.linalg.norm(la - lb))


def seam_ratio(g, bound, win=80):
    """Max row-step near seam vs far-field max (<1 = smooth blend)."""
    rows = np.abs(np.diff(g.mean(axis=1)))
    h = len(rows)
    near = rows[max(0, bound - win):bound + win]
    far = np.concatenate([rows[:max(1, bound - win)],
                          rows[bound + win:]]) if bound + win < h else rows
    return float(near.max() / max(far.max(), 1e-6))


def measure(path, W, H, sw, sh, times=None):
    R = regions(W, H, sw, sh)
    frames, color, flick, times = grab(path, times)
    rows = []
    for t in times:
        f, c = frames[t], color[t]
        top, bot = f[R["top"][0]:R["top"][1]], f[R["bot"][0]:R["bot"][1]]
        ct, cb = c[R["top"][0]:R["top"][1]], c[R["bot"][0]:R["bot"][1]]
        src = c[R["src"][0]:R["src"][1]]
        # adjacent source strips for dE (32px inside source at each seam)
        dE_top = de76(ct, src[:32])
        dE_bot = de76(cb, src[-32:])
        rows.append({
            "t": t,
            "lap_top": lap_var(top), "lap_bot": lap_var(bot),
            "lap_src": lap_var(f[R["src"][0]:R["src"][1]]),
            "ten_top": tenengrad(top), "ten_bot": tenengrad(bot),
            "ten_src": tenengrad(f[R["src"][0]:R["src"][1]]),
            "lvl_top": flat_levels(top), "lvl_bot": flat_levels(bot),
            "sat_top": sat_mean(ct), "sat_bot": sat_mean(cb),
            "sat_src": sat_mean(src),
            "dE_top": dE_top, "dE_bot": dE_bot,
            "seam_top": seam_ratio(f, R["top"][1]),
            "seam_bot": seam_ratio(f, R["bot"][0]),
            "flick": flick[t],
        })
    return rows, times


def summ(rows):
    keys = [k for k in rows[0] if k != "t"]
    out = {}
    for k in keys:
        v = np.array([r[k] for r in rows])
        out[k] = (float(v.mean()), float(v.std()))
    laps = np.array([r["lap_top"] + r["lap_bot"] for r in rows])
    out["tshstd"] = (float(laps.std()), 0.0)
    return out


def detail_gain(up_path, in_path, W, H, sw, sh, times):
    """Laplacian-sharpness ratio: upscaled band vs Lanczos-upscaled input
    band (>1 = diffusion added real detail beyond interpolation)."""
    R = regions(W, H, sw, sh)
    cap_u = cv2.VideoCapture(up_path)
    cap_i = cv2.VideoCapture(in_path)
    fu = cap_u.get(cv2.CAP_PROP_FPS)
    fi = cap_i.get(cv2.CAP_PROP_FPS)
    out = []
    for t in times:
        cap_u.set(cv2.CAP_PROP_POS_FRAMES, int(t * fu))
        _, a = cap_u.read()
        cap_i.set(cv2.CAP_PROP_POS_FRAMES, int(t * fi))
        ok, b = cap_i.read()
        if not ok:
            raise RuntimeError(f"{in_path} t={t}: no frame")
        ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float32)
        gb = cv2.resize(cv2.cvtColor(b, cv2.COLOR_BGR2GRAY), (W, H),
                        interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
        for name, (y0, y1) in (("top", R["top"]), ("bot", R["bot"])):
            la, lb = lap_var(ga[y0:y1]), lap_var(gb[y0:y1])
            out.append((round(t, 2), name, la / max(lb, 1e-6)))
    cap_u.release()
    cap_i.release()
    return out


def main():
    pa, pb = sys.argv[1], sys.argv[2]
    W, H, sw, sh = map(int, sys.argv[3:7])
    la = sys.argv[7] if len(sys.argv) > 7 else pa.split("/")[-1]
    lb = sys.argv[8] if len(sys.argv) > 8 else pb.split("/")[-1]
    ref = sys.argv[9] if len(sys.argv) > 9 else None
    ra, ta = measure(pa, W, H, sw, sh)
    rb, _ = measure(pb, W, H, sw, sh, ta)
    sa, sb = summ(ra), summ(rb)
    print(f"== {la} vs {lb} ({W}x{H} from {sw}x{sh}, "
          f"{len(ra)} probes @ {ta}) ==")
    print(f"{'metric':9s} {'A_mean':>8s} {'A_std':>6s} "
          f"{'B_mean':>8s} {'B_std':>6s}  B-A")
    for k in sa:
        a, asd = sa[k]
        b, bsd = sb[k]
        print(f"{k:9s} {a:8.2f} {asd:6.2f} {b:8.2f} {bsd:6.2f}  "
              f"{b - a:+.2f}")
    if ref:
        print(f"-- detail gain vs Lanczos({ref.split('/')[-1]}) --")
        for name, path in ((la, pa), (lb, pb)):
            g = detail_gain(path, ref, W, H, sw, sh, ta)
            tops = [x[2] for x in g if x[1] == "top"]
            bots = [x[2] for x in g if x[1] == "bot"]
            print(f"  {name}: top gain {np.mean(tops):.2f} "
                  f"(probes {[round(x, 2) for x in tops]})")
            print(f"  {name}: bot gain {np.mean(bots):.2f} "
                  f"(probes {[round(x, 2) for x in bots]})")


if __name__ == "__main__":
    main()
