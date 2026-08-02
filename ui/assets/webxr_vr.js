/**
 * WebXR VR Module for Reels — v2.1 (Fixed & Stabilised)
 *
 * Architecture: Single XRWebGLLayer with video texture quad + controls overlay quad.
 * This approach is universally supported (Quest Browser, desktop emulator, etc.)
 * unlike the XRMediaBinding + XRWebGLBinding mixed-layer approach which has
 * compatibility issues on Quest.
 *
 * Features:
 *  - Video rendered as a textured quad in front of the user
 *  - YouTube VR-style floating transport controls (show on pause, B button, auto-hide)
 *  - Grip-to-reposition, thumbstick resize/seek
 *  - No per-frame updateRenderState (was crashing Quest)
 *  - No layer recreation on video change (was crashing on auto-advance/trigger)
 *  - requestVideoFrameCallback for efficient texture uploads
 *
 * Public API:
 *   WebXRVR.init(videoEl, callbacks)
 *   WebXRVR.enterVR()
 *   WebXRVR.exitVR()
 *   WebXRVR.isSupported() → Promise<boolean>
 *   WebXRVR.onVideoChange()  — lightweight, no layer recreation
 */
const WebXRVR = (function () {
  'use strict';

  /* ═══ VERSION TAG — check console to confirm fresh code ═══ */
  const VR_VERSION = 'v2.3-20260802';
  console.log('[WebXRVR] Module loaded:', VR_VERSION);

  // ─── State ───────────────────────────────────────────────────────────
  let xrSession = null;
  let xrRefSpace = null;
  let videoElement = null;
  let callbacks = {};

  // WebGL state
  let gl = null;
  let glLayer = null;
  let glProgram = null;
  let glVideoTexture = null;
  let glControlsTexture = null;
  let glQuadBuf = null;

  // Cached GL locations
  let loc_aPos = -1;
  let loc_aUV = -1;
  let loc_uMVP = null;
  let loc_uTex = null;
  let loc_uAlpha = null;

  // Screen transform
  const DEFAULT_POS = { x: 0, y: 1.6, z: -2.8 };
  const DEFAULT_SCALE = 4.0;
  const MIN_SCALE = 1.0;
  const MAX_SCALE = 10.0;
  const SCALE_SPEED = 0.04;

  let screenPos = { ...DEFAULT_POS };
  let screenQuat = { x: 0, y: 0, z: 0, w: 1 };
  let screenScale = DEFAULT_SCALE;

  // Grab state
  let isGrabbing = false;
  let grabControllerIdx = -1;
  let grabDistance = 3.0;

  // Controls panel state
  let controlsVisible = false;
  let controlsCanvas = null;
  let controlsCtx = null;
  const CONTROLS_W = 512;
  const CONTROLS_H = 128;
  let hoveredButton = -1;
  let controlsAutoHideTimer = null;
  const CONTROLS_AUTO_HIDE_MS = 5000;

  // Video frame tracking
  let hasNewVideoFrame = true;
  let lastVideoTime = -1;

  // Thumbstick flick debounce
  let flickedX = false;
  const FLICK_THRESHOLD = 0.5;
  const FLICK_RESET = 0.3;

  // External button state tracking — WebXR gamepads are snapshots recreated each
  // frame, so you CANNOT persist state on gp.buttons[n].  Track externally.
  const prevBtnState = { rightA: false, rightB: false, leftA: false, leftB: false };

  // Button definitions for the controls panel
  const CTRL_BUTTONS = [
    { label: '⏮',   action: 'prev',   x: 16,  w: 48 },
    { label: '◀◀',  action: 'rew',    x: 72,  w: 48 },
    { label: '▶',    action: 'play',   x: 128, w: 64 },
    { label: '▶▶',  action: 'fwd',    x: 200, w: 48 },
    { label: '⏭',   action: 'next',   x: 256, w: 48 },
    { label: '🔊',   action: 'mute',   x: 320, w: 48 },
    { label: '✕',    action: 'exit',   x: 384, w: 48 },
  ];

  // ─── Helpers ─────────────────────────────────────────────────────────

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function vecLen(a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
  function vecSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function vecAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
  function vecScale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
  function vecNorm(a) {
    const l = vecLen(a) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  }

  // ─── Controls Canvas Rendering ───────────────────────────────────────

  function initControlsCanvas() {
    controlsCanvas = document.createElement('canvas');
    controlsCanvas.width = CONTROLS_W;
    controlsCanvas.height = CONTROLS_H;
    controlsCtx = controlsCanvas.getContext('2d');
  }

  function renderControlsCanvas() {
    const ctx = controlsCtx;
    if (!ctx) return;

    const isPaused = videoElement ? videoElement.paused : true;
    const isMuted = videoElement ? videoElement.muted : true;
    const currentTime = videoElement ? videoElement.currentTime : 0;
    const duration = videoElement ? videoElement.duration : 0;

    ctx.clearRect(0, 0, CONTROLS_W, CONTROLS_H);

    // Background
    ctx.fillStyle = 'rgba(8, 9, 10, 0.88)';
    ctx.beginPath();
    ctx.roundRect(0, 0, CONTROLS_W, CONTROLS_H, 12);
    ctx.fill();

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0, 0, CONTROLS_W, CONTROLS_H, 12);
    ctx.stroke();

    // Buttons row
    CTRL_BUTTONS.forEach((btn, i) => {
      const isHover = (hoveredButton === i);
      const y = 10;
      const h = 40;

      if (btn.action === 'play') btn.label = isPaused ? '▶' : '⏸';
      if (btn.action === 'mute') btn.label = isMuted ? '🔇' : '🔊';

      ctx.fillStyle = isHover ? '#FF3B1F' : 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.roundRect(btn.x, y, btn.w, h, 6);
      ctx.fill();

      ctx.fillStyle = isHover ? '#0A0A0A' : '#F2F3F5';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(btn.label, btn.x + btn.w / 2, y + h / 2);
    });

    // Progress bar
    const barX = 16, barY = 65;
    const barW = CONTROLS_W - 32, barH = 6;
    const progress = duration > 0 ? currentTime / duration : 0;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 3);
    ctx.fill();

    ctx.fillStyle = '#FF3B1F';
    ctx.beginPath();
    ctx.roundRect(barX, barY, Math.max(1, barW * progress), barH, 3);
    ctx.fill();

    // Time
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(currentTime) + ' / ' + formatTime(duration), CONTROLS_W - 16, barY + barH + 16);

    // Metadata
    const playlist = callbacks.getPlaylist ? callbacks.getPlaylist() : [];
    const idx = callbacks.getCurrentIndex ? callbacks.getCurrentIndex() : 0;
    const item = playlist[idx];
    if (item) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${item.filename}  ·  📁 ${item.folder}  ·  ${item.size}`, 16, CONTROLS_H - 14);
    }
    if (playlist.length > 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${idx + 1} / ${playlist.length}`, CONTROLS_W - 16, CONTROLS_H - 14);
    }
  }

  // ─── Controls Raycast ────────────────────────────────────────────────

  function hitTestControls(rayOrigin, rayDir) {
    const ctrlCenter = {
      x: screenPos.x,
      y: screenPos.y - screenScale / 2 - 0.25,
      z: screenPos.z,
    };
    const ctrlWidth = screenScale * 0.8;
    const ctrlHeight = ctrlWidth * (CONTROLS_H / CONTROLS_W);

    if (Math.abs(rayDir.z) < 0.001) return -1;
    const t = (ctrlCenter.z - rayOrigin.z) / rayDir.z;
    if (t < 0 || t > 20) return -1;

    const hitX = rayOrigin.x + rayDir.x * t;
    const hitY = rayOrigin.y + rayDir.y * t;

    const halfW = ctrlWidth / 2;
    const halfH = ctrlHeight / 2;
    const localX = hitX - (ctrlCenter.x - halfW);
    const localY = (ctrlCenter.y + halfH) - hitY;

    if (localX < 0 || localX > ctrlWidth || localY < 0 || localY > ctrlHeight) return -1;

    const u = localX / ctrlWidth;
    const v = localY / ctrlHeight;
    const canvasX = u * CONTROLS_W;
    const canvasY = v * CONTROLS_H;

    for (let i = 0; i < CTRL_BUTTONS.length; i++) {
      const btn = CTRL_BUTTONS[i];
      if (canvasX >= btn.x && canvasX <= btn.x + btn.w && canvasY >= 10 && canvasY <= 50) {
        return i;
      }
    }
    return -1;
  }

  function executeControlButton(index) {
    if (index < 0 || index >= CTRL_BUTTONS.length) return;
    const action = CTRL_BUTTONS[index].action;
    resetAutoHideTimer();
    switch (action) {
      case 'prev':  callbacks.onPrev && callbacks.onPrev(); break;
      case 'next':  callbacks.onNext && callbacks.onNext(); break;
      case 'play':  callbacks.onTogglePlay && callbacks.onTogglePlay(); break;
      case 'rew':   callbacks.onSeek && callbacks.onSeek(-5); break;
      case 'fwd':   callbacks.onSeek && callbacks.onSeek(5); break;
      case 'mute':
        if (videoElement) videoElement.muted = !videoElement.muted;
        break;
      case 'exit':  exitVR(); break;
    }
  }

  // ─── Controls Visibility ─────────────────────────────────────────────

  function showControls() {
    controlsVisible = true;
    resetAutoHideTimer();
  }

  function hideControls() {
    controlsVisible = false;
    clearAutoHideTimer();
  }

  function toggleControls() {
    if (controlsVisible) hideControls();
    else showControls();
  }

  function resetAutoHideTimer() {
    clearAutoHideTimer();
    if (videoElement && !videoElement.paused) {
      controlsAutoHideTimer = setTimeout(function() {
        controlsVisible = false;
      }, CONTROLS_AUTO_HIDE_MS);
    }
  }

  function clearAutoHideTimer() {
    if (controlsAutoHideTimer) {
      clearTimeout(controlsAutoHideTimer);
      controlsAutoHideTimer = null;
    }
  }

  // ─── Video Frame Tracking ───────────────────────────────────────────

  function setupVideoFrameTracking() {
    if (!videoElement) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      function onFrame(now, metadata) {
        hasNewVideoFrame = true;
        if (xrSession) videoElement.requestVideoFrameCallback(onFrame);
      }
      videoElement.requestVideoFrameCallback(onFrame);
    }
  }

  // ─── WebGL Setup ────────────────────────────────────────────────────

  const VERT = `
    attribute vec2 aPos;
    attribute vec2 aUV;
    varying vec2 vUV;
    uniform mat4 uMVP;
    void main() {
      vUV = aUV;
      gl_Position = uMVP * vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform float uAlpha;
    void main() {
      vec4 c = texture2D(uTex, vUV);
      gl_FragColor = vec4(c.rgb, c.a * uAlpha);
    }
  `;

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[WebXRVR] Shader error:', gl.getShaderInfoLog(s));
    }
    return s;
  }

  function initGL(session) {
    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl', { xrCompatible: true, alpha: false });
    if (!gl) {
      console.error('[WebXRVR] Failed to create WebGL context');
      return false;
    }

    glLayer = new XRWebGLLayer(session, gl);
    session.updateRenderState({ baseLayer: glLayer });

    // Shaders
    const vs = compileShader(gl.VERTEX_SHADER, VERT);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG);
    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);

    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      console.error('[WebXRVR] Program link error:', gl.getProgramInfoLog(glProgram));
      return false;
    }

    // Cache locations ONCE
    loc_aPos = gl.getAttribLocation(glProgram, 'aPos');
    loc_aUV = gl.getAttribLocation(glProgram, 'aUV');
    loc_uMVP = gl.getUniformLocation(glProgram, 'uMVP');
    loc_uTex = gl.getUniformLocation(glProgram, 'uTex');
    loc_uAlpha = gl.getUniformLocation(glProgram, 'uAlpha');

    // Quad verts
    const verts = new Float32Array([
      -0.5, -0.5,  0, 1,
       0.5, -0.5,  1, 1,
      -0.5,  0.5,  0, 0,
       0.5,  0.5,  1, 0,
    ]);
    glQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    // Video texture
    glVideoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Controls texture
    glControlsTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    console.log('[WebXRVR] WebGL initialised OK');
    return true;
  }

  // ─── Matrix Math ────────────────────────────────────────────────────

  function mat4Mul(a, b) {
    const r = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        r[i * 4 + j] = 0;
        for (let k = 0; k < 4; k++) {
          r[i * 4 + j] += a[k * 4 + j] * b[i * 4 + k];
        }
      }
    }
    return r;
  }

  function buildMVP(viewMat, projMat, pos, scaleW, scaleH) {
    const model = new Float32Array([
      scaleW, 0, 0, 0,
      0, scaleH, 0, 0,
      0, 0, 1, 0,
      pos.x, pos.y, pos.z, 1,
    ]);
    return mat4Mul(projMat, mat4Mul(viewMat, model));
  }

  // ─── Draw a Quad ────────────────────────────────────────────────────

  function drawQuad(viewMat, projMat, texture, pos, scaleW, scaleH, alpha) {
    gl.useProgram(glProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuf);
    gl.enableVertexAttribArray(loc_aPos);
    gl.enableVertexAttribArray(loc_aUV);
    gl.vertexAttribPointer(loc_aPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(loc_aUV, 2, gl.FLOAT, false, 16, 8);

    const mvp = buildMVP(viewMat, projMat, pos, scaleW, scaleH);
    gl.uniformMatrix4fv(loc_uMVP, false, mvp);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc_uTex, 0);
    gl.uniform1f(loc_uAlpha, alpha);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ─── XR Frame Loop ──────────────────────────────────────────────────

  function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(xrRefSpace);
    if (!pose) return;

    // Process controller input
    processInput(frame);

    // Auto-show controls when paused
    if (videoElement && videoElement.paused && !controlsVisible) {
      showControls();
    }

    if (!glLayer || !gl) return;

    // Bind XR framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    gl.clearColor(0.03, 0.03, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Upload video texture only when there's a new frame
    // Fallback: check currentTime change for browsers without requestVideoFrameCallback
    if (videoElement && videoElement.readyState >= 2) {
      const vt = videoElement.currentTime;
      if (hasNewVideoFrame || vt !== lastVideoTime) {
        gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
        hasNewVideoFrame = false;
        lastVideoTime = vt;
      }
    }

    // Upload controls texture if visible
    if (controlsVisible) {
      renderControlsCanvas();
      gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, controlsCanvas);
    }

    // Render for each eye
    for (const view of pose.views) {
      const vp = glLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      const viewMat = view.transform.inverse.matrix;
      const projMat = view.projectionMatrix;

      // Video quad (1:1 square)
      drawQuad(viewMat, projMat, glVideoTexture, screenPos, screenScale, screenScale, 1.0);

      // Controls overlay (below video)
      if (controlsVisible) {
        const ctrlPos = {
          x: screenPos.x,
          y: screenPos.y - screenScale / 2 - 0.25,
          z: screenPos.z,
        };
        const ctrlW = screenScale * 0.8;
        const ctrlH = ctrlW * (CONTROLS_H / CONTROLS_W);
        drawQuad(viewMat, projMat, glControlsTexture, ctrlPos, ctrlW, ctrlH, 0.95);
      }
    }
  }

  // ─── Controller Input ───────────────────────────────────────────────

  function processInput(frame) {
    if (!xrSession) return;

    for (const source of xrSession.inputSources) {
      if (!source.gamepad) continue;

      const gp = source.gamepad;
      const hand = source.handedness;

      // Controller pose
      let controllerPos = null;
      let controllerDir = null;
      if (source.targetRaySpace) {
        const rayPose = frame.getPose(source.targetRaySpace, xrRefSpace);
        if (rayPose) {
          const t = rayPose.transform;
          controllerPos = { x: t.position.x, y: t.position.y, z: t.position.z };
          const m = t.matrix || rayPose.transform.matrix;
          if (m) controllerDir = { x: -m[8], y: -m[9], z: -m[10] };
        }
      }

      // Grip: Grab & reposition (Quest Touch = buttons[1])
      const gripPressed = gp.buttons.length > 1 && gp.buttons[1].pressed;
      if (gripPressed && controllerPos && controllerDir) {
        if (!isGrabbing) {
          isGrabbing = true;
          grabControllerIdx = hand === 'right' ? 1 : 0;
          const toScreen = vecSub(screenPos, controllerPos);
          grabDistance = vecLen(toScreen) || 3.0;
        }
        screenPos = vecAdd(controllerPos, vecScale(vecNorm(controllerDir), grabDistance));
      } else if (isGrabbing && ((hand === 'right' && grabControllerIdx === 1) ||
                                 (hand === 'left' && grabControllerIdx === 0))) {
        isGrabbing = false;
        grabControllerIdx = -1;
      }

      // Right hand only for other controls
      if (hand !== 'right') continue;

      // A button (buttons[4]) — Play/Pause
      // Using external state tracking because WebXR gamepad is a snapshot
      const aPressed = gp.buttons.length > 4 && gp.buttons[4].pressed;
      if (aPressed && !prevBtnState.rightA) {
        callbacks.onTogglePlay && callbacks.onTogglePlay();
        showControls();
      }
      prevBtnState.rightA = aPressed;

      // B button (buttons[5]) — Toggle controls
      const bPressed = gp.buttons.length > 5 && gp.buttons[5].pressed;
      if (bPressed && !prevBtnState.rightB) {
        toggleControls();
      }
      prevBtnState.rightB = bPressed;

      // Right thumbstick
      const thumbX = gp.axes[2] || 0;
      const thumbY = gp.axes[3] || 0;

      // Y: resize
      if (Math.abs(thumbY) > FLICK_THRESHOLD) {
        screenScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
          screenScale + (-thumbY) * SCALE_SPEED
        ));
      }

      // X: seek (flick)
      if (Math.abs(thumbX) > FLICK_THRESHOLD && !flickedX) {
        flickedX = true;
        callbacks.onSeek && callbacks.onSeek(thumbX > 0 ? 5 : -5);
        showControls();
      } else if (Math.abs(thumbX) < FLICK_RESET) {
        flickedX = false;
      }

      // Raycast controls
      if (controlsVisible && controllerPos && controllerDir) {
        hoveredButton = hitTestControls(controllerPos, controllerDir);
      } else {
        hoveredButton = -1;
      }
    }
  }

  // ─── XR Availability ───────────────────────────────────────────────

  function getXR() {
    try { if (window.top && window.top.navigator && window.top.navigator.xr) return window.top.navigator.xr; } catch (e) {}
    try { if (window.parent && window.parent.navigator && window.parent.navigator.xr) return window.parent.navigator.xr; } catch (e) {}
    return navigator.xr;
  }

  // ─── Session Management ──────────────────────────────────────────────

  async function enterVR() {
    if (xrSession) return;
    console.log('[WebXRVR] enterVR() called —', VR_VERSION);

    const xr = getXR();
    if (!xr) {
      alert('WebXR not available. Requires HTTPS or localhost.');
      return;
    }

    // Request session
    try {
      xrSession = await xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'local'],
      });
    } catch (e) {
      try {
        xrSession = await xr.requestSession('immersive-vr');
      } catch (e2) {
        console.error('[WebXRVR] Session request failed:', e2);
        alert('Could not start VR: ' + e2.message);
        return;
      }
    }
    console.log('[WebXRVR] XR session started');

    // Reset state
    screenPos = { ...DEFAULT_POS };
    screenScale = DEFAULT_SCALE;
    controlsVisible = false;
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    hoveredButton = -1;
    isGrabbing = false;

    // Init controls canvas
    initControlsCanvas();

    // Reference space
    try {
      xrRefSpace = await xrSession.requestReferenceSpace('local-floor');
    } catch {
      xrRefSpace = await xrSession.requestReferenceSpace('local');
    }
    console.log('[WebXRVR] Reference space acquired');

    // Init WebGL — this is the ONLY rendering path now (no XRMediaBinding)
    if (!initGL(xrSession)) {
      console.error('[WebXRVR] WebGL init failed, ending session');
      xrSession.end().catch(() => {});
      xrSession = null;
      return;
    }

    // Video frame tracking
    setupVideoFrameTracking();

    // Events
    xrSession.addEventListener('selectstart', onSelectStart);
    xrSession.addEventListener('end', onSessionEnd);
    if (videoElement) {
      videoElement.addEventListener('pause', onVideoPause);
      videoElement.addEventListener('play', onVideoPlay);
    }

    // VR active indicator
    const frameEl = document.getElementById('reelsFrame');
    if (frameEl) frameEl.classList.add('vr-active');

    // Ensure video is playing
    if (videoElement && videoElement.paused) {
      videoElement.play().catch(() => {});
    }

    // Start render loop
    console.log('[WebXRVR] Starting render loop');
    xrSession.requestAnimationFrame(onXRFrame);
  }

  function onVideoPause() {
    if (xrSession) showControls();
  }

  function onVideoPlay() {
    if (xrSession && controlsVisible) resetAutoHideTimer();
  }

  function onSelectStart(ev) {
    const hand = ev.inputSource.handedness;

    // Priority: controls button click
    if (controlsVisible && hoveredButton >= 0) {
      executeControlButton(hoveredButton);
      return;
    }

    // Otherwise: navigate
    if (hand === 'right') {
      callbacks.onNext && callbacks.onNext();
      showControls();
    } else if (hand === 'left') {
      callbacks.onPrev && callbacks.onPrev();
      showControls();
    }
  }

  function onSessionEnd() {
    console.log('[WebXRVR] Session ended');
    cleanup();
  }

  function exitVR() {
    if (xrSession) xrSession.end().catch(() => {});
  }

  function cleanup() {
    if (videoElement) {
      videoElement.removeEventListener('pause', onVideoPause);
      videoElement.removeEventListener('play', onVideoPlay);
    }
    clearAutoHideTimer();
    xrSession = null;
    xrRefSpace = null;
    gl = null;
    glLayer = null;
    glProgram = null;
    glVideoTexture = null;
    glControlsTexture = null;
    glQuadBuf = null;
    loc_aPos = -1;
    loc_aUV = -1;
    loc_uMVP = null;
    loc_uTex = null;
    loc_uAlpha = null;
    controlsVisible = false;
    isGrabbing = false;
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    hoveredButton = -1;

    const frameEl = document.getElementById('reelsFrame');
    if (frameEl) frameEl.classList.remove('vr-active');
  }

  /**
   * Called when video source changes. NO-OP by design.
   * The video quad reads from the <video> element each frame.
   * When src changes, we just pick up the new frames automatically.
   */
  function onVideoChange() {
    // Intentionally lightweight — just reset frame tracking
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    console.log('[WebXRVR] Video source changed — will pick up new frames next render');
  }

  // ─── Public API ──────────────────────────────────────────────────────

  return {
    init(video, cbs) {
      videoElement = video;
      callbacks = cbs || {};
      console.log('[WebXRVR] Initialised', VR_VERSION);
    },

    async isSupported() {
      const xr = getXR();
      if (!xr) return false;
      try { return await xr.isSessionSupported('immersive-vr'); } catch { return false; }
    },

    enterVR,
    exitVR,
    onVideoChange,
  };
})();
