const fs = require('fs');

async function main() {
  const ver = await (await fetch('http://localhost:9222/json/version')).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}, sessionId) => {
    const msgId = id++;
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
    return msgId;
  };

  ws.addEventListener('open', () => {
    send('Target.getTargets');
  });

  let sid = null;
  let reloadMsgId = null;
  let evalMsgId = null;

  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.result && m.result.targetInfos) {
      const reelsTab = m.result.targetInfos.find(t => (t.url || '').includes('localhost:5173/reels') && !t.url.includes('preview'));
      if (!reelsTab) {
        console.error('No reels tab found!');
        process.exit(1);
      }
      console.log('Attaching to reels tab:', reelsTab.targetId, reelsTab.url);
      send('Target.attachToTarget', { targetId: reelsTab.targetId, flatten: true });
    }

    if (m.params && m.params.sessionId && !sid) {
      sid = m.params.sessionId;
      send('Runtime.enable', {}, sid);
      send('Log.enable', {}, sid);
      send('Page.enable', {}, sid);

      console.log('Reloading /reels page to ensure fresh state...');
      reloadMsgId = send('Page.reload', { ignoreCache: true }, sid);
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[BROWSER CONSOLE]', ...(m.params.args || []).map(a => a.value || a.description));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[BROWSER EXCEPTION]', m.params.exceptionDetails);
    }

    if (m.method === 'Page.loadEventFired') {
      console.log('Page loaded! Waiting 1s for player hydration...');
      setTimeout(() => {
        const expr = `(async () => {
          const vr = window.WebXRVR;
          const vrBtn = document.getElementById('vrBtn');
          const vrBtnWrap = document.getElementById('vrBtnWrap');
          const hasXR = typeof navigator !== 'undefined' && !!navigator.xr;
          let isSupportedRes = null;
          if (vr && vr.isSupported) {
            try { isSupportedRes = await vr.isSupported(); } catch (e) { isSupportedRes = 'threw: ' + e.message; }
          }
          return {
            hasXR,
            hasTHREE: typeof window.THREE !== 'undefined',
            hasVRUICanvas: typeof window.VRUICanvas !== 'undefined',
            hasWebXRVR: typeof vr !== 'undefined',
            vrVersion: vr ? vr.version : null,
            isSupportedRes,
            vrBtnFound: !!vrBtn,
            vrBtnWrapFound: !!vrBtnWrap,
            vrBtnWrapDisplay: vrBtnWrap ? vrBtnWrap.style.display : null,
            vrBtnDisabled: vrBtn ? vrBtn.disabled : null,
          };
        })()`;
        evalMsgId = send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      }, 1200);
    }

    if (m.id === evalMsgId) {
      console.log('\n=== REELS PAGE STATE ===');
      console.log(JSON.stringify(m.result?.result?.value, null, 2));

      // Now attempt clicking vrBtn!
      console.log('\nAttempting click on vrBtn...');
      const clickExpr = `(async () => {
        const vrBtn = document.getElementById('vrBtn');
        if (!vrBtn) return { clicked: false, error: 'no vrBtn' };
        try {
          vrBtn.click();
          return { clicked: true };
        } catch (err) {
          return { clicked: false, error: err.message };
        }
      })()`;
      send('Runtime.evaluate', { expression: clickExpr, awaitPromise: true, returnByValue: true }, sid);

      setTimeout(() => {
        process.exit(0);
      }, 2000);
    }
  });
}

main().catch(console.error);
