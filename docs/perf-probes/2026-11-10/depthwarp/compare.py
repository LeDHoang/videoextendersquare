#!/usr/bin/env python3
"""Old (baked right eye) vs new (colour+depth, warped at playback) 3D pipeline.

For each clip it runs process_video_spatial twice with production defaults
(H.264 CRF 20, full SBS): once as before, once with depth_pack=True. It times
each stage, then decodes both outputs and measures, on sampled frame pairs:

  depth codec error   decoded grey vs the clean nearness, in disparity px
  seam bleed          error in the depth columns next to the colour/depth seam,
                      and in the colour columns next to it
  flicker             frame-to-frame depth change that the clean depth lacks
  warp artefacts      new: a numpy port of the webxr_vr.js 'sbsd' shader gives
                      per-eye stretch (smear), fold and unconverged pixels;
                      old: hole pixels the splat left for background_fill
  method difference   old right eye vs the port warping the right eye alone

usage: <repo>/.venv/bin/python docs/perf-probes/2026-11-10/depthwarp/compare.py \
           --work <scratch dir> [--clips name=path[:seconds[:size]] ...]
Writes summary.json, summary.md and crops/*.png next to this script. Videos
stay in --work."""
import argparse, json, os, subprocess, sys, time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "../../../.."))
sys.path.insert(0, REPO)
from pipeline import spatial_worker as sw  # noqa: E402

ITERS = 3                       # fixed-point refinements in the shader
EDGE_GRAD = 0.02                # nearness change per px that counts as a depth edge


# ─── Shader port ──────────────────────────────────────────────────────────

def _sample(img, cx, rows):
    """Bilinear lookup at continuous x (pixel centres at i + 0.5), like texture2D."""
    return cv2.remap(img, (cx - 0.5).astype(np.float32), rows, cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REPLICATE)


def warp_eye(colour, near, shift_px, clamp=True):
    """One eye of the 'sbsd' shader. colour (H,E,3) float32, near (H,E) float32,
    shift_px = eyeSign * 0.5 * MAX_SHIFT * strength * E. Returns the eye and
    per-pixel stats: sx (lookup x), residual (px), clamped mask."""
    H, E = near.shape
    x = np.broadcast_to(np.arange(E, dtype=np.float32) + 0.5, (H, E))
    rows = np.broadcast_to(np.arange(H, dtype=np.float32)[:, None], (H, E)).astype(np.float32)
    lo, hi = (0.002 * E, 0.998 * E) if clamp else (-1e9, 1e9)
    sx = x.copy()
    for _ in range(ITERS):
        sx = x - shift_px * (1.0 - _sample(near, np.clip(sx, lo, hi), rows))
    residual = np.abs(x - shift_px * (1.0 - _sample(near, np.clip(sx, lo, hi), rows)) - sx)
    final = np.clip(sx, lo, hi)
    eye = _sample(colour, final, rows)
    return eye, final, residual, (sx < lo) | (sx > hi)


def warp_stats(sx, residual, clamped):
    d = np.diff(sx, axis=1)
    return {
        "stretch_pct": 100 * float((d < 0.5).mean()),     # one source px drawn over >2 output px: smear
        "fold_pct": 100 * float((d < 0).mean()),          # lookup runs backwards: content drawn twice
        "unconverged_pct": 100 * float((residual > 0.5).mean()),
        "clamped_pct": 100 * float(clamped.mean()),
    }


# ─── Helpers ──────────────────────────────────────────────────────────────

def psnr(a, b, mask=None):
    e = (a.astype(np.float32) - b.astype(np.float32)) ** 2
    if mask is not None:
        e = e[mask]
    m = float(e.mean())
    return 99.0 if m == 0 else round(10 * np.log10(255 ** 2 / m), 2)


def edge_mask(near):
    g = np.abs(cv2.Sobel(near.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)) / 4
    return cv2.dilate((g > EDGE_GRAD).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)


