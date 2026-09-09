"""Full-length reels compare: chunked LTX-2.3 outpaint -> x2 upscale ->
TwoAbove, sequential, single GPU. Overlapping chunks + streaming crossfade
stitches (tone pops hide in the blend). Orientation-aware throughout.

Bills (measured rates): LTX ~2 Mpx/s, UP2560 ~1.15 Mpx/s, TW14 ~8.2 s/frame.
reel3 (11.5s) ~2h | reel1 (23.75s) ~3.8h | reel2 (35.2s) ~5.7h. Order:
shortest first so the pipeline proves itself early.
"""
import cv2
import json
import os
import subprocess
import sys
import time

WS = "/prj/corp/airesearch/lasvegas/vol11-scratch/hleduc/tmptest/videoextendersquare"
PY = os.path.join(WS, "comfy-venv/bin/python -u")
LOG = os.path.join(WS, "logs/comfy_reels_full.log")
FPS = 30.0

REELS = [
    dict(tag="reel3", src="input/reels/Video-96468.mp4", dur=11.515,
         prompt="dark night background with faint distant lights on both sides, blue glow haze, cinematic"),
    dict(tag="reel1", src="input/reels/Video-57715.mp4", dur=23.752,
         prompt="neon-lit futuristic city billboard glow above and dark rainy street reflections below, magenta purple haze, cinematic live action"),
    dict(tag="reel2", src="input/reels/Video-87640.mp4", dur=35.224,
         prompt="blurry downtown city buildings and trees continuing on both sides, overcast daylight, motion blur, cinematic"),
]


def log(msg):
    line = f"{msg} {time.strftime('%H:%M:%S', time.gmtime())}"
    with open(LOG, "a") as f:
        f.write(line + "\n")


def run(cmd, timeout):
    t0 = time.time()
    r = subprocess.run(cmd, timeout=timeout)
    log(f"rc={r.returncode} in {time.time()-t0:.0f}s :: {' '.join(cmd[4:7])}")
    return r.returncode == 0


def chunks(dur, clen, ov):
    out, s = [], 0.0
    while s + clen < dur:
        out.append((s, s + clen))
        s += clen - ov
    out.append((max(0.0, dur - clen), dur))
    seen, uniq = set(), []
    for c in out:
        k = (round(c[0], 2), round(c[1], 2))
        if k not in seen:
            seen.add(k)
            uniq.append(c)
    return uniq


def norm30(src, dst):
    subprocess.run(["ffmpeg", "-y", "-i", src, "-r", "30", "-c:v",
                    "libx264", "-preset", "fast", "-crf", "17", "-an",
                    dst], check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE)


