import re,sys,statistics as st,json
def parse(path):
    phase=None; idx=0; out=[]
    for l in open(path,errors='ignore'):
        m=re.search(r'ABMARK\s*:\s*phase (\S+)',l)
        if m: phase=None if m[1]=='none' else m[1]; idx+=1; skip=1; continue
        m=re.search(r'ABMARK\s*:\s*result (\S+) (\S+)',l)
        if m:
            if m[2]=='dirty': out=[r for r in out if r['idx']!=idx-1]
            continue
        if 'FPS=' not in l or phase is None: continue
        if skip: skip-=1; continue   # first 1 s line straddles the phase edge
        g=lambda p: re.search(p,l)
        out.append(dict(phase=phase,idx=idx,fps=int(g(r'FPS=(\d+)/')[1]),tgt=int(g(r'FPS=\d+/(\d+)')[1]),stale=int(g(r'Stale=(\d+)')[1]),app=float(g(r'App=([\d.]+)ms')[1]),gpu=float(g(r'GPU%=([\d.]+)')[1]),cpu=float(g(r'CPU%=([\d.]+)')[1]),lvl=g(r'CPU4/GPU=(\d+/\d+)')[1],mhz=g(r',(\d+/\d+)MHz')[1],fov=g(r'Fov=(\d+)')[1],temp=float(g(r'Temp=([\d.]+)C')[1])))
    return out
for path in sys.argv[1:]:
    rows=parse(path); print(path.split('/')[-2])
    keys=[]
    for r in rows:
        k=(r['idx'],r['phase'])
        if k not in keys: keys.append(k)
    for k in keys:
        a=[r for r in rows if (r['idx'],r['phase'])==k]
        med=lambda f: st.median([r[f] for r in a])
        print('  %-6s n=%2d fps %5.1f/%d (min %d) stale/s %5.1f appGPU %5.2f ms (max %.2f) gpu%% %.2f cpu%% %.2f lvl %s %sMHz fov %s T %.0f'%(k[1],len(a),med('fps'),a[0]['tgt'],min(r['fps'] for r in a),med('stale'),med('app'),max(r['app'] for r in a),med('gpu'),med('cpu'),a[-1]['lvl'],a[-1]['mhz'],a[-1]['fov'],a[-1]['temp']))