def decode_frames(path, w, h, matrix, want):
    out = {}
    for i, f in enumerate(sw._decode(path, w, h, matrix)):
        if i in want:
            out[i] = f
        if i >= max(want):
            break
    return out


def cut_clip(src, dst, seconds, size):
    vf = f"scale={size}:{size}:flags=lanczos" if size else "null"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-t", str(seconds), "-vf", vf,
                    "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p",
                    "-an", dst], check=True)


class Timers:
    """Wraps the worker's stage functions with perf_counter accumulators and
    keeps copies of the clean nearness and old right eye for sampled frames."""

    def __init__(self, want):
        self.want = want
        self.orig = (sw._depth_video, sw.condition_depth, sw.render_right_eye)

    def __enter__(self):
        self.t = {"depth": 0.0, "condition": 0.0, "render": 0.0}
        self.clean, self.right, self.n = {}, {}, 0
        dv, cd, rr = self.orig

        def depth_video(*a, **k):
            t = time.perf_counter(); r = dv(*a, **k); self.t["depth"] += time.perf_counter() - t; return r

        def condition(*a, **k):
            t = time.perf_counter(); r = cd(*a, **k); self.t["condition"] += time.perf_counter() - t
            if self.n in self.want:
                self.clean[self.n] = r.astype(np.float32)
            self.n += 1
            return r

        def render(*a, **k):
            t = time.perf_counter(); r = rr(*a, **k); self.t["render"] += time.perf_counter() - t
            if self.n - 1 in self.want:
                self.right[self.n - 1] = r
            return r

        sw._depth_video, sw.condition_depth, sw.render_right_eye = depth_video, condition, render
        return self

    def __exit__(self, *exc):
        sw._depth_video, sw.condition_depth, sw.render_right_eye = self.orig


def convert(src, out, depth_pack, want):
    with Timers(want) as tm:
        t = time.perf_counter()
        _, metrics = sw.process_video_spatial(src, out, depth_pack=depth_pack)
        total = time.perf_counter() - t
    n = metrics["frames"]
    stages = {k: round(v, 2) for k, v in tm.t.items()}
    stages["other"] = round(total - sum(tm.t.values()), 2)
    return {
        "total_s": round(total, 2), "frames": n, "ms_per_frame": round(1000 * total / n, 1),
        "stages_s": stages, "bytes": os.path.getsize(out), "resolution": metrics["resolution"],
        "engine": metrics["engine"],
    }, tm


# ─── One clip ─────────────────────────────────────────────────────────────

