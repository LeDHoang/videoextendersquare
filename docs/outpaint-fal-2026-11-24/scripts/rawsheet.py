import sys, cv2, numpy as np
out, idx = sys.argv[1], int(sys.argv[2]); tiles = []
for arg in sys.argv[3:]:
    lab, p = arg.split("=", 1); c = cv2.VideoCapture(p); c.set(cv2.CAP_PROP_POS_FRAMES, idx); f = c.read()[1]
    t = cv2.resize(f, (480, 480), interpolation=cv2.INTER_AREA)
    cv2.putText(t, f"{lab} f{idx}", (8, 28), 0, 0.8, (0, 0, 0), 4); cv2.putText(t, f"{lab} f{idx}", (8, 28), 0, 0.8, (255, 255, 255), 1)
    tiles.append(t)
cv2.imwrite(out, np.hstack(tiles), [cv2.IMWRITE_JPEG_QUALITY, 90])
