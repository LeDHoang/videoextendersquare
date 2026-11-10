"""Summarize run3 verify passes: python3 analyze.py <out_dir>/<pass> [...]"""
import json, sys, os, re, statistics as st, collections


def vrapi_parse(path):
    """VrApi FPS lines tagged with the latest ABMARK phase (same rules as ../abparse.py)."""
    phase = None; skip = 0; out = []
    for l in open(path, errors='ignore'):
        m = re.search(r'ABMARK\s*:\s*phase (\S+)', l)
        if m:
            phase = None if m[1] == 'none' else m[1]; skip = 1; continue
        if 'FPS=' not in l or phase is None:
            continue
        if skip:
            skip -= 1; continue  # first 1 s line straddles the phase edge
        g = lambda p: re.search(p, l)
        out.append(dict(phase=phase, fps=int(g(r'FPS=(\d+)/')[1]), stale=int(g(r'Stale=(\d+)')[1]),
                        app=float(g(r'App=([\d.]+)ms')[1]), gpu=float(g(r'GPU%=([\d.]+)')[1]), temp=float(g(r'Temp=([\d.]+)C')[1])))
    return out

med = lambda xs: round(st.median(xs), 2) if xs else None


def summarize(d):
    c = json.load(open(os.path.join(d, 'capture.json')))
    marks, S, D = c['marks'], c['samples'], c['diag']
    out = {'pass': os.path.basename(d), 'engine': c['engine'], 'query': c['query'], 'override': c['override']}

    # VrApi per reel phase (logcat ABMARK phases r<i>)
    rows = vrapi_parse(os.path.join(d, 'logcat.txt'))
    by = collections.defaultdict(list)
    for r in rows:
        by[r['phase']].append(r)
    reels = {m['i']: m['reel'] for m in marks if m['name'] == 'reel'}
    per = []
    for i, reel in sorted(reels.items()):
        a = by.get('r%d' % i, [])
        per.append(dict(i=i, reel=reel[:44], n=len(a), fps=med([r['fps'] for r in a]), fpsMin=min([r['fps'] for r in a], default=None),
                        stale=med([r['stale'] for r in a]), app=med([r['app'] for r in a]), gpu=med([r['gpu'] for r in a]),
                        temp=a[-1]['temp'] if a else None))
    out['vrapi'] = per
    for kind in ('img', 'vid'):
        a = [r for p in per if p['reel'].startswith(kind) for r in by.get('r%d' % p['i'], [])]
        out['vrapi_' + kind] = dict(n=len(a), fps=med([r['fps'] for r in a]), stale=med([r['stale'] for r in a]),
                                    app=med([r['app'] for r in a]), gpu=med([r['gpu'] for r in a]))

    # Enter-VR hitch: worst XR frame gap in the first 3 s presenting
    tp = next(m['t'] for m in marks if m['name'] == 'presenting')
    out['enterHitchMs'] = max([s['xr']['dtMax'] for s in S if tp <= s['t'] <= tp + 3000 and s['xr']], default=None)

    # Per switch: first-visible latency from samples, decoded size, src
    clicks = {m['i']: m['t'] for m in marks if m['name'] == 'switch-click'}
    ends = sorted([m['t'] for m in marks if m['name'] in ('switch-click', 'exit-vr')])
    sw = []
    for i, t0 in sorted(clicks.items()):
        reel = reels.get(i, '')
        t1 = next((t for t in ends if t > t0), t0 + 12000)
        win = [s for s in S if t0 <= s['t'] < t1]
        name = reel.split(':', 1)[1]
        if reel.startswith('img'):
            vis = next((s['t'] for s in win if s['img'] and s['img']['src'] and s['img']['src'] in name and s['img']['shown'] and s['img']['ok']), None)
            info = {}
        else:
            base = None
            vis = None
            for s in win:
                if s['src'] and (name[-30:] in s['src'] or s['src'][-30:] in name or '__vr2ktest' in s['src']):
                    if base is None:
                        base = s['rvfc']
                    elif s['rvfc'] > base and s['ct'] > 0:
                        vis = s['t']; break
            last = [s for s in win if s['src']][-1:] or [{}]
            info = dict(src=(last[0].get('src') or '')[-40:], vw=last[0].get('vw'), vh=last[0].get('vh'),
                        meta=last[0].get('meta'), drop=last[0].get('pqDrop'), tot=last[0].get('pqTotal'))
        # XR fps from sampler frame counts across the window after the first 2 s
        w2 = [s for s in win if s['t'] >= t0 + 2000 and s['xr']]
        span = (w2[-1]['wall'] - w2[0]['wall']) / 1000 if len(w2) > 1 else 0
        xrfps = round(sum(s['xr']['n'] for s in w2[1:]) / span, 1) if span else None
        waits = sum(1 for s in win for e in (s.get('ev') or []) if 'wait' in str(e))
        sw.append(dict(i=i, reel=reel[:44], visMs=(vis - t0) if vis else None, xrfps=xrfps,
                       dtMax=max([s['xr']['dtMax'] for s in w2], default=None), waiting=waits, **info))
    out['switches'] = sw

    # Diag (1/s): uploads per second while presenting, switch timings, stalls
    pres = [x for x in D if x.get('xrFrames', 0) > 30]
    out['diag'] = dict(n=len(pres), dockPerS=med([x['dockUploads'] for x in pres]), dockMax=max([x['dockUploads'] for x in pres], default=None),
                       videoPerS=med([x['videoUploads'] for x in pres]), overlayPerS=med([x['overlayUploads'] for x in pres]),
                       panelPerS=med([x['panelUploads'] for x in pres]), stalls=max([x.get('stalls', 0) for x in D], default=0),
                       stallMs=max([x.get('stallMs', 0) for x in D], default=0),
                       fbs=(D[-1].get('flags') or {}).get('fbs'), texCap=(D[-1].get('flags') or {}).get('texCap'))
    sm, seen = [], set()
    for x in D:
        k = (x.get('switchSrc'), x.get('switchMs'))
        if x.get('switchMs') is not None and k not in seen:
            seen.add(k); sm.append(dict(src=(x['switchSrc'] or '')[-36:], ms=x['switchMs'], cache=x.get('switchFromCache')))
    out['diagSwitch'] = sm

    # Network: media requests, aborted ranges, duplicate image fetches
    N = c['net']
    media = [n for n in N if n['type'] == 'Media' or '.mp4' in n['url']]
    out['media'] = [dict(url=n['url'][-36:], range=n.get('range'), st=n.get('status'), canceled=bool(n.get('canceled')), fail=n.get('failed'), disk=n.get('fromDisk'), ms=n.get('totalMs')) for n in media]
    imgs = collections.Counter(n['url'] for n in N if re.search(r'\.(png|jpe?g|webp)$', n['url'].split('?')[0]) and 'uploads/' in n['full'])
    out['imgDupes'] = {u: k for u, k in imgs.items() if k > 1}
    out['imgFetches'] = sum(imgs.values())

    # Console + heap
    out['errors'] = sorted(set(x['text'][:200] for x in c['console'] if x['type'] in ('error', 'exception', 'warning')))
    hp = [s['heap'] for s in S if s.get('heap')]
    out['heap'] = dict(first=hp[0] if hp else None, max=max(hp) if hp else None, last=hp[-1] if hp else None)
    return out


