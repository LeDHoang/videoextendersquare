import sys, cv2, numpy as np
# usage: tint.py mask.png label=video ...  -> LAB L*,a*,b* means in generated area (mask==0) and source area (mask==1), sampled every 6th frame
m = cv2.imread(sys.argv[1], 0) > 127
for arg in sys.argv[2:]:
    lab, path = arg.split("=", 1)
    cap = cv2.VideoCapture(path); i = 0; g = []; s = []
    while True:
        ok, f = cap.read()
        if not ok: break
        if i % 6 == 0:
            L = cv2.cvtColor(f, cv2.COLOR_BGR2LAB).astype(np.float32)
            L[..., 0] *= 100/255; L[..., 1:] -= 128
            nz = L[..., 0] > 3  # skip pure-black frame border
            g.append(L[~m & nz].mean(0)); s.append(L[m].mean(0))
        i += 1
    g, s = np.mean(g, 0), np.mean(s, 0)
    print(f"{lab:10s} frames={i:4d} gen L={g[0]:5.1f} a={g[1]:+5.2f} b={g[2]:+5.2f} | src L={s[0]:5.1f} a={s[1]:+5.2f} b={s[2]:+5.2f}")
