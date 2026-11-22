import json,sys,collections
d=json.load(open(sys.argv[1])); S=[s for s in d['samples'] if not s.get('timeout')]; off=d['t0pt']
segs=[];cur=None
for s in S:
    k=s['src'] if s['vid'] else None
    if k!=(cur and cur['src']):
        if cur: segs.append(cur)
        cur={'src':k,'a':s['t'],'ss':[]} if k else None
    if cur: cur['ss'].append(s)
if cur: segs.append(cur)
mv=d['mv'] or []
print(f"{'video':42} {'dur':>5} {'MB':>5} {'Mbps':>5} {'dl_s':>5} {'first':>5} {'stall#':>6} {'stall_s':>7} {'endhang_s':>9} {'shown_s':>7} drop/tot")
for g in segs:
    ss=g['ss']; a=g['a']; z=ss[-1]['t']; src=g['src']
    dur=max(s['dur'] for s in ss)
    first=next((s['t']-a for s in ss if s['ct']>0.05),None)
    endhang=sum(1 for s in ss if dur and s['ct']>=dur-0.15 and not s['ended'])*0.4
    ev=[e for e in mv if e['src']==src and a<=e['t']-off<=z+500]
    w=[e for e in ev if e['k']=='waiting' and e['ct']>0.05]
    # stall time: samples where ct not advancing while not at end
    st=0
    for p,q in zip(ss,ss[1:]):
        if q['ct']==p['ct'] and not q['paused'] and q['ct']>0.05 and q['ct']<dur-0.15: st+=(q['t']-p['t'])/1000
    r=[x for x in d['reqs'] if x['url'].endswith(src.split('/')[-1][-30:]) and x['at']>=a-30000]
    mb=sum(x['b'] for x in r)/1e6
    dl=max([ (x.get('end') or z)-x['at'] for x in r] or [0])/1000
    q=ss[-1]
    print(f"{src[-42:]:42} {dur:5.1f} {mb:5.1f} {mb*8/dur if dur else 0:5.1f} {dl:5.1f} {(first or 0)/1000:5.1f} {len(w):6d} {st:7.1f} {endhang:9.1f} {(z-a)/1000:7.1f} {q.get('drop')}/{q.get('tot')}")
