(() => {
  const cap = window.__cap, v = document.getElementById('reelsVideo'), pv = document.getElementById('preloadVideo');
  const base = s => String(s || '').split('?')[0].split('/').pop().slice(-70);
  const pq = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  const x = cap.xr; cap.xr = cap.newXr(); cap.xr.last = x.last;
  const evs = cap.ev; cap.ev = [];
  const s = cap.session; let sess = null;
  try { if (s) sess = { vis: s.visibilityState, fr: s.frameRate, sup: s.supportedFrameRates ? Array.from(s.supportedFrameRates) : null, feats: s.enabledFeatures ? Array.from(s.enabledFeatures) : null, ffr: cap.layerObj ? cap.layerObj.fixedFoveation : undefined }; } catch (e) {}
  let be = 0; try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) > be) be = v.buffered.end(i); } catch (e) {}
  return { t: Math.round(performance.now()), src: base(v.currentSrc), blob: /^blob:/.test(v.currentSrc), vw: v.videoWidth, vh: v.videoHeight, rs: v.readyState, ns: v.networkState, paused: v.paused, ct: +v.currentTime.toFixed(2), dur: +(v.duration || 0).toFixed(2), bufEnd: +be.toFixed(2),
    pqTotal: pq && pq.totalVideoFrames, pqDrop: pq && pq.droppedVideoFrames, rvfc: cap.frames, meta: cap.meta,
    pre: pv ? { src: base(pv.currentSrc), rs: pv.readyState } : null,
    img: (im => im ? { src: base(im.currentSrc), shown: im.style.display !== 'none', w: im.naturalWidth, h: im.naturalHeight, ok: im.complete } : null)(document.getElementById('reelsImage')),
    presenting: !!(window.WebXRVR && WebXRVR.isPresenting()), stereo: window.WebXRVR && WebXRVR.getSourceStereo && WebXRVR.getSourceStereo(),
    xr: { n: x.n, dtMax: +x.dtMax.toFixed(1), hist: x.hist, cbAvg: x.n ? +(x.cbSum / x.n).toFixed(2) : 0, cbMax: +x.cbMax.toFixed(1), cbOver8: x.cbOver8 },
    sess, layer: cap.layer, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, ev: evs,
    title: (document.querySelector('.reel-title,.video-title,#videoTitle,#reelTitle') || {}).textContent || null };
})()
