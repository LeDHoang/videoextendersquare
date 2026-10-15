async function test() {
  const verRes = await fetch('http://localhost:9222/json/version');
  const ver = await verRes.json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}, sessionId) => {
    const msgId = id++;
    const payload = { id: msgId, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return msgId;
  };
  ws.addEventListener('open', () => send('Target.getTargets'));
  let sid = null;
  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.result && m.result.targetInfos) {
      const page = m.result.targetInfos.find(t => (t.url || '').includes('localhost:5173/reels'));
      if (page) send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    }
    if (m.params && m.params.sessionId && !sid) {
      sid = m.params.sessionId;
      send('Runtime.enable', {}, sid);
      send('Log.enable', {}, sid);
      
      // Inject WebXR Mock and test enterVR()
      const testCode = `(async () => {
        console.log('[MOCK-XR] Setting up WebXR emulation test...');
        
        // Emulate an XRSession and XRWebGLLayer to see exactly what onXRFrame does!
        class MockXRView {
          constructor(eye) {
            this.eye = eye;
            this.projectionMatrix = new Float32Array([
              1, 0, 0, 0,
              0, 1, 0, 0,
              0, 0, -1.0002, -1,
              0, 0, -0.10001, 0
            ]);
            this.transform = {
              position: { x: eye === 'left' ? -0.032 : 0.032, y: 1.52, z: 0 },
              orientation: { x: 0, y: 0, z: 0, w: 1 },
              matrix: new Float32Array([
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                eye === 'left' ? -0.032 : 0.032, 1.52, 0, 1
              ])
            };
          }
        }

        class MockXRViewerPose {
          constructor() {
            this.transform = {
              position: { x: 0, y: 1.52, z: 0 },
              orientation: { x: 0, y: 0, z: 0, w: 1 },
              matrix: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,1.52,0,1])
            };
            this.views = [new MockXRView('left'), new MockXRView('right')];
          }
        }

        let rafCallbacks = [];
        let sessionRunning = true;

        const mockSession = {
          renderState: { baseLayer: null },
          updateRenderState(state) {
            Object.assign(this.renderState, state);
          },
          requestReferenceSpace: async (type) => ({ type }),
          requestAnimationFrame(cb) {
            if (sessionRunning) rafCallbacks.push(cb);
            return rafCallbacks.length;
          },
          cancelAnimationFrame(id) {},
          addEventListener(type, cb) {},
          removeEventListener(type, cb) {},
          end: async () => { sessionRunning = false; },
          inputSources: []
        };

        const origRequestSession = navigator.xr.requestSession.bind(navigator.xr);
        navigator.xr.requestSession = async (mode, opts) => {
          console.log('[MOCK-XR] requestSession intercepted with mode:', mode);
          return mockSession;
        };

        try {
          console.log('[MOCK-XR] Invoking WebXRVR.enterVR()...');
          await window.WebXRVR.enterVR();
          console.log('[MOCK-XR] enterVR completed. isPresenting:', window.WebXRVR.isPresenting());

          // Now simulate 5 frames of onXRFrame!
          const frame = {
            session: mockSession,
            getViewerPose(refSpace) {
              return new MockXRViewerPose();
            },
            getPose(space, refSpace) {
              return null;
            }
          };

          for (let i = 0; i < 5; i++) {
            const cbs = rafCallbacks.slice();
            rafCallbacks = [];
            console.log(\`[MOCK-XR] Running frame \${i + 1} (\${cbs.length} callbacks)...\`);
            for (const cb of cbs) {
              cb(performance.now(), frame);
            }
          }

          console.log('[MOCK-XR] All frames executed cleanly! Exiting VR...');
          await window.WebXRVR.exitVR();
          return { success: true };
        } catch (err) {
          console.error('[MOCK-XR] ERROR during simulated VR session:', err);
          return { success: false, error: err.message, stack: err.stack };
        } finally {
          navigator.xr.requestSession = origRequestSession;
        }
      })()`;

      send('Runtime.evaluate', { expression: testCode, awaitPromise: true, returnByValue: true }, sid);
    }

    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('[BROWSER CONSOLE]', ...(m.params.args || []).map(a => a.value || a.description));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[BROWSER EXCEPTION]', m.params.exceptionDetails);
    }
    if (m.result && m.result.result && m.result.result.value) {
      console.log('FINAL EVAL RESULT:', JSON.stringify(m.result.result.value, null, 2));
      process.exit(0);
    }
  });
}
test().catch(console.error);
