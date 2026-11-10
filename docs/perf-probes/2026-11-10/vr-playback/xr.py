import json,sys,collections
d=json.load(open(sys.argv[1])); S=[x for x in d['samples'] if 't' in x]
t0=S[0]['t']
E=['<10','<12','<13','<15','<17','<20','<25','<30','<42','<60','<100','>=100']
pres=[s for s in S if s['presenting']]
print('session',json.dumps(pres[0]['sess']), 'layer',json.dumps(pres[0]['layer']))
print('last sess',json.dumps(pres[-1]['sess']))
# segments by (src, has video)
segs=[];cur=None
prev=None
for s in pres:
    kind='video' if s['rs']>=2 and not s['paused'] else 'novideo'
    key=(kind,s['src'][-28:] if kind=='video' else '', (s['sess'] or {}).get('vis'))
    if cur is None or cur['key']!=key:
        cur={'key':key,'t0':s['t'],'hist':[0]*12,'n':0,'dtMax':0,'cbMax':0,'cbSum':0,'cb8':0,'rv0':s['rvfc'],'pq0':s['pqTotal'],'drop0':s['pqDrop'],'vw':s['vw'],'vh':s['vh'],'stereo':s['stereo'],'heap':[]} ; segs.append(cur)
    x=s['xr']; cur['n']+=x['n']; cur['hist']=[a+b for a,b in zip(cur['hist'],x['hist'])]; cur['dtMax']=max(cur['dtMax'],x['dtMax']); cur['cbMax']=max(cur['cbMax'],x['cbMax']); cur['cbSum']+=x['cbAvg']*x['n']; cur['cb8']+=x['cbOver8']
    cur['t1']=s['t']; cur['rv1']=s['rvfc']; cur['pq1']=s['pqTotal']; cur['drop1']=s['pqDrop']; cur['heap'].append(s['heap'])
print('%7s %5s %-9s %-30s %6s %6s %6s %6s %6s %6s %5s  hist %s'%('t','dur','kind','src','xrfps','dtMax','>17ms','cbAvg','cbMax','vfps','heap',' '.join(E)))
tot=[0]*12
for g in segs:
    dur=(g['t1']-g['t0'])/1000+0.5
    if g['n']<5: continue
    slow=sum(g['hist'][5:]); tot=[a+b for a,b in zip(tot,g['hist'])]
    vf=(g['rv1']-g['rv0'])/dur if g['key'][0]=='video' else 0
    print('%7.1f %5.1f %-9s %-30s %6.1f %6.1f %6d %6.2f %6.1f %6.1f %5s  %s %s %sx%s %s'%((g['t0']-t0)/1000,dur,g['key'][0],g['key'][1],g['n']/dur,g['dtMax'],slow,g['cbSum']/max(1,g['n']),g['cbMax'],vf,max(h for h in g['heap'] if h is not None) if any(g['heap']) else '-',g['hist'],g['key'][2],g['vw'],g['vh'],g['stereo']))
n=sum(tot); print('TOTAL frames',n,'hist',dict(zip(E,tot)),' >=20ms: %.2f%%'%(100*sum(tot[5:])/max(1,n)))
# diag
D=d['diag']
if D:
    print('diag n',len(D),'engine',D[0].get('engine'),'features',json.dumps(D[0].get('sessionFeatures')),'uploadMode',D[0].get('uploadMode'),'flags fbs/fov',D[0]['flags'].get('fbs'),D[0]['flags'].get('fov'),'stereoEye',D[0]['flags'].get('stereoEye'))
    import statistics as st
    print('xrFrames/s median',st.median(x['xrFrames'] for x in D),'min',min(x['xrFrames'] for x in D),'dtMax max',max(x['dtMaxMs'] for x in D), 'dtMax>50 count',sum(1 for x in D if x['dtMaxMs']>50))
    vu=[x['videoUploads'] for x in D if x['videoUploads']>0]; print('videoUploads/s when>0: median',st.median(vu) if vu else None,'max',max(vu) if vu else None,'n',len(vu))
    print('stalls',sum(x.get('stalls',0) for x in D),'stallMs',sum(x.get('stallMs',0) for x in D))
    sw=collections.OrderedDict()
    for x in D:
        if x.get('switchSrc'): sw[x['switchSrc']]=(x['switchMs'],x['switchFromCache'])
    print('switch timings',json.dumps(sw))
    print('uploads/s totals: overlay',sum(x['overlayUploads'] for x in D),'dock',sum(x['dockUploads'] for x in D),'panel',sum(x['panelUploads'] for x in D),'guide',sum(x['guideUploads'] for x in D),'transNotReady',sum(x['transNotReady'] for x in D))
