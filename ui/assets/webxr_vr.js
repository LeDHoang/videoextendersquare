/**
 * WebXR VR Module for Reels — v3.9 (YouTube VR Curve & DeoVR 6DOF Grab)
 *
 * Key Improvements in v3.9:
 *  - YouTube VR Standard Curved Screen (ARC_ANGLE = 0.6 rad ~34.4° arc, R = 1.6667m)
 *  - DeoVR / Skybox 6DOF Grab & Repositioning restored from commit ddcd715
 *  - Exact 1:1 Square Aspect Ratio preserved in both Curved & Flat modes
 */
const WebXRVR = (function () {
  'use strict';

  /* ═══ VERSION TAG ═══ */
  const VR_VERSION = 'v4.0-20260803';
  console.log('[WebXRVR] Module loaded:', VR_VERSION);

  // ─── State ───────────────────────────────────────────────────────────
  let xrSession = null;
  let xrRefSpace = null;
  let videoElement = null;
  let callbacks = {};

  // Display Settings
  let isCurved = true;         // Default to Deep IMAX Curved Screen

  // WebGL state
  let gl = null;
  let glLayer = null;
  let glProgram = null;
  let glVideoTexture = null;
  let glControlsTexture = null;
  let glReticleTexture = null;
  let glGridBuf = null;
  let glGridVertCount = 0;
  let glLaserBuf = null;

  // Cached GL locations
  let loc_aPos = -1;
  let loc_aUV = -1;
  let loc_uMVP = null;
  let loc_uTex = null;
  let loc_uAlpha = null;
  let loc_uCurved = null;

  // Pointer & Ray tracking
  let activeRayOrigin = null;
  let activeRayDir = null;
  let activeHitDist = 3.0;
  let activeIsHovering = false;

  // Screen transform
  const DEFAULT_POS = { x: 0, y: 1.6, z: -2.8 };
  const DEFAULT_SCALE = 4.0;
  const MIN_SCALE = 1.0;
  const MAX_SCALE = 10.0;
  const SCALE_SPEED = 0.04;

  let screenPos = { ...DEFAULT_POS };
  let screenQuat = { x: 0, y: 0, z: 0, w: 1 };
  let screenScale = DEFAULT_SCALE;

  // 6DOF Grab state (DeoVR / Skybox style)
  let isGrabbing = false;
  let grabControllerIdx = -1;
  let grabRelPos = { x: 0, y: 0, z: 0 };
  let grabRelQuat = { x: 0, y: 0, z: 0, w: 1 };

  // Controls panel state
  let controlsVisible = false;
  let controlsCanvas = null;
  let controlsCtx = null;
  const CONTROLS_W = 640;
  const CONTROLS_H = 150;
  let hoveredButton = -1;
  let controlsAutoHideTimer = null;
  const CONTROLS_AUTO_HIDE_MS = 5000;

  // Video frame tracking
  let hasNewVideoFrame = true;
  let lastVideoTime = -1;

  // Thumbstick flick debounces
  let flickedX = false;
  let flickedY = false;
  const FLICK_THRESHOLD = 0.5;
  const FLICK_RESET = 0.3;

  // External button state tracking
  const prevBtnState = { rightA: false, rightB: false, leftA: false, leftB: false };

  // Button definitions for the UI controls panel
  const CTRL_BUTTONS = [
    { label: '⏮',       action: 'prev',   x: 16,  w: 52 },
    { label: '◀◀',      action: 'rew',    x: 76,  w: 52 },
    { label: '▶',        action: 'play',   x: 136, w: 68 },
    { label: '▶▶',      action: 'fwd',    x: 212, w: 52 },
    { label: '⏭',       action: 'next',   x: 272, w: 52 },
    { label: '🌙 CURVE', action: 'curve',  x: 332, w: 106 },
    { label: '🔊',       action: 'mute',   x: 446, w: 52 },
    { label: '✕',        action: 'exit',   x: 506, w: 52 },
  ];

  // ─── Quaternion & Vector Math Helpers ───────────────────────────────

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

  function quatInvert(q) {
    const normSq = q.x*q.x + q.y*q.y + q.z*q.z + q.w*q.w;
    if (normSq === 0) return { x: 0, y: 0, z: 0, w: 1 };
    const inv = -1 / normSq;
    return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w / normSq };
  }

  function quatMul(a, b) {
    return {
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    };
  }

  function quatRotVec(q, v) {
    const qv = { x: v.x, y: v.y, z: v.z, w: 0 };
    const res = quatMul(quatMul(q, qv), quatInvert(q));
    return { x: res.x, y: res.y, z: res.z };
  }

  function quatLevelFromDir(dir) {
    // Compute yaw such that screen's local +Z axis points towards viewer direction.
    // Correct formula: yaw = atan2(dir.x, dir.z).
    // (Previous -dir.x, -dir.z produced a 180° wrong rotation causing screen flip.)
    const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    if (len < 0.001) return { x: 0, y: 0, z: 0, w: 1 };
    const yaw = Math.atan2(dir.x, dir.z);
    return {
      x: 0,
      y: Math.sin(yaw / 2),
      z: 0,
      w: Math.cos(yaw / 2),
    };
  }

  // ─── Premium UI Controls Canvas Rendering ────────────────────────────

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

    // Dark Glass Container Background
    ctx.fillStyle = 'rgba(8, 9, 10, 0.94)';
    ctx.beginPath();
    ctx.roundRect(0, 0, CONTROLS_W, CONTROLS_H, 16);
    ctx.fill();

    // Glowing Border
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(0, 0, CONTROLS_W, CONTROLS_H, 16);
    ctx.stroke();

    // Header Metadata & Badge Row
    ctx.fillStyle = '#FF3B1F';
    ctx.beginPath();
    ctx.roundRect(16, 12, 108, 18, 4);
    ctx.fill();

    ctx.fillStyle = '#0A0A0A';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('4K VR REELS', 70, 21);

    const playlist = callbacks.getPlaylist ? callbacks.getPlaylist() : [];
    const idx = callbacks.getCurrentIndex ? callbacks.getCurrentIndex() : 0;
    const item = playlist[idx];

    if (item) {
      ctx.fillStyle = 'rgba(242, 243, 245, 0.85)';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${item.filename}`, 134, 21);
    }
    if (playlist.length > 0) {
      ctx.fillStyle = '#FF3B1F';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${idx + 1} / ${playlist.length}`, CONTROLS_W - 16, 21);
    }

    // Buttons Row
    CTRL_BUTTONS.forEach((btn, i) => {
      const isHover = (hoveredButton === i);
      const y = 42;
      const h = 42;

      if (btn.action === 'play') btn.label = isPaused ? '▶' : '⏸';
      if (btn.action === 'mute') btn.label = isMuted ? '🔇' : '🔊';
      if (btn.action === 'curve') btn.label = isCurved ? '🌙 CURVE' : '📺 FLAT';

      if (isHover || btn.action === 'play') {
        ctx.fillStyle = isHover ? '#FF3B1F' : 'rgba(255, 59, 31, 0.85)';
        ctx.shadowColor = 'rgba(255, 59, 31, 0.6)';
        ctx.shadowBlur = 10;
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.shadowBlur = 0;
      }
      ctx.beginPath();
      ctx.roundRect(btn.x, y, btn.w, h, 8);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = isHover ? '#FF3B1F' : 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(btn.x, y, btn.w, h, 8);
      ctx.stroke();

      ctx.fillStyle = (isHover || btn.action === 'play') ? '#0A0A0A' : '#F2F3F5';
      ctx.font = btn.action === 'curve' ? 'bold 12px sans-serif' : 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(btn.label, btn.x + btn.w / 2, y + h / 2);
    });

    // Progress Bar Track
    const barX = 16, barY = 98;
    const barW = CONTROLS_W - 32, barH = 8;
    const progress = duration > 0 ? currentTime / duration : 0;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 4);
    ctx.fill();

    // Progress Fill
    ctx.fillStyle = '#FF3B1F';
    ctx.shadowColor = '#FF3B1F';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.roundRect(barX, barY, Math.max(2, barW * progress), barH, 4);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Time Indicator Text
    ctx.fillStyle = 'rgba(242, 243, 245, 0.8)';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('PROGRESS', 16, CONTROLS_H - 16);

    ctx.textAlign = 'right';
    ctx.fillText(formatTime(currentTime) + ' / ' + formatTime(duration), CONTROLS_W - 16, CONTROLS_H - 16);
  }

  // ─── YouTube VR Curved Screen Arc Geometry Math ─────────────────────
  // ARC_ANGLE = 0.6 rad (~34.4° arc angle for authentic YouTube VR curve)
  // R_CURVE = 1.0 / 0.6 = 1.6667 (Arc length == 1.0, perfect 1:1 square ratio)

  const ARC_ANGLE = 0.6;
  const R_CURVE = 1.6667;

  function hitTestCurvedScreen(rayOrigin, rayDir) {
    const halfW = screenScale / 2;
    const halfH = screenScale / 2;

    const invQ = quatInvert(screenQuat);
    const O_loc = quatRotVec(invQ, vecSub(rayOrigin, screenPos));
    const D_loc = quatRotVec(invQ, rayDir);

    if (isCurved) {
      const R_world = R_CURVE * screenScale;
      const Ox = O_loc.x, Oz = O_loc.z - R_world;
      const Dx = D_loc.x, Dz = D_loc.z;

      const A = Dx * Dx + Dz * Dz;
      if (A < 0.00001) return { hit: false, dist: -1 };

      const B = 2 * (Ox * Dx + Oz * Dz);
      const C = Ox * Ox + Oz * Oz - R_world * R_world;

      const disc = B * B - 4 * A * C;
      if (disc < 0) return { hit: false, dist: -1 };

      let t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t < 0) t = (-B + Math.sqrt(disc)) / (2 * A);
      if (t < 0 || t > 20) return { hit: false, dist: -1 };

      const hitLocal = vecAdd(O_loc, vecScale(D_loc, t));
      const angle = Math.atan2(hitLocal.x, R_world - hitLocal.z);
      const halfArc = (ARC_ANGLE * 0.5);

      if (Math.abs(angle) <= halfArc && Math.abs(hitLocal.y) <= halfH) {
        return { hit: true, dist: t, hitLocal };
      }
      return { hit: false, dist: -1 };
    } else {
      const denom = D_loc.z;
      if (Math.abs(denom) < 0.0001) return { hit: false, dist: -1 };

      const t = -O_loc.z / denom;
      if (t < 0 || t > 20) return { hit: false, dist: -1 };

      const hitLocal = vecAdd(O_loc, vecScale(D_loc, t));
      if (Math.abs(hitLocal.x) <= halfW && Math.abs(hitLocal.y) <= halfH) {
        return { hit: true, dist: t, hitLocal };
      }
      return { hit: false, dist: -1 };
    }
  }

  function getHitDistControls(rayOrigin, rayDir) {
    const ctrlCenter = {
      x: screenPos.x,
      y: screenPos.y - screenScale / 2 - 0.28,
      z: screenPos.z,
    };
    const normal = quatRotVec(screenQuat, { x: 0, y: 0, z: 1 });
    const denom = rayDir.x * normal.x + rayDir.y * normal.y + rayDir.z * normal.z;
    if (Math.abs(denom) < 0.0001) return -1;
    const t = ((ctrlCenter.x - rayOrigin.x) * normal.x +
               (ctrlCenter.y - rayOrigin.y) * normal.y +
               (ctrlCenter.z - rayOrigin.z) * normal.z) / denom;
    return t > 0 ? t : -1;
  }

  function hitTestControls(rayOrigin, rayDir) {
    const ctrlCenter = {
      x: screenPos.x,
      y: screenPos.y - screenScale / 2 - 0.28,
      z: screenPos.z,
    };
    const ctrlWidth = screenScale * 0.8;
    const ctrlHeight = ctrlWidth * (CONTROLS_H / CONTROLS_W);

    const normal = quatRotVec(screenQuat, { x: 0, y: 0, z: 1 });
    const denom = rayDir.x * normal.x + rayDir.y * normal.y + rayDir.z * normal.z;

    if (Math.abs(denom) < 0.0001) return -1;
    const t = ((ctrlCenter.x - rayOrigin.x) * normal.x +
               (ctrlCenter.y - rayOrigin.y) * normal.y +
               (ctrlCenter.z - rayOrigin.z) * normal.z) / denom;
    if (t < 0 || t > 20) return -1;

    const hitP = vecAdd(rayOrigin, vecScale(rayDir, t));
    const invQ = quatInvert(screenQuat);
    const localP = quatRotVec(invQ, vecSub(hitP, ctrlCenter));

    const halfW = ctrlWidth / 2;
    const halfH = ctrlHeight / 2;

    if (Math.abs(localP.x) > halfW || Math.abs(localP.y) > halfH) return -1;

    const u = (localP.x + halfW) / ctrlWidth;
    const v = (halfH - localP.y) / ctrlHeight;
    const canvasX = u * CONTROLS_W;
    const canvasY = v * CONTROLS_H;

    for (let i = 0; i < CTRL_BUTTONS.length; i++) {
      const btn = CTRL_BUTTONS[i];
      if (canvasX >= btn.x && canvasX <= btn.x + btn.w && canvasY >= 42 && canvasY <= 84) {
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
      case 'curve': isCurved = !isCurved; break;
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

  // ─── WebGL Setup & Shaders ──────────────────────────────────────────

  /**
   * YouTube VR Curved Arc Shader (ARC_ANGLE = 0.6 rad ~34.4° arc, R = 1.6667m)
   * Arc length = R * ARC_ANGLE = 1.0 → perfect 1:1 square video ratio preserved.
   */
  const VERT = `
    attribute vec3 aPos;
    attribute vec2 aUV;
    varying vec2 vUV;
    uniform mat4 uMVP;
    uniform float uCurved;

    const float ARC_ANGLE = 0.6;
    const float R = 1.6667;

    void main() {
      vUV = aUV;
      vec3 pos = aPos;
      if (uCurved > 0.5) {
        float angle = aPos.x * ARC_ANGLE;
        pos.x = R * sin(angle);
        pos.z = R * (1.0 - cos(angle)); // YouTube VR style subtle curve towards viewer
      }
      gl_Position = uMVP * vec4(pos, 1.0);
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

  function initReticleTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, '#FFFFFF');
    grad.addColorStop(0.25, '#FF3B1F');
    grad.addColorStop(0.7, 'rgba(255, 59, 31, 0.6)');
    grad.addColorStop(1, 'rgba(255, 59, 31, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#FF3B1F';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(32, 32, 12, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(32, 32, 4, 0, Math.PI * 2);
    ctx.fill();

    glReticleTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glReticleTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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

    loc_aPos = gl.getAttribLocation(glProgram, 'aPos');
    loc_aUV = gl.getAttribLocation(glProgram, 'aUV');
    loc_uMVP = gl.getUniformLocation(glProgram, 'uMVP');
    loc_uTex = gl.getUniformLocation(glProgram, 'uTex');
    loc_uAlpha = gl.getUniformLocation(glProgram, 'uAlpha');
    loc_uCurved = gl.getUniformLocation(glProgram, 'uCurved');

    const COLS = 32;
    const verts = [];
    for (let col = 0; col <= COLS; col++) {
      const u = col / COLS;
      const x = u - 0.5;
      verts.push(x, 0.5, 0.0, u, 0);
      verts.push(x, -0.5, 0.0, u, 1);
    }
    glGridVertCount = (COLS + 1) * 2;
    glGridBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glGridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

    glLaserBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glLaserBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(10), gl.DYNAMIC_DRAW);

    glVideoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    glControlsTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    initReticleTexture();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    console.log('[WebXRVR] WebGL initialised OK with Deep IMAX Curve & Smooth 6DOF');
    return true;
  }

  // ─── Matrix & Transformation Math ────────────────────────────────────

  function mat4FromRotationTranslationScale(q, p, sW, sH) {
    const sZ = sW; // Uniform Z scale matching screen width scale
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    const m00 = (1 - (yy + zz)) * sW;
    const m10 = (xy + wz) * sW;
    const m20 = (xz - wy) * sW;

    const m01 = (xy - wz) * sH;
    const m11 = (1 - (xx + zz)) * sH;
    const m21 = (yz + wx) * sH;

    const m02 = (xz + wy) * sZ;
    const m12 = (yz - wx) * sZ;
    const m22 = (1 - (xx + yy)) * sZ;

    return new Float32Array([
      m00, m10, m20, 0,
      m01, m11, m21, 0,
      m02, m12, m22, 0,
      p.x, p.y, p.z, 1
    ]);
  }

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

  // ─── Draw Mesh Grid ──────────────────────────────────────────────────

  function drawGrid(viewMat, projMat, texture, pos, quat, scaleW, scaleH, alpha, curved) {
    gl.useProgram(glProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, glGridBuf);
    gl.enableVertexAttribArray(loc_aPos);
    gl.enableVertexAttribArray(loc_aUV);
    gl.vertexAttribPointer(loc_aPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(loc_aUV, 2, gl.FLOAT, false, 20, 12);

    const modelMat = mat4FromRotationTranslationScale(quat, pos, scaleW, scaleH);
    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));

    gl.uniformMatrix4fv(loc_uMVP, false, mvp);
    gl.uniform1f(loc_uCurved, curved ? 1.0 : 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc_uTex, 0);
    gl.uniform1f(loc_uAlpha, alpha);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, glGridVertCount);
  }

  // ─── Draw Laser Pointer Beam & Target Reticle Dot ────────────────────

  function drawLaserPointer(viewMat, projMat) {
    if (!activeRayOrigin || !activeRayDir) return;

    const hitDist = (activeHitDist > 0) ? activeHitDist : 3.0;
    const hitP = vecAdd(activeRayOrigin, vecScale(activeRayDir, hitDist));

    const lineVerts = new Float32Array([
      activeRayOrigin.x, activeRayOrigin.y, activeRayOrigin.z, 0.5, 0.5,
      hitP.x, hitP.y, hitP.z, 0.5, 0.5
    ]);

    gl.useProgram(glProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, glLaserBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, lineVerts);

    gl.enableVertexAttribArray(loc_aPos);
    gl.enableVertexAttribArray(loc_aUV);
    gl.vertexAttribPointer(loc_aPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(loc_aUV, 2, gl.FLOAT, false, 20, 12);

    const mvp = mat4Mul(projMat, viewMat);
    gl.uniformMatrix4fv(loc_uMVP, false, mvp);
    gl.uniform1f(loc_uCurved, 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glReticleTexture);
    gl.uniform1i(loc_uTex, 0);
    gl.uniform1f(loc_uAlpha, 0.85);

    gl.drawArrays(gl.LINES, 0, 2);

    const dotScale = activeIsHovering ? 0.06 : 0.04;
    drawGrid(viewMat, projMat, glReticleTexture, hitP, screenQuat, dotScale, dotScale, 0.95, false);
  }

  // ─── XR Frame Loop ──────────────────────────────────────────────────

  function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(xrRefSpace);
    if (!pose) return;

    processInput(frame);

    if (videoElement && videoElement.paused && !controlsVisible) {
      showControls();
    }

    if (!glLayer || !gl) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    gl.clearColor(0.03, 0.03, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (videoElement && videoElement.readyState >= 2) {
      const vt = videoElement.currentTime;
      if (hasNewVideoFrame || vt !== lastVideoTime) {
        gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
        hasNewVideoFrame = false;
        lastVideoTime = vt;
      }
    }

    if (controlsVisible) {
      renderControlsCanvas();
      gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, controlsCanvas);
    }

    for (const view of pose.views) {
      const vp = glLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      const viewMat = view.transform.inverse.matrix;
      const projMat = view.projectionMatrix;

      drawGrid(viewMat, projMat, glVideoTexture, screenPos, screenQuat, screenScale, screenScale, 1.0, isCurved);

      if (controlsVisible) {
        const offsetLocal = { x: 0, y: -screenScale / 2 - 0.28, z: 0 };
        const offsetWorld = quatRotVec(screenQuat, offsetLocal);
        const ctrlPos = vecAdd(screenPos, offsetWorld);

        const ctrlW = screenScale * 0.8;
        const ctrlH = ctrlW * (CONTROLS_H / CONTROLS_W);
        drawGrid(viewMat, projMat, glControlsTexture, ctrlPos, screenQuat, ctrlW, ctrlH, 0.96, false);
      }

      drawLaserPointer(viewMat, projMat);
    }
  }

  // ─── Controller Input Processing ─────────────────────────────────────

  function processInput(frame) {
    if (!xrSession) return;

    for (const source of xrSession.inputSources) {
      if (!source.gamepad) continue;

      const gp = source.gamepad;
      const hand = source.handedness;

      let controllerPos = null;
      let controllerDir = null;
      let controllerQuat = { x: 0, y: 0, z: 0, w: 1 };

      if (source.targetRaySpace) {
        const rayPose = frame.getPose(source.targetRaySpace, xrRefSpace);
        if (rayPose) {
          const t = rayPose.transform;
          controllerPos = { x: t.position.x, y: t.position.y, z: t.position.z };
          controllerQuat = { x: t.orientation.x, y: t.orientation.y, z: t.orientation.z, w: t.orientation.w };
          const m = t.matrix || rayPose.transform.matrix;
          if (m) controllerDir = { x: -m[8], y: -m[9], z: -m[10] };
        }
      }

      // ── Grip: 6DOF Natural Grab & Reposition (DeoVR / Skybox style) ──
      const gripPressed = gp.buttons.length > 1 && gp.buttons[1].pressed;
      if (gripPressed && controllerPos && controllerDir) {
        if (!isGrabbing) {
          isGrabbing = true;
          grabControllerIdx = hand === 'right' ? 1 : 0;
          const qCtrlInv = quatInvert(controllerQuat);
          const pDiff = vecSub(screenPos, controllerPos);
          grabRelPos = quatRotVec(qCtrlInv, pDiff);
          grabRelQuat = quatMul(qCtrlInv, screenQuat);
        }
        if ((hand === 'right' && grabControllerIdx === 1) || (hand === 'left' && grabControllerIdx === 0)) {
          const rotatedRel = quatRotVec(controllerQuat, grabRelPos);
          screenPos = vecAdd(controllerPos, rotatedRel);

          // Keep screen horizontally level & upright (zero pitch/roll, facing viewer)
          const toViewer = vecNorm(vecSub({ x: 0, y: 1.6, z: 0 }, screenPos));
          const yaw = Math.atan2(toViewer.x, toViewer.z);
          screenQuat = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
        }
      } else if (isGrabbing && ((hand === 'right' && grabControllerIdx === 1) ||
                                 (hand === 'left' && grabControllerIdx === 0))) {
        isGrabbing = false;
        grabControllerIdx = -1;
      }

      // Process right controller inputs
      if (hand !== 'right') continue;

      // Active pointer ray tracking
      if (controllerPos && controllerDir) {
        activeRayOrigin = controllerPos;
        activeRayDir = controllerDir;

        let hitDist = -1;
        let isHover = false;

        if (controlsVisible) {
          const btnIdx = hitTestControls(controllerPos, controllerDir);
          if (btnIdx >= 0) {
            hoveredButton = btnIdx;
            hitDist = getHitDistControls(controllerPos, controllerDir);
            isHover = true;
          } else {
            hoveredButton = -1;
          }
        }

        if (!isHover) {
          const mainHit = hitTestCurvedScreen(controllerPos, controllerDir);
          if (mainHit.hit) {
            hitDist = mainHit.dist;
            isHover = true;
          }
        }

        activeHitDist = (hitDist > 0) ? hitDist : 3.0;
        activeIsHovering = isHover;
      }

      // ── 2. Right Joystick Handling ──
      const thumbY = gp.axes[3] || 0;
      const thumbX = gp.axes[2] || 0;

      if (gripPressed) {
        // A) GRIP HELD + Joystick Y Up/Down -> Scale Screen Larger / Smaller
        if (Math.abs(thumbY) > FLICK_THRESHOLD) {
          screenScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
            screenScale + (-thumbY) * SCALE_SPEED
          ));
        }
      } else {
        // B) NORMAL Joystick Y Up/Down -> Next / Previous Reel Navigation
        if (Math.abs(thumbY) > FLICK_THRESHOLD && !flickedY) {
          flickedY = true;
          if (thumbY > 0) {
            callbacks.onNext && callbacks.onNext();
          } else {
            callbacks.onPrev && callbacks.onPrev();
          }
          showControls();
        } else if (Math.abs(thumbY) < FLICK_RESET) {
          flickedY = false;
        }
      }

      // C) Joystick X Left/Right -> Seek ±5s
      if (Math.abs(thumbX) > FLICK_THRESHOLD && !flickedX) {
        flickedX = true;
        callbacks.onSeek && callbacks.onSeek(thumbX > 0 ? 5 : -5);
        showControls();
      } else if (Math.abs(thumbX) < FLICK_RESET) {
        flickedX = false;
      }

      // ── 3. A Button: Toggle Play / Pause ──
      const aPressed = gp.buttons.length > 4 && gp.buttons[4].pressed;
      if (aPressed && !prevBtnState.rightA) {
        callbacks.onTogglePlay && callbacks.onTogglePlay();
        showControls();
      }
      prevBtnState.rightA = aPressed;

      // ── 4. B Button: Disabled (no-op) ──
      const bPressed = gp.buttons.length > 5 && gp.buttons[5].pressed;
      prevBtnState.rightB = bPressed;
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

    screenPos = { ...DEFAULT_POS };
    screenQuat = { x: 0, y: 0, z: 0, w: 1 };
    screenScale = DEFAULT_SCALE;
    controlsVisible = false;
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    hoveredButton = -1;
    isGrabbing = false;
    activeRayOrigin = null;
    activeRayDir = null;
    flickedX = false;
    flickedY = false;

    initControlsCanvas();

    try {
      xrRefSpace = await xrSession.requestReferenceSpace('local-floor');
    } catch {
      xrRefSpace = await xrSession.requestReferenceSpace('local');
    }

    if (!initGL(xrSession)) {
      xrSession.end().catch(() => {});
      xrSession = null;
      return;
    }

    setupVideoFrameTracking();

    xrSession.addEventListener('selectstart', onSelectStart);
    xrSession.addEventListener('end', onSessionEnd);

    if (videoElement) {
      videoElement.addEventListener('pause', onVideoPause);
      videoElement.addEventListener('play', onVideoPlay);
    }

    const frameEl = document.getElementById('reelsFrame');
    if (frameEl) frameEl.classList.add('vr-active');

    if (videoElement && videoElement.paused) {
      videoElement.play().catch(() => {});
    }

    xrSession.requestAnimationFrame(onXRFrame);
  }

  function onVideoPause() {
    if (xrSession) showControls();
  }

  function onVideoPlay() {
    if (xrSession && controlsVisible) resetAutoHideTimer();
  }

  /**
   * Primary Trigger Click Handler
   */
  function onSelectStart(ev) {
    const source = ev.inputSource;
    if (!source) return;

    const frame = ev.frame;
    let rayOrigin = null, rayDir = null;
    if (source.targetRaySpace && frame && xrRefSpace) {
      const rayPose = frame.getPose(source.targetRaySpace, xrRefSpace);
      if (rayPose) {
        const t = rayPose.transform;
        rayOrigin = { x: t.position.x, y: t.position.y, z: t.position.z };
        const m = t.matrix || rayPose.transform.matrix;
        if (m) rayDir = { x: -m[8], y: -m[9], z: -m[10] };
      }
    }

    // 1. Check UI Controls Button Click
    if (controlsVisible && hoveredButton >= 0) {
      executeControlButton(hoveredButton);
      return;
    }

    // 2. Check Click on Main Video Screen
    if (rayOrigin && rayDir) {
      const mainHit = hitTestCurvedScreen(rayOrigin, rayDir);
      if (mainHit.hit) {
        callbacks.onTogglePlay && callbacks.onTogglePlay();
        toggleControls();
        return;
      }
    }

    // 3. Click outside screen -> toggle controls visibility
    toggleControls();
  }

  function onSessionEnd() {
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
    glReticleTexture = null;
    glGridBuf = null;
    glLaserBuf = null;
    glGridVertCount = 0;
    loc_aPos = -1;
    loc_aUV = -1;
    loc_uMVP = null;
    loc_uTex = null;
    loc_uAlpha = null;
    loc_uCurved = null;
    controlsVisible = false;
    isGrabbing = false;
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    hoveredButton = -1;
    activeRayOrigin = null;
    activeRayDir = null;
    flickedX = false;
    flickedY = false;

    const frameEl = document.getElementById('reelsFrame');
    if (frameEl) frameEl.classList.remove('vr-active');
  }

  function onVideoChange() {
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    console.log('[WebXRVR] Video source changed — picking up new frame');
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
