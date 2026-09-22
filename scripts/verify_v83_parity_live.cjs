// v8.3 live verification probe: lock-to-viewer pose, PlayVR scale/distance
// state, LEFT comments panel / RIGHT guide geometry, popup overlay, and
// AUTO/LOOP + LOCK/FREE dock labels on /reels/immersive-preview.
// Runnable from the repo root: node scripts/verify_v83_parity_live.cjs
// Requires: backend :8000, vite :5173, CDP Chrome :9222 (see RUNNING.md).
const fs = require('fs');

const FAILURES = [];

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!cond) FAILURES.push(name);
}

async function main() {
  const verRes = await fetch('http://localhost:9222/json/version');
  const ver = await verRes.json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);

  let id = 1;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => {
    const msgId = id++;
    const payload = { id: msgId, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve) => pending.set(msgId, resolve));
  };

  ws.addEventListener('open', async () => {
    const { targetInfos } = (await send('Target.getTargets')).result;
    let page = (targetInfos || []).find((t) => (t.url || '').includes('localhost:5173/reels/immersive-preview'));
    if (!page) {
      const created = await send('Target.createTarget', { url: 'about:blank' });
      page = { targetId: created.result.targetId };
    }
    const targetId = page.targetId;
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result.sessionId;
    await send('Runtime.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);

    const errors = [];
    const evalJs = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      return res.result && res.result.result ? res.result.result.value : undefined;
    };

    console.log('Navigating to /reels/immersive-preview ...');
    await send('Page.navigate', { url: 'http://localhost:5173/reels/immersive-preview' }, sessionId);
    // Poll for the auto-started preview (reels bundle fetch + GL bind).
    let running = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      running = await evalJs(`(() => {
        const vr = window.WebXRVR;
        return !!(vr && vr.isPreviewRunning && vr.isPreviewRunning());
      })()`);
      if (running) break;
    }
    const diag = await evalJs(`(() => {
      const vr = window.WebXRVR;
      let manual = null;
      if (vr && !vr.isPreviewRunning()) {
        // Auto-start did not fire in this tab (auth-less CDP context):
        // bind the page canvas manually so the remaining checks run.
        try {
          const canvas = Array.from(document.querySelectorAll('canvas'))
            .find((c) => (c.clientWidth | 0) > 0);
          if (!canvas) manual = 'no-canvas';
          else {
            vr.startPreview(canvas, { cameraMode: 'headset', sceneMode: 'reels', showControls: true });
            manual = 'started';
          }
        } catch (e) { manual = 'throw:' + String((e && e.message) || e); }
      }
      return {
        hasVR: !!vr,
        manual,
        running: !!(vr && vr.isPreviewRunning && vr.isPreviewRunning()),
        errorBox: (document.querySelector('.sx-error-box') || {}).innerText || null,
      };
    })()`);
    console.log('Preview diag:', JSON.stringify(diag));
    running = diag.running === true;
    if (!running) {
      console.error('Preview did not start; aborting live checks.');
      try { ws.close(); } catch (e) {}
      process.exit(2);
    }

    // STEP 1: engine version + screen state + scene graph.
    // NOTE: rAF does not tick reliably in this backgrounded headless tab,
    // so the lock pose is driven once through the real code path
    // (applyLockToViewer + commitScreenTransform) instead of the frame loop.
    const s1 = await evalJs(`(() => {
      const vr = window.WebXRVR;
      if (!vr) return { noVR: true };
      const t = vr.__test;
      t.applyLockToViewer();
      t.commitScreenTransform();
      const info = t.getSceneInfo();
      const st = vr.getPreviewState();
      // v8.4: overlay churn check — two refreshes with no comments must
      // upload at most once total (dirty-only, no currentTime-driven churn).
      t.refreshOverlayTexture(1000);
      const up1 = t.getScreenState().overlayUploads;
      t.refreshOverlayTexture(2000);
      const up2 = t.getScreenState().overlayUploads;
      // v8.4: upload path A/B smoke.
      const modeRespec = vr.setVideoUploadMode('respec');
      const modeBack = vr.setVideoUploadMode('subimage');
      // v8.6: laser/reticle always-on-top flags + right-hand preference.
      // NOTE: rAF stalls in this backgrounded tab, so render once to warm
      // matrixWorld (raycast reads it) before firing the laser evaluate.
      t.readCenterPixels();
      t.updateLaserPointer({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 });
      const pinfo = t.getSceneInfo();
      var pointer = pinfo.pointer || null;
      var reticle = pinfo.reticle || null;
      var picked = t.pickPointerSource([{ handedness: 'left' }, { handedness: 'right' }]);
      var pickedHand = picked && picked.handedness;
      return {
        version: vr.version,
        running: vr.isPreviewRunning(),
        screenState: t.getScreenState(),
        screenMeshPos: info.screen && info.screen.pos,
        screenVerts: info.screen && info.screen.verts,
        paint: {
          screen: info.screen && info.screen.paint,
          overlay: info.overlay && { renderOrder: info.overlay.renderOrder, depthTest: info.overlay.depthTest },
          controls: info.controls && { renderOrder: info.controls.renderOrder, depthTest: info.controls.depthTest },
          comments: info.comments && { renderOrder: info.comments.renderOrder, depthTest: info.comments.depthTest },
          guide: info.guide && { renderOrder: info.guide.renderOrder, depthTest: info.guide.depthTest },
        },
        filters: t.getTextureFilterInfo(),
        overlayChurn: { up1, up2 },
        uploadModes: { modeRespec, modeBack },
        renderStats: vr.getPreviewState().renderStats,
        pointerFlags: pointer ? { depthTest: pointer.depthTest, renderOrder: pointer.renderOrder } : null,
        reticleFlags: reticle ? {
          depthTest: reticle.depthTest, renderOrder: reticle.renderOrder,
          beamLen: pointer && pointer.beam ? Math.hypot(
            pointer.beam.end[0] - pointer.beam.start[0],
            pointer.beam.end[1] - pointer.beam.start[1],
            pointer.beam.end[2] - pointer.beam.start[2]) : null,
          retLen: pointer && pointer.beam && reticle.pos ? Math.hypot(
            reticle.pos[0] - pointer.beam.start[0],
            reticle.pos[1] - pointer.beam.start[1],
            reticle.pos[2] - pointer.beam.start[2]) : null,
        } : null,
        pickedHand,
        dock: t.computeDockPose({ x: 0, y: 1.6, z: 0 }),
        comments: t.getCommentsPanelLayout(),
        guide: t.getGuidePanelLayout(),
        overlay: info.overlay || null,
        guideMesh: info.guide || null,
        lockToViewer: st.lockToViewer,
        errors: (window.__pageErrors || []).slice(0, 5),
      };
    })()`);
    console.log('\n=== STEP 1: v8.3 live state ===');
    console.log(JSON.stringify(s1, null, 2));
    check('engine is v8.17', typeof s1.version === 'string' && s1.version.indexOf('v8.17') === 0, s1.version);
    check('preview running', s1.running === true, s1.running);
    check('default screen scale 4.0 (fills view)', s1.screenState && s1.screenState.scale === 4.0, s1.screenState && s1.screenState.scale);
    check('default distance 2.24', s1.screenState && Math.abs(s1.screenState.distance - 2.24) < 1e-9, s1.screenState && s1.screenState.distance);
    check('headset preview locks to viewer', s1.lockToViewer === true, s1.lockToViewer);
    // Locked headset POV: camera (0,1.6,0) facing −Z → screen ≈ (0,1.6,−2.24).
    const sp = (s1.screenMeshPos || []);
    check(
      'locked screen centered on gaze',
      Math.abs(sp[0]) < 0.05 && Math.abs(sp[1] - 1.6) < 0.05 && Math.abs(sp[2] + 2.24) < 0.05,
      sp
    );
    // v8.5 legacy-exact: locked dock sits room-fixed at the default spot
    // (0, 1.52−2.0−0.08, −2.24) while the screen follows the gaze.
    check('dock hangs below screen', s1.dock && Math.abs(s1.dock.pos.y + 0.56) < 1e-9 && s1.dock.pos.z === -2.24, s1.dock && s1.dock.pos);
    check('comments panel LEFT of player', s1.comments && s1.comments.center.x < 0, s1.comments && s1.comments.center);
    check('guide panel RIGHT of player', s1.guide && s1.guide.center.x > 0, s1.guide && s1.guide.center);
    check('no page errors', !s1.errors || s1.errors.length === 0, s1.errors);
    // v8.4 paint-order ladder: screen 0 (depth-tested), overlay 2, dock 3,
    // comments/guide 4 — all UI depth-test-free (legacy painter's order).
    const p = s1.paint || {};
    check('paint ladder screen/overlay/dock/comments/guide',
      p.screen && p.screen.renderOrder === 0 && p.screen.depthTest === true &&
      p.overlay && p.overlay.renderOrder === 2 && p.overlay.depthTest === false &&
      p.controls && p.controls.renderOrder === 3 && p.controls.depthTest === false &&
      p.comments && p.comments.renderOrder === 4 && p.comments.depthTest === false &&
      p.guide && p.guide.renderOrder === 4 && p.guide.depthTest === false,
      p);
    // v8.4 legacy sampling: LINEAR, no mipmaps on every canvas texture.
    const LINEAR = await evalJs(`window.WebXRVR.getThree().LinearFilter`);
    const fok = Object.entries(s1.filters || {}).every(([k, f]) => f && f.minFilter === LINEAR && f.generateMipmaps === false);
    check('linear sampling, no mipmaps (all canvas textures)', fok, s1.filters);
    // v8.4 dirty-only overlay: ≤1 upload across two refreshes, no comments.
    check('overlay uploads only when dirty', s1.overlayChurn && s1.overlayChurn.up2 <= 1, s1.overlayChurn);
    // v8.4 upload path A/B switch.
    check('respec/subimage switch', s1.uploadModes && s1.uploadModes.modeRespec === 'respec' && s1.uploadModes.modeBack === 'subimage', s1.uploadModes);
    // v8.7 per-texture upload + transition counters present.
    const rs = s1.renderStats || {};
    check('upload/transition counters present',
      ['videoUploads', 'overlayUploads', 'dockUploads', 'panelUploads', 'guideUploads',
       'transChanges', 'transClears', 'transNotReady'].every((k) => typeof rs[k] === 'number'),
      rs);
    // v8.6 laser: always-on-top flags, reticle pullback, right-hand preference.
    check('laser always on top', s1.pointerFlags && s1.pointerFlags.depthTest === false && s1.pointerFlags.renderOrder === 999, s1.pointerFlags);
    check('reticle on top + pulled back 0.02',
      s1.reticleFlags && s1.reticleFlags.depthTest === false && s1.reticleFlags.renderOrder === 1000 &&
      s1.reticleFlags.beamLen !== null && Math.abs((s1.reticleFlags.beamLen - s1.reticleFlags.retLen) - 0.02) < 1e-3,
      s1.reticleFlags);
    check('laser prefers right hand', s1.pickedHand === 'right', s1.pickedHand);

    // STEP 2: drive scale + distance through the XR input seam with a mock
    // right-hand gamepad (same path the headset uses).
    const s2 = await evalJs(`(() => {
      const vr = window.WebXRVR;
      const t = vr.__test;
      const gp = (axes, pressed) => ({ axes, buttons: pressed.map((p) => ({ pressed: !!p })), hapticActuators: [] });
      const sess = (gpObj) => ({ inputSources: [{ handedness: 'right', gamepad: gpObj, targetRaySpace: null }] });
      const before = t.getScreenState();
      t.processXRInput(null, sess(gp([0, 0, 0, -1], [false, true, false, false, false, false])));
      const scaled = t.getScreenState();
      t.setScreenState({ locked: true });
      t.processXRInput(null, sess(gp([0, 0, 1, 0], [false, true, false, false, false, false])));
      const disted = t.getScreenState();
      return { beforeScale: before.scale, afterScale: scaled.scale, afterDist: disted.distance };
    })()`);
    console.log('\n=== STEP 2: live scale/distance drive ===');
    console.log(JSON.stringify(s2, null, 2));
    check('grip+stickY scales live', Math.abs(s2.afterScale - (s2.beforeScale + 0.04)) < 1e-9, s2);
    check('grip+stickX changes distance live', Math.abs(s2.afterDist - 2.27) < 1e-9, s2);

    // STEP 3: overlay + guide meshes exist and the screen paints.
    // No video loads in this auth-less tab, so the mesh→camera→pixels path
    // is proven with the red debug tint (existing CDP diagnosis seam).
    const s3 = await evalJs(`(() => {
      const vr = window.WebXRVR;
      const t = vr.__test;
      t.toggleCommentsPanel();
      t.refreshOverlayTexture(1000, true);
      const info = t.getSceneInfo();
      t.toggleCommentsPanel();
      t.setScreenDebugColor(0xff0000);
      const red = t.readCenterPixels();
      t.setScreenDebugColor(null);
      const restored = t.readCenterPixels();
      return {
        overlayMesh: !!info.overlay,
        guideMesh: !!info.guide,
        guideUploaded: t.getScreenState().guideUploaded,
        redPixels: red,
        restoredPixels: restored,
      };
    })()`);
    console.log('\n=== STEP 3: overlay/guide presence ===');
    console.log(JSON.stringify(s3, null, 2));
    check('overlay mesh present', !!s3.overlayMesh, s3.overlayMesh);
    check('guide mesh present', !!s3.guideMesh, s3.guideMesh);
    check('guide artwork uploaded', s3.guideUploaded === true, s3.guideUploaded);
    const rp = (s3.redPixels && s3.redPixels.mean) || [];
    check('screen mesh paints (red tint)', rp[0] > 200 && rp[1] < 60 && rp[2] < 60, rp);

    // v8.7 bisection flag round-trip (restored immediately).
    const s4 = await evalJs(`(() => {
      const t = window.WebXRVR.__test;
      const before = t.getDebugFlags();
      t.setDebugFlags({ lock: false, overlay: false, guide: false, glow: false, dockfreeze: true, glowprobe: false });
      const during = t.getDebugFlags();
      t.setDebugFlags({ lock: true, overlay: true, guide: true, glow: true, dockfreeze: false, glowprobe: true });
      const after = t.getDebugFlags();
      return { before, during, after };
    })()`);
    console.log('\n=== STEP 4: bisection flags ===');
    console.log(JSON.stringify(s4, null, 2));
    const same = (a, b) => a && b && a.lock === b.lock && a.overlay === b.overlay && a.guide === b.guide &&
      a.glow === b.glow && a.dockfreeze === b.dockfreeze && a.glowprobe === b.glowprobe;
    check('flag round-trip restores cleanly',
      s4 && s4.during.lock === false && s4.during.dockfreeze === true && same(s4.before, s4.after), s4);

    console.log(`\n${FAILURES.length === 0 ? 'ALL V8.3 LIVE CHECKS GREEN' : `FAILURES: ${FAILURES.join(', ')}`}`);
    try { ws.close(); } catch (e) {}
    process.exit(FAILURES.length === 0 ? 0 : 1);
  });

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.error('[EXCEPTION]', JSON.stringify(m.params.exceptionDetails).slice(0, 500));
    }
  });

  ws.addEventListener('error', (e) => {
    console.error('CDP socket error', e);
    process.exit(2);
  });
}

main().catch((e) => { console.error(e); process.exit(2); });
