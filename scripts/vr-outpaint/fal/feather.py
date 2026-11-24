# Same simple composite for any raw: source pasted back with a 12 px inward feather, no tone match.
import sys, cv2, numpy as np
raw, ref, mask, out = sys.argv[1:5]
m = (cv2.imread(mask, 0) > 127).astype(np.uint8)
a = np.clip(cv2.distanceTransform(m, cv2.DIST_L2, 5) / 12.0, 0, 1)[..., None]
cr, cs = cv2.VideoCapture(raw), cv2.VideoCapture(ref)
vw = cv2.VideoWriter(out + ".tmp.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 24, (1088, 1088))
while True:
    o1, g = cr.read(); o2, s = cs.read()
    if not (o1 and o2): break
    vw.write((a * s + (1 - a) * g).astype(np.uint8))
vw.release()
