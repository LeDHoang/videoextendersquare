"""Quality metrics on 90-degree headset views of each option (same FOV, same 960px output)."""
import json, os, subprocess, sys
import cv2, numpy as np

D = sys.argv[1]  # compare dir
V = os.path.join(D, "views")
OPTS = {k: "hequirect" for k in sys.argv[2].split(",")}
VIEWS = {"front": (0, 0), "left": (-50, 0), "right": (50, 0), "up": (0, 50), "down": (0, -50)}
os.makedirs(os.path.join(D, "masks_geo"), exist_ok=True)


def frames(path, gray=False):
    cap = cv2.VideoCapture(path); out = []
    while True:
        ok, f = cap.read()
        if not ok: break
        out.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) if gray else f)
    return np.array(out)


def valid_mask(proj, yaw, pitch):
    src = "color=white:s=1088x1088" if proj == "hequirect" else "color=white:s=2176x1088"
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", src, "-frames:v", "1", "-vf",
        f"v360=input={proj}:output=flat:h_fov=90:v_fov=90:yaw={yaw}:pitch={pitch}:w=960:h=960:interp=near",
        "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(960, 960) > 128


# footage = rectilinear rect fitted against the source (half-tan width, half-tan height)
FIT = {k: (432 / 960, 243 / 960) for k in OPTS}


def foot_mask(o, proj, yaw, pitch):
    tw, th = FIT[o]
    W, H = (1088, 1088) if proj == "hequirect" else (2176, 1088)
    span = 180 if proj == "hequirect" else 360
    lon = np.radians((np.arange(W) + 0.5) / W * span - span / 2)[None, :]
    lat = np.radians(90 - (np.arange(H) + 0.5) / H * 180)[:, None]
    dx, dy, dz = np.cos(lat) * np.sin(lon), np.sin(lat) + 0 * lon, np.cos(lat) * np.cos(lon)
    with np.errstate(divide="ignore", invalid="ignore"):
        m = (dz > 0) & (np.abs(dx / dz) <= tw) & (np.abs(dy / dz) <= th)
    img = (m * 255).astype(np.uint8)
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}",
        "-i", "-", "-frames:v", "1", "-vf",
        f"v360=input={proj}:output=flat:h_fov=90:v_fov=90:yaw={yaw}:pitch={pitch}:w=960:h=960:interp=near",
        "-f", "rawvideo", "-pix_fmt", "gray", "-"], input=img.tobytes(), capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(960, 960) > 128


res = {}
grid = {}
for o, proj in OPTS.items():
    acc = {"gen_px": 0}; sums = {}
    for vn, (yaw, pitch) in VIEWS.items():
        comp = frames(f"{V}/{o}_comp_{vn}.mp4"); raw = frames(f"{V}/{o}_raw_{vn}.mp4")
        cg = np.array([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in comp]).astype(np.float32)
        rg = np.array([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in raw]).astype(np.float32)
        valid = cv2.erode(valid_mask(proj, yaw, pitch).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        foot = foot_mask(o, proj, yaw, pitch) & valid
        k = np.ones((13, 13), np.uint8)
        gen = valid & ~(cv2.dilate(foot.astype(np.uint8), k) > 0)
        foot_in = cv2.erode(foot.astype(np.uint8), k) > 0
        ring_in = foot & ~foot_in
        ring_out = (cv2.dilate(foot.astype(np.uint8), k) > 0) & ~foot & valid
        cv2.imwrite(f"{D}/masks_geo/{o}_{vn}.png", (foot * 255 + gen * 90).astype(np.uint8))
        m = {}
        lap = [cv2.Laplacian(f, cv2.CV_32F, ksize=3) for f in cg[::4]]
        m["sharp_gen"] = float(np.mean([l[gen].var() for l in lap])) if gen.sum() > 500 else None
        m["sharp_foot"] = float(np.mean([l[foot_in].var() for l in lap])) if foot_in.sum() > 500 else None
        # temporal: flow-warped error between consecutive frames, at half res
        errs_g, errs_f = [], []
        small = [cv2.resize(f, (480, 480), interpolation=cv2.INTER_AREA) for f in cg]
        gs = cv2.resize(gen.astype(np.uint8), (480, 480), interpolation=cv2.INTER_NEAREST) > 0
        fs = cv2.resize(foot_in.astype(np.uint8), (480, 480), interpolation=cv2.INTER_NEAREST) > 0
        yy, xx = np.mgrid[0:480, 0:480].astype(np.float32)
        for a, b in zip(small[:-1], small[1:]):
            fl = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 4, 21, 3, 5, 1.1, 0)
            wb = cv2.remap(b, xx + fl[..., 0], yy + fl[..., 1], cv2.INTER_LINEAR)
            e = np.abs(wb - a)
            if gs.sum() > 200: errs_g.append(e[gs].mean())
            if fs.sum() > 200: errs_f.append(e[fs].mean())
        m["warp_err_gen"] = float(np.mean(errs_g)) if errs_g else None
        m["warp_err_foot"] = float(np.mean(errs_f)) if errs_f else None
        if ring_in.sum() > 200 and ring_out.sum() > 200:
            lab_f = [cv2.cvtColor(f, cv2.COLOR_BGR2LAB).astype(np.float32) for f in comp[::4]]
            m["seam_dE"] = float(np.mean([np.linalg.norm(l[ring_in].mean(0) - l[ring_out].mean(0)) for l in lab_f]))
        if foot_in.sum() > 500:
            mse = ((cg - rg)[:, foot_in] ** 2).mean()
            m["raw_vs_source_psnr"] = float(10 * np.log10(255 ** 2 / mse))
        m["gen_px"] = int(gen.sum()); m["foot_px"] = int(foot.sum())
        sums[vn] = m
        grid[(o, vn)] = comp[int(sys.argv[3])]
        print(o, vn, json.dumps({k: (round(v, 2) if isinstance(v, float) else v) for k, v in m.items()}), flush=True)
    res[o] = sums
json.dump(res, open(f"{D}/metrics_geo.json", "w"), indent=1)

# contact sheet: rows = options, cols = views, frame N
T = 360
rows = []
for o in OPTS:
    tiles = []
    for vn in VIEWS:
        t = cv2.resize(grid[(o, vn)], (T, T), interpolation=cv2.INTER_AREA)
        cv2.putText(t, f"{o} {vn}", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4)
        cv2.putText(t, f"{o} {vn}", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 1)
        tiles.append(t)
    rows.append(np.hstack(tiles))
cv2.imwrite(f"{D}/views_frame{sys.argv[3]}.jpg", np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 92])
