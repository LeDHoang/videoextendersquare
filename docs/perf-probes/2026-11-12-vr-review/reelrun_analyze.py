"""Summarise a reelrun.mjs capture: per-switch time to a visible picture in VR, rebuffers, XR frame gaps
and media responses. usage: python3 reelrun_analyze.py <run.json>

A video switch is ready at its first decoded frame. An image switch is ready when the VR bitmap for that
src exists (fetch with cache:'reload', then createImageBitmap); until then the engine shows the old frame.
An image switch is a new post when the page fetched the following post's cover just before the src change,
when the video src was cleared at the same moment (coming from a video) or after a NEXT press; otherwise it
is the next slide of the same post. The split is a heuristic; the totals are not.
"""
import json, sys, statistics as st
from collections import Counter, defaultdict

d = json.load(open(sys.argv[1]))
ev = [e for s in d['samples'] for e in s['ev']]
ev.sort(key=lambda e: e['t'])
off = st.median(s['wall'] - s['t'] for s in d['samples'])  # wall = page t + off
press = [e['wall'] - off for e in d['events'] if e['k'] == 'press-next']
phase_next = next((e['wall'] - off for e in d['events'] if e['k'] == 'phase-next'), 1e18)
xr_start = next((e['t'] for e in ev if e['k'] == 'xr-start'), 0)

