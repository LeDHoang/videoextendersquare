[(() => {
  if (window.__cap) return 'already';
  const cap = window.__cap = { ev: [], frames: 0, meta: null, lastFrameSrc: '', xr: null, layer: null, session: null };
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-70);
  const v = document.getElementById('reelsVideo');
  const push = (k, x) => cap.ev.push(Object.assign({ k, t: Math.round(performance.now()) }, x || {}));
  ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','playing','waiting','stalled','error','emptied','pause','ended'].forEach(n =>
    v.addEventListener(n, () => push(n, { src: base(v.currentSrc), rs: v.readyState, ct: +v.currentTime.toFixed(2) })));
  const loop = (now, meta) => {
    cap.frames++; cap.meta = { pf: meta.presentedFrames, w: meta.width, h: meta.height, mt: meta.mediaTime, pd: meta.processingDuration };
    if (v.currentSrc !== cap.lastFrameSrc) { cap.lastFrameSrc = v.currentSrc; push('first-frame', { src: base(v.currentSrc), w: meta.width, h: meta.height }); }
    v.requestVideoFrameCallback(loop);
  };
  v.requestVideoFrameCallback(loop);
  const newXr = () => ({ n: 0, last: -1, dtMax: 0, hist: new Array(12).fill(0), cbMax: 0, cbSum: 0, cbOver8: 0 });
  cap.xr = newXr(); cap.newXr = newXr;
  // dt buckets (ms): <10,<12,<13,<15,<17,<20,<25,<30,<42,<60,<100,>=100
  const edges = [10,12,13,15,17,20,25,30,42,60,100];
  const xr = navigator.xr, rs = xr.requestSession.bind(xr);
  xr.requestSession = async (...a) => {
    const s = await rs(...a);
    cap.session = s; push('xr-session', { mode: a[0] });
    s.addEventListener('visibilitychange', () => push('xr-visibility', { vis: s.visibilityState }));
    s.addEventListener('end', () => push('xr-end'));
    const raf = s.requestAnimationFrame.bind(s);
    s.requestAnimationFrame = cb => raf((time, frame) => {
      const x = cap.xr;
      if (x.last >= 0) { const dt = time - x.last; let i = 0; while (i < edges.length && dt >= edges[i]) i++; x.hist[i]++; if (dt > x.dtMax) x.dtMax = dt; }
      x.last = time; x.n++;
      const t0 = performance.now(); cb(time, frame); const d = performance.now() - t0;
      x.cbSum += d; if (d > x.cbMax) x.cbMax = d; if (d > 8) x.cbOver8++;
    });
    return s;
  };
  if (window.XRWebGLBinding) {
    const P = XRWebGLBinding.prototype, cpl = P.createProjectionLayer;
    P.createProjectionLayer = function (...a) { const l = cpl.apply(this, a); try { cap.layer = { kind: 'projection', w: l.textureWidth, h: l.textureHeight, arr: l.textureArrayLength, init: a[0] || null, ffr: l.fixedFoveation }; cap.layerObj = l; } catch (e) {} return l; };
  }
  if (window.XRWebGLLayer) {
    const O = XRWebGLLayer;
    window.XRWebGLLayer = new Proxy(O, { construct(T, a) { const l = new T(...a); try { cap.layer = { kind: 'webgl', w: l.framebufferWidth, h: l.framebufferHeight, init: a[2] || null, aa: l.antialias }; } catch (e) {} return l; } });
  }
  return 'hooked';
})(), (() => {
  const cap = window.__cap; if (!cap || cap.img) return 'img-already';
  cap.img = true;
  const im = document.getElementById('reelsImage'); if (!im) return 'no-img';
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-70);
  const push = (k, x) => cap.ev.push(Object.assign({ k, t: Math.round(performance.now()) }, x || {}));
  im.addEventListener('load', () => push('img-load', { src: base(im.currentSrc), w: im.naturalWidth, h: im.naturalHeight }));
  im.addEventListener('error', () => push('img-error', { src: base(im.currentSrc) }));
  new MutationObserver(() => push('img-src', { src: base(im.getAttribute('src')), shown: im.style.display !== 'none' })).observe(im, { attributes: true, attributeFilter: ['src', 'style'] });
  return 'img-hooked';
})(), (() => {
  const cap = window.__cap; if (!cap || cap.pre) return 'pre-already';
  cap.pre = true;
  const pv = document.getElementById('preloadVideo'); if (!pv) return 'no-pre';
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-70);
  const push = (k, x) => cap.ev.push(Object.assign({ k, t: Math.round(performance.now()) }, x || {}));
  ['loadstart', 'loadedmetadata', 'loadeddata', 'canplaythrough', 'emptied', 'error'].forEach(n =>
    pv.addEventListener(n, () => push('pre-' + n, { src: base(pv.currentSrc), rs: pv.readyState })));
  new MutationObserver(() => push('pre-src', { src: base(pv.getAttribute('src')) })).observe(pv, { attributes: true, attributeFilter: ['src'] });
  return 'pre-hooked';
})()]
