// Open a fresh reels tab via Target.createTarget, attach, wait for load, probe.
const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
let id = 1;
const send = (m, p={}, sid) => { const o={id:id++, method:m, params:p}; if(sid) o.sessionId=sid; ws.send(JSON.stringify(o)); return o.id; };
ws.addEventListener('open', () => {
  const cid = send('Target.createTarget', { url: 'http://localhost:5173/reels' });
  const h = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === cid && m.result) {
      const targetId = m.result.targetId;
      console.log('created target:', targetId);
      const aid = send('Target.attachToTarget', { targetId, flatten: true });
      const h2 = (e2) => {
        const m2 = JSON.parse(e2.data);
        if (m2.id === aid && m2.result) {
          const sid = m2.result.sessionId;
          console.log('attached, session:', sid, '— waiting 6s for reels load...');
          setTimeout(() => probe(sid), 6000);
          ws.removeEventListener('message', h2);
        }
      };
      ws.addEventListener('message', h2);
      ws.removeEventListener('message', h);
    }
  };
  ws.addEventListener('message', h);
});
function probe(sid){
  const expr = `(async()=>{
    const v=document.querySelector('video');
    const c=document.querySelector('canvas');
    let g=null;
    try{ if(c){const gl=c.getContext('webgl2')||c.getContext('webgl'); if(gl){const d=gl.getExtension('WEBGL_debug_renderer_info'); g={ren:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),maxTex:gl.getParameter(gl.MAX_TEXTURE_SIZE),db:[gl.drawingBufferWidth,gl.drawingBufferHeight]};}}}catch(e){g={err:String(e)};}
    const pq=v&&v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():null;
    const raf=[];
    await new Promise(r=>{let last=performance.now(),s=last;(function t(x){if(last!==null)raf.push(x-last);last=x;if(x-s<1000)requestAnimationFrame(t);else r();})(s);});
    raf.sort((a,b)=>a-b);
    return {url:location.href, video:v?{src:(v.src||v.currentSrc||'').slice(0,110),paused:v.paused,ready:v.readyState,ct:+v.currentTime.toFixed(2),vw:v.videoWidth,vh:v.videoHeight,webkitDropped:v.webkitDroppedFrameCount,webkitDecoded:v.webkitDecodedFrameCount,pqDropped:pq?pq.droppedVideoFrames:null,pqTotal:pq?pq.totalVideoFrames:null}:null, gl:g, xr:navigator.xr?!!(navigator.xr.isPresenting):'no-xr', dpr:window.devicePixelRatio, cores:navigator.hardwareConcurrency, rafN:raf.length, rafMed:+raf[raf.length>>1]?.toFixed(2), rafOver20:raf.filter(x=>x>20).length};
  })()`;
  const eid = send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  const h3 = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === eid) {
      console.log('\n=== PROBE RESULT ===');
      console.log(JSON.stringify(m.result?.result?.value ?? m.result, null, 2));
      ws.removeEventListener('message', h3);
      setTimeout(()=>{ws.close(); process.exit(0);}, 500);
    }
  };
  ws.addEventListener('message', h3);
}
setTimeout(()=>{ console.error('timeout'); process.exit(1); }, 30000);