def run_clip(name, src, work, pair_every, crops_dir, repeat):
    info = sw._probe(src)
    rw, rh, crop = sw.eye_geometry(info["width"], info["height"])
    E, Eh = rw - 2 * crop, rh - 2 * crop
    n_frames = int(round(info["duration"] * info["fps"]))
    want = sorted({i + d for i in range(0, n_frames - 1, pair_every) for d in (0, 1)})
    want = [i for i in want if i < n_frames - 1]

    old_out, new_out = os.path.join(work, f"{name}.old.mp4"), os.path.join(work, f"{name}.new.mp4")
    print(f"[{name}] {info['width']}x{info['height']} {info['duration']:.1f}s render {rw} eye {E}", flush=True)
    # Interleaved repeats; the faster run of each mode is the time reported.
    t_old, tm_old = convert(src, old_out, False, want)
    t_new, tm_new = convert(src, new_out, True, want)
    for _ in range(repeat - 1):
        t_old = min(t_old, convert(src, old_out, False, set())[0], key=lambda r: r["total_s"])
        t_new = min(t_new, convert(src, new_out, True, set())[0], key=lambda r: r["total_s"])
    print(f"[{name}] old {t_old['total_s']}s new {t_new['total_s']}s", flush=True)
    want = sorted(set(tm_new.clean) & set(tm_old.right))

    src_f = decode_frames(src, rw, rh, info["matrix"], set(want))
    old_f = decode_frames(old_out, 2 * E, Eh, sw._probe(old_out)["matrix"], set(want))
    new_f = decode_frames(new_out, 2 * E, Eh, sw._probe(new_out)["matrix"], set(want))

    c = slice(crop, rh - crop), slice(crop, rw - crop)
    acc = {k: [] for k in ("err_all", "err_edge", "err_flat", "seam_depth", "seam_colour", "flicker_all",
                           "flicker_edge")}
    st = {k: [] for k in ("new_dec", "new_clean", "old_holes", "old_stretch", "method_all", "method_edge",
                          "depth_codec_eye_psnr", "old_codec_psnr", "new_colour_psnr")}
    s_eye = 0.5 * sw.MAX_SHIFT * E
    to_px = sw.MAX_SHIFT * E                       # nearness 1.0 = this much disparity between the eyes
    best = (-1, None)
    prev = None
    for i in want:
        clean = tm_new.clean[i][c]
        dec = new_f[i][:, E:, 1].astype(np.float32) / 255
        colour = new_f[i][:, :E].astype(np.float32)
        edge = edge_mask(clean)
        err = np.abs(dec - clean) * to_px
        acc["err_all"].append(err.ravel())
        acc["err_edge"].append(err[edge])
        acc["err_flat"].append(err[~edge])
        acc["seam_depth"].append(err[:, :48].mean(axis=0))
        acc["seam_colour"].append(np.abs(colour - src_f[i][c].astype(np.float32)).mean(axis=(0, 2))[-48:])
        st["new_colour_psnr"].append(psnr(colour, src_f[i][c]))
        if prev is not None and prev[0] == i - 1:
            fl = np.abs((dec - prev[1]) - (clean - prev[2])) * to_px
            acc["flicker_all"].append(fl.ravel())
            acc["flicker_edge"].append(fl[edge])
        prev = (i, dec, clean)

        eyes = {}
        for tag, near in (("dec", dec), ("clean", clean)):
            per = []
            for sign in (-1, 1):
                eye, sx, res, cl = warp_eye(colour, near, sign * s_eye)
                per.append(warp_stats(sx, res, cl))
                eyes[(tag, sign)] = (eye, sx, res)
            st["new_dec" if tag == "dec" else "new_clean"].append(
                {k: (per[0][k] + per[1][k]) / 2 for k in per[0]})
        for sign in (-1, 1):
            st["depth_codec_eye_psnr"].append(psnr(eyes[("dec", sign)][0], eyes[("clean", sign)][0]))

        # Old holes and the method difference, both at render size like the worker.
        d_full = tm_new.clean[i]
        fx = rw * sw.MAX_SHIFT * (1 - d_full)
        holes = (sw.softsplat(src_f[i], fx, sw.NEAR_IMPORTANCE * d_full)[1] <= 0)[c]
        st["old_holes"].append(100 * float(holes.mean()))
        # Same smear criterion as the warp: one source px spread over >2 output px.
        st["old_stretch"].append(100 * float((np.diff(fx, axis=1) > 1)[c[0], c[1]][:, :-1].mean()))
        port_r = warp_eye(src_f[i].astype(np.float32), d_full, sw.MAX_SHIFT * rw, clamp=False)[0][c]
        old_r = tm_old.right[i][c]
        st["method_all"].append(psnr(port_r, old_r))
        st["method_edge"].append(psnr(port_r, old_r, edge))
        st["old_codec_psnr"].append(psnr(old_f[i][:, E:], old_r))

        if edge.mean() > best[0]:
            best = (edge.mean(), dict(i=i, src=src_f[i][c], clean=clean, dec=dec, holes=holes, edge=edge,
                                      old_l=old_f[i][:, :E], old_r=old_f[i][:, E:],
                                      new_l=eyes[("dec", -1)][0], new_r=eyes[("dec", 1)][0],
                                      new_sx=eyes[("dec", 1)][1], new_res=eyes[("dec", 1)][2]))

    cat = {k: np.concatenate(v) if v and v[0].ndim == 1 and k not in ("seam_depth", "seam_colour") else v
           for k, v in acc.items()}

    def dist(a):
        return {"mean": round(float(a.mean()), 3), "p99": round(float(np.percentile(a, 99)), 3),
                "max": round(float(a.max()), 3)}

    def avg(rows):
        return {k: round(float(np.mean([r[k] for r in rows])), 3) for k in rows[0]}

    seam_d = np.mean(acc["seam_depth"], axis=0)
    seam_c = np.mean(acc["seam_colour"], axis=0)
    result = {
        "source": os.path.relpath(src, REPO) if src.startswith(REPO) else os.path.basename(src),
        "duration_s": round(info["duration"], 2), "render": f"{rw}x{rh}", "eye_px": E,
        "sampled_frames": len(want),
        "old": t_old, "new": t_new,
        "speedup": round(t_old["total_s"] / t_new["total_s"], 2),
        "size_ratio": round(t_new["bytes"] / t_old["bytes"], 3),
        "depth_codec_err_px": {"all": dist(cat["err_all"]), "edges": dist(cat["err_edge"]),
                               "flat": dist(cat["err_flat"])},
        "flicker_px": {"all": dist(cat["flicker_all"]), "edges": dist(cat["flicker_edge"])}
        if acc["flicker_all"] else None,
        "seam": {
            "depth_err_px_cols_0_8_16_32": [round(float(seam_d[j]), 3) for j in (0, 8, 16, 32)],
            "depth_err_px_interior": round(float(cat["err_flat"].mean()), 3),
            "colour_err_cols_from_seam_1_8_16_32": [round(float(seam_c[-j]), 2) for j in (1, 8, 16, 32)],
        },
        "new_colour_psnr_db": round(float(np.mean(st["new_colour_psnr"])), 2),
        "new_warp_decoded_depth": avg(st["new_dec"]),
        "new_warp_clean_depth": avg(st["new_clean"]),
        "new_eye_psnr_decoded_vs_clean_depth_db": round(float(np.mean(st["depth_codec_eye_psnr"])), 2),
        "old_hole_pct": round(float(np.mean(st["old_holes"])), 3),
        "old_stretch_pct": round(float(np.mean(st["old_stretch"])), 3),
        "old_right_codec_psnr_db": round(float(np.mean(st["old_codec_psnr"])), 2),
        "method_psnr_db": {"all": round(float(np.mean(st["method_all"])), 2),
                           "edges": round(float(np.mean(st["method_edge"])), 2)},
    }
    save_crop(name, best[1], crops_dir, E)
    result["crop_frame"] = best[1]["i"]
    return result