def count(path):
    c = cv2.VideoCapture(path)
    n = int(c.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(c.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(c.get(cv2.CAP_PROP_FRAME_HEIGHT))
    c.release()
    return n, w, h


def chunk_ok(path, a, b, is_last=False):
    """Reusable chunk: exists and frame count matches its time span.

    The final chunk of a phase may snap short (e.g. LTX VAE 16k+1 lengths
    like 81f for a 90f request, or trims past a stitched file's true end):
    accept it when rc was 0 and it holds >=60% of nominal frames. The
    time-based stitcher absorbs short tails exactly.
    """
    if not os.path.exists(path):
        return False
    try:
        n = count(path)[0]
    except Exception:
        return False
    nominal = round((b - a) * FPS)
    if abs(n - nominal) <= 6:
        return True
    if is_last and n >= 0.6 * nominal:
        log(f"short-tail accept {os.path.basename(path)}: {n}f "
            f"vs nominal {nominal}f")
        return True
    return False


def stitch(parts, bounds, dst, W, H, fps=30.0, xform=None):
    """Time-based composite: each output frame t maps to covering chunk(s);
    overlap zones crossfade across the whole zone. Exact union, no doubles."""
    import numpy as np
    allfr, starts = [], []
    for p, (a, b) in zip(parts, bounds):
        cap = cv2.VideoCapture(p)
        frames = []
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            if (fr.shape[1], fr.shape[0]) != (W, H):
                fr = cv2.resize(fr, (W, H))
            if xform is not None:
                fr = xform(fr)
            frames.append(fr)
        cap.release()
        assert len(frames) > 1, f"{p} empty"
        allfr.append(frames)
        starts.append(a)
    cov0 = starts[0]
    cov1 = max(a + len(fr) / fps for a, fr in zip(starts, allfr))
    nout = int(round((cov1 - cov0) * fps))
    tmp = os.path.join(WS, ".cache/stitch_tmp.mp4")
    vw = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), fps,
                         (W, H))
    for i in range(nout):
        t = cov0 + i / fps
        cov = [(j, (t - a) * fps) for j, a in enumerate(starts)
               if 0 <= (t - a) * fps <= len(allfr[j]) - 1]
        if not cov:  # gap fallback: nearest chunk edge
            j = min(range(len(starts)),
                    key=lambda j: abs(t - starts[j]))
            k = int(round((t - starts[j]) * fps))
            k = max(0, min(k, len(allfr[j]) - 1))
            vw.write(allfr[j][k])
            continue
        if len(cov) == 1:
            j, kf = cov[0]
            vw.write(allfr[j][int(round(kf))])
        else:
            (j1, k1), (j2, k2) = cov[0], cov[-1]
            z0, z1 = starts[j2], starts[j1] + (len(allfr[j1]) - 1) / fps
            alpha = 0.5 if z1 <= z0 else (t - z0) / (z1 - z0)
            f1 = allfr[j1][int(round(k1))].astype("float32")
            f2 = allfr[j2][int(round(k2))].astype("float32")
            vw.write(np_clip(f1 * (1 - alpha) + f2 * alpha))
    vw.release()
    subprocess.run(["ffmpeg", "-y", "-i", tmp, "-c:v", "libx264",
                    "-preset", "fast", "-crf", "17", "-an", dst],
                   check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE)
    return nout


def np_clip(fr):
    import numpy as np
    return np.clip(fr, 0, 255).astype("uint8")


def decrush(fr, staged_w, staged_h, W, H):
    import numpy as np
    f = fr.astype("float32")
    if staged_w >= staged_h:
        y0 = (H - staged_h) // 2
        edges = (y0, y0 + staged_h)
        for e in edges:
            top, bot = f[e - 2].copy(), f[e + 2].copy()
            for k, wgt in ((-1, 0.25), (0, 0.5), (1, 0.75)):
                f[e + k] = top * (1 - wgt) + bot * wgt
    else:
        x0 = (W - staged_w) // 2
        for e in (x0, x0 + staged_w):
            l, r = f[:, e - 2].copy(), f[:, e + 2].copy()
            for k, wgt in ((-1, 0.25), (0, 0.5), (1, 0.75)):
                f[:, e + k] = l * (1 - wgt) + r * wgt
    return np_clip(f)


