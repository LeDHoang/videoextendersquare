/**
 * WebXR VR Module for Reels — Option C (XRQuadLayer)
 *
 * Provides a YouTube-VR-style immersive viewing experience:
 *  - XRQuadLayer path for Meta Quest (hardware compositor, max sharpness)
 *  - WebGL fallback for desktop WebXR Emulator testing
 *  - Grip-to-reposition, thumbstick resize/seek, floating transport controls
 *
 * Public API:
 *   WebXRVR.init(videoEl, callbacks)
 *   WebXRVR.enterVR()
 *   WebXRVR.exitVR()
 *   WebXRVR.isSupported() → Promise<boolean>
 */
const WebXRVR = (function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────
  let xrSession = null;
  let xrRefSpace = null;
  let videoElement = null;
  let callbacks = {};          // { onNext, onPrev, onTogglePlay, onSeek, getPlaylist, getCurrentIndex }
  let useLayers = false;       // true on Quest (XRMediaBinding available)

  // Layers path
  let videoLayer = null;       // XRQuadLayer for video
  let controlsLayer = null;    // XRQuadLayer for transport controls

  // WebGL fallback path
  let glLayer = null;
  let gl = null;
  let glProgram = null;
  let glVideoTexture = null;
  let glControlsTexture = null;
  let glQuadVAO = null;

  // Screen transform
  const DEFAULT_POS = { x: 0, y: 1.6, z: -2.8 };
  const DEFAULT_SCALE = 4.0;   // meters (full cinema screen scale by default)
  const MIN_SCALE = 1.0;
  const MAX_SCALE = 10.0;
  const SCALE_SPEED = 0.04;

  let screenPos = { ...DEFAULT_POS };
  let screenQuat = { x: 0, y: 0, z: 0, w: 1 };
  let screenScale = DEFAULT_SCALE;

  // Grab state
  let isGrabbing = false;
  let grabControllerIdx = -1;
  let grabDistance = 3.0;      // distance along ray when grab started

  // Controls panel state
  let controlsVisible = false;
  let controlsCanvas = null;
  let controlsCtx = null;
  const CONTROLS_W = 512;
  const CONTROLS_H = 128;
  let hoveredButton = -1;

  // Thumbstick flick debounce
  let flickedX = false;
  let flickedY = false;
  const FLICK_THRESHOLD = 0.5;
  const FLICK_RESET = 0.3;

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

  function vecLen(a) {
    return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  }

  function vecSub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  }

  function vecAdd(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  }

  function vecScale(a, s) {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
  }

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

    // Background — dark semi-transparent panel
    ctx.clearRect(0, 0, CONTROLS_W, CONTROLS_H);
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

    // Buttons row (top half)
    CTRL_BUTTONS.forEach((btn, i) => {
      const isHover = (hoveredButton === i);
      const y = 10;
      const h = 40;

      // Update play button label
      if (btn.action === 'play') btn.label = isPaused ? '▶' : '⏸';
      if (btn.action === 'mute') btn.label = isMuted ? '🔇' : '🔊';

      // Button background
      ctx.fillStyle = isHover ? '#FF3B1F' : 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.roundRect(btn.x, y, btn.w, h, 6);
      ctx.fill();

      // Button label
      ctx.fillStyle = isHover ? '#0A0A0A' : '#F2F3F5';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(btn.label, btn.x + btn.w / 2, y + h / 2);
    });

    // Progress bar (bottom section)
    const barX = 16;
    const barY = 65;
    const barW = CONTROLS_W - 32;
    const barH = 6;
    const progress = duration > 0 ? currentTime / duration : 0;

    // Track
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 3);
    ctx.fill();

    // Fill
    ctx.fillStyle = '#FF3B1F';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW * progress, barH, 3);
    ctx.fill();

    // Time text
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(
      formatTime(currentTime) + ' / ' + formatTime(duration),
      CONTROLS_W - 16, barY + barH + 16
    );

    // Metadata line
    const playlist = callbacks.getPlaylist ? callbacks.getPlaylist() : [];
    const idx = callbacks.getCurrentIndex ? callbacks.getCurrentIndex() : 0;
    const item = playlist[idx];
    if (item) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      const meta = `${item.filename}  ·  📁 ${item.folder}  ·  ${item.size}`;
      ctx.fillText(meta, 16, CONTROLS_H - 14);
    }

    // Counter top-right
    if (playlist.length > 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${idx + 1} / ${playlist.length}`, CONTROLS_W - 16, CONTROLS_H - 14);
    }
  }

  // ─── Controls Raycast ────────────────────────────────────────────────

  function hitTestControls(rayOrigin, rayDir) {
    // The controls panel sits below the video screen
    const ctrlCenter = {
      x: screenPos.x,
      y: screenPos.y - screenScale / 2 - 0.25,  // 0.25m below video
      z: screenPos.z,
    };
    const ctrlWidth = screenScale * 0.8;
    const ctrlHeight = ctrlWidth * (CONTROLS_H / CONTROLS_W);

    // Simple ray-plane intersection (panel faces +Z toward user)
    if (Math.abs(rayDir.z) < 0.001) return -1;
    const t = (ctrlCenter.z - rayOrigin.z) / rayDir.z;
    if (t < 0 || t > 20) return -1;

    const hitX = rayOrigin.x + rayDir.x * t;
    const hitY = rayOrigin.y + rayDir.y * t;

    // Convert to panel UV (0..1)
    const halfW = ctrlWidth / 2;
    const halfH = ctrlHeight / 2;
    const localX = hitX - (ctrlCenter.x - halfW);
    const localY = (ctrlCenter.y + halfH) - hitY;  // flip Y

    if (localX < 0 || localX > ctrlWidth || localY < 0 || localY > ctrlHeight) return -1;

    const u = localX / ctrlWidth;
    const v = localY / ctrlHeight;
    const canvasX = u * CONTROLS_W;
    const canvasY = v * CONTROLS_H;

    // Check button hit
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
    switch (action) {
      case 'prev':  callbacks.onPrev && callbacks.onPrev(); break;
      case 'next':  callbacks.onNext && callbacks.onNext(); break;
      case 'play':  callbacks.onTogglePlay && callbacks.onTogglePlay(); break;
      case 'rew':   callbacks.onSeek && callbacks.onSeek(-5); break;
      case 'fwd':   callbacks.onSeek && callbacks.onSeek(5); break;
      case 'mute':
        if (videoElement) {
          videoElement.muted = !videoElement.muted;
        }
        break;
      case 'exit':  exitVR(); break;
    }
  }

  // ─── WebGL Fallback Shaders ──────────────────────────────────────────

  const VERT_SRC = `
    attribute vec2 aPos;
    attribute vec2 aUV;
    varying vec2 vUV;
    uniform mat4 uMVP;
    void main() {
      vUV = aUV;
      gl_Position = uMVP * vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAG_SRC = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform float uAlpha;
    void main() {
      vec4 c = texture2D(uTex, vUV);
      gl_FragColor = vec4(c.rgb, c.a * uAlpha);
    }
  `;

  function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(s));
    }
    return s;
  }

  function initWebGLFallback(session) {
    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl', { xrCompatible: true });

    glLayer = new XRWebGLLayer(session, gl);
    session.updateRenderState({ baseLayer: glLayer });

    // Compile shaders
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);

    // Quad geometry: [-0.5, 0.5] with UVs
    const verts = new Float32Array([
      -0.5, -0.5,  0, 1,
       0.5, -0.5,  1, 1,
      -0.5,  0.5,  0, 0,
       0.5,  0.5,  1, 0,
    ]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
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
  }

  /**
   * Build a simple model-view-projection matrix for a quad at screenPos
   * with the given scale, viewed from viewMatrix + projMatrix.
   */
  function buildMVP(view, proj, pos, scale, aspect) {
    // Model matrix: translate to pos, scale
    // We build a 4x4 column-major array for WebGL
    const sw = scale;
    const sh = scale * aspect;

    const model = new Float32Array([
      sw, 0, 0, 0,
      0, sh, 0, 0,
      0, 0, 1, 0,
      pos.x, pos.y, pos.z, 1,
    ]);

    // MV = view * model
    const mv = mat4Mul(view, model);
    // MVP = proj * MV
    return mat4Mul(proj, mv);
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

  function renderWebGLQuad(viewMatrix, projMatrix, texture, pos, scale, aspect, alpha) {
    gl.useProgram(glProgram);

    const aPos = gl.getAttribLocation(glProgram, 'aPos');
    const aUV = gl.getAttribLocation(glProgram, 'aUV');
    const uMVP = gl.getUniformLocation(glProgram, 'uMVP');
    const uTex = gl.getUniformLocation(glProgram, 'uTex');
    const uAlpha = gl.getUniformLocation(glProgram, 'uAlpha');

    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);

    const mvp = buildMVP(viewMatrix, projMatrix, pos, scale, aspect);
    gl.uniformMatrix4fv(uMVP, false, mvp);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uTex, 0);
    gl.uniform1f(uAlpha, alpha);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ─── XR Frame Loop ──────────────────────────────────────────────────

  function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(xrRefSpace);
    if (!pose) return;

    // ── Process controller input ──
    processInput(frame);

    // ── Update controls visibility (auto-show on pause) ──
    const shouldShowControls = videoElement && videoElement.paused;
    controlsVisible = shouldShowControls || controlsVisible;

    // ── Layers path (Quest) ──
    if (useLayers && videoLayer) {
      // Update video layer transform
      videoLayer.transform = new XRRigidTransform(screenPos, screenQuat);
      videoLayer.width = screenScale;
      videoLayer.height = screenScale;

      // Update controls layer
      if (controlsVisible && controlsLayer) {
        renderControlsCanvas();
        controlsLayer.transform = new XRRigidTransform(
          {
            x: screenPos.x,
            y: screenPos.y - screenScale / 2 - 0.25,
            z: screenPos.z,
          },
          screenQuat
        );
        controlsLayer.width = screenScale * 0.8;
        controlsLayer.height = screenScale * 0.8 * (CONTROLS_H / CONTROLS_W);

        xrSession.updateRenderState({
          layers: [videoLayer, controlsLayer],
        });
      } else {
        xrSession.updateRenderState({
          layers: [videoLayer],
        });
      }
      return;
    }

    // ── WebGL fallback path (Desktop/Emulator) ──
    if (!glLayer || !gl) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    gl.viewport(0, 0, glLayer.framebufferWidth, glLayer.framebufferHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    for (const view of pose.views) {
      const vp = glLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      const viewMat = view.transform.inverse.matrix;
      const projMat = view.projectionMatrix;

      // Update video texture from <video> element
      if (videoElement && videoElement.readyState >= 2) {
        gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
      }

      // Render video quad
      renderWebGLQuad(viewMat, projMat, glVideoTexture, screenPos, screenScale, 1.0, 1.0);

      // Render controls quad if visible
      if (controlsVisible) {
        renderControlsCanvas();
        gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, controlsCanvas);

        const ctrlPos = {
          x: screenPos.x,
          y: screenPos.y - screenScale / 2 - 0.25,
          z: screenPos.z,
        };
        const ctrlScale = screenScale * 0.8;
        renderWebGLQuad(viewMat, projMat, glControlsTexture, ctrlPos, ctrlScale, CONTROLS_H / CONTROLS_W, 0.95);
      }
    }
  }

  // ─── Controller Input Processing ─────────────────────────────────────

  function processInput(frame) {
    if (!xrSession) return;

    for (const source of xrSession.inputSources) {
      if (!source.gamepad) continue;

      const gp = source.gamepad;
      const hand = source.handedness;  // 'left', 'right', or 'none'

      // Get controller pose for ray direction
      let controllerPos = null;
      let controllerDir = null;
      if (source.targetRaySpace) {
        const rayPose = frame.getPose(source.targetRaySpace, xrRefSpace);
        if (rayPose) {
          const t = rayPose.transform;
          controllerPos = { x: t.position.x, y: t.position.y, z: t.position.z };
          // The ray direction is -Z in the ray space's orientation
          const m = t.matrix || rayPose.transform.matrix;
          if (m) {
            controllerDir = { x: -m[8], y: -m[9], z: -m[10] };
          }
        }
      }

      // ── Grip: Grab & Reposition ──
      // Grip is typically gp.buttons[2]
      const gripPressed = gp.buttons[2] && gp.buttons[2].pressed;
      if (gripPressed && controllerPos && controllerDir) {
        if (!isGrabbing) {
          isGrabbing = true;
          grabControllerIdx = source.handedness === 'right' ? 1 : 0;
          // Calculate current grab distance
          const toScreen = vecSub(screenPos, controllerPos);
          grabDistance = vecLen(toScreen) || 3.0;
        }
        // Move screen to follow controller ray
        const dir = vecNorm(controllerDir);
        screenPos = vecAdd(controllerPos, vecScale(dir, grabDistance));
      } else if (isGrabbing && ((hand === 'right' && grabControllerIdx === 1) ||
                                 (hand === 'left' && grabControllerIdx === 0))) {
        isGrabbing = false;
        grabControllerIdx = -1;
      }

      // Only process other controls for the right hand
      if (hand !== 'right') continue;

      // ── Trigger: Next/Prev Reel ──
      // Right trigger = button[0] (select)
      // We use the 'selectstart'/'selectend' events instead for triggers
      // to avoid repeated firing. But we can also detect rising edge:
      // Actually, let's use gamepad for left trigger too.

      // ── A Button (button[4] on Quest) — Play/Pause ──
      if (gp.buttons[4] && gp.buttons[4].pressed) {
        if (!gp.buttons[4]._wasPressed) {
          callbacks.onTogglePlay && callbacks.onTogglePlay();
          gp.buttons[4]._wasPressed = true;
        }
      } else if (gp.buttons[4]) {
        gp.buttons[4]._wasPressed = false;
      }

      // ── B Button (button[5] on Quest) — Toggle controls ──
      if (gp.buttons[5] && gp.buttons[5].pressed) {
        if (!gp.buttons[5]._wasPressed) {
          controlsVisible = !controlsVisible;
          gp.buttons[5]._wasPressed = true;
        }
      } else if (gp.buttons[5]) {
        gp.buttons[5]._wasPressed = false;
      }

      // ── Right Thumbstick (axes[2]=X, axes[3]=Y) ──
      const thumbX = gp.axes[2] || 0;
      const thumbY = gp.axes[3] || 0;

      // Y-axis: resize screen
      if (Math.abs(thumbY) > FLICK_THRESHOLD) {
        // Continuous resize while held
        screenScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
          screenScale + (-thumbY) * SCALE_SPEED
        ));
      }

      // X-axis: seek ±5s (flick, not continuous)
      if (Math.abs(thumbX) > FLICK_THRESHOLD && !flickedX) {
        flickedX = true;
        callbacks.onSeek && callbacks.onSeek(thumbX > 0 ? 5 : -5);
      } else if (Math.abs(thumbX) < FLICK_RESET) {
        flickedX = false;
      }

      // ── Raycast against controls panel when visible ──
      if (controlsVisible && controllerPos && controllerDir) {
        hoveredButton = hitTestControls(controllerPos, controllerDir);
      }
    }

    // ── Left controller: trigger for Previous ──
    for (const source of xrSession.inputSources) {
      if (!source.gamepad || source.handedness !== 'left') continue;
      // Left trigger = button[0]
      // Handled via select events below
    }
  }

  // ─── Session Management ──────────────────────────────────────────────

  async function enterVR() {
    if (xrSession) return;
    if (!navigator.xr) {
      alert('WebXR is not available in this browser context. WebXR requires HTTPS or localhost, and feature policy permission on the iframe.');
      console.warn('WebXR not available');
      return;
    }

    try {
      xrSession = await navigator.xr.requestSession('immersive-vr', {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['layers'],
      });
    } catch (e) {
      // Fallback without local-floor
      try {
        xrSession = await navigator.xr.requestSession('immersive-vr', {
          optionalFeatures: ['local-floor', 'layers'],
        });
      } catch (e2) {
        console.error('Failed to start WebXR session:', e2);
        alert('Could not start Immersive VR session: ' + e2.message);
        return;
      }
    }

    // Reset screen position
    screenPos = { ...DEFAULT_POS };
    screenScale = DEFAULT_SCALE;
    controlsVisible = false;

    // Get reference space
    try {
      xrRefSpace = await xrSession.requestReferenceSpace('local-floor');
    } catch {
      xrRefSpace = await xrSession.requestReferenceSpace('local');
    }

    // Detect Layers API support
    useLayers = false;
    if (typeof XRMediaBinding !== 'undefined') {
      try {
        const binding = new XRMediaBinding(xrSession);
        // Try creating the video quad layer
        videoLayer = binding.createQuadLayer(videoElement, {
          space: xrRefSpace,
          width: screenScale,
          height: screenScale,
          layout: 'mono',
          transform: new XRRigidTransform(screenPos, screenQuat),
        });
        useLayers = true;

        // Create controls layer from canvas
        initControlsCanvas();
        renderControlsCanvas();

        // For controls, we need an XRWebGLBinding to create a quad from texture
        // Actually, for simplicity on Quest, we can use a second XRMediaBinding
        // but it only works with video elements. So we use XRWebGLBinding for
        // the controls quad, or just overlay the controls info on the same layer.
        // Simplification: render controls as a second quad layer if possible,
        // otherwise render it as part of the same session.
        //
        // The Meta Quest compositor supports multiple layers. We'll create
        // the controls as an XRWebGLBinding quad with canvas texture.
        const glCanvas = document.createElement('canvas');
        const glCtx = glCanvas.getContext('webgl', { xrCompatible: true });
        if (glCtx) {
          const webglBinding = new XRWebGLBinding(xrSession, glCtx);
          controlsLayer = webglBinding.createQuadLayer({
            space: xrRefSpace,
            width: screenScale * 0.8,
            height: screenScale * 0.8 * (CONTROLS_H / CONTROLS_W),
            viewPixelWidth: CONTROLS_W,
            viewPixelHeight: CONTROLS_H,
            layout: 'mono',
            transform: new XRRigidTransform(
              {
                x: screenPos.x,
                y: screenPos.y - screenScale / 2 - 0.25,
                z: screenPos.z,
              },
              screenQuat
            ),
          });
        }

        xrSession.updateRenderState({ layers: [videoLayer] });
        console.log('[WebXRVR] Using XRQuadLayer (hardware compositor)');
      } catch (e) {
        console.warn('[WebXRVR] XRMediaBinding failed, using WebGL fallback:', e);
        useLayers = false;
        videoLayer = null;
        controlsLayer = null;
      }
    }

    // WebGL fallback
    if (!useLayers) {
      initControlsCanvas();
      initWebGLFallback(xrSession);
      console.log('[WebXRVR] Using WebGL fallback (texture quad)');
    }

    // Controller events for trigger-based navigation
    xrSession.addEventListener('selectstart', onSelectStart);
    xrSession.addEventListener('end', onSessionEnd);

    // Add VR active class
    const frame = document.getElementById('reelsFrame');
    if (frame) frame.classList.add('vr-active');

    // Ensure video is playing
    if (videoElement && videoElement.paused) {
      videoElement.play().catch(() => {});
    }

    // Start render loop
    xrSession.requestAnimationFrame(onXRFrame);
  }

  function onSelectStart(ev) {
    const hand = ev.inputSource.handedness;
    if (hand === 'right') {
      callbacks.onNext && callbacks.onNext();
    } else if (hand === 'left') {
      callbacks.onPrev && callbacks.onPrev();
    }

    // Also check if we hit a controls button
    if (controlsVisible && hoveredButton >= 0) {
      executeControlButton(hoveredButton);
    }
  }

  function onSessionEnd() {
    cleanup();
  }

  function exitVR() {
    if (xrSession) {
      xrSession.end().catch(() => {});
    }
  }

  function cleanup() {
    xrSession = null;
    xrRefSpace = null;
    videoLayer = null;
    controlsLayer = null;
    glLayer = null;
    gl = null;
    glProgram = null;
    glVideoTexture = null;
    glControlsTexture = null;
    useLayers = false;
    isGrabbing = false;
    controlsVisible = false;

    const frame = document.getElementById('reelsFrame');
    if (frame) frame.classList.remove('vr-active');
  }

  // ─── Public API ──────────────────────────────────────────────────────

  return {
    init(video, cbs) {
      videoElement = video;
      callbacks = cbs || {};
    },

    async isSupported() {
      if (!navigator.xr) return false;
      try {
        return await navigator.xr.isSessionSupported('immersive-vr');
      } catch {
        return false;
      }
    },

    enterVR,
    exitVR,
  };
})();