# ─── Crops ────────────────────────────────────────────────────────────────

def save_crop(name, f, crops_dir, E, size=256):
    dens = cv2.boxFilter(f["edge"].astype(np.float32), -1, (size, size))
    y, x = np.unravel_index(np.argmax(dens), dens.shape)
    y0 = int(np.clip(y - size // 2, 0, f["edge"].shape[0] - size))
    x0 = int(np.clip(x - size // 2, 0, E - size))
    win = (slice(y0, y0 + size), slice(x0, x0 + size))

    def rgb(a):
        return np.clip(a, 0, 255).astype(np.uint8)

    def grey(a):
        return np.repeat(rgb(a * 255)[..., None], 3, axis=2)

    def mask(m):
        return np.repeat((m * 255).astype(np.uint8)[..., None], 3, axis=2)

    def ana(l, r):
        return np.stack([rgb(l)[..., 0], rgb(r)[..., 1], rgb(r)[..., 2]], axis=-1)

    stretch = np.zeros_like(f["dec"], bool)
    stretch[:, 1:] = np.diff(f["new_sx"], axis=1) < 0.5
    cells = [
        [("source", rgb(f["src"])), ("clean depth", grey(f["clean"])), ("decoded depth", grey(f["dec"]))],
        [("old L", rgb(f["old_l"])), ("old R (baked)", rgb(f["old_r"])), ("old anaglyph", ana(f["old_l"], f["old_r"]))],
        [("new L (warp)", rgb(f["new_l"])), ("new R (warp)", rgb(f["new_r"])), ("new anaglyph", ana(f["new_l"], f["new_r"]))],
        [("old holes (filled)", mask(f["holes"])), ("new R stretch <0.5", mask(stretch)),
         ("new R unconverged", mask(f["new_res"] > 0.5))],
    ]
    rows = []
    for row in cells:
        out = []
        for label, img in row:
            tile = np.ascontiguousarray(cv2.resize(img[win], (size * 2, size * 2), interpolation=cv2.INTER_NEAREST))
            cv2.putText(tile, label, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4, cv2.LINE_AA)
            cv2.putText(tile, label, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2, cv2.LINE_AA)
            out.append(tile)
        rows.append(np.concatenate(out, axis=1))
    grid = np.concatenate(rows, axis=0)
    os.makedirs(crops_dir, exist_ok=True)
    cv2.imwrite(os.path.join(crops_dir, f"{name}.png"), cv2.cvtColor(grid, cv2.COLOR_RGB2BGR),
                [cv2.IMWRITE_PNG_COMPRESSION, 9])


# ─── GPU cross-check ──────────────────────────────────────────────────────

def gpu_check(work, strength=1.0):
    """Compare harness.html's GPU eyes with the numpy port run on the same
    browser-decoded frame. 'flat' is the unwarped colour, for scale."""
    def load(n):
        return cv2.cvtColor(cv2.imread(os.path.join(work, n)), cv2.COLOR_BGR2RGB).astype(np.float32)

    raw = load("gpu_raw.png")
    E = raw.shape[1] // 2
    colour, near = raw[:, :E], raw[:, E:, 1] / 255
    edge = edge_mask(near)
    out = {"eye_px": E, "edge_pct": round(100 * float(edge.mean()), 2)}
    for tag, sign in (("L", -1), ("R", 1)):
        gpu = load(f"gpu_{tag}.png")
        port = warp_eye(colour, near, sign * 0.5 * sw.MAX_SHIFT * strength * E)[0]
        out[tag] = {"port_psnr": psnr(gpu, port), "port_psnr_edges": psnr(gpu, port, edge),
                    "flat_psnr": psnr(gpu, colour), "flat_psnr_edges": psnr(gpu, colour, edge),
                    "port_p99_abs": round(float(np.percentile(np.abs(gpu - port), 99)), 1)}
    return out


# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--clips", nargs="+", default=[], help="name=path[:seconds[:size]]")
    ap.add_argument("--gpu-check", action="store_true", help="compare harness.html captures in --work")
    ap.add_argument("--pair-every", type=int, default=10)
    ap.add_argument("--repeat", type=int, default=2)
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    if a.gpu_check:
        print(json.dumps(gpu_check(a.work), indent=1))
        return

    print("loading depth model", flush=True)
    sw._depth_model()
    out = {"date": time.strftime("%Y-%m-%d"), "clips": {}}
    out_path = os.path.join(HERE, "summary.json")
    for spec in a.clips:
        name, rest = spec.split("=", 1)
        parts = rest.split(":")
        path, secs = parts[0], float(parts[1]) if len(parts) > 1 else 5
        size = int(parts[2]) if len(parts) > 2 else 1080
        clip = os.path.join(a.work, f"{name}.src.mp4")
        if not os.path.exists(clip):
            cut_clip(path, clip, secs, size)
        if not out["clips"]:
            sw._depth_video([f for _, f in zip(range(8), sw._decode(clip, 518, 518, "bt709"))], 30.0)  # warm MPS
        out["clips"][name] = run_clip(name, clip, a.work, a.pair_every, os.path.join(HERE, "crops"), a.repeat)
        out["clips"][name]["source"] = os.path.basename(path)
        with open(out_path, "w") as fh:
            json.dump(out, fh, indent=1)
        print(json.dumps(out["clips"][name], indent=1), flush=True)


if __name__ == "__main__":
    main()
