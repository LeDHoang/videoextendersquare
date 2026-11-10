import re,sys,statistics as st
rows=[]
for l in open(sys.argv[1],errors='ignore'):
    if 'VrApi   : FPS=' not in l: continue
    ts=l[6:18]
    g=lambda p: re.search(p,l)
    fps=g(r'FPS=(\d+)/(\d+)'); stale=g(r'Stale=(\d+)'); app=g(r'App=([\d.]+)ms'); cg=g(r'CPU&GPU=([\d.]+)ms'); gpu=g(r'GPU%=([\d.]+)'); cpu=g(r'CPU%=([\d.]+)'); lvl=g(r'CPU4/GPU=(\d+)/(\d+)'); mhz=g(r',(\d+)/(\d+)MHz'); temp=g(r'Temp=([\d.]+)C'); free=g(r'Free=(\d+)MB'); lc=g(r'LCnt=(\d+)'); tear=g(r'Tear=(\d+)'); early=g(r'Early=(\d+)'); tw=g(r'TW=([\d.]+)ms'); fov=g(r'Fov=(\d+)'); smax=g(r'Stale2/5/10/max=(\d+)/(\d+)/(\d+)/(\d+)')
    rows.append(dict(ts=ts,fps=int(fps[1]),tgt=int(fps[2]),stale=int(stale[1]),app=float(app[1]),cg=float(cg[1]),gpu=float(gpu[1]),cpu=float(cpu[1]),cl=int(lvl[1]),gl=int(lvl[2]),cm=int(mhz[1]),gm=int(mhz[2]),temp=float(temp[1]),free=int(free[1]),lc=int(lc[1]),tear=int(tear[1]),early=int(early[1]),tw=float(tw[1]),smax=int(smax[4])))
mode=sys.argv[2] if len(sys.argv)>2 else 'sum'
if mode=='all':
    for r in rows: print(r['ts'],'fps %d/%d stale %d max %d app %.1f cpu&gpu %.1f gpu%% %.2f cpu%% %.2f lvl %d/%d %d/%dMHz T %.0f free %d lc %d tear %d'%(r['fps'],r['tgt'],r['stale'],r['smax'],r['app'],r['cg'],r['gpu'],r['cpu'],r['cl'],r['gl'],r['cm'],r['gm'],r['temp'],r['free'],r['lc'],r['tear']))
else:
    a=[r for r in rows if r['tgt']==90]
    print('lines',len(rows),'at90',len(a))
    for k in ['fps','stale','app','cg','gpu','cpu','temp','free']:
        v=[r[k] for r in a]; v.sort()
        print('%5s min %.2f p50 %.2f p90 %.2f max %.2f'%(k,v[0],v[len(v)//2],v[int(len(v)*.9)],v[-1]))
