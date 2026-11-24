import sys, cv2, numpy as np
m = cv2.erode((cv2.imread(sys.argv[1], 0) > 127).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
ref = sys.argv[2]
for arg in sys.argv[3:]:
    lab, p = arg.split("=", 1); a, b = cv2.VideoCapture(p), cv2.VideoCapture(ref); ps = []
    while True:
        o1, x = a.read(); o2, y = b.read()
        if not (o1 and o2): break
        ps.append(10 * np.log10(255**2 / max(np.mean((x[m].astype(float) - y[m]) ** 2), 1e-6)))
    ps = np.array(ps); q = len(ps) // 4
    print(f"{lab:8s} src PSNR mean {ps.mean():5.2f}  by quarter " + " ".join(f"{ps[i*q:(i+1)*q].mean():5.2f}" for i in range(4)))
