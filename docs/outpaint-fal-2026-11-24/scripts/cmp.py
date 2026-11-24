import sys, cv2, numpy as np
fal, araw, ref, mask, out = sys.argv[1:6]
m = cv2.imread(mask, 0) > 127
mi = cv2.erode(m.astype(np.uint8), np.ones((9,9),np.uint8)) > 0
caps = [cv2.VideoCapture(p) for p in (fal, araw, ref)]
stats = {"fal":[], "A":[]}; grabs = {}
def lap(f, sel): g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY); return cv2.Laplacian(g, cv2.CV_64F)[sel].var()
prev = {}
flick = {"fal":[], "A":[]}
for i in range(121):
    fr = [c.read()[1] for c in caps]
    if any(x is None for x in fr): break
    F, A, R = fr
    for k, X in (("fal",F),("A",A)):
        d = (X[mi].astype(float)-R[mi])
        psnr = 10*np.log10(255**2/np.mean(d**2))
        outside = X[~m]
        stats[k].append((psnr, outside.mean(), (outside.max(axis=1)<16).mean(), lap(X, ~m)))
        if k in prev: flick[k].append(np.abs(X[~m].astype(float)-prev[k][~m]).mean())
        prev[k] = X
    if i in (0,48,120): grabs[i] = (R,F,A)
for k,v in stats.items():
    v = np.array(v)
    print(k, "src_psnr %.2f  out_mean %.1f  out_black_frac %.3f  out_lapvar %.0f  temporal_diff %.2f" % (*v.mean(0), np.mean(flick[k])))
rows = []
for i,(R,F,A) in grabs.items():
    row = np.hstack([cv2.resize(x,(544,544)) for x in (R,F,A)])
    cv2.putText(row, f"f{i}: ref | fal | runpod A", (10,30), 0, 0.9, (0,255,255), 2)
    rows.append(row)
cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])
