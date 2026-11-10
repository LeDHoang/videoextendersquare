import json,sys
d=json.load(open(sys.argv[1])); d['samples']=[x for x in d['samples'] if 't' in x]
t0=d['samples'][0]['t']; w0=d['samples'][0]['wall']
rows=[]
for m in d['marks']:
    rows.append((m['t'],'MARK '+m['name']+' '+json.dumps({k:v for k,v in m.items() if k not in('name','t','wall')})))
for s in d['samples']:
    for e in s.get('ev',[]):
        rows.append((e['t'],'  ev %-14s %s'%(e['k'],json.dumps({k:v for k,v in e.items() if k not in('k','t')}))))
last=None
for s in d['samples']:
    key=(s['src'],s['rs'],s['paused'],s['stereo'],s['presenting'],s['vw'])
    if key!=last:
        rows.append((s['t'],'    state src=%s blob=%s %dx%d rs=%d ns=%d paused=%s stereo=%s pres=%s ct=%.1f/%.1f buf=%.1f'%(s['src'][-40:],s['blob'],s['vw'],s['vh'],s['rs'],s['ns'],s['paused'],s['stereo'],s['presenting'],s['ct'],s['dur'],s['bufEnd']))); last=key
rows.sort(key=lambda r:r[0])
for t,r in rows: print('%7.1f %s'%((t-t0)/1000,r))