def show(o):
    print('=' * 8, o['pass'], o['engine'], o['query'] or '-', 'override:', o['override'])
    d = o['diag']
    print('  fbs %s texCap %s | enter hitch %s ms | heap %s | img fetches %d dupes %s' % (d['fbs'], d['texCap'], o['enterHitchMs'], o['heap'], o['imgFetches'], o['imgDupes'] or '-'))
    print('  diag/s: dock %s (max %s) video %s overlay %s panel %s | stalls %s (%s ms)' % (d['dockPerS'], d['dockMax'], d['videoPerS'], d['overlayPerS'], d['panelPerS'], d['stalls'], d['stallMs']))
    print('  VrApi img:', o['vrapi_img'], '\n  VrApi vid:', o['vrapi_vid'])
    for p in o['vrapi']:
        print('   r%-2d %-44s n=%-3s fps %-5s min %-3s stale %-5s app %-5s gpu %-4s T %s' % (p['i'], p['reel'], p['n'], p['fps'], p['fpsMin'], p['stale'], p['app'], p['gpu'], p['temp']))
    for s in o['switches']:
        extra = '' if 'src' not in s else ' src ..%s %sx%s meta %s drop %s/%s' % (s['src'], s['vw'], s['vh'], s['meta'] and (s['meta']['w'], s['meta']['h']), s['drop'], s['tot'])
        print('   sw%-2d %-44s vis %-5s xrfps %-5s dtMax %-5s wait %s%s' % (s['i'], s['reel'], s['visMs'], s['xrfps'], s['dtMax'], s['waiting'], extra))
    print('  diag switch:', o['diagSwitch'])
    for m in o['media']:
        print('   media', m)
    print('  console err/warn (%d):' % len(o['errors']))
    for e in o['errors'][:15]:
        print('    ', e)


if __name__ == '__main__':
    for d in sys.argv[1:]:
        o = summarize(d)
        show(o)
        json.dump(o, open(os.path.join(d, 'summary.json'), 'w'), indent=1)