def main():
    log("=== REELS FULL start")
    for R in REELS:
        src = os.path.join(WS, R["src"])
        # ---- LTX chunks (6s/1s), resume-safe ----
        ltx_parts, ltx_bounds = [], []
        ltx_spans = chunks(R["dur"], 6.0, 1.0)
        for i, (a, b) in enumerate(ltx_spans):
            px = f"{R['tag']}_23f{i}"
            out = os.path.join(WS, f"output/{px}.mp4")
            last = i == len(ltx_spans) - 1
            if not chunk_ok(out, a, b, last):
                ok = run([*PY.split(), f"{WS}/scripts/comfy_ltx_outpaint.py",
                          "--input", src, "--trim-start", str(a),
                          "--trim-duration", str(round(b - a, 3)),
                          "--target-width", "1280", "--target-height",
                          "1280", "--prompt", R["prompt"], "--seed", "7",
                          "--prefix", px, "--output", out, "--timeout",
                          "2400"], timeout=2400)
                if not ok or not chunk_ok(out, a, b, last):
                    log(f"FAIL ltx {px}, abort reel")
                    break
            else:
                log(f"reuse {px}")
            nn = os.path.join(WS, f".cache/{px}_n30.mp4")
            norm30(out, nn)
            ltx_parts.append(nn)
            ltx_bounds.append((a, b))
        else:
            ltx_full = os.path.join(WS, f"output/{R['tag']}_23full.mp4")
            n0 = count(ltx_parts[0])
            total = stitch(ltx_parts, ltx_bounds, ltx_full, n0[1], n0[2])
            exp = round(R["dur"] * FPS)
            got = count(ltx_full)[0]
            log(f"VALIDATE {R['tag']} LTX-full: {count(ltx_full)} "
                f"stitched={total} expected~{exp} "
                f"{'OK' if abs(got - exp) <= 8 else 'MISMATCH'}")
            # ---- upscale chunks (3s/0.5s over TRUE duration) ----
            up_parts, up_bounds = [], []
            up_spans = chunks(R["dur"], 3.0, 0.5)
            for i, (a, b) in enumerate(up_spans):
                px = f"{R['tag']}_upf{i}"
                out = os.path.join(WS, f"output/{px}.mp4")
                last = i == len(up_spans) - 1
                if not chunk_ok(out, a, b, last):
                    ok = run([*PY.split(),
                              f"{WS}/scripts/comfy_ltx_upscale.py",
                              "--input", ltx_full, "--trim-start", str(a),
                              "--trim-duration", str(round(b - a, 3)),
                              "--scale", "2", "--template", "2.3", "--seed",
                              "7", "--prefix", px, "--output", out,
                              "--timeout", "3600"], timeout=3600)
                    if not ok or not chunk_ok(out, a, b, last):
                        log(f"FAIL up {px}, abort reel")
                        break
                else:
                    log(f"reuse {px}")
                nn = os.path.join(WS, f".cache/{px}_n30.mp4")
                norm30(out, nn)
                up_parts.append(nn)
                up_bounds.append((a, b))
            else:
                up_full = os.path.join(WS, f"output/{R['tag']}_upfull.mp4")
                n0 = count(up_parts[0])
                total = stitch(up_parts, up_bounds, up_full, n0[1], n0[2])
                got = count(up_full)[0]
                log(f"VALIDATE {R['tag']} UP-full: {count(up_full)} "
                    f"stitched={total} expected~{exp} "
                    f"{'OK' if abs(got - exp) <= 8 else 'MISMATCH'}")
        # ---- TW chunks (3s/1s, 90f exact, no pad), resume-safe ----
        tw_parts, tw_bounds = [], []
        tw_spans = chunks(R["dur"], 3.0, 1.0)
        for i, (a, b) in enumerate(tw_spans):
            px = f"{R['tag']}_twf{i}"
            out = os.path.join(WS, f"output/{px}.mp4")
            last = i == len(tw_spans) - 1
            if not chunk_ok(out, a, b, last):
                ok = run([*PY.split(), f"{WS}/scripts/comfy_h3tw_outpaint.py",
                          "--input", src, "--trim-start", str(a),
                          "--trim-duration", str(round(b - a, 3)),
                          "--aspect", "1:1 square", "--min-src-mp", "0.5",
                          "--seed", "7", "--steps", "14", "--frame-cap",
                          "120", "--prefix", px, "--output", out,
                          "--timeout", "3600"], timeout=3600)
                if not ok or not chunk_ok(out, a, b, last):
                    log(f"FAIL tw {px}, abort reel")
                    break
            else:
                log(f"reuse {px}")
            nn = os.path.join(WS, f".cache/{px}_n30.mp4")
            norm30(out, nn)
            tw_parts.append(nn)
            tw_bounds.append((a, b))
        else:
            # stitch with decrush (staged dims from probed orientation)
            tw_full = os.path.join(WS, f"output/{R['tag']}_twfull.mp4")
            n0 = count(tw_parts[0])
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=width,height", "-of", "json",
                 src], stdout=subprocess.PIPE, check=True)
            ps = json.loads(probe.stdout)["streams"][0]
            sw, sh = (1248, 704) if int(ps["width"]) >= int(ps["height"]) \
                else (704, 1248)
            W0, H0 = n0[1], n0[2]
            total = stitch(tw_parts, tw_bounds, tw_full, W0, H0,
                           xform=lambda fr: decrush(fr, sw, sh, W0, H0))
            exp = round(R["dur"] * FPS)
            got = count(tw_full)[0]
            log(f"VALIDATE {R['tag']} TW-full: {count(tw_full)} "
                f"stitched={total} expected~{exp} "
                f"{'OK' if abs(got - exp) <= 8 else 'MISMATCH'}")
        log(f"--- {R['tag']} done ---")
    log("=== REELS FULL end ALLDONE")


if __name__ == "__main__":
    main()
