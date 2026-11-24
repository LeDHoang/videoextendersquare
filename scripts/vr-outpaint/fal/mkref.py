import sys, cv2, numpy as np
src, out, nfr = sys.argv[1], sys.argv[2], int(sys.argv[3])
W = H = 1088; tw, th = 432/960, 243/960
lon = np.radians((np.arange(W)+0.5)/W*180-90)[None,:]; lat = np.radians(90-(np.arange(H)+0.5)/H*180)[:,None]
dx, dy, dz = np.cos(lat)*np.sin(lon), np.sin(lat)+0*lon, np.cos(lat)*np.cos(lon)
with np.errstate(divide="ignore", invalid="ignore"):
    x, y = dx/dz, dy/dz
    m = (dz > 0) & (np.abs(x) <= tw) & (np.abs(y) <= th)
cap = cv2.VideoCapture(src); sw, sh = int(cap.get(3)), int(cap.get(4))
mx = np.where(m, (x/tw+1)/2*sw-0.5, -1).astype(np.float32); my = np.where(m, (-y/th+1)/2*sh-0.5, -1).astype(np.float32)
vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), 24, (W, H))
for i in range(nfr):
    ok, f = cap.read()
    if not ok: break
    e = cv2.remap(f, mx, my, cv2.INTER_AREA if False else cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    e[~m] = 0; vw.write(e)
vw.release(); cv2.imwrite(out + ".mask.png", (m*255).astype(np.uint8)); print("frac", m.mean())