def pct(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else None

switches = []
for i, e in enumerate(ev):
    if e['t'] < xr_start: continue
    if e['k'] == 'vid-src' and e['src']:
        kind = 'video'
    elif e['k'] == 'img-src' and e['src'] and e.get('shown'):
        kind = 'image'
    else:
        continue
    switches.append((i, kind, e))

rows = []
prev_kind = 'video'
for n, (i, kind, e) in enumerate(switches):
    t, src = e['t'], e['src']
    nxt = switches[n + 1][2]['t'] if n + 1 < len(switches) else 1e18
    pressed = any(0 <= t - p <= 1500 for p in press)
    row = {'t': t, 'kind': kind, 'from': prev_kind, 'src': src, 'pressed': pressed, 'phase': 'next' if t >= phase_next else 'auto'}
    if kind == 'video':
        ff = next((x for x in ev[i:] if x['k'] == 'v-first-frame' and x['src'] == src and x['t'] >= t), None)
        row['ready_ms'] = ff['t'] - t if ff and ff['t'] < nxt + 50 else None
        row['res'] = f"{ff['w']}x{ff['h']}" if ff else None
        row['post'] = True
    else:
        before = [x for x in ev[max(0, i - 6):i] if t - x['t'] <= 3]
        from_video = any(x['k'] == 'vid-src' and not x['src'] for x in before) or prev_kind == 'video'
        prefetch_next = any(x['k'] == 'img-fetch' and x['src'] != src for x in before)
        row['post'] = from_video or prefetch_next or pressed
        # On a new post the page fetches the cover synchronously, before the MutationObserver record
        # for the src change is delivered, so the on-demand fetch can sit a few ms before t.
        lo = max(0, i - 8)
        refetch = next((x for x in ev[lo:] if x['k'] == 'img-fetch' and x['src'] == src and -10 <= x['t'] - t <= 300), None)
        bm = next((x for x in ev[lo:] if x['k'] == 'img-bitmap' and x['src'] == src and x['t'] >= refetch['t']), None) if refetch else None
        if refetch:
            row['ready_ms'] = bm['t'] - t if bm else None
            row['vr_prefetch'] = 'miss'
            hdr = next((x for x in ev[lo:] if x['k'] == 'img-headers' and x['src'] == src and x['t'] >= refetch['t']), None)
            body = next((x for x in ev[lo:] if x['k'] == 'img-body' and x['src'] == src and x['t'] >= refetch['t']), None)
            row['ttfb_ms'] = hdr['ms'] if hdr else None
            row['bytes'] = body['bytes'] if body else None
            row['decode_ms'] = bm['ms'] if bm else None
        else:
            row['ready_ms'] = 0
            row['vr_prefetch'] = 'hit'
    rows.append(row)
    prev_kind = kind

def group(name, sel):
    xs = [r['ready_ms'] for r in rows if sel(r) and r['ready_ms'] is not None]
    miss = [r for r in rows if sel(r)]
    hits = sum(1 for r in miss if r.get('vr_prefetch') == 'hit')
    print(f"{name:34s} n={len(miss):3d} p50={pct(xs,50)} p90={pct(xs,90)} max={max(xs) if xs else None}"
          + (f"  vr-prefetch hits {hits}/{len(miss)}" if miss and miss[0]['kind'] == 'image' else ''))

print('== Time to a visible new picture in VR (ms), from the src change ==')
group('video <- video', lambda r: r['kind'] == 'video' and r['from'] == 'video')
group('video <- image', lambda r: r['kind'] == 'video' and r['from'] == 'image')
group('image <- video (new post)', lambda r: r['kind'] == 'image' and r['from'] == 'video')
group('image <- image, new post', lambda r: r['kind'] == 'image' and r['from'] == 'image' and r['post'])
group('image <- image, next slide', lambda r: r['kind'] == 'image' and r['from'] == 'image' and not r['post'])
group('all, AUTO phase', lambda r: r['phase'] == 'auto')
group('all, NEXT-press phase', lambda r: r['phase'] == 'next')
print()
for r in rows:
    print(f"  t={r['t']:>7} {r['phase']:4s} {r['from']:5s}->{r['kind']:5s} {'post ' if r['post'] else 'slide'} ready={r['ready_ms']}"
          + (f" res={r['res']}" if r.get('res') else '')
          + (f" vr={r['vr_prefetch']} ttfb={r.get('ttfb_ms')} bytes={r.get('bytes')} decode={r.get('decode_ms')}" if r['kind'] == 'image' else '')
          + f" {r['src'][:46]}")

print('\n== Rebuffers after the first frame ==')
first = {}
for e in ev:
    if e['k'] == 'v-first-frame': first.setdefault(e['src'], e['t'])
rb = [e for e in ev if e['k'] == 'rebuffer-end' and e['src'] in first and e['t'] - e['ms'] > first[e['src']] + 50]
waits = [e for e in ev if e['k'] == 'v-waiting' and e['src'] in first and e['t'] > first[e['src']] + 50]
for e in rb: print(f"  t={e['t']} {e['ms']} ms at ct={e['ct']} buf={e['buf']} {e['src'][:60]}")
print(f"  waiting events after first frame: {len(waits)}; rebuffer total {sum(e['ms'] for e in rb)} ms")
stalls = [e for e in ev if e['k'] == 'v-stalled']
print(f"  'stalled' events: {len(stalls)}  errors: {[e for e in ev if e['k'] in ('v-error','img-error','img-fetch-fail','img-bitmap-fail')][:5]}")

print('\n== XR frames ==')
pres = [s for s in d['samples'] if s['presenting']]
n = sum(s['xr']['n'] for s in pres); o25 = sum(s['xr']['over25'] for s in pres); o40 = sum(s['xr']['over40'] for s in pres)
dur = (pres[-1]['wall'] - pres[0]['wall']) / 1000 if pres else 0
print(f"  presenting {dur:.0f} s, {n} frames ({n/dur if dur else 0:.1f} fps), gaps >25 ms {o25}, >40 ms {o40}, max {max((s['xr']['max'] for s in pres), default=0)} ms")
gaps = [e for e in ev if e['k'] == 'xr-gap']
near = [g for g in gaps if any(abs(g['t'] - r['t']) <= 600 for r in rows)]
print(f"  gaps >40 ms within 600 ms of a switch: {len(near)} of {len(gaps)}: {[g['ms'] for g in near][:20]}")
print(f"  left presenting during run: {sum(1 for s in d['samples'][1:] if not s['presenting'])} samples; xr-end events {sum(1 for e in ev if e['k']=='xr-end')}")
print(f"  dropped video frames (last sample per src): ", end='')
last = {}
for s in d['samples']:
    if s['cur'].startswith('vid:') and s['frames']: last[s['cur']] = (s['drop'], s['frames'])
print({k[4:40]: v for k, v in list(last.items())[:12]})
hp = [s['heap'] for s in d['samples'] if s['heap']]
print(f"  JS heap MB first/max/last: {hp[0] if hp else None}/{max(hp) if hp else None}/{hp[-1] if hp else None}")

print('\n== Media responses (CDP) ==')
net = d['net']
by = defaultdict(list)
for r in net: by[(r.get('type'), r.get('cf'))].append(r)
for k, v in sorted(by.items(), key=lambda kv: -len(kv[1])):
    tt = [r['ttfb'] for r in v if r.get('ttfb') is not None and not r.get('fromCache')]
    print(f"  {str(k):28s} n={len(v):3d} wireMB={sum(r.get('bytes') or 0 for r in v)/1e6:7.1f} ttfb p50={pct(tt,50)} p90={pct(tt,90)} fromCache={sum(1 for r in v if r.get('fromCache'))}")
dup = Counter(r['url'] for r in net if r.get('type') in ('Image', 'Fetch') and (r.get('bytes') or 0) > 10000)
print(f"  image files downloaded more than once over the wire: {sum(1 for c in dup.values() if c > 1)} of {len(dup)}; extra MB {sum((c-1) * next(r['bytes'] for r in net if r['url']==u and (r.get('bytes') or 0) > 10000) for u, c in dup.items() if c > 1)/1e6:.1f}")
vids = [r for r in net if r.get('type') == 'Media']
for r in vids[:40]:
    print(f"   media {r['url'][:58]:58s} {r.get('status')} cf={r.get('cf')} range={r.get('range')} lenMB={(r.get('len') or 0)/1e6:.1f} wireMB={(r.get('bytes') or 0)/1e6:.1f} ttfb={r.get('ttfb')} done={r.get('doneMs')} cache={r.get('fromCache')} {r.get('failed') or ''}")
print('\n== Probe events ==')
for e in d['events']:
    if e['k'] not in ('press-next',): print(' ', e['wall'], e['k'], {k: v for k, v in e.items() if k not in ('wall', 'k')})
