"""Full-reference perceptual fidelity of the PRESERVED-CENTER region vs true source.

Answers: how faithfully does each outpaint pipeline keep the original content?
For each output we derive the letterbox geometry (source scaled to fit inside
the canvas, centered), crop that center rectangle, resize the true source frame
at the SAME timestamp to it, and score:
  LPIPS (alex) : perceptual distance, lower = closer to source (the decisive one)
  SSIM         : structural similarity, higher = better
  PSNR         : dB, higher = better
  NCC          : luma cross-correlation (legacy, for continuity with the doc)
Frames sampled uniformly across the clip (default 24), aligned by timestamp.

Usage: fidelity.py SOURCE srcW srcH  out1.mp4 W1 H1 label1  [out2 W2 H2 label2 ...]
"""
import sys

import cv2
import numpy as np
import torch
import lpips
from skimage.metrics import structural_similarity as ssim
from skimage.metrics import peak_signal_noise_ratio as psnr

_LP = None


def lp():
    global _LP
    if _LP is None:
        _LP = lpips.LPIPS(net='alex', verbose=False)
        if torch.cuda.is_available():
            _LP = _LP.cuda()
    return _LP


def center_rect(W, H, sw, sh):
    s = min(W / sw, H / sh)
    dw, dh = int(round(sw * s)), int(round(sh * s))
    x0, y0 = (W - dw) // 2, (H - dh) // 2
    return x0, y0, dw, dh


def to_lpips(bgr):
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 127.5 - 1.0
    t = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0)
    return t.cuda() if torch.cuda.is_available() else t


def ncc(a, b):
    a = a.astype(np.float32).ravel() - a.mean()
    b = b.astype(np.float32).ravel() - b.mean()
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float(a @ b / d) if d else 0.0


def eval_clip(src, sw, sh, out, W, H, n_probes):
    scap, ocap = cv2.VideoCapture(src), cv2.VideoCapture(out)
    sfps = scap.get(cv2.CAP_PROP_FPS)
    ofps = ocap.get(cv2.CAP_PROP_FPS)
    sN = int(scap.get(cv2.CAP_PROP_FRAME_COUNT))
    oN = int(ocap.get(cv2.CAP_PROP_FRAME_COUNT))
    dur = min(sN / sfps, oN / ofps)
    x0, y0, dw, dh = center_rect(W, H, sw, sh)
    times = [dur * (i + 0.5) / n_probes for i in range(n_probes)]
    L, S, P, N = [], [], [], []
    for t in times:
        scap.set(cv2.CAP_PROP_POS_FRAMES, min(int(t * sfps), sN - 1))
        oks, sf = scap.read()
        ocap.set(cv2.CAP_PROP_POS_FRAMES, min(int(t * ofps), oN - 1))
        oko, of = ocap.read()
        if not (oks and oko):
            continue
        center = of[y0:y0 + dh, x0:x0 + dw]
        srcr = cv2.resize(sf, (dw, dh), interpolation=cv2.INTER_AREA)
        # match global tone so we score STRUCTURE, not exposure (VAE tone shift)
        for c in range(3):
            m = srcr[:, :, c].mean() - center[:, :, c].mean()
            center[:, :, c] = np.clip(center[:, :, c].astype(np.float32) + m,
                                      0, 255).astype(np.uint8)
        with torch.no_grad():
            L.append(float(lp()(to_lpips(center), to_lpips(srcr)).item()))
        gc = cv2.cvtColor(center, cv2.COLOR_BGR2GRAY)
        gs = cv2.cvtColor(srcr, cv2.COLOR_BGR2GRAY)
        S.append(float(ssim(gs, gc)))
        P.append(float(psnr(gs, gc, data_range=255)))
        N.append(ncc(gc, gs))
    scap.release()
    ocap.release()
    return (np.mean(L), np.mean(S), np.mean(P), np.mean(N))


def main():
    src, sw, sh = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    rest = sys.argv[4:]
    n = 24
    print(f"source {src} {sw}x{sh}, {n} probes, center-region full-reference")
    print(f"{'pipeline':14s} {'LPIPS↓':>8s} {'SSIM↑':>7s} {'PSNR↑':>7s} {'NCC↑':>7s}")
    for i in range(0, len(rest), 4):
        out, W, H, label = rest[i], int(rest[i+1]), int(rest[i+2]), rest[i+3]
        lp_, ss, ps, nc = eval_clip(src, sw, sh, out, W, H, n)
        print(f"{label:14s} {lp_:8.4f} {ss:7.4f} {ps:7.2f} {nc:7.4f}")


if __name__ == "__main__":
    main()
