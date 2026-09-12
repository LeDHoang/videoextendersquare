/**
 * WebXR VR Module for Reels — v4.1 (Tangent-to-Viewer POV & Horizontally Level Grip Drag)
 *
 * Key Improvements in v4.1:
 *  - Tangent to Viewer POV: Screen tilts forward/backward when moved up/down to face your eyes directly
 *  - 100% Horizontally Level: Zero sideways roll along Z-axis (left/right edges stay level)
 *  - DeoVR/Skybox 6DOF Natural Grab & Repositioning
 *  - YouTube VR Standard Curved Screen (ARC_ANGLE = 0.6 rad ~34.4° arc, R = 1.6667m)
 */
window.WebXRVR = window.WebXRVR || (function () {
  'use strict';

  /* ═══ VERSION TAG ═══ */
  const VR_VERSION = 'v5.0-20260912-earth-preview';
  console.log('[WebXRVR] Module loaded:', VR_VERSION);

  // ─── State ───────────────────────────────────────────────────────────
  let xrSession = null;
  let xrRefSpace = null;
  let videoElement = null;
  let callbacks = {};

  // Curvature Settings
  // 1: Concave Hemisphere (Radial Dome, Default - Center is focal point, curves on all sides)
  // 2: Concave Square (Biaxial Pillow Curve - Symmetrical curve maintaining square format)
  // 0: Flat
  let curvatureMode = 1;
  let isCurved = true; // backward compat

  // WebGL state
  let gl = null;
  let glLayer = null;
  let glProgram = null;
  let glVideoTexture = null;
  let glVideoTextureB = null; // double-buffer back texture (2d re-spec path only)
  let videoTexFront = 0; // 0 = A front / B back, 1 = B front / A back
  let glVideoTextureExt = null; // OES_texture_external target (zero-copy video bind)
  let glControlsTexture = null;
  let glOverlayTexture = null;
  let glGuideTexture = null;
  let glCommentsTexture = null;
  let glReticleTexture = null;
  let glGridBuf = null;
  let glGridIndexBuf = null;
  let glGridIndexCount = 0;
  let glLaserBuf = null;

  // In-Screen VR Comments Overlay Canvas
  let overlayCanvas = null;
  let overlayCtx = null;
  const OVERLAY_W = 1024;
  const OVERLAY_H = 1024;

  // VR video-texture cap. The Adreno 740 cannot sustain a 56 MiB (3840² RGBA)
  // texImage2D per decoded frame — each upload stalls ~45-110ms and drops the
  // XR rate to ~22fps (telemetry-confirmed). The Quest 3S panel is ~1832px/eye,
  // so 3840 is ~2× oversampled anyway. Drawing the video into a 2048² proxy
  // canvas (GPU-side drawImage, cheap) then uploading THAT cuts each upload to
  // 16 MiB → ~13ms → ~72fps, with no visible quality loss on the headset.
  // Masters on disk stay 4K; only the in-VR texture is capped. Tunable.
  const VR_TEX_CAP = 2048;
  // Video-texture binding path override. 'auto' arms the OES external-texture
  // zero-copy path when the GPU exposes it (recommended); '2d' forces today's
  // TEXTURE_2D texImage2D path (used if a device regresses on external bind).
  const VR_TEX_MODE = 'auto';
  // GL context preference. 'auto' prefers WebGL1: on Quest Browser, a WebGL2
// context fails to establish a valid XR compositor client (uid/pid -1, no
// presenting → runtime auto-exits the session ~0.7s after enter; logcat
// confirmed). WebGL2 works as a plain context but its XR layer is unreliable
// here, so it is only used when forced with '2'. '1' forces WebGL1.
  const VR_GL_MODE = 'auto';
  let vrProxyCanvas = null;
  let vrProxyCtx = null;
  let videoTexAllocated = false; // first upload allocates; later ones texSubImage2D (no re-spec → no GPU pipeline flush)
  // Hitboxes for the currently rendered pop-up overlay comments (canvas coords),
  // used to detect a laser trigger on a pop-up so the panel can jump to it.
  let activeOverlayRegions = [];
  let activeOverlayHoverId = null;
  // Comment to highlight in the VR panel (from a pop-up click)
  let cPanelHighlightId = null;
  let cPanelHighlightTimer = null;

  // Cached GL locations
  let loc_aPos = -1;
  let loc_aUV = -1;
  let loc_uMVP = null;
  let loc_uTex = null;
  let loc_uAlpha = null;
  let loc_uCurvatureMode = null;
  let loc_uStereo = null;
  let loc_uEyeOff = null;

  // OES external-texture video path (zero-copy decoder-surface bind).
  // Mirrors the main program locs but samples a samplerExternalOES from a
  // TEXTURE_EXTERNAL_OES target, so per-frame binding avoids re-specifying a
  // sampled 2D texture (the ~100ms GPU pipeline flush that caused ~22fps).
  let glVideoProgram = null;
  let loc2_aPos = -1;
  let loc2_aUV = -1;
  let loc2_uMVP = null;
  let loc2_uTex = null;
  let loc2_uAlpha = null;
  let loc2_uCurvatureMode = null;
  let loc2_uStereo = null;
  let loc2_uEyeOff = null;
  let videoTexMode = '2d'; // '2d' | 'external' — set at initGL via feature detection

  // SBS stereoscopic playback: when true, each XR eye samples its half of the
  // video frame (left half = left eye, right half = right eye).
  let stereoMode = false;

  // Starfield Environment State
  let glStarProgram = null;
  let glStarBuf = null;
  const STAR_COUNT = 1800;
  let loc_star_aPos = -1;
  let loc_star_aData = -1;
  let loc_star_uVP = null;
  let loc_star_uHeadPos = null;
  let loc_star_uTime = null;

  // Ambient Video Glow (Ambilight) State
  let glGlowProgram = null;
  let loc_glow_aPos = -1;
  let loc_glow_aUV = -1;
  let loc_glow_uMVP = null;
  let loc_glow_uCurvatureMode = null;
  let loc_glow_uColor = null;
  let loc_glow_uIntensity = null;

  let ambilightCanvas = null;
  let ambilightCtx = null;
  let curGlowColor = [0.12, 0.28, 0.65];
  let targetGlowColor = [0.12, 0.28, 0.65];
  let lastColorSampleTime = 0;

  // Shared scene mode: normal reels or the location-activity Earth.
  let sceneMode = 'reels';
  let reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Earth mode is lazy: no GPU resources are created and no globe draw calls
  // occur until the user explicitly opens it.
  const EARTH_TEXTURE_URL = '/assets/earth-natural-1024x512.jpg';
  const EARTH_RADIUS = 0.52;
  const EARTH_MARKER_LIMIT = 128;
  const EARTH_IDLE_RADIANS_PER_SECOND = Math.PI / 60; // 3 degrees/second
  let earthCenter = { x: 0, y: 1.12, z: -1.3 };
  let earthYaw = -0.35;
  let earthPitch = -0.12;
  let earthLocations = [];
  let earthHoveredIndex = -1;
  let earthSelectedIndex = -1;
  let earthStatus = 'OPEN EARTH TO LOAD ACTIVITY';
  let earthDragging = false;
  let earthDragSource = null;
  let earthDragLastDir = null;
  let earthDragMoved = false;
  let earthPressMarker = -1;
  let earthLastFrameTime = -1;
  let earthActivityAbort = null;
  let earthActivityGeneration = 0;
  let earthSelectionGeneration = 0;
  let earthResumePlayback = false;

  let glEarthSphereBuf = null;
  let glEarthSphereIndexBuf = null;
  let glEarthSphereIndexCount = 0;
  let glEarthRimBuf = null;
  let glEarthRimIndexBuf = null;
  let glEarthRimIndexCount = 0;
  let glEarthMarkerProgram = null;
  let glEarthMarkerBuf = null;
  let glEarthMarkerCount = 0;
  let glEarthTexture = null;
  let glEarthRimTexture = null;
  let glEarthLabelTexture = null;
  let earthLabelCanvas = null;
  let earthLabelCtx = null;
  let earthLabelSignature = '';
  let loc_earthMarker_aPos = -1;
  let loc_earthMarker_aHeat = -1;
  let loc_earthMarker_aState = -1;
  let loc_earthMarker_uMVP = null;
  let glIsWebGL2 = false;
  let earthResourcesReady = false;
  let earthTextureReady = false;
  let earthDragInputSource = null;
  let earthInteractionUntil = 0;
  const renderStats = { earthDrawCalls: 0, reelDrawCalls: 0, videoUploads: 0 };

  // Desktop preview driver. It owns only camera/input/RAF; scene geometry and
  // draw functions are shared with the XR driver.
  let previewCanvas = null;
  let previewRaf = 0;
  let previewRunning = false;
  let previewCameraMode = 'headset';
  let previewStereo = false;
  let previewYaw = 0;
  let previewPitch = 0;
  let previewOrbitYaw = 0;
  let previewOrbitPitch = -0.08;
  let previewOrbitDistance = 4.8;
  let previewPointer = null;
  let previewLastViews = [];
  let previewListeners = null;

  // Pointer & Ray tracking
  let activeRayOrigin = null;
  let activeRayDir = null;
  let activeHitDist = 3.0;
  let activeIsHovering = false;

  // Screen transform
  const DEFAULT_POS = { x: 0, y: 1.52, z: -2.24 };
  const DEFAULT_SCALE = 4.0;
  const MIN_SCALE = 1.0;
  const MAX_SCALE = 10.0;
  const SCALE_SPEED = 0.04;

  let screenPos = { ...DEFAULT_POS };
  let screenQuat = { x: 0, y: 0, z: 0, w: 1 };
  let screenScale = DEFAULT_SCALE;
  let currentHeadPos = { x: 0, y: 1.52, z: 0 };
  let currentHeadQuat = { x: 0, y: 0, z: 0, w: 1 };
  let isInitialPoseSet = false;

  // Head-locked default: the screen stays perpendicular to the user's view and
  // centered in it, so the user always looks at the middle of the screen.
  // Toggle off via the 🎯 LOCK control to restore free 6DOF placement.
  let lockToViewer = true;

  // 6DOF Grab state (DeoVR / Skybox style)
  let isGrabbing = false;
  let grabControllerIdx = -1;
  let grabRelPos = { x: 0, y: 0, z: 0 };
  let grabRelQuat = { x: 0, y: 0, z: 0, w: 1 };

  // Controls panel state
  let controlsVisible = false;
  let controlsCanvas = null;
  let controlsCtx = null;
  const CONTROLS_W = 800;
  const CONTROLS_H = 260;
  const CONTROLS_Y_OFFSET = 0.08; // Gap below bottom edge

  // Meta Quest Guide Panel State
  let guideCanvas = null;
  let guideCtx = null;
  let questControllerImg = null;
  let isQuestControllerImgLoaded = false;
  const QUEST_CONTROLLER_B64 = window.QUEST_CONTROLLER_B64;
  const GUIDE_W = 440;
  const GUIDE_H = 760;
  let hoveredButton = -1;
  let lastControlsCanvasX = 0;
  let lastControlsCanvasY = 0;
  let controlsAutoHideTimer = null;
  const CONTROLS_AUTO_HIDE_MS = 5000;

  // ── VR Comments Panel (world-space, symmetric to the right-side guide) ──
  let commentsPanelVisible = false;
  let commentsPanelCanvas = null;
  let commentsPanelCtx = null;
  const CPANEL_W = 560;
  const CPANEL_H = 860;
  const CP_HEADER_H = 60;
  const CP_LIST_TOP = 66;
  const CP_LIST_BOTTOM = 748;
  const CP_LIST_X = 16;
  const CP_LIST_W = 498; // 560 - 16 - 46 (right scrollbar column)
  const CP_ITEM_H = 96;
  const CP_ITEM_GAP = 10;
  const CP_SCROLL_X = 516;
  const CP_SCROLL_W = 30;
  let cPanelTab = 'all';
  let cPanelScrollY = 0;
  let cPanelMaxScroll = 0;
  let cPanelHover = null;
  let cPanelDrag = false;
  let cPanelDragStartCanvasY = 0;
  let cPanelDragStartScroll = 0;
  let lastCommentsCanvasX = 0;
  let lastCommentsCanvasY = 0;

  // Quest DOM-Overlay virtual keyboard for posting comments from VR
  let domOverlayRoot = null;
  let domOverlayInput = null;
  let pendingSyncTime = null;

  // Video frame tracking
  let hasNewVideoFrame = true;
  let lastVideoTime = -1;
  let lastVideoFrameCount = -1; // decoded-frame counter (getVideoPlaybackQuality)
  let videoFrameCallbackId = null;
  let videoFrameTrackingGeneration = 0;

  // Adaptive upload stride (resolution + stall aware). Low-res files sustain
  // stride 1 (every decoded frame → full motion); high-res / stalling sessions
  // back off to 2-3 so the texImage2D re-spec flush fires less often.
  // 4K masters can never hold stride 1 (telemetry: ~100ms flush vs 11ms budget).
  let vrUploadStride = 1; // 1 = every decoded frame, 2 = every 2nd, 3 = every 3rd
  let vrSkipCounter = 0;
  let vrStallFrames = 0; // recent XR frames with dt > 25ms
  let vrCalmFrames = 0; // recent XR frames with dt < 18ms
  let vrLastFrameT = -1;
  // UI texture throttles: controls progress looks smooth at 10Hz; the guide is
  // static artwork uploaded once. Per-frame UI re-specs were extra flushes.
  let vrLastUiUploadT = -1;
  let vrLastPanelUploadT = -1;
  let vrGuideUploaded = false;
  const VR_UI_MIN_INTERVAL = 100; // ms between UI texture uploads

  // ── In-headset VR telemetry (POSTed to /api/reels/diag ~1Hz) ──
  // CDP can't see the Quest tab during immersive VR, so the render loop
  // self-reports XR frame timing + texture-upload count + decode drops.
  let _diagLastT = null;
  let _diagLastPost = 0;
  let _diagFrames = 0;
  let _diagDtMin = Infinity, _diagDtMax = 0, _diagDtSum = 0, _diagOver20 = 0, _diagOver14 = 0;
  let _diagLastPqTotal = -1;
  let _diagTexUploads = 0;
  let _diagUploadMaxMs = 0;
  let _diagDrawMaxMs = 0;
  let _diagGLInfo = null;
  let _diagForce = false; // emit a snapshot immediately (bypasses 1s throttle)

  // Thumbstick flick debounces
  let flickedX = false;
  let flickedY = false;
  const FLICK_THRESHOLD = 0.5;
  const FLICK_RESET = 0.3;

  // External button state tracking
  const prevBtnState = { rightA: false, rightB: false, leftA: false, leftB: false };

  // ── VR site-chrome helpers — notify the host page so the global header can hide ──
  function notifyVrEnter() {
    try {
      window.dispatchEvent(new CustomEvent('echo:vr-enter', { detail: { inVR: true } }));
      window.dispatchEvent(new CustomEvent('echo:vrchange', { detail: { inVR: true } }));
      try { if (window.top && window.top !== window) window.top.dispatchEvent(new CustomEvent('echo:vr-enter', { detail: { inVR: true } })); } catch (e2) {}
      document.documentElement.classList.add('sx-vr-active');
      if (document.body) document.body.classList.add('sx-vr-active');
    } catch (e) {}
  }
  function notifyVrExit() {
    try {
      window.dispatchEvent(new CustomEvent('echo:vr-exit', { detail: { inVR: false } }));
      window.dispatchEvent(new CustomEvent('echo:vrchange', { detail: { inVR: false } }));
      try { if (window.top && window.top !== window) window.top.dispatchEvent(new CustomEvent('echo:vr-exit', { detail: { inVR: false } })); } catch (e2) {}
      document.documentElement.classList.remove('sx-vr-active');
      if (document.body) document.body.classList.remove('sx-vr-active');
    } catch (e) {}
  }

  // Button definitions for the UI controls panel (WebXR HUD Media Control Dock)
  const CTRL_BUTTONS = [
    // Left secondary column (Pills)
    { label: 'AUTO',  action: 'mode',  x: 24,  y: 66,  w: 156, h: 44 },
    { label: 'DOME',  action: 'curve', x: 24,  y: 120, w: 156, h: 44 },

    // Center primary transport controls
    { label: '◀◀',   action: 'rew',   x: 228, y: 92,  w: 48,  h: 48 },
    { label: '⏮',    action: 'prev',  x: 290, y: 88,  w: 56,  h: 56 },
    { label: '▶',     action: 'play',  x: 360, y: 76,  w: 80,  h: 80 },
    { label: '⏭',    action: 'next',  x: 454, y: 88,  w: 56,  h: 56 },
    { label: '▶▶',   action: 'fwd',   x: 524, y: 92,  w: 48,  h: 48 },

    // Right secondary column (Pills)
    { label: 'LOCK',  action: 'lock',  x: 620, y: 66,  w: 156, h: 44 },
    { label: 'AUDIO', action: 'mute',  x: 620, y: 120, w: 156, h: 44 },

    // Header comment pill → toggles the VR comments panel
    { label: '💬',    action: 'comments', x: 476, y: 13, w: 64, h: 22 },

    // Open Earth activity mode, or restore All Locations after a location feed.
    { label: 'EARTH', action: 'earth', x: 628, y: 13, w: 108, h: 22 },

    // Header exit button
    { label: '✕',     action: 'exit',  x: 746, y: 13,  w: 30,  h: 22 },

    // Bottom progress scrub track
    { label: 'TRACK', action: 'seek',  x: 24,  y: 202, w: 752, h: 32 },
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

  function quatFaceViewerLevel(screenPos, headPos) {
    const head = headPos || currentHeadPos || { x: 0, y: 1.52, z: 0 };
    const dx = head.x - screenPos.x;
    const dy = head.y - screenPos.y;
    const dz = head.z - screenPos.z;

    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.001) return { x: 0, y: 0, z: 0, w: 1 };

    // Normalized dir pointing to viewer (local +Z)
    const zx = dx / len;
    const zy = dy / len;
    const zz = dz / len;

    // Horizontal len in X-Z plane
    const lenXZ = Math.sqrt(zx * zx + zz * zz);
    if (lenXZ < 0.001) return { x: 0, y: 0, z: 0, w: 1 };

    // Local +X axis = (0, 1, 0) x (zx, zy, zz) = (zz, 0, -zx) / lenXZ (Zero Y component = 100% Level)
    const xx = zz / lenXZ;
    const xy = 0;
    const xz = -zx / lenXZ;

    // Local +Y axis = Z_axis x X_axis
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    const m00 = xx,  m01 = yx,  m02 = zx;
    const m10 = xy,  m11 = yy,  m12 = zy;
    const m20 = xz,  m21 = yz,  m22 = zz;

    const trace = m00 + m11 + m22;
    let qx, qy, qz, qw;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      qw = 0.25 / s;
      qx = (m21 - m12) * s;
      qy = (m02 - m20) * s;
      qz = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
      qw = (m21 - m12) / s;
      qx = 0.25 * s;
      qy = (m01 + m10) / s;
      qz = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
      qw = (m02 - m20) / s;
      qx = (m01 + m10) / s;
      qy = 0.25 * s;
      qz = (m12 + m21) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
      qw = (m10 - m01) / s;
      qx = (m02 + m20) / s;
      qy = (m12 + m21) / s;
      qz = 0.25 * s;
    }

    return { x: qx, y: qy, z: qz, w: qw };
  }

  // ─── Head-Locked Screen Mode ──────────────────────────────────────────
  // Keeps the screen at a fixed distance in front of the user's face,
  // perpendicular to the view direction, so the user always looks into the
  // center of the screen. Screen local axes follow the head exactly:
  // +Z faces back toward the viewer, +Y up, +X right.
  function applyLockToViewer() {
    const dist = -DEFAULT_POS.z;
    const fwd = quatRotVec(currentHeadQuat, { x: 0, y: 0, z: -1 });
    screenPos = {
      x: currentHeadPos.x + fwd.x * dist,
      y: currentHeadPos.y + fwd.y * dist,
      z: currentHeadPos.z + fwd.z * dist,
    };
    screenQuat = currentHeadQuat;
  }

  // ─── Premium UI Controls Canvas Rendering ────────────────────────────

  function initControlsCanvas() {
    controlsCanvas = document.createElement('canvas');
    controlsCanvas.width = CONTROLS_W;
    controlsCanvas.height = CONTROLS_H;
    controlsCtx = controlsCanvas.getContext('2d');
  }

  function initOverlayCanvas() {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = OVERLAY_W;
    overlayCanvas.height = OVERLAY_H;
    overlayCtx = overlayCanvas.getContext('2d');
  }

  function renderOverlayCanvas() {
    const ctx = overlayCtx;
    if (!ctx || !videoElement) return false;

    const currentTime = videoElement.currentTime || 0;
    const comments = callbacks.getComments ? callbacks.getComments() : [];

    // Filter active time-synced comments within active window [timestamp, timestamp + 4.2s]
    const active = comments.filter((c) => {
      if (c.timestamp === null || c.timestamp === undefined) return false;
      const t = Number(c.timestamp);
      return currentTime >= t && currentTime <= (t + 4.2);
    });

    ctx.clearRect(0, 0, OVERLAY_W, OVERLAY_H);
    activeOverlayRegions = [];
    if (active.length === 0) {
      activeOverlayHoverId = null;
      return false;
    }
    if (activeOverlayHoverId && !active.some((c) => c.id === activeOverlayHoverId)) {
      activeOverlayHoverId = null;
    }

    // Up to 3 stacked comments on the middle-left area of the 1:1 square canvas
    const maxShow = Math.min(3, active.length);
    const itemHeight = 60;
    const gap = 11;
    const totalH = maxShow * itemHeight + (maxShow - 1) * gap;
    const startY = (OVERLAY_H / 2) - (totalH / 2);

    for (let i = 0; i < maxShow; i++) {
      const c = active[i];
      const y = startY + i * (itemHeight + gap);
      const x = 0.10 * OVERLAY_W; // 10% gap from the left side of the reels
      const isHovered = (c.id === activeOverlayHoverId);

      // Progress fade-in / fade-out alpha
      const elapsed = currentTime - Number(c.timestamp);
      let alpha = 1.0;
      if (elapsed < 0.35) {
        alpha = Math.max(0, elapsed / 0.35);
      } else if (elapsed > 3.6) {
        alpha = Math.max(0, (4.2 - elapsed) / 0.6);
      }

      ctx.save();
      ctx.globalAlpha = alpha;

      // Shadow for high-contrast legibility over video — no background box,
      // but with the 2D twitch-comment-pill typography AND its left accent line.
      ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;

      const authorColor = c.avatar_color || '#FF3B1F';
      const authorName = c.author_name || 'Anonymous';
      const hasTime = c.timestamp !== null && c.timestamp !== undefined;
      const timeStr = hasTime ? '⏱️ ' + formatTime(c.timestamp) : '';

      // Vertical accent line (mirrors the 3px border-left of .twitch-comment-pill)
      const barW = 3;
      const contentX = x + barW + 10; // gap like pill border-left + padding

      // Prepare display text early so the hover pill can be sized and drawn
      // FIRST (behind) so it never covers the accent bar, avatar or name.
      ctx.font = '500 14px "Archivo", sans-serif';
      let dispText = c.text;
      if (dispText.length > 46) {
        dispText = dispText.slice(0, 44) + '…';
      }
      const textW = ctx.measureText(dispText).width;
      const regionW = Math.max(260, textW + 90);
      const regionX = x - 12;
      const regionY = y - 6;
      const regionH = itemHeight + 12;

      // Hover / click affordance background — drawn behind all pill content
      if (isHovered) {
        ctx.fillStyle = 'rgba(18, 19, 21, 0.78)';
        ctx.strokeStyle = '#FF3B1F';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(regionX, regionY, regionW, regionH, 4);
        ctx.fill();
        ctx.stroke();
      }

      ctx.fillStyle = authorColor;
      ctx.fillRect(x, y + 8, barW, itemHeight - 16);

      const avatarX = contentX + 25;
      const nameX = contentX + 50;
      const textX = contentX + 50;
      const nameY = y + 11;
      const timeY = y + 14;
      const textY = y + 32;

      // Avatar Icon / Emoji (Middle-Left, like .twitch-avatar)
      ctx.font = '22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.author_avatar || '👤', avatarX, y + itemHeight / 2);

      // Author Name — bold colored like .twitch-author
      ctx.font = '800 13px "Archivo", sans-serif';
      ctx.fillStyle = authorColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(authorName, nameX, nameY);
      const nameW = ctx.measureText(authorName).width;

      // Timestamp tag — muted monospace like .twitch-tag
      if (hasTime) {
        ctx.font = '700 11px "JetBrains Mono", monospace';
        ctx.fillStyle = '#A4ABB3';
        ctx.fillText(timeStr, nameX + nameW + 8, timeY);
      }

      // Comment Text — light Archivo like .twitch-text
      ctx.font = '500 14px "Archivo", sans-serif';
      ctx.fillStyle = '#F2F3F5';
      ctx.textBaseline = 'top';
      ctx.fillText(dispText, textX, textY);

      // Record the clickable hitbox for this pop-up comment
      activeOverlayRegions.push({ id: c.id, x: regionX, y: regionY, w: regionW, h: regionH });

      ctx.restore();
    }

    return true;
  }

  // Map a screen-local hit point to an overlay pop-up comment id, if any.
  function overlayCommentAtHit(hitLocal) {
    if (activeOverlayRegions.length === 0 || !hitLocal) return null;
    const u = (hitLocal.x / screenScale) + 0.5;
    const v = 0.5 - (hitLocal.y / screenScale);
    const cx = u * OVERLAY_W;
    const cy = v * OVERLAY_H;
    for (const r of activeOverlayRegions) {
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return r.id;
    }
    return null;
  }

  function renderControlsCanvas() {
    const ctx = controlsCtx;
    if (!ctx) return;

    const isPaused = videoElement ? videoElement.paused : true;
    const isMuted = videoElement ? videoElement.muted : true;
    const currentTime = videoElement ? videoElement.currentTime : 0;
    const duration = videoElement ? videoElement.duration : 0;
    const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;

    const isAutoNext = callbacks.getAutoNext ? callbacks.getAutoNext() : true;
    const playlist = callbacks.getPlaylist ? callbacks.getPlaylist() : [];
    const idx = callbacks.getCurrentIndex ? callbacks.getCurrentIndex() : 0;
    const item = playlist[idx];
    const comments = callbacks.getComments ? callbacks.getComments() : [];

    ctx.clearRect(0, 0, CONTROLS_W, CONTROLS_H);

    // 1. Dark Glass Container Background
    ctx.fillStyle = 'rgba(12, 14, 17, 0.96)';
    ctx.beginPath();
    ctx.roundRect(0, 0, CONTROLS_W, CONTROLS_H, 4);
    ctx.fill();

    // 2. Vermilion Glow Outer Border
    ctx.strokeStyle = '#FF3B1F';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255, 59, 31, 0.25)';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.roundRect(0, 0, CONTROLS_W, CONTROLS_H, 4);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 3. Top Telemetry Header
    // Accent Block (Left)
    ctx.fillStyle = '#FF3B1F';
    ctx.fillRect(24, 14, 4, 20);

    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('4K VR REELS', 36, 24);

    // Filename
    let dispName = item ? item.filename : 'SYS_RENDER_004.mp4';
    if (dispName.length > 26) dispName = dispName.slice(0, 24) + '…';
    ctx.fillStyle = '#E3E2E3';
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.fillText(dispName, 144, 24);

    // Pill Badges & Status (Right)
    // Comment pill — also the VR comments panel toggle
    const commentBtnIdx = CTRL_BUTTONS.findIndex((b) => b.action === 'comments');
    const isCommentHover = (hoveredButton === commentBtnIdx);
    ctx.fillStyle = isCommentHover ? '#1D2126' : '#101214';
    ctx.strokeStyle = isCommentHover ? '#FF3B1F' : '#3A4047';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(476, 13, 64, 22, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isCommentHover ? '#FFFFFF' : '#E7BDB5';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`💬 ${comments.length || 0}`, 508, 24);

    // Index pill
    ctx.fillStyle = '#101214';
    ctx.strokeStyle = '#3A4047';
    ctx.beginPath();
    ctx.roundRect(548, 13, 72, 22, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#E7BDB5';
    ctx.fillText(`${playlist.length ? idx + 1 : 0} / ${playlist.length}`, 584, 24);

    // Earth / All Locations mode control.
    const earthBtnIdx = CTRL_BUTTONS.findIndex((button) => button.action === 'earth');
    const earthButton = CTRL_BUTTONS[earthBtnIdx];
    const isEarthHover = hoveredButton === earthBtnIdx;
    const hasLocationFeed = callbacks.isLocationFeedActive && callbacks.isLocationFeedActive();
    ctx.fillStyle = (sceneMode === 'earth' || isEarthHover) ? '#1D2126' : '#101214';
    ctx.strokeStyle = (sceneMode === 'earth' || isEarthHover) ? '#FFB11F' : '#3A4047';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(earthButton.x, earthButton.y, earthButton.w, earthButton.h, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = (sceneMode === 'earth' || isEarthHover) ? '#FFFFFF' : '#E7BDB5';
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(hasLocationFeed && sceneMode !== 'earth' ? 'ALL LOCATIONS' : (sceneMode === 'earth' ? 'REELS' : 'EARTH'), earthButton.x + earthButton.w / 2, 24);

    // Exit Button
    const exitBtnIdx = CTRL_BUTTONS.findIndex((button) => button.action === 'exit');
    const isExitHover = (hoveredButton === exitBtnIdx);
    ctx.fillStyle = isExitHover ? '#1D2126' : '#101214';
    ctx.strokeStyle = isExitHover ? '#FF3B1F' : '#3A4047';
    ctx.beginPath();
    ctx.roundRect(746, 13, 30, 22, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isExitHover ? '#FF3B1F' : '#E7BDB5';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✕', 761, 24);

    // Divider Line below Header
    ctx.strokeStyle = '#24282D';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(24, 48);
    ctx.lineTo(776, 48);
    ctx.stroke();

    if (sceneMode === 'earth') {
      ctx.fillStyle = '#F7FAFC';
      ctx.font = '700 18px "Archivo", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('DRAG THE GLOBE · SELECT A HEAT MARKER', CONTROLS_W / 2, 112);
      ctx.fillStyle = '#AEB9C8';
      ctx.font = '700 12px "JetBrains Mono", monospace';
      ctx.fillText('THUMBSTICK / WHEEL ALSO ROTATES · EARTH RETURNS TO REELS', CONTROLS_W / 2, 148);
      return;
    }

    // 4. Main Controls Cluster
    CTRL_BUTTONS.forEach((btn, i) => {
      if (btn.action === 'exit' || btn.action === 'seek' || btn.action === 'comments' || btn.action === 'earth') return;

      const isHover = (hoveredButton === i);

      // Left Column Pill Buttons (AUTO / DOME)
      if (btn.action === 'mode' || btn.action === 'curve') {
        ctx.fillStyle = isHover ? '#1D2126' : '#101214';
        ctx.strokeStyle = isHover ? '#FF3B1F' : '#3A4047';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 4);
        ctx.fill();
        ctx.stroke();

        ctx.font = 'bold 11px "JetBrains Mono", monospace';
        ctx.fillStyle = isHover ? '#FFFFFF' : '#E7BDB5';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const label = btn.action === 'mode'
          ? (isAutoNext ? 'AUTO' : 'LOOP')
          : (curvatureMode === 1 ? 'DOME' : (curvatureMode === 2 ? 'SQ CURVE' : 'FLAT'));
        ctx.fillText(label, btn.x + 14, btn.y + btn.h / 2);

        ctx.font = '15px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = isHover ? '#FF3B1F' : '#C5C6C8';
        const icon = btn.action === 'mode' ? '⟳' : '🌐';
        ctx.fillText(icon, btn.x + btn.w - 14, btn.y + btn.h / 2);
      }

      // Right Column Pill Buttons (LOCK / AUDIO)
      else if (btn.action === 'lock' || btn.action === 'mute') {
        const isLockActive = (btn.action === 'lock' && lockToViewer);
        ctx.fillStyle = (isLockActive || isHover) ? '#1D2126' : '#101214';
        ctx.strokeStyle = (isLockActive || isHover) ? '#FF3B1F' : '#3A4047';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 4);
        ctx.fill();
        ctx.stroke();

        ctx.font = 'bold 11px "JetBrains Mono", monospace';
        ctx.fillStyle = (isLockActive || isHover) ? '#FFFFFF' : '#E7BDB5';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const label = btn.action === 'lock'
          ? (lockToViewer ? 'LOCK' : 'FREE')
          : (isMuted ? 'MUTED' : 'AUDIO');
        ctx.fillText(label, btn.x + 14, btn.y + btn.h / 2);

        ctx.font = '15px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = (isLockActive || isHover) ? '#FF3B1F' : '#C5C6C8';
        const icon = btn.action === 'lock'
          ? (lockToViewer ? '🔒' : '🔓')
          : (isMuted ? '🔇' : '🔊');
        ctx.fillText(icon, btn.x + btn.w - 14, btn.y + btn.h / 2);
      }

      // Center Secondary Buttons (rew, prev, next, fwd)
      else if (btn.action !== 'play') {
        ctx.fillStyle = isHover ? '#1D2126' : '#101214';
        ctx.strokeStyle = isHover ? '#FF3B1F' : '#3A4047';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isHover ? '#FFFFFF' : '#E3E2E3';
        ctx.font = (btn.action === 'prev' || btn.action === 'next') ? 'bold 18px sans-serif' : 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let lbl = btn.label;
        if (btn.action === 'rew') lbl = '◀◀';
        if (btn.action === 'fwd') lbl = '▶▶';
        if (btn.action === 'prev') lbl = '⏮';
        if (btn.action === 'next') lbl = '⏭';
        ctx.fillText(lbl, btn.x + btn.w / 2, btn.y + btn.h / 2);
      }

      // Center Primary Play/Pause Glow Button
      else if (btn.action === 'play') {
        ctx.fillStyle = '#FF3B1F';
        ctx.shadowColor = 'rgba(255, 59, 31, 0.55)';
        ctx.shadowBlur = isHover ? 28 : 20;
        ctx.beginPath();
        ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 4);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#0A0A0A';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(isPaused ? '▶' : '⏸', btn.x + btn.w / 2, btn.y + btn.h / 2);
      }
    });

    // 5. Bottom Progress Track
    // Divider Line above Progress
    ctx.strokeStyle = '#24282D';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(24, 184);
    ctx.lineTo(776, 184);
    ctx.stroke();

    // Time Indicators
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FF3B1F';
    ctx.fillText(formatTime(currentTime), 24, 198);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#9BA1A8';
    ctx.fillText(formatTime(duration), 776, 198);

    // Track Bar
    const trackX = 24, trackY = 214, trackW = 752, trackH = 6;
    ctx.fillStyle = '#101214';
    ctx.strokeStyle = '#3A4047';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(trackX, trackY, trackW, trackH, 2);
    ctx.fill();
    ctx.stroke();

    // Progress Fill
    const fillW = Math.max(0, Math.min(trackW, trackW * progress));
    if (fillW > 0) {
      ctx.fillStyle = '#FF3B1F';
      ctx.shadowColor = 'rgba(255, 59, 31, 0.6)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.roundRect(trackX, trackY, fillW, trackH, 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Scrubber Thumb / Playhead
      const thumbX = Math.max(trackX, Math.min(trackX + trackW - 8, trackX + fillW - 4));
      ctx.fillStyle = '#FF3B1F';
      ctx.shadowColor = 'rgba(255, 59, 31, 0.7)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.roundRect(thumbX, trackY - 5, 8, 16, 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // ─── Meta Quest 3 Controller Guide Panel Canvas Rendering ───────────

  function initGuideCanvas() {
    guideCanvas = document.createElement('canvas');
    guideCanvas.width = GUIDE_W;
    guideCanvas.height = GUIDE_H;
    guideCtx = guideCanvas.getContext('2d');
    if (!questControllerImg) {
      questControllerImg = new Image();
      questControllerImg.onload = () => {
        isQuestControllerImgLoaded = true;
        renderGuideCanvas();
        vrGuideUploaded = false; // finished artwork: re-upload once next frame
      };
      questControllerImg.src = QUEST_CONTROLLER_B64;
    }
    renderGuideCanvas();
  }

  // Helper: Draw a Meta Quest 3 Touch Plus right controller silhouette
  function drawQuestController(ctx, cx, cy, scale) {
    const s = scale || 1.0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);

    // ── Controller Handle (ergonomic curved grip) ──
    ctx.fillStyle = '#1A1B1F';
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-16, 20);
    ctx.bezierCurveTo(-18, 55, -20, 100, -16, 140);
    ctx.bezierCurveTo(-14, 155, 14, 155, 16, 140);
    ctx.bezierCurveTo(20, 100, 18, 55, 16, 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Handle texture lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 6; i++) {
      const ly = 50 + i * 16;
      ctx.beginPath();
      ctx.moveTo(-12, ly);
      ctx.lineTo(12, ly);
      ctx.stroke();
    }

    // ── Tracking Ring (circular halo around top) ──
    ctx.strokeStyle = '#2A2C32';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(0, -18, 52, 42, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Ring inner highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, -18, 50, 40, 0, Math.PI * 0.9, Math.PI * 1.9);
    ctx.stroke();

    // ── Top Face Plate ──
    ctx.fillStyle = '#222428';
    ctx.beginPath();
    ctx.ellipse(0, -5, 38, 28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#333640';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // ── Thumbstick (left position on face) ──
    // Thumbstick base
    ctx.fillStyle = '#0D0E11';
    ctx.beginPath();
    ctx.arc(-14, -12, 14, 0, Math.PI * 2);
    ctx.fill();
    // Thumbstick cap
    ctx.fillStyle = '#18191D';
    ctx.beginPath();
    ctx.arc(-14, -12, 10, 0, Math.PI * 2);
    ctx.fill();
    // Concentric grip ring on cap
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(-14, -12, 7, 0, Math.PI * 2);
    ctx.stroke();
    // Directional dot at center
    ctx.fillStyle = '#FF3B1F';
    ctx.beginPath();
    ctx.arc(-14, -12, 2, 0, Math.PI * 2);
    ctx.fill();

    // ── A Button (lower right) ──
    ctx.fillStyle = '#FF3B1F';
    ctx.shadowColor = 'rgba(255, 59, 31, 0.5)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(14, -2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A', 14, -2);

    // ── B Button (upper right) ──
    ctx.fillStyle = '#FF3B1F';
    ctx.shadowColor = 'rgba(255, 59, 31, 0.35)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(20, -22, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('B', 20, -22);

    // ── Index Trigger (front curved) ──
    ctx.fillStyle = '#2A2C32';
    ctx.strokeStyle = '#FF3B1F';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-12, 18);
    ctx.bezierCurveTo(-14, 28, -10, 36, -2, 38);
    ctx.bezierCurveTo(4, 36, 8, 28, 6, 18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // ── Side Grip Button ──
    ctx.fillStyle = '#2A2C32';
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(-24, 55, 8, 30, 3);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  function renderGuideCanvas() {
    const ctx = guideCtx;
    if (!ctx) return;

    ctx.clearRect(0, 0, GUIDE_W, GUIDE_H);

    // Dark Glass Container Background
    ctx.fillStyle = 'rgba(8, 9, 10, 0.94)';
    ctx.beginPath();
    ctx.roundRect(0, 0, GUIDE_W, GUIDE_H, 18);
    ctx.fill();

    // Signature Red Glow Border
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(0, 0, GUIDE_W, GUIDE_H, 18);
    ctx.stroke();

    // Header Badge
    ctx.fillStyle = '#FF3B1F';
    ctx.beginPath();
    ctx.roundRect(16, 14, 140, 24, 4);
    ctx.fill();

    ctx.fillStyle = '#0A0A0A';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CONTROLLER GUIDE', 86, 26);

    ctx.fillStyle = 'rgba(255, 59, 31, 0.85)';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('META QUEST 3', GUIDE_W - 16, 26);

    // ── TOP SECTION: Centered Controller Graphic ──
    if (isQuestControllerImgLoaded && questControllerImg) {
      const imgW = 210;
      const imgH = imgW * (questControllerImg.height / questControllerImg.width);
      const imgX = (GUIDE_W - imgW) / 2;
      ctx.drawImage(questControllerImg, imgX, 46, imgW, imgH);
    } else {
      drawQuestController(ctx, GUIDE_W / 2, 210, 1.8);
    }

    // Divider Line
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(20, 405);
    ctx.lineTo(GUIDE_W - 20, 405);
    ctx.stroke();

    // ── BOTTOM SECTION: 2-Column Cards Grid ──
    const accentColor = '#FF3B1F';
    const dimText = 'rgba(242, 243, 245, 0.85)';
        const cards = [
      { title: 'THUMBSTICK', desc: 'Up/Down → Next/Prev Reel|Left/Right → Seek ±5s' },
      { title: 'A BUTTON', desc: 'Toggle Play / Pause|In-VR Video Control' },
      { title: 'B BUTTON', desc: 'Toggle Guide & Controls|Show/Hide Overlay' },
      { title: 'INDEX TRIGGER', desc: 'Laser Aim & Click|Tap Video → Play/Pause' },
      { title: 'SIDE GRIP (Hold)', desc: '6DOF Drag & Reposition|Only when UNLOCKED (🎯)' },
      { title: 'GRIP + STICK ↕', desc: 'Zoom Screen In / Out|Smooth Scale Control' }
    ];const colW = 198;
    const cardH = 88;
    const gapX = 12;
    const gapY = 10;
    const startX = 16;
    const startY = 418;

    cards.forEach((card, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = startX + col * (colW + gapX);
      const cy = startY + row * (cardH + gapY);

      // Card background
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.beginPath();
      ctx.roundRect(cx, cy, colW, cardH, 8);
      ctx.fill();

      // Left accent bar
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.roundRect(cx, cy, 3, cardH, 2);
      ctx.fill();

      // Card border
      ctx.strokeStyle = 'rgba(255, 59, 31, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(cx, cy, colW, cardH, 8);
      ctx.stroke();

      // Title
      ctx.fillStyle = accentColor;
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(card.title, cx + 10, cy + 10);

      // Desc lines
      ctx.fillStyle = dimText;
      ctx.font = '10px sans-serif';
      const lines = card.desc.split('|');
      lines.forEach((line, li) => {
        ctx.fillText(line, cx + 10, cy + 30 + li * 16);
      });
    });

    // Footer hint
    ctx.fillStyle = 'rgba(155, 161, 168, 0.6)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Press B or ✕ to dismiss', GUIDE_W / 2, GUIDE_H - 14);
  }

  // ─── VR Comments Panel (world-space) ────────────────────────────────

  function initCommentsPanelCanvas() {
    commentsPanelCanvas = document.createElement('canvas');
    commentsPanelCanvas.width = CPANEL_W;
    commentsPanelCanvas.height = CPANEL_H;
    commentsPanelCtx = commentsPanelCanvas.getContext('2d');
  }

  function getInitials(name) {
    if (!name) return '??';
    const parts = name.split(/[_\s]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function wrapTextLines(ctx, text, maxWidth, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (cur && ctx.measureText(test).width > maxWidth) {
        lines.push(cur);
        cur = w;
        if (lines.length >= maxLines) break;
      } else {
        cur = test;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines;
  }

  function getPanelFilteredComments() {
    const comments = callbacks.getComments ? callbacks.getComments() : [];
    if (cPanelTab === 'sync') return comments.filter((c) => c.timestamp !== null && c.timestamp !== undefined);
    if (cPanelTab === 'general') return comments.filter((c) => c.timestamp === null || c.timestamp === undefined);
    return comments;
  }

  function clampPanelScroll(v) {
    return Math.max(0, Math.min(cPanelMaxScroll, v));
  }

  // ── Panel geometry (mirrors getGuideCenter on the LEFT side) ──
  function getCommentsPanelSize() {
    const base = lockToViewer ? DEFAULT_SCALE : screenScale;
    const w = base * 0.432; // 0.36 * 1.2 → 20% larger world-space panel
    const h = w * (CPANEL_H / CPANEL_W);
    return { w, h };
  }

  function getCommentsPanelCenter() {
    const { w } = getCommentsPanelSize();
    if (lockToViewer) {
      return {
        x: DEFAULT_POS.x - DEFAULT_SCALE / 2 - w / 2 - 0.384,
        y: DEFAULT_POS.y,
        z: DEFAULT_POS.z - 0.15,
      };
    }
    const offsetLocal = { x: -screenScale / 2 - w / 2 - 0.384, y: 0, z: -0.15 };
    const offsetWorld = quatRotVec(screenQuat, offsetLocal);
    return vecAdd(screenPos, offsetWorld);
  }

  function getCommentsPanelQuat() {
    return quatFaceViewerLevel(getCommentsPanelCenter(), currentHeadPos);
  }

  function getHitDistCommentsPanel(rayOrigin, rayDir) {
    const center = getCommentsPanelCenter();
    const normal = quatRotVec(getCommentsPanelQuat(), { x: 0, y: 0, z: 1 });
    const denom = rayDir.x * normal.x + rayDir.y * normal.y + rayDir.z * normal.z;
    if (Math.abs(denom) < 0.0001) return -1;
    const t = ((center.x - rayOrigin.x) * normal.x +
               (center.y - rayOrigin.y) * normal.y +
               (center.z - rayOrigin.z) * normal.z) / denom;
    return t > 0 ? t : -1;
  }

  // ── Panel hit testing → canvas region descriptor ──
  function resolveCommentsPanelRegion(canvasX, canvasY) {
    const listH = CP_LIST_BOTTOM - CP_LIST_TOP;
    const filtered = getPanelFilteredComments();
    const contentH = filtered.length * (CP_ITEM_H + CP_ITEM_GAP);

    // Header
    if (canvasY < CP_HEADER_H) {
      if (canvasX >= 296 && canvasX < 344 && canvasY >= 16 && canvasY < 46) return 'tab:all';
      if (canvasX >= 352 && canvasX < 416 && canvasY >= 16 && canvasY < 46) return 'tab:sync';
      if (canvasX >= 424 && canvasX < 502 && canvasY >= 16 && canvasY < 46) return 'tab:general';
      if (canvasX >= 522 && canvasX < 548 && canvasY >= 16 && canvasY < 46) return 'close';
      return 'panel';
    }

    // Footer
    if (canvasY > CP_LIST_BOTTOM) {
      if (canvasY >= CP_LIST_BOTTOM + 10 && canvasY < CP_LIST_BOTTOM + 44 && canvasX >= 16 && canvasX < 216) return 'account';
      if (canvasY >= CP_LIST_BOTTOM + 54 && canvasY < CP_LIST_BOTTOM + 98 && canvasX >= 16 && canvasX < CPANEL_W - 16) return 'add';
      return 'panel';
    }

    // Scrollbar column
    if (canvasX >= CP_SCROLL_X) {
      if (canvasY >= CP_LIST_TOP && canvasY < CP_LIST_TOP + 26) return 'scrollup';
      if (canvasY >= CP_LIST_BOTTOM - 26 && canvasY < CP_LIST_BOTTOM) return 'scrolldown';
      const trackTop = CP_LIST_TOP + 30;
      const trackBot = CP_LIST_BOTTOM - 30;
      if (cPanelMaxScroll > 0) {
        const handleH = Math.max(40, (trackBot - trackTop) * (listH / contentH));
        const frac = cPanelScrollY / cPanelMaxScroll;
        const handleY = trackTop + frac * ((trackBot - trackTop) - handleH);
        if (canvasY >= handleY && canvasY < handleY + handleH) return 'scrollbar';
      }
      return 'list';
    }

    // List content items
    const relY = canvasY - CP_LIST_TOP + cPanelScrollY;
    const idx = Math.floor(relY / (CP_ITEM_H + CP_ITEM_GAP));
    if (idx >= 0 && idx < filtered.length) {
      const c = filtered[idx];
      const y = CP_LIST_TOP + idx * (CP_ITEM_H + CP_ITEM_GAP) - cPanelScrollY;
      const itemX = CP_LIST_X + 10;
      const itemW = CP_LIST_W - 20;
      if (canvasY >= y + 8 && canvasY < y + 36) {
        const hasTime = c.timestamp !== null && c.timestamp !== undefined;
        if (canvasX >= itemX + 8 && canvasX < itemX + 174) return 'profile:' + (c.author_name || '');
        if (hasTime && canvasX >= itemX + 180 && canvasX < itemX + 280) return 'seek:' + c.id;
        if (canvasX >= itemX + itemW - 46 && canvasX < itemX + itemW - 6) return 'like:' + c.id;
      }
    }
    return 'list';
  }

  function hitTestCommentsPanel(rayOrigin, rayDir) {
    const center = getCommentsPanelCenter();
    const quat = getCommentsPanelQuat();
    const { w, h } = getCommentsPanelSize();
    const normal = quatRotVec(quat, { x: 0, y: 0, z: 1 });
    const denom = rayDir.x * normal.x + rayDir.y * normal.y + rayDir.z * normal.z;
    if (Math.abs(denom) < 0.0001) return null;

    const t = ((center.x - rayOrigin.x) * normal.x +
               (center.y - rayOrigin.y) * normal.y +
               (center.z - rayOrigin.z) * normal.z) / denom;
    if (t < 0 || t > 20) return null;

    const hitP = vecAdd(rayOrigin, vecScale(rayDir, t));
    const invQ = quatInvert(quat);
    const localP = quatRotVec(invQ, vecSub(hitP, center));
    const halfW = w / 2, halfH = h / 2;
    if (Math.abs(localP.x) > halfW || Math.abs(localP.y) > halfH) return null;

    lastCommentsCanvasX = ((localP.x + halfW) / w) * CPANEL_W;
    lastCommentsCanvasY = ((halfH - localP.y) / h) * CPANEL_H;
    return resolveCommentsPanelRegion(lastCommentsCanvasX, lastCommentsCanvasY);
  }

  // ── Panel rendering ──
  function renderCommentsPanelCanvas() {
    const ctx = commentsPanelCtx;
    if (!ctx) return;

    const comments = callbacks.getComments ? callbacks.getComments() : [];
    let filtered = comments;
    if (cPanelTab === 'sync') filtered = comments.filter((c) => c.timestamp !== null && c.timestamp !== undefined);
    else if (cPanelTab === 'general') filtered = comments.filter((c) => c.timestamp === null || c.timestamp === undefined);

    const listH = CP_LIST_BOTTOM - CP_LIST_TOP;
    const contentH = filtered.length * (CP_ITEM_H + CP_ITEM_GAP);
    cPanelMaxScroll = Math.max(0, contentH - listH);
    if (cPanelScrollY > cPanelMaxScroll) cPanelScrollY = cPanelMaxScroll;

    const user = callbacks.getCurrentUser ? callbacks.getCurrentUser() : null;
    const accent = '#FF3B1F';

    ctx.clearRect(0, 0, CPANEL_W, CPANEL_H);

    // Container
    ctx.fillStyle = 'rgba(13, 14, 15, 0.97)';
    ctx.beginPath();
    ctx.roundRect(0, 0, CPANEL_W, CPANEL_H, 6);
    ctx.fill();
    ctx.strokeStyle = '#343536';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0, 0, CPANEL_W, CPANEL_H, 6);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, CPANEL_W, 3);

    // Header
    ctx.fillStyle = '#0d0e0f';
    ctx.fillRect(0, 3, CPANEL_W, CP_HEADER_H - 3);
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = accent;
    ctx.fillText('💬', 18, 33);
    ctx.font = '700 11px "JetBrains Mono", monospace';
    ctx.fillText('COMMENTS', 40, 33);
    ctx.fillStyle = 'rgba(255,85,58,0.7)';
    const titleW = ctx.measureText('COMMENTS').width;
    ctx.fillText('(' + comments.length + ')', 40 + titleW + 10, 33);

    const tabs = [
      { key: 'all', label: 'ALL', x: 296, w: 48 },
      { key: 'sync', label: 'SYNC', x: 352, w: 64 },
      { key: 'general', label: 'GENERAL', x: 424, w: 78 },
    ];
    tabs.forEach((tab) => {
      const active = cPanelTab === tab.key;
      const hover = cPanelHover === ('tab:' + tab.key);
      ctx.fillStyle = active ? accent : (hover ? '#1D2126' : '#1f2021');
      ctx.strokeStyle = active ? accent : (hover ? accent : '#343536');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(tab.x, 16, tab.w, 30, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = active ? '#5a0600' : (hover ? '#FFFFFF' : '#ff553a');
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(tab.label, tab.x + tab.w / 2, 31);
    });

    const closeHover = cPanelHover === 'close';
    ctx.fillStyle = closeHover ? '#292a2b' : '#1f2021';
    ctx.strokeStyle = closeHover ? accent : '#343536';
    ctx.beginPath();
    ctx.roundRect(522, 16, 26, 30, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = closeHover ? '#FFFFFF' : accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('✕', 535, 31);

    ctx.strokeStyle = '#343536';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, CP_HEADER_H);
    ctx.lineTo(CPANEL_W, CP_HEADER_H);
    ctx.stroke();

    // List viewport
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, CP_LIST_TOP, CP_LIST_X + CP_LIST_W, listH);
    ctx.clip();

    if (filtered.length === 0) {
      ctx.fillStyle = accent;
      ctx.font = '700 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        cPanelTab === 'general' ? 'NO GENERAL COMMENTS' : cPanelTab === 'sync' ? 'NO TIME-SYNCED COMMENTS' : 'NO COMMENTS YET',
        CPANEL_W / 2, CP_LIST_TOP + 40
      );
      ctx.fillStyle = 'rgba(155,161,168,0.6)';
      ctx.fillText('Tap ADD COMMENT below to drop one', CPANEL_W / 2, CP_LIST_TOP + 60);
    } else {
      filtered.forEach((c, i) => {
        const y = CP_LIST_TOP + i * (CP_ITEM_H + CP_ITEM_GAP) - cPanelScrollY;
        if (y + CP_ITEM_H < CP_LIST_TOP || y > CP_LIST_BOTTOM) return;

        const itemX = CP_LIST_X + 10;
        const itemW = CP_LIST_W - 20;
        const border = c.avatar_color || accent;
        const hoveredLike = cPanelHover === ('like:' + c.id);
        const hoveredSeek = cPanelHover === ('seek:' + c.id);
        const highlighted = c.id === cPanelHighlightId;

        ctx.fillStyle = highlighted ? '#1c1d1f' : '#121315';
        ctx.beginPath();
        ctx.roundRect(itemX, y, itemW, CP_ITEM_H, 4);
        ctx.fill();
        ctx.strokeStyle = highlighted ? accent : ((hoveredSeek || hoveredLike) ? 'rgba(255,85,58,0.6)' : '#343536');
        ctx.lineWidth = highlighted ? 2.5 : 1;
        ctx.stroke();
        if (highlighted) {
          ctx.shadowColor = 'rgba(255, 85, 58, 0.45)';
          ctx.shadowBlur = 16;
          ctx.strokeStyle = accent;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.roundRect(itemX, y, itemW, CP_ITEM_H, 4);
          ctx.stroke();
          ctx.shadowBlur = 0;
          // "jump marker" on the right edge
          ctx.fillStyle = accent;
          ctx.font = 'bold 14px sans-serif';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText('◀', itemX + itemW - 10, y + CP_ITEM_H / 2);
        }

        ctx.fillStyle = border;
        ctx.fillRect(itemX, y, 3, CP_ITEM_H);

        const isEmojiAvatar = c.author_avatar && c.author_avatar.length <= 2 && /\p{Emoji}/u.test(c.author_avatar);
        ctx.fillStyle = '#1f2021';
        ctx.beginPath();
        ctx.roundRect(itemX + 8, y + 12, 40, 40, 4);
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.stroke();
        if (isEmojiAvatar) {
          ctx.font = '20px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(c.author_avatar, itemX + 28, y + 33);
        } else {
          ctx.fillStyle = border;
          ctx.font = '700 11px "JetBrains Mono", monospace';
          ctx.fillText(getInitials(c.author_name), itemX + 28, y + 33);
        }

        ctx.fillStyle = border;
        ctx.font = '700 11px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let name = c.author_name || 'Anonymous';
        if (name.length > 16) name = name.slice(0, 15) + '…';
        ctx.fillText(name, itemX + 56, y + 14);

        const hasTime = c.timestamp !== null && c.timestamp !== undefined;
        const pillX = itemX + 180;
        ctx.fillStyle = hoveredSeek ? accent : '#292a2b';
        ctx.strokeStyle = accent;
        ctx.beginPath();
        ctx.roundRect(pillX, y + 10, 100, 24, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = hoveredSeek ? '#5a0600' : accent;
        ctx.font = '700 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(hasTime ? ('⏱ ' + formatTime(c.timestamp)) : 'GENERAL', pillX + 50, y + 23);

        const likeX = itemX + itemW - 46;
        if (hoveredLike) {
          ctx.fillStyle = '#1D2126';
          ctx.beginPath();
          ctx.roundRect(likeX, y + 10, 40, 24, 3);
          ctx.fill();
        }
        ctx.fillStyle = accent;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('♥ ' + (c.likes || 0), likeX + 38, y + 23);

        ctx.fillStyle = '#e3e2e3';
        ctx.font = '500 13px Archivo, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const lines = wrapTextLines(ctx, c.text || '', itemW - 70, 2);
        lines.forEach((line, li) => {
          ctx.fillText(line, itemX + 56, y + 48 + li * 18);
        });
      });
    }
    ctx.restore();

    // Scrollbar column
    const upHover = cPanelHover === 'scrollup';
    ctx.fillStyle = upHover ? '#1D2126' : '#1f2021';
    ctx.strokeStyle = upHover ? accent : '#343536';
    ctx.beginPath();
    ctx.roundRect(CP_SCROLL_X, CP_LIST_TOP, CP_SCROLL_W, 26, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = upHover ? '#FFFFFF' : accent;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▲', CP_SCROLL_X + CP_SCROLL_W / 2, CP_LIST_TOP + 14);

    const downHover = cPanelHover === 'scrolldown';
    ctx.fillStyle = downHover ? '#1D2126' : '#1f2021';
    ctx.strokeStyle = downHover ? accent : '#343536';
    ctx.beginPath();
    ctx.roundRect(CP_SCROLL_X, CP_LIST_BOTTOM - 26, CP_SCROLL_W, 26, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = downHover ? '#FFFFFF' : accent;
    ctx.fillText('▼', CP_SCROLL_X + CP_SCROLL_W / 2, CP_LIST_BOTTOM - 12);

    const trackTop = CP_LIST_TOP + 30;
    const trackBot = CP_LIST_BOTTOM - 30;
    ctx.strokeStyle = '#343536';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CP_SCROLL_X + CP_SCROLL_W / 2, trackTop);
    ctx.lineTo(CP_SCROLL_X + CP_SCROLL_W / 2, trackBot);
    ctx.stroke();

    if (cPanelMaxScroll > 0) {
      const handleH = Math.max(40, (trackBot - trackTop) * (listH / contentH));
      const frac = cPanelScrollY / cPanelMaxScroll;
      const handleY = trackTop + frac * ((trackBot - trackTop) - handleH);
      const handleHover = cPanelHover === 'scrollbar';
      ctx.fillStyle = handleHover ? accent : '#5d3f3a';
      ctx.beginPath();
      ctx.roundRect(CP_SCROLL_X + CP_SCROLL_W / 2 - 4, handleY, 8, handleH, 4);
      ctx.fill();
    }

    // Footer
    const footerY = CP_LIST_BOTTOM + 4;
    ctx.fillStyle = '#0d0e0f';
    ctx.fillRect(0, footerY, CPANEL_W, CPANEL_H - footerY);

    const accountHover = cPanelHover === 'account';
    ctx.fillStyle = accountHover ? '#292a2b' : '#1f2021';
    ctx.strokeStyle = accountHover ? accent : '#343536';
    ctx.beginPath();
    ctx.roundRect(16, footerY + 10, 200, 34, 3);
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (user) {
      ctx.fillStyle = user.avatar_color || accent;
      ctx.fillText((user.display_name || user.username || '?').slice(0, 1).toUpperCase(), 28, footerY + 28);
      ctx.fillStyle = '#e3e2e3';
      ctx.fillText('@' + (user.username || 'account'), 52, footerY + 28);
    } else {
      ctx.fillStyle = accent;
      ctx.fillText('?', 28, footerY + 28);
      ctx.fillStyle = '#e3e2e3';
      ctx.fillText('SIGN IN TO INTERACT', 52, footerY + 28);
    }

    ctx.fillStyle = 'rgba(155,161,168,0.8)';
    ctx.font = '700 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('SYNC: ' + formatTime(videoElement ? videoElement.currentTime : 0), CPANEL_W - 16, footerY + 28);

    const addHover = cPanelHover === 'add';
    ctx.fillStyle = addHover ? '#ff6a52' : accent;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.roundRect(16, footerY + 54, CPANEL_W - 32, 44, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#5a0600';
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('+ ADD COMMENT', CPANEL_W / 2, footerY + 77);
  }

  // ── Panel actions ──
  function executeCommentAction(desc) {
    if (!desc) return false;
    if (desc === 'panel') return true; // consume non-interactive panel presses
    if (desc === 'list' || desc === 'scrollbar') {
      cPanelDrag = true;
      cPanelDragStartCanvasY = lastCommentsCanvasY;
      cPanelDragStartScroll = cPanelScrollY;
      return true;
    }
    if (desc.indexOf('tab:') === 0) {
      cPanelTab = desc.slice(4);
      cPanelScrollY = 0;
      clearPanelHighlight();
      return true;
    }
    if (desc === 'close') {
      commentsPanelVisible = false;
      cPanelHover = null;
      return true;
    }
    if (desc === 'add') {
      openVrKeyboard();
      return true;
    }
    if (desc === 'scrollup') {
      cPanelScrollY = clampPanelScroll(cPanelScrollY - (CP_ITEM_H + CP_ITEM_GAP));
      return true;
    }
    if (desc === 'scrolldown') {
      cPanelScrollY = clampPanelScroll(cPanelScrollY + (CP_ITEM_H + CP_ITEM_GAP));
      return true;
    }
    if (desc.indexOf('seek:') === 0) {
      const id = desc.slice(5);
      const comments = callbacks.getComments ? callbacks.getComments() : [];
      const c = comments.find((x) => x.id === id);
      if (c && c.timestamp !== null && c.timestamp !== undefined && callbacks.onSeekTo) {
        callbacks.onSeekTo(Number(c.timestamp));
      }
      return true;
    }
    if (desc.indexOf('like:') === 0) {
      const id = desc.slice(5);
      if (callbacks.onLikeComment) callbacks.onLikeComment(id);
      return true;
    }
    if (desc.indexOf('profile:') === 0) {
      const username = desc.slice(8);
      if (username && callbacks.onOpenProfile) callbacks.onOpenProfile(username);
      return true;
    }
    if (desc === 'account') {
      if (callbacks.onOpenAccount) callbacks.onOpenAccount();
      return true;
    }
    return false;
  }

  function toggleCommentsPanel() {
    commentsPanelVisible = !commentsPanelVisible;
    if (!commentsPanelVisible) {
      cPanelDrag = false;
      cPanelHover = null;
      clearPanelHighlight();
      closeVrKeyboard();
    }
  }

  // Open the VR comments panel, scroll to and highlight a specific comment
  // (usually triggered by clicking a pop-up overlay comment).
  function openCommentsPanelToComment(commentId) {
    commentsPanelVisible = true;
    cPanelTab = 'all';
    const filtered = getPanelFilteredComments();
    const idx = filtered.findIndex((c) => c.id === commentId);
    const listH = CP_LIST_BOTTOM - CP_LIST_TOP;
    if (idx >= 0) {
      const itemTop = idx * (CP_ITEM_H + CP_ITEM_GAP);
      cPanelScrollY = Math.max(0, itemTop - (listH - CP_ITEM_H) / 2);
    }
    setPanelHighlight(commentId);
  }

  function setPanelHighlight(commentId) {
    clearPanelHighlight();
    cPanelHighlightId = commentId;
    cPanelHighlightTimer = setTimeout(() => {
      cPanelHighlightId = null;
      cPanelHighlightTimer = null;
    }, 4000);
  }

  function clearPanelHighlight() {
    if (cPanelHighlightTimer) {
      clearTimeout(cPanelHighlightTimer);
      cPanelHighlightTimer = null;
    }
    cPanelHighlightId = null;
  }

  // ── Quest virtual keyboard (DOM Overlay) for posting comments ──
  function initDomOverlay() {
    if (domOverlayRoot) return;
    domOverlayRoot = document.createElement('div');
    domOverlayRoot.id = 'vrCommentDomOverlay';
    domOverlayRoot.style.cssText = 'position:fixed;left:0;right:0;bottom:0;top:auto;height:360px;z-index:2147483646;pointer-events:none;';
    domOverlayInput = document.createElement('input');
    domOverlayInput.type = 'text';
    domOverlayInput.autocomplete = 'off';
    domOverlayInput.setAttribute('enterkeyhint', 'send');
    domOverlayInput.placeholder = 'Type a VR comment…';
    domOverlayInput.style.cssText = 'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);width:460px;max-width:80vw;padding:14px 16px;font-family:Archivo,system-ui,sans-serif;font-size:16px;color:#e3e2e3;background:rgba(13,14,15,0.97);border:2px solid #ff553a;border-radius:8px;outline:none;pointer-events:auto;display:none;box-shadow:0 8px 32px rgba(0,0,0,0.9);';
    domOverlayInput.addEventListener('keydown', onCommentInputKeydown);
    domOverlayInput.addEventListener('blur', onCommentInputBlur);
    domOverlayRoot.appendChild(domOverlayInput);
    (document.body || document.documentElement).appendChild(domOverlayRoot);
  }

  function openVrKeyboard() {
    initDomOverlay();
    if (!domOverlayInput) return;
    pendingSyncTime = videoElement ? Math.round(videoElement.currentTime * 10) / 10 : null;
    domOverlayInput.value = '';
    domOverlayInput.style.display = 'block';
    try { domOverlayInput.focus(); } catch (e) {}
  }

  function closeVrKeyboard() {
    if (domOverlayInput) {
      domOverlayInput.style.display = 'none';
      try { domOverlayInput.blur(); } catch (e) {}
    }
  }

  function onCommentInputKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = domOverlayInput ? domOverlayInput.value.trim() : '';
      closeVrKeyboard();
      if (text && callbacks.onPostComment) {
        callbacks.onPostComment(text, pendingSyncTime);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeVrKeyboard();
    }
  }

  function onCommentInputBlur() {
    setTimeout(() => {
      if (domOverlayInput && document.activeElement !== domOverlayInput) {
        domOverlayInput.style.display = 'none';
      }
    }, 150);
  }

  // ─── All-Side Concave Screen Arc Geometry Math ─────────────────────
  // ARC_ANGLE = 0.65 rad (~37.2° arc angle for immersive concave curvature)
  // R_CURVE = 1.0 / 0.65 = 1.5385 (Direct center view is the center focal point)

  const ARC_ANGLE = 0.65;
  const R_CURVE = 1.5385;

  function hitTestCurvedScreen(rayOrigin, rayDir) {
    const halfW = screenScale / 2;
    const halfH = screenScale / 2;

    const invQ = quatInvert(screenQuat);
    const O_loc = quatRotVec(invQ, vecSub(rayOrigin, screenPos));
    const D_loc = quatRotVec(invQ, rayDir);

    if (curvatureMode === 1 || curvatureMode === 2) {
      const R_world = R_CURVE * screenScale;
      const Ox = O_loc.x, Oy = O_loc.y, Oz = O_loc.z - R_world;
      const Dx = D_loc.x, Dy = D_loc.y, Dz = D_loc.z;

      const A = Dx * Dx + Dy * Dy + Dz * Dz;
      if (A < 0.00001) return { hit: false, dist: -1 };

      const B = 2 * (Ox * Dx + Oy * Dy + Oz * Dz);
      const C = Ox * Ox + Oy * Oy + Oz * Oz - R_world * R_world;

      const disc = B * B - 4 * A * C;
      if (disc < 0) return { hit: false, dist: -1 };

      let t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t < 0) t = (-B + Math.sqrt(disc)) / (2 * A);
      if (t < 0 || t > 20) return { hit: false, dist: -1 };

      const hitLocal = vecAdd(O_loc, vecScale(D_loc, t));
      if (Math.abs(hitLocal.x) <= halfW && Math.abs(hitLocal.y) <= halfH) {
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

  function getControlsCenter() {
    if (sceneMode === 'earth') {
      return { x: earthCenter.x, y: earthCenter.y - 0.72, z: earthCenter.z + 0.08 };
    }
    if (lockToViewer) {
      // Decoupled from the head-locked screen block: the transport panel stays
      // fixed and level in the room at the default screen spot.
      const offsetLocal = { x: 0, y: -DEFAULT_SCALE / 2 - CONTROLS_Y_OFFSET, z: 0 };
      return vecAdd({ ...DEFAULT_POS }, offsetLocal);
    }
    const offsetLocal = { x: 0, y: -screenScale / 2 - CONTROLS_Y_OFFSET, z: 0 };
    const offsetWorld = quatRotVec(screenQuat, offsetLocal);
    return vecAdd(screenPos, offsetWorld);
  }

  function getGuideCenter() {
    if (lockToViewer) {
      const guideW = DEFAULT_SCALE * 0.4212; // 0.351 * 1.2 → 20% larger (symmetric with comments panel)
      return {
        x: DEFAULT_POS.x + DEFAULT_SCALE / 2 + guideW / 2 + 0.384,
        y: DEFAULT_POS.y,
        z: DEFAULT_POS.z - 0.15,
      };
    }
    const guideW = screenScale * 0.4212; // 0.351 * 1.2 → 20% larger (symmetric with comments panel)
    const offsetLocal = { x: screenScale / 2 + guideW / 2 + 0.384, y: 0, z: -0.15 };
    const offsetWorld = quatRotVec(screenQuat, offsetLocal);
    return vecAdd(screenPos, offsetWorld);
  }

  function getControlsQuat() {
    if (sceneMode === 'earth') {
      return quatFaceViewerLevel(getControlsCenter(), currentHeadPos);
    }
    if (lockToViewer) {
      return quatFaceViewerLevel(getControlsCenter(), currentHeadPos);
    }
    return screenQuat;
  }

  function getControlsScale() {
    if (sceneMode === 'earth') return 1.2;
    return lockToViewer ? DEFAULT_SCALE : screenScale;
  }

  function getHitDistControls(rayOrigin, rayDir) {
    const ctrlCenter = getControlsCenter();
    const normal = quatRotVec(getControlsQuat(), { x: 0, y: 0, z: 1 });
    const denom = rayDir.x * normal.x + rayDir.y * normal.y + rayDir.z * normal.z;
    if (Math.abs(denom) < 0.0001) return -1;
    const t = ((ctrlCenter.x - rayOrigin.x) * normal.x +
               (ctrlCenter.y - rayOrigin.y) * normal.y +
               (ctrlCenter.z - rayOrigin.z) * normal.z) / denom;
    return t > 0 ? t : -1;
  }

  function hitTestControls(rayOrigin, rayDir) {
    const ctrlCenter = getControlsCenter();
    const ctrlWidth = getControlsScale() * 0.82;
    const ctrlHeight = ctrlWidth * (CONTROLS_H / CONTROLS_W);

    const ctrlQuat = getControlsQuat();
    const normal = quatRotVec(ctrlQuat, { x: 0, y: 0, z: 1 });
    const denom = rayDir.x * normal.x + rayDir.y * normal.y + rayDir.z * normal.z;

    if (Math.abs(denom) < 0.0001) return -1;
    const t = ((ctrlCenter.x - rayOrigin.x) * normal.x +
               (ctrlCenter.y - rayOrigin.y) * normal.y +
               (ctrlCenter.z - rayOrigin.z) * normal.z) / denom;
    if (t < 0 || t > 20) return -1;

    const hitP = vecAdd(rayOrigin, vecScale(rayDir, t));
    const invQ = quatInvert(ctrlQuat);
    const localP = quatRotVec(invQ, vecSub(hitP, ctrlCenter));

    const halfW = ctrlWidth / 2;
    const halfH = ctrlHeight / 2;

    if (Math.abs(localP.x) > halfW || Math.abs(localP.y) > halfH) return -1;

    const u = (localP.x + halfW) / ctrlWidth;
    const v = (halfH - localP.y) / ctrlHeight;
    const canvasX = u * CONTROLS_W;
    const canvasY = v * CONTROLS_H;

    lastControlsCanvasX = canvasX;
    lastControlsCanvasY = canvasY;

    for (let i = 0; i < CTRL_BUTTONS.length; i++) {
      const btn = CTRL_BUTTONS[i];
      if (sceneMode === 'earth' && btn.action !== 'earth' && btn.action !== 'exit') continue;
      if (canvasX >= btn.x && canvasX <= btn.x + btn.w &&
          canvasY >= btn.y && canvasY <= btn.y + btn.h) {
        return i;
      }
    }
    return -1;
  }

  function executeControlButton(index) {
    if (index < 0 || index >= CTRL_BUTTONS.length) return;
    const action = CTRL_BUTTONS[index].action;
    if (sceneMode === 'earth' && action !== 'earth' && action !== 'exit') return;
    resetAutoHideTimer();
    switch (action) {
      case 'prev':  callbacks.onPrev && callbacks.onPrev(); break;
      case 'next':  callbacks.onNext && callbacks.onNext(); break;
      case 'play':  callbacks.onTogglePlay && callbacks.onTogglePlay(); break;
      case 'rew':   callbacks.onSeek && callbacks.onSeek(-5); break;
      case 'fwd':   callbacks.onSeek && callbacks.onSeek(5); break;
      case 'mode':  callbacks.onToggleMode && callbacks.onToggleMode(); break;
      case 'curve':
        curvatureMode = (curvatureMode + 1) % 3;
        isCurved = (curvatureMode !== 0);
        break;
      case 'lock':
        lockToViewer = !lockToViewer;
        if (lockToViewer) {
          isGrabbing = false;
          grabControllerIdx = -1;
        }
        break;
      case 'mute':
        if (videoElement) {
          videoElement.muted = !videoElement.muted;
          if (callbacks.onMuteChange) callbacks.onMuteChange(videoElement.muted);
        }
        break;
      case 'seek':
        if (videoElement && videoElement.duration) {
          const ratio = Math.max(0, Math.min(1, (lastControlsCanvasX - 24) / 752));
          videoElement.currentTime = ratio * videoElement.duration;
        }
        break;
      case 'comments': toggleCommentsPanel(); break;
      case 'earth': toggleEarthMode(); break;
      case 'exit':  xrSession ? exitVR() : stopPreview(); break;
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

  // ─── Earth Activity Mode ─────────────────────────────────────────────

  function earthRotationQuat() {
    const yawQ = { x: 0, y: Math.sin(earthYaw / 2), z: 0, w: Math.cos(earthYaw / 2) };
    const pitchQ = { x: Math.sin(earthPitch / 2), y: 0, z: 0, w: Math.cos(earthPitch / 2) };
    return quatMul(yawQ, pitchQ);
  }

  function locationToUnit(lat, lon) {
    const latRad = Number(lat) * Math.PI / 180;
    const lonRad = Number(lon) * Math.PI / 180;
    const cosLat = Math.cos(latRad);
    return {
      x: cosLat * Math.sin(lonRad),
      y: Math.sin(latRad),
      z: cosLat * Math.cos(lonRad),
    };
  }

  function setEarthStatus(message) {
    earthStatus = String(message || '');
    earthLabelSignature = '';
  }

  function renderEarthLabelCanvas() {
    if (!earthLabelCtx || !earthLabelCanvas) return;
    const location = earthLocations[earthSelectedIndex] || earthLocations[earthHoveredIndex] || null;
    const title = location ? location.name : 'EARTH ACTIVITY';
    const detail = location
      ? ((location.active_reel_count || 0) + ' ACTIVE · ' + (location.new_reel_count || 0) + ' NEW · HEAT ' + Math.round((location.heat || 0) * 100) + '%')
      : earthStatus;
    const signature = title + '|' + detail;
    if (signature === earthLabelSignature) return;
    earthLabelSignature = signature;
    const ctx = earthLabelCtx;
    ctx.clearRect(0, 0, earthLabelCanvas.width, earthLabelCanvas.height);
    ctx.fillStyle = 'rgba(7, 12, 24, 0.94)';
    ctx.strokeStyle = location ? '#FFB11F' : '#3A506B';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(2, 2, earthLabelCanvas.width - 4, earthLabelCanvas.height - 4, 14);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#F7FAFC';
    ctx.font = '700 28px "Archivo", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, earthLabelCanvas.width / 2, 43);
    ctx.fillStyle = '#B8C6D9';
    ctx.font = '700 15px "JetBrains Mono", monospace';
    ctx.fillText(detail || 'NO RECENT ACTIVITY', earthLabelCanvas.width / 2, 84);
    if (gl && glEarthLabelTexture) {
      gl.bindTexture(gl.TEXTURE_2D, glEarthLabelTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, earthLabelCanvas);
    }
  }

  function uploadEarthMarkers() {
    if (!gl || !glEarthMarkerBuf) return;
    const values = [];
    earthLocations.slice(0, EARTH_MARKER_LIMIT).forEach((location) => {
      const unit = location._unit || locationToUnit(location.lat, location.lon);
      location._unit = unit;
      const radius = EARTH_RADIUS * 1.025;
      const index = values.length / 5;
      const state = index === earthSelectedIndex ? 2 : (index === earthHoveredIndex ? 1 : 0);
      values.push(
        unit.x * radius,
        unit.y * radius,
        unit.z * radius,
        Math.max(0, Math.min(1, Number(location.heat) || 0)),
        state
      );
    });
    glEarthMarkerCount = Math.min(earthLocations.length, EARTH_MARKER_LIMIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, glEarthMarkerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.DYNAMIC_DRAW);
  }

  function setEarthHoveredIndex(index) {
    const next = Number.isInteger(index) ? index : -1;
    if (earthHoveredIndex === next) return;
    earthHoveredIndex = next;
    earthLabelSignature = '';
    uploadEarthMarkers();
  }

  function setLocationActivity(rows) {
    earthLocations = Array.isArray(rows)
      ? rows.slice(0, EARTH_MARKER_LIMIT).filter((row) => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon)))
      : [];
    earthLocations.forEach((location) => { location._unit = locationToUnit(location.lat, location.lon); });
    earthHoveredIndex = -1;
    earthSelectedIndex = -1;
    setEarthStatus(earthLocations.length ? 'POINT, DRAG, OR USE THUMBSTICK' : 'NO RECENT LOCATION ACTIVITY');
    uploadEarthMarkers();
    return earthLocations.length;
  }

  function anchorEarthFromHead() {
    const facing = quatRotVec(currentHeadQuat, { x: 0, y: 0, z: -1 });
    const horizontal = vecNorm({ x: facing.x, y: 0, z: facing.z });
    earthCenter = {
      x: currentHeadPos.x + horizontal.x * 1.3,
      y: currentHeadPos.y - 0.4,
      z: currentHeadPos.z + horizontal.z * 1.3,
    };
  }

  async function loadEarthActivity() {
    if (earthActivityAbort) earthActivityAbort.abort();
    const generation = ++earthActivityGeneration;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    earthActivityAbort = controller;
    setEarthStatus('LOADING 7-DAY ACTIVITY…');
    try {
      const response = await fetch('/api/reels/locations/activity?window_days=7&limit=128', {
        credentials: 'include',
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) throw new Error('Activity request failed (' + response.status + ')');
      const payload = await response.json();
      if (generation !== earthActivityGeneration || sceneMode !== 'earth') return;
      setLocationActivity(payload.locations || []);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (generation !== earthActivityGeneration || sceneMode !== 'earth') return;
      console.error('[WebXRVR] Earth activity load failed:', error);
      setEarthStatus('ACTIVITY UNAVAILABLE · TRY AGAIN');
    } finally {
      if (earthActivityAbort === controller) earthActivityAbort = null;
    }
  }

  function openEarthMode() {
    if (sceneMode === 'earth') return;
    sceneMode = 'earth';
    earthResumePlayback = !!(videoElement && !videoElement.paused);
    commentsPanelVisible = false;
    controlsVisible = true;
    clearAutoHideTimer();
    anchorEarthFromHead();
    earthLastFrameTime = -1;
    earthDragging = false;
    earthDragSource = null;
    earthDragLastDir = null;
    earthDragInputSource = null;
    earthPressMarker = -1;
    earthLocations = [];
    earthHoveredIndex = -1;
    earthSelectedIndex = -1;
    uploadEarthMarkers();
    if (videoElement) {
      try { videoElement.pause(); } catch (e) {}
    }
    if (callbacks.onEarthOpen) {
      const resumeOverride = callbacks.onEarthOpen(earthResumePlayback);
      if (typeof resumeOverride === 'boolean') earthResumePlayback = resumeOverride;
    }
    if (gl) initEarthResources();
    loadEarthActivity();
    if (callbacks.onSceneModeChange) callbacks.onSceneModeChange('earth');
    emitPreviewState();
  }

  function closeEarthMode(options) {
    if (sceneMode !== 'earth') return;
    const opts = options || {};
    sceneMode = 'reels';
    earthActivityGeneration += 1;
    earthSelectionGeneration += 1;
    if (earthActivityAbort) {
      earthActivityAbort.abort();
      earthActivityAbort = null;
    }
    earthHoveredIndex = -1;
    earthSelectedIndex = -1;
    earthDragging = false;
    earthDragSource = null;
    earthDragLastDir = null;
    earthDragInputSource = null;
    earthPressMarker = -1;
    earthLastFrameTime = -1;
    if (callbacks.onEarthClose) callbacks.onEarthClose(opts.resume !== false && earthResumePlayback);
    if (callbacks.onSceneModeChange) callbacks.onSceneModeChange('reels');
    resetAutoHideTimer();
    emitPreviewState();
  }

  function toggleEarthMode() {
    if (sceneMode === 'earth') {
      closeEarthMode();
      return;
    }
    if (callbacks.isLocationFeedActive && callbacks.isLocationFeedActive()) {
      Promise.resolve(callbacks.onRestoreAllLocations && callbacks.onRestoreAllLocations())
        .catch((error) => console.error('[WebXRVR] All locations restore failed:', error));
      return;
    }
    openEarthMode();
  }

  function selectEarthLocation(index) {
    const location = earthLocations[index];
    if (!location || !callbacks.onSelectLocation) return;
    const generation = ++earthSelectionGeneration;
    earthSelectedIndex = index;
    uploadEarthMarkers();
    setEarthStatus('LOADING ' + String(location.name || location.slug || 'LOCATION').toUpperCase() + '…');
    Promise.resolve(callbacks.onSelectLocation(location)).then((accepted) => {
      if (generation !== earthSelectionGeneration || sceneMode !== 'earth') return;
      if (accepted === false) {
        setEarthStatus('NO RECENT REELS IN THIS LOCATION');
        return;
      }
      closeEarthMode({ resume: false });
    }).catch((error) => {
      if (generation !== earthSelectionGeneration || sceneMode !== 'earth') return;
      console.error('[WebXRVR] Location feed switch failed:', error);
      setEarthStatus('LOCATION FEED UNAVAILABLE');
    });
  }

  function rotateEarth(deltaYaw, deltaPitch) {
    earthYaw = (earthYaw + deltaYaw) % (Math.PI * 2);
    earthPitch = Math.max(-1.1, Math.min(1.1, earthPitch + deltaPitch));
  }

  function raySphereHit(rayOrigin, rayDir, center, radius) {
    const offset = vecSub(rayOrigin, center);
    const a = rayDir.x * rayDir.x + rayDir.y * rayDir.y + rayDir.z * rayDir.z;
    const b = 2 * (offset.x * rayDir.x + offset.y * rayDir.y + offset.z * rayDir.z);
    const c = offset.x * offset.x + offset.y * offset.y + offset.z * offset.z - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0 || a < 0.000001) return null;
    let distance = (-b - Math.sqrt(disc)) / (2 * a);
    if (distance < 0) distance = (-b + Math.sqrt(disc)) / (2 * a);
    if (distance < 0 || distance > 20) return null;
    const world = vecAdd(rayOrigin, vecScale(rayDir, distance));
    const local = vecNorm(quatRotVec(quatInvert(earthRotationQuat()), vecSub(world, earthCenter)));
    return { distance, world, local };
  }

  function hitTestEarth(rayOrigin, rayDir) {
    const hit = raySphereHit(rayOrigin, rayDir, earthCenter, EARTH_RADIUS * 1.08);
    if (!hit) return { hit: false, dist: -1, markerIndex: -1 };
    let markerIndex = -1;
    let bestDot = -1;
    earthLocations.forEach((location, index) => {
      const unit = location._unit || locationToUnit(location.lat, location.lon);
      const dot = hit.local.x * unit.x + hit.local.y * unit.y + hit.local.z * unit.z;
      const threshold = Math.cos(0.12 + Math.max(0, Math.min(1, Number(location.heat) || 0)) * 0.08);
      if (dot >= threshold && dot > bestDot) {
        bestDot = dot;
        markerIndex = index;
      }
    });
    return { hit: true, dist: hit.distance, markerIndex, local: hit.local };
  }

  function updateEarthDrag(direction) {
    if (!direction) return;
    const normalized = vecNorm(direction);
    if (earthDragLastDir) {
      const dx = normalized.x - earthDragLastDir.x;
      const dy = normalized.y - earthDragLastDir.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.002) earthDragMoved = true;
      rotateEarth(dx * 2.8, -dy * 2.4);
    }
    earthDragLastDir = normalized;
  }


  function advanceEarthSpin(time) {
    if (earthLastFrameTime < 0) {
      earthLastFrameTime = time;
      return 0;
    }
    const dt = Math.max(0, Math.min(0.1, (time - earthLastFrameTime) * 0.001));
    earthLastFrameTime = time;
    if (reducedMotion || earthDragging || time < earthInteractionUntil) return 0;
    const delta = EARTH_IDLE_RADIANS_PER_SECOND * dt;
    rotateEarth(delta, 0);
    return delta;
  }

  function beginEarthDrag(source, hit) {
    if (!hit || !hit.hit) return false;
    earthDragging = true;
    earthDragSource = source || 'pointer';
    earthDragInputSource = source && typeof source === 'object' ? source : null;
    earthDragLastDir = hit.local;
    earthDragMoved = false;
    earthPressMarker = hit.markerIndex;
    earthInteractionUntil = performance.now() + 900;
    return true;
  }

  function endEarthDrag(source, hit) {
    if (!earthDragging) return false;
    if (earthDragInputSource && source && earthDragInputSource !== source) return false;
    if (hit && hit.hit) updateEarthDrag(hit.local);
    const selected = !earthDragMoved && earthPressMarker >= 0
      && hit && hit.markerIndex === earthPressMarker
      ? earthPressMarker
      : -1;
    earthDragging = false;
    earthDragSource = null;
    earthDragInputSource = null;
    earthDragLastDir = null;
    earthPressMarker = -1;
    earthInteractionUntil = performance.now() + 900;
    if (selected >= 0) selectEarthLocation(selected);
    return true;
  }


  // ─── Video Frame Tracking ───────────────────────────────────────────

  function stopVideoFrameTracking() {
    videoFrameTrackingGeneration += 1;
    if (videoElement && videoFrameCallbackId !== null &&
        typeof videoElement.cancelVideoFrameCallback === 'function') {
      try { videoElement.cancelVideoFrameCallback(videoFrameCallbackId); } catch (e) {}
    }
    videoFrameCallbackId = null;
  }

  function setupVideoFrameTracking() {
    stopVideoFrameTracking();
    if (!videoElement || typeof videoElement.requestVideoFrameCallback !== 'function') return;
    const generation = videoFrameTrackingGeneration;
    function onFrame() {
      if (generation !== videoFrameTrackingGeneration) return;
      hasNewVideoFrame = true;
      if (xrSession || previewRunning) {
        videoFrameCallbackId = videoElement.requestVideoFrameCallback(onFrame);
      } else {
        videoFrameCallbackId = null;
      }
    }
    videoFrameCallbackId = videoElement.requestVideoFrameCallback(onFrame);
  }

  // Minimum sane stride for the current file: 4K masters start at 2 because a
  // stride-1 4K upload (~100ms flush) can never fit an 11-14ms XR budget.
  // Low-res files (720p/1080p/1280²) start at 1 → full frame rate.
  function vrMinStride() {
    const w = videoElement ? (videoElement.videoWidth || 0) : 0;
    if (w >= 3000) return 2;
    return 1;
  }

  // ─── VR Telemetry: self-report XR frame timing + texture uploads ───
  function _postDiag(time) {
    if (_diagLastT !== null) {
      const dt = time - _diagLastT;
      _diagFrames++;
      _diagDtMin = Math.min(_diagDtMin, dt);
      _diagDtMax = Math.max(_diagDtMax, dt);
      _diagDtSum += dt;
      if (dt > 20) _diagOver20++;
      if (dt > 14) _diagOver14++; // 72Hz budget is 13.9ms: 14-20ms frames miss
                                  // vsync (flash) without tripping over20
    }
    _diagLastT = time;

    if (!_diagForce && time - _diagLastPost < 1000) return; // throttle to ~1 Hz
    _diagLastPost = time;
    _diagForce = false;

    const pq = (videoElement && videoElement.getVideoPlaybackQuality)
      ? videoElement.getVideoPlaybackQuality() : null;
    const pqTotal = pq ? pq.totalVideoFrames : 0;
    const pqDropped = pq ? pq.droppedVideoFrames : 0;
    if (_diagLastPqTotal < 0) _diagLastPqTotal = pqTotal;
    const newDecoded = Math.max(0, pqTotal - _diagLastPqTotal);
    _diagLastPqTotal = pqTotal;

    if (!_diagGLInfo && gl) {
      try {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        _diagGLInfo = {
          renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
          glVersion: String(gl.getParameter(gl.VERSION)),
          extOES: !!gl.getExtension('OES_texture_external'),
          texTarget: videoTexMode,
        };
      } catch (e) { _diagGLInfo = { err: String(e) }; }
    }

    const n = Math.max(1, _diagFrames);
    const payload = {
      t_ms: Math.round(time),
      xrFrames: _diagFrames,
      dtMedMs: +((_diagDtSum / n)).toFixed(2),
      dtMinMs: +(_diagDtMin === Infinity ? 0 : _diagDtMin).toFixed(2),
      dtMaxMs: +(_diagDtMax).toFixed(2),
      over20: _diagOver20,
      over14: _diagOver14,
      texUploads: _diagTexUploads,
      uploadMaxMs: +_diagUploadMaxMs.toFixed(2),
      drawMaxMs: +_diagDrawMaxMs.toFixed(2),
      proxyW: vrProxyCanvas ? vrProxyCanvas.width : 0,
      newDecoded: newDecoded,
      pqTotal: pqTotal,
      pqDropped: pqDropped,
      texTarget: videoTexMode,
      upStride: vrUploadStride,
      videoW: videoElement ? videoElement.videoWidth : 0,
      videoH: videoElement ? videoElement.videoHeight : 0,
      ct: videoElement ? +(videoElement.currentTime).toFixed(2) : 0,
      ready: videoElement ? videoElement.readyState : 0,
      gl: _diagGLInfo,
    };
    try {
      const body = JSON.stringify(payload);
      // keepalive so the POST survives even if the tab is backgrounded mid-XR
      fetch('/api/reels/diag', { method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
    } catch (e) {}

    // reset window accumulators
    _diagFrames = 0;
    _diagDtMin = Infinity; _diagDtMax = 0; _diagDtSum = 0; _diagOver20 = 0; _diagOver14 = 0;
    _diagTexUploads = 0;
    _diagUploadMaxMs = 0;
    _diagDrawMaxMs = 0;
  }

  // ─── WebGL Setup & Shaders ──────────────────────────────────────────

  /**
   * Multi-Side Concave Screen Shader
   * Curvature modes:
   *  1.0: Concave Hemisphere (3D Spherical Dome Cap - All sides wrap towards viewer from direct center)
   *  2.0: Concave Square (Biaxial Pillow Curve - Symmetrical horizontal & vertical amphitheater curve)
   *  0.0: Flat Screen
   */
  const VERT = `
    attribute vec3 aPos;
    attribute vec2 aUV;
    varying vec2 vUV;
    uniform mat4 uMVP;
    uniform float uCurvatureMode;

    const float ARC_ANGLE = 0.65;
    const float R = 1.5385; // 1.0 / ARC_ANGLE

    void main() {
      vUV = aUV;
      vec3 pos = aPos;

      if (uCurvatureMode > 0.5 && uCurvatureMode < 1.5) {
        // Mode 1: Concave Hemisphere (Radial Spherical Dome)
        // Direct center (0,0) is apex / focal center; all edges curve inward toward viewer (+Z)
        // Uses true arc length so screen dimension is identical to square & flat modes
        float r = length(aPos.xy);
        if (r > 0.0001) {
          float phi = r * ARC_ANGLE;
          float rProj = R * sin(phi);
          vec2 dir = aPos.xy / r;
          pos.xy = dir * rProj;
          pos.z = R * (1.0 - cos(phi));
        }
      } else if (uCurvatureMode > 1.5) {
        // Mode 2: Concave Square (Biaxial Pillow Curve)
        // All four sides curve inward while maintaining square boundary alignment
        float angX = aPos.x * ARC_ANGLE;
        float angY = aPos.y * ARC_ANGLE;
        pos.x = R * sin(angX);
        pos.y = R * sin(angY);
        pos.z = R * (1.0 - cos(angX) * cos(angY));
      }

      gl_Position = uMVP * vec4(pos, 1.0);
    }
  `;

  // WebGL2 (GLSL ES 3.00) variants — required because Quest's WebGL1 context
  // does NOT expose OES_texture_external and forbids texSubImage2D from a video,
  // so the zero-copy / in-place update paths need a WebGL2 context.
  const VERT_V2 = `
    #version 300 es
    in vec3 aPos;
    in vec2 aUV;
    out vec2 vUV;
    uniform mat4 uMVP;
    uniform float uCurvatureMode;

    const float ARC_ANGLE = 0.65;
    const float R = 1.5385; // 1.0 / ARC_ANGLE

    void main() {
      vUV = aUV;
      vec3 pos = aPos;

      if (uCurvatureMode > 0.5 && uCurvatureMode < 1.5) {
        float r = length(aPos.xy);
        if (r > 0.0001) {
          float phi = r * ARC_ANGLE;
          float rProj = R * sin(phi);
          vec2 dir = aPos.xy / r;
          pos.xy = dir * rProj;
          pos.z = R * (1.0 - cos(phi));
        }
      } else if (uCurvatureMode > 1.5) {
        float angX = aPos.x * ARC_ANGLE;
        float angY = aPos.y * ARC_ANGLE;
        pos.x = R * sin(angX);
        pos.y = R * sin(angY);
        pos.z = R * (1.0 - cos(angX) * cos(angY));
      }

      gl_Position = uMVP * vec4(pos, 1.0);
    }
  `;

  const FRAG = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform float uAlpha;
    uniform float uStereo;
    uniform float uEyeOff;
    void main() {
      vec2 uv = vUV;
      // SBS stereo: sample only this eye's half of the source frame
      if (uStereo > 0.5) {
        uv.x = uv.x * 0.5 + uEyeOff;
      }
      vec4 c = texture2D(uTex, uv);
      gl_FragColor = vec4(c.rgb, c.a * uAlpha);
    }
  `;

  const FRAG_V2 = `
    #version 300 es
    precision mediump float;
    in vec2 vUV;
    uniform sampler2D uTex;
    uniform float uAlpha;
    uniform float uStereo;
    uniform float uEyeOff;
    out vec4 fragColor;
    void main() {
      vec2 uv = vUV;
      // SBS stereo: sample only this eye's half of the source frame
      if (uStereo > 0.5) {
        uv.x = uv.x * 0.5 + uEyeOff;
      }
      vec4 c = texture(uTex, uv);
      fragColor = vec4(c.rgb, c.a * uAlpha);
    }
  `;

  // External-texture variant of FRAG for the zero-copy video screen. Same
  // geometry + SBS stereo math, but samples the decoder surface directly via
  // samplerExternalOES (TEXTURE_EXTERNAL_OES) — no texImage2D re-spec.
  const EXT_FRAG = `
    #extension GL_OES_EGL_image_external : require
    precision mediump float;
    precision mediump samplerExternalOES;
    varying vec2 vUV;
    uniform samplerExternalOES uTex;
    uniform float uAlpha;
    uniform float uStereo;
    uniform float uEyeOff;
    void main() {
      vec2 uv = vUV;
      // SBS stereo: sample only this eye's half of the source frame
      if (uStereo > 0.5) {
        uv.x = uv.x * 0.5 + uEyeOff;
      }
      vec4 c = texture2D(uTex, uv);
      gl_FragColor = vec4(c.rgb, c.a * uAlpha);
    }
  `;

  const EXT_FRAG_V2 = `
    #version 300 es
    #extension GL_OES_EGL_image_external : require
    precision mediump float;
    precision mediump samplerExternalOES;
    in vec2 vUV;
    uniform samplerExternalOES uTex;
    uniform float uAlpha;
    uniform float uStereo;
    uniform float uEyeOff;
    out vec4 fragColor;
    void main() {
      vec2 uv = vUV;
      // SBS stereo: sample only this eye's half of the source frame
      if (uStereo > 0.5) {
        uv.x = uv.x * 0.5 + uEyeOff;
      }
      vec4 c = texture(uTex, uv);
      fragColor = vec4(c.rgb, c.a * uAlpha);
    }
  `;

  /**
   * Celestial Starfield Shader with Organic Breathing Oscillation
   */
  const STAR_VERT = `
    attribute vec3 aPos;
    attribute vec3 aData; // x: size, y: phase, z: colorType
    uniform mat4 uVP;
    uniform vec3 uHeadPos;
    uniform float uTime;
    varying float vAlpha;
    varying vec3 vColor;

    void main() {
      // Starfield centered around current viewer head position so it feels at infinity
      vec3 worldPos = aPos + uHeadPos;
      gl_Position = uVP * vec4(worldPos, 1.0);
      
      // Multi-frequency breathing oscillation for natural, organic twinkle
      float breath = sin(uTime * 1.35 + aData.y) * 0.45 + sin(uTime * 0.65 + aData.y * 2.1) * 0.25;
      float curSize = aData.x * (1.0 + breath * 0.45);
      gl_PointSize = clamp(curSize, 1.5, 13.0);
      
      vAlpha = clamp(0.60 + breath * 0.45, 0.15, 1.0);
      
      if (aData.z < 0.5) {
        vColor = vec3(0.92, 0.96, 1.0); // Diamond white
      } else if (aData.z < 1.5) {
        vColor = vec3(0.40, 0.76, 1.0); // Celestial neon cyan/blue
      } else {
        vColor = vec3(1.0, 0.86, 0.68); // Warm stellar amber
      }
    }
  `;

  const STAR_FRAG = `
    precision mediump float;
    varying float vAlpha;
    varying vec3 vColor;

    void main() {
      vec2 coord = gl_PointCoord - vec2(0.5);
      float dist = length(coord);
      if (dist > 0.5) discard;
      float core = smoothstep(0.5, 0.05, dist);
      float glow = exp(-dist * 4.5);
      float finalAlpha = (core * 0.8 + glow * 0.4) * vAlpha;
      gl_FragColor = vec4(vColor, finalAlpha);
    }
  `;

  const STAR_VERT_V2 = `
    #version 300 es
    in vec3 aPos;
    in vec3 aData; // x: size, y: phase, z: colorType
    uniform mat4 uVP;
    uniform vec3 uHeadPos;
    uniform float uTime;
    out float vAlpha;
    out vec3 vColor;

    void main() {
      // Starfield centered around current viewer head position so it feels at infinity
      vec3 worldPos = aPos + uHeadPos;
      gl_Position = uVP * vec4(worldPos, 1.0);

      // Multi-frequency breathing oscillation for natural, organic twinkle
      float breath = sin(uTime * 1.35 + aData.y) * 0.45 + sin(uTime * 0.65 + aData.y * 2.1) * 0.25;
      float curSize = aData.x * (1.0 + breath * 0.45);
      gl_PointSize = clamp(curSize, 1.5, 13.0);

      vAlpha = clamp(0.60 + breath * 0.45, 0.15, 1.0);

      if (aData.z < 0.5) {
        vColor = vec3(0.92, 0.96, 1.0); // Diamond white
      } else if (aData.z < 1.5) {
        vColor = vec3(0.40, 0.76, 1.0); // Celestial neon cyan/blue
      } else {
        vColor = vec3(1.0, 0.86, 0.68); // Warm stellar amber
      }
    }
  `;

  const STAR_FRAG_V2 = `
    #version 300 es
    precision mediump float;
    in float vAlpha;
    in vec3 vColor;
    out vec4 fragColor;

    void main() {
      vec2 coord = gl_PointCoord - vec2(0.5);
      float dist = length(coord);
      if (dist > 0.5) discard;
      float core = smoothstep(0.5, 0.05, dist);
      float glow = exp(-dist * 4.5);
      float finalAlpha = (core * 0.8 + glow * 0.4) * vAlpha;
      fragColor = vec4(vColor, finalAlpha);
    }
  `;

  /**
   * Ambient Video Glow (Ambilight) Shader with Soft Radial Falloff matching multi-side curvature
   */
  const GLOW_VERT = `
    attribute vec3 aPos;
    attribute vec2 aUV;
    varying vec2 vUV;
    uniform mat4 uMVP;
    uniform float uCurvatureMode;

    const float ARC_ANGLE = 0.65;
    const float R = 1.5385;

    void main() {
      vUV = aUV;
      vec3 pos = aPos;

      if (uCurvatureMode > 0.5 && uCurvatureMode < 1.5) {
        float r = length(aPos.xy);
        if (r > 0.0001) {
          float phi = r * ARC_ANGLE;
          float rProj = R * sin(phi);
          vec2 dir = aPos.xy / r;
          pos.xy = dir * rProj;
          pos.z = R * (1.0 - cos(phi));
        }
      } else if (uCurvatureMode > 1.5) {
        float angX = aPos.x * ARC_ANGLE;
        float angY = aPos.y * ARC_ANGLE;
        pos.x = R * sin(angX);
        pos.y = R * sin(angY);
        pos.z = R * (1.0 - cos(angX) * cos(angY));
      }

      gl_Position = uMVP * vec4(pos, 1.0);
    }
  `;

  const GLOW_FRAG = `
    precision mediump float;
    varying vec2 vUV;
    uniform vec3 uColor;
    uniform float uIntensity;

    void main() {
      vec2 d = abs(vUV - 0.5) * 2.0;
      float edgeDist = length(max(vec2(0.0), d - vec2(0.68, 0.68)));
      float falloff = exp(-edgeDist * 3.8);
      float borderMask = (1.0 - smoothstep(0.85, 1.0, d.x)) * (1.0 - smoothstep(0.85, 1.0, d.y));
      float alpha = falloff * borderMask * uIntensity;
      gl_FragColor = vec4(uColor * 1.3, alpha);
    }
  `;

  const GLOW_VERT_V2 = `
    #version 300 es
    in vec3 aPos;
    in vec2 aUV;
    out vec2 vUV;
    uniform mat4 uMVP;
    uniform float uCurvatureMode;

    const float ARC_ANGLE = 0.65;
    const float R = 1.5385;

    void main() {
      vUV = aUV;
      vec3 pos = aPos;

      if (uCurvatureMode > 0.5 && uCurvatureMode < 1.5) {
        float r = length(aPos.xy);
        if (r > 0.0001) {
          float phi = r * ARC_ANGLE;
          float rProj = R * sin(phi);
          vec2 dir = aPos.xy / r;
          pos.xy = dir * rProj;
          pos.z = R * (1.0 - cos(phi));
        }
      } else if (uCurvatureMode > 1.5) {
        float angX = aPos.x * ARC_ANGLE;
        float angY = aPos.y * ARC_ANGLE;
        pos.x = R * sin(angX);
        pos.y = R * sin(angY);
        pos.z = R * (1.0 - cos(angX) * cos(angY));
      }

      gl_Position = uMVP * vec4(pos, 1.0);
    }
  `;

  const GLOW_FRAG_V2 = `
    #version 300 es
    precision mediump float;
    in vec2 vUV;
    uniform vec3 uColor;
    uniform float uIntensity;
    out vec4 fragColor;

    void main() {
      vec2 d = abs(vUV - 0.5) * 2.0;
      float edgeDist = length(max(vec2(0.0), d - vec2(0.68, 0.68)));
      float falloff = exp(-edgeDist * 3.8);
      float borderMask = (1.0 - smoothstep(0.85, 1.0, d.x)) * (1.0 - smoothstep(0.85, 1.0, d.y));
      float alpha = falloff * borderMask * uIntensity;
      fragColor = vec4(uColor * 1.3, alpha);
    }
  `;

  const EARTH_MARKER_VERT = `
    attribute vec3 aPos;
    attribute float aHeat;
    attribute float aState;
    uniform mat4 uMVP;
    varying float vHeat;
    varying float vState;

    void main() {
      vHeat = clamp(aHeat, 0.0, 1.0);
      vState = aState;
      gl_Position = uMVP * vec4(aPos, 1.0);
      gl_PointSize = 10.0 + vHeat * 18.0 + aState * 6.0;
    }
  `;

  const EARTH_MARKER_FRAG = `
    precision mediump float;
    varying float vHeat;
    varying float vState;

    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float radius = length(p);
      if (radius > 1.0) discard;
      vec3 cool = vec3(1.0, 0.72, 0.12);
      vec3 hot = vec3(1.0, 0.12, 0.03);
      vec3 color = mix(mix(cool, hot, vHeat), vec3(1.0), clamp(vState, 0.0, 1.0) * 0.7);
      float alpha = (1.0 - smoothstep(0.55, 1.0, radius)) * (0.68 + vHeat * 0.32);
      gl_FragColor = vec4(color, alpha);
    }
  `;

  const EARTH_MARKER_VERT_V2 = `
    #version 300 es
    in vec3 aPos;
    in float aHeat;
    in float aState;
    uniform mat4 uMVP;
    out float vHeat;
    out float vState;

    void main() {
      vHeat = clamp(aHeat, 0.0, 1.0);
      vState = aState;
      gl_Position = uMVP * vec4(aPos, 1.0);
      gl_PointSize = 10.0 + vHeat * 18.0 + aState * 6.0;
    }
  `;

  const EARTH_MARKER_FRAG_V2 = `
    #version 300 es
    precision mediump float;
    in float vHeat;
    in float vState;
    out vec4 fragColor;

    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float radius = length(p);
      if (radius > 1.0) discard;
      vec3 cool = vec3(1.0, 0.72, 0.12);
      vec3 hot = vec3(1.0, 0.12, 0.03);
      vec3 color = mix(mix(cool, hot, vHeat), vec3(1.0), clamp(vState, 0.0, 1.0) * 0.7);
      float alpha = (1.0 - smoothstep(0.55, 1.0, radius)) * (0.68 + vHeat * 0.32);
      fragColor = vec4(color, alpha);
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

  function initStarfield() {
    const data = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      // Random spherical distribution
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 40.0 + Math.random() * 35.0; // 40m - 75m distance

      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);

      const size = 2.5 + Math.random() * 4.5;
      const phase = Math.random() * Math.PI * 2;
      const colorType = Math.random() < 0.6 ? 0.0 : (Math.random() < 0.5 ? 1.0 : 2.0);

      data.push(x, y, z, size, phase, colorType);
    }
    glStarBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glStarBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  }

  function initAmbilight() {
    ambilightCanvas = document.createElement('canvas');
    ambilightCanvas.width = 8;
    ambilightCanvas.height = 8;
    ambilightCtx = ambilightCanvas.getContext('2d', { willReadFrequently: true });
  }

  function updateAmbilightColor(now) {
    if (!videoElement || videoElement.readyState < 2 || videoElement.paused) return;
    // In-XR the drawImage+getImageData readback below runs ON the XR thread and
    // forces a CPU sync against the playing decoder (typically 10-20ms — a
    // missed vsync at 72Hz that never trips the >20ms tripwire, i.e. invisible
    // flashing). Sample at 1Hz in XR; the per-frame lerp toward the target
    // keeps the glow transition smooth. 2D keeps 80ms.
    const interval = xrSession ? 1000 : 80;
    if (now - lastColorSampleTime < interval) return; // Sample at ~12 FPS
    lastColorSampleTime = now;

    try {
      ambilightCtx.drawImage(videoElement, 0, 0, 8, 8);
      const imgData = ambilightCtx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0;
      const count = 64;
      for (let i = 0; i < imgData.length; i += 4) {
        r += imgData[i];
        g += imgData[i + 1];
        b += imgData[i + 2];
      }
      r = (r / count) / 255.0;
      g = (g / count) / 255.0;
      b = (b / count) / 255.0;

      // Enhance vibrant ambient glow tone while preserving dark blue cosmos vibe
      targetGlowColor = [
        Math.min(1.0, r * 1.35 + 0.03),
        Math.min(1.0, g * 1.35 + 0.05),
        Math.min(1.0, b * 1.45 + 0.09)
      ];
    } catch (e) {
      // Ignore security errors if cross-origin
    }
  }

  function initGL(session, suppliedCanvas) {
    const isXR = !!session;
    // WebGL2 first: the Quest WebGL1 context does NOT expose OES_texture_external
    // and forbids texSubImage2D from a video source — both needed for the
    // zero-copy / in-place update paths. Falls back to WebGL1 + GLSL ES 1.00
    // (non-Quest devices / contexts the XR layer rejects) which keeps today's
    // texImage2D behavior. Each candidate uses a FRESH canvas (a canvas can only
    // ever bind one context type), and XRWebGLLayer construction is guarded so a
    // rejection here returns false instead of throwing → enterVR ends the session.
    let isGL2 = false;
    let contextOk = false;
    let layerOk = !isXR;
    // Quest Browser: WebGL1 XR layers work, WebGL2 XR layers do not register a
    // compositor client → auto-exit. Prefer WebGL1; WebGL2 only when forced.
    const GL_TRY = isXR
      ? (VR_GL_MODE === '2' ? [['webgl2', true]]
        : VR_GL_MODE === '1' ? [['webgl', false]]
        : [['webgl', false], ['webgl2', true]])
      : [['webgl2', true], ['webgl', false]];
    for (const [ctxt, is2] of GL_TRY) {
      const canvas = suppliedCanvas || document.createElement('canvas');
      let candidate = null;
      try {
        candidate = canvas.getContext(ctxt, { xrCompatible: isXR, alpha: false, antialias: true });
      } catch (error) {
        if (isXR) window.__xrErr = 'getContext ' + ctxt + ' threw: ' + String(error);
      }
      if (!candidate) continue;
      if (isXR) {
        try {
          const layer = new XRWebGLLayer(session, candidate);
          if (!layer) continue;
          glLayer = layer;
          layerOk = true;
        } catch (error) {
          console.warn('[WebXRVR] XRWebGLLayer rejected ' + ctxt + ' context:', error);
          window.__xrErr = 'XRWebGLLayer rejected ' + ctxt + ': ' + String(error);
          continue;
        }
      }
      gl = candidate;
      isGL2 = is2;
      contextOk = true;
      break;
    }
    if (!contextOk || !layerOk) {
      console.error('[WebXRVR] No compatible ' + (isXR ? 'XR ' : '') + 'WebGL context');
      if (isXR) window.__xrErr = 'no compatible XR WebGL context (tried: ' + GL_TRY.map(x => x[0]).join(',') + ')';
      return false;
    }
    glIsWebGL2 = isGL2;
    videoTexMode = '2d';
    if (isXR) {
      window.__xrGL = (isGL2 ? 'webgl2' : 'webgl1') + ':' + (isGL2 ? 'glsl300' : 'glsl100');
      session.updateRenderState({ baseLayer: glLayer });
      if (typeof session.updateTargetFrameRate === 'function') {
        try { session.updateTargetFrameRate(72); } catch (e) { /* optional API */ }
      }
    }
    console.log('[WebXRVR] GL context:', (isGL2 ? 'WebGL 2.0' : 'WebGL 1.0') + (isXR ? ' XR' : ' preview'));

    // GLSL ES 3.00 shaders for WebGL2, GLSL ES 1.00 for the WebGL1 fallback.
    const VS = isGL2 ? VERT_V2 : VERT;
    const FS = isGL2 ? FRAG_V2 : FRAG;
    const EXTF = isGL2 ? EXT_FRAG_V2 : EXT_FRAG;
    const STARV = isGL2 ? STAR_VERT_V2 : STAR_VERT;
    const STARF = isGL2 ? STAR_FRAG_V2 : STAR_FRAG;
    const GLOWV = isGL2 ? GLOW_VERT_V2 : GLOW_VERT;
    const GLOWF = isGL2 ? GLOW_FRAG_V2 : GLOW_FRAG;

    // Main Program
    const vs = compileShader(gl.VERTEX_SHADER, VS);
    const fs = compileShader(gl.FRAGMENT_SHADER, FS);
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
    loc_uCurvatureMode = gl.getUniformLocation(glProgram, 'uCurvatureMode');
    loc_uStereo = gl.getUniformLocation(glProgram, 'uStereo');
    loc_uEyeOff = gl.getUniformLocation(glProgram, 'uEyeOff');

    // Video texture path selection. Priority:
    //  1) external — OES_texture_external (zero-copy decoder-surface bind).
    //     Re-binding each decoded frame does NOT re-specify the texture, so the
    //     ~100ms GPU pipeline flush that caused ~22fps never fires.
    //  2) subimage — WebGL2 only: allocate the 4K texture once, then
    //     texSubImage2D in place per decoded frame (also avoids the re-spec).
    //     WebGL1 forbids uploading video via texSubImage2D, hence path 3 there.
    //  3) 2d — original texImage2D per frame (fallback, no gain expected).
    let extOES = null;
    if (isXR && VR_TEX_MODE !== '2d') {
      try { extOES = gl.getExtension('OES_texture_external'); } catch (e) {}
    }
    if (extOES) {
      const extVs = compileShader(gl.VERTEX_SHADER, VS);
      const extFs = compileShader(gl.FRAGMENT_SHADER, EXTF);
      glVideoProgram = gl.createProgram();
      gl.attachShader(glVideoProgram, extVs);
      gl.attachShader(glVideoProgram, extFs);
      gl.linkProgram(glVideoProgram);

      if (gl.getProgramParameter(glVideoProgram, gl.LINK_STATUS)) {
        loc2_aPos = gl.getAttribLocation(glVideoProgram, 'aPos');
        loc2_aUV = gl.getAttribLocation(glVideoProgram, 'aUV');
        loc2_uMVP = gl.getUniformLocation(glVideoProgram, 'uMVP');
        loc2_uTex = gl.getUniformLocation(glVideoProgram, 'uTex');
        loc2_uAlpha = gl.getUniformLocation(glVideoProgram, 'uAlpha');
        loc2_uCurvatureMode = gl.getUniformLocation(glVideoProgram, 'uCurvatureMode');
        loc2_uStereo = gl.getUniformLocation(glVideoProgram, 'uStereo');
        loc2_uEyeOff = gl.getUniformLocation(glVideoProgram, 'uEyeOff');
        videoTexMode = 'external';
        if (isXR) window.__xrGL += ':external';
        console.log('[WebXRVR] OES_texture_external armed — zero-copy video path active');
      } else {
        console.error('[WebXRVR] External shader link error:', gl.getProgramInfoLog(glVideoProgram));
        glVideoProgram = null;
      }
    } else if (isGL2) {
      videoTexMode = 'subimage';
      if (isXR) window.__xrGL += ':subimage';
      console.log('[WebXRVR] OES_texture_external unavailable — WebGL2 in-place texSubImage2D path armed');
    } else {
      if (isXR) window.__xrGL += ':2d';
      console.log('[WebXRVR] OES_texture_external unavailable on WebGL1 — using per-frame texImage2D');
    }

    // Starfield Program
    const starVs = compileShader(gl.VERTEX_SHADER, STARV);
    const starFs = compileShader(gl.FRAGMENT_SHADER, STARF);
    glStarProgram = gl.createProgram();
    gl.attachShader(glStarProgram, starVs);
    gl.attachShader(glStarProgram, starFs);
    gl.linkProgram(glStarProgram);

    loc_star_aPos = gl.getAttribLocation(glStarProgram, 'aPos');
    loc_star_aData = gl.getAttribLocation(glStarProgram, 'aData');
    loc_star_uVP = gl.getUniformLocation(glStarProgram, 'uVP');
    loc_star_uHeadPos = gl.getUniformLocation(glStarProgram, 'uHeadPos');
    loc_star_uTime = gl.getUniformLocation(glStarProgram, 'uTime');

    // Ambient Glow Program
    const glowVs = compileShader(gl.VERTEX_SHADER, GLOWV);
    const glowFs = compileShader(gl.FRAGMENT_SHADER, GLOWF);
    glGlowProgram = gl.createProgram();
    gl.attachShader(glGlowProgram, glowVs);
    gl.attachShader(glGlowProgram, glowFs);
    gl.linkProgram(glGlowProgram);

    loc_glow_aPos = gl.getAttribLocation(glGlowProgram, 'aPos');
    loc_glow_aUV = gl.getAttribLocation(glGlowProgram, 'aUV');
    loc_glow_uMVP = gl.getUniformLocation(glGlowProgram, 'uMVP');
    loc_glow_uCurvatureMode = gl.getUniformLocation(glGlowProgram, 'uCurvatureMode');
    loc_glow_uColor = gl.getUniformLocation(glGlowProgram, 'uColor');
    loc_glow_uIntensity = gl.getUniformLocation(glGlowProgram, 'uIntensity');

    // Generate 2D Multi-Side Curvature Mesh Grid (32x32 Quads)
    const COLS = 32;
    const ROWS = 32;
    const verts = [];
    const indices = [];

    for (let r = 0; r <= ROWS; r++) {
      const v = r / ROWS;
      const y = 0.5 - v;
      for (let c = 0; c <= COLS; c++) {
        const u = c / COLS;
        const x = u - 0.5;
        verts.push(x, y, 0.0, u, v);
      }
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i0 = r * (COLS + 1) + c;
        const i1 = i0 + 1;
        const i2 = (r + 1) * (COLS + 1) + c;
        const i3 = i2 + 1;
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }

    glGridIndexCount = indices.length;
    glGridBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glGridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

    glGridIndexBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glGridIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    glLaserBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glLaserBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(10), gl.DYNAMIC_DRAW);

    glVideoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    // Double-buffer back texture: the 2d path re-specifies via texImage2D, and
    // re-specifying the texture currently sampled by in-flight draws stalls
    // ~24ms (1280²) / ~100ms (4K). Uploading into the UNSAMPLED back texture
    // then flipping avoids the pipeline bubble. (~13MB extra at 1280².)
    glVideoTextureB = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glVideoTextureB);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    if (videoTexMode === 'external') {
      glVideoTextureExt = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_EXTERNAL_OES, glVideoTextureExt);
      gl.texParameteri(gl.TEXTURE_EXTERNAL_OES, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_EXTERNAL_OES, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_EXTERNAL_OES, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_EXTERNAL_OES, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    glControlsTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    glGuideTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glGuideTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    glOverlayTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glOverlayTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    glCommentsTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glCommentsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    initReticleTexture();
    initStarfield();
    initAmbilight();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    console.log('[WebXRVR] WebGL initialised OK with Celestial Cosmos & Dynamic Ambilight Glow');
    return true;
  }

  function initEarthResources() {
    if (!gl || earthResourcesReady) return earthResourcesReady;

    const markerVs = compileShader(gl.VERTEX_SHADER, glIsWebGL2 ? EARTH_MARKER_VERT_V2 : EARTH_MARKER_VERT);
    const markerFs = compileShader(gl.FRAGMENT_SHADER, glIsWebGL2 ? EARTH_MARKER_FRAG_V2 : EARTH_MARKER_FRAG);
    glEarthMarkerProgram = gl.createProgram();
    gl.attachShader(glEarthMarkerProgram, markerVs);
    gl.attachShader(glEarthMarkerProgram, markerFs);
    gl.linkProgram(glEarthMarkerProgram);
    if (!gl.getProgramParameter(glEarthMarkerProgram, gl.LINK_STATUS)) {
      console.error('[WebXRVR] Earth marker program link error:', gl.getProgramInfoLog(glEarthMarkerProgram));
      glEarthMarkerProgram = null;
      return false;
    }
    loc_earthMarker_aPos = gl.getAttribLocation(glEarthMarkerProgram, 'aPos');
    loc_earthMarker_aHeat = gl.getAttribLocation(glEarthMarkerProgram, 'aHeat');
    loc_earthMarker_aState = gl.getAttribLocation(glEarthMarkerProgram, 'aState');
    loc_earthMarker_uMVP = gl.getUniformLocation(glEarthMarkerProgram, 'uMVP');

    const sphereVerts = [];
    const sphereIndices = [];
    const latSegments = 24;
    const lonSegments = 48;
    for (let row = 0; row <= latSegments; row++) {
      const v = row / latSegments;
      const lat = Math.PI * 0.5 - v * Math.PI;
      const cosLat = Math.cos(lat);
      for (let col = 0; col <= lonSegments; col++) {
        const u = col / lonSegments;
        const lon = u * Math.PI * 2 - Math.PI;
        sphereVerts.push(
          EARTH_RADIUS * cosLat * Math.sin(lon),
          EARTH_RADIUS * Math.sin(lat),
          EARTH_RADIUS * cosLat * Math.cos(lon),
          u,
          v
        );
      }
    }
    for (let row = 0; row < latSegments; row++) {
      for (let col = 0; col < lonSegments; col++) {
        const a = row * (lonSegments + 1) + col;
        const b = a + lonSegments + 1;
        sphereIndices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    glEarthSphereBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glEarthSphereBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sphereVerts), gl.STATIC_DRAW);
    glEarthSphereIndexBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glEarthSphereIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(sphereIndices), gl.STATIC_DRAW);
    glEarthSphereIndexCount = sphereIndices.length;

    const rimVerts = [];
    const rimIndices = [];
    const rimSegments = 64;
    const rimInner = EARTH_RADIUS * 0.94;
    const rimOuter = EARTH_RADIUS * 1.30;
    const rimTop = -EARTH_RADIUS * 0.10;
    const rimBottom = -EARTH_RADIUS * 0.72;
    function appendRimRing(radius, y) {
      const start = rimVerts.length / 5;
      for (let i = 0; i <= rimSegments; i++) {
        const a = i / rimSegments * Math.PI * 2;
        rimVerts.push(Math.sin(a) * radius, y, Math.cos(a) * radius, i / rimSegments, y === rimTop ? 0 : 1);
      }
      return start;
    }
    function appendRimStrip(first, second) {
      for (let i = 0; i < rimSegments; i++) {
        const a = first + i;
        const b = second + i;
        rimIndices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const topInner = appendRimRing(rimInner, rimTop);
    const topOuter = appendRimRing(rimOuter, rimTop);
    const bottomOuter = appendRimRing(rimOuter, rimBottom);
    const bottomInner = appendRimRing(rimInner, rimBottom);
    appendRimStrip(topInner, topOuter);
    appendRimStrip(topOuter, bottomOuter);
    appendRimStrip(bottomInner, topInner);
    appendRimStrip(bottomOuter, bottomInner);
    glEarthRimBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glEarthRimBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(rimVerts), gl.STATIC_DRAW);
    glEarthRimIndexBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glEarthRimIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(rimIndices), gl.STATIC_DRAW);
    glEarthRimIndexCount = rimIndices.length;

    glEarthMarkerBuf = gl.createBuffer();

    glEarthTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glEarthTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([17, 62, 92, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const rimCanvas = document.createElement('canvas');
    rimCanvas.width = 64;
    rimCanvas.height = 64;
    const rimCtx = rimCanvas.getContext('2d');
    const rimGradient = rimCtx.createRadialGradient(32, 32, 5, 32, 32, 32);
    rimGradient.addColorStop(0, '#25334a');
    rimGradient.addColorStop(0.62, '#101a2c');
    rimGradient.addColorStop(1, '#050914');
    rimCtx.fillStyle = rimGradient;
    rimCtx.fillRect(0, 0, 64, 64);
    glEarthRimTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glEarthRimTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rimCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    earthLabelCanvas = document.createElement('canvas');
    earthLabelCanvas.width = 640;
    earthLabelCanvas.height = 112;
    earthLabelCtx = earthLabelCanvas.getContext('2d');
    glEarthLabelTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glEarthLabelTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    earthResourcesReady = true;
    uploadEarthMarkers();
    renderEarthLabelCanvas();

    const context = gl;
    const texture = glEarthTexture;
    const image = new Image();
    image.decoding = 'async';
    image.onload = function () {
      if (gl !== context || glEarthTexture !== texture) return;
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, image);
      earthTextureReady = true;
    };
    image.onerror = function () {
      console.warn('[WebXRVR] Bundled Earth texture could not be loaded:', EARTH_TEXTURE_URL);
      setEarthStatus('MAP TEXTURE UNAVAILABLE');
    };
    image.src = EARTH_TEXTURE_URL;
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

  function mat4Perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, (2 * far * near) * nf, 0,
    ]);
  }

  function vecDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function vecCross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  function mat4LookAt(eye, target, up) {
    const z = vecNorm(vecSub(eye, target));
    const x = vecNorm(vecCross(up, z));
    const y = vecCross(z, x);
    return new Float32Array([
      x.x, y.x, z.x, 0,
      x.y, y.y, z.y, 0,
      x.z, y.z, z.z, 0,
      -vecDot(x, eye), -vecDot(y, eye), -vecDot(z, eye), 1,
    ]);
  }

  function quatFromYawPitch(yaw, pitch) {
    const yawQ = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    const pitchQ = { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) };
    return quatMul(yawQ, pitchQ);
  }

  function quatFromForward(direction) {
    const forward = vecNorm(direction);
    const yaw = Math.atan2(-forward.x, -forward.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
    return quatFromYawPitch(yaw, pitch);
  }

  function previewSceneTarget() {
    return sceneMode === 'earth' ? earthCenter : screenPos;
  }

  function getPreviewCamera() {
    if (previewCameraMode === 'orbit') {
      const target = previewSceneTarget();
      const cosPitch = Math.cos(previewOrbitPitch);
      const position = {
        x: target.x + Math.sin(previewOrbitYaw) * cosPitch * previewOrbitDistance,
        y: target.y + Math.sin(previewOrbitPitch) * previewOrbitDistance,
        z: target.z + Math.cos(previewOrbitYaw) * cosPitch * previewOrbitDistance,
      };
      const forward = vecNorm(vecSub(target, position));
      return { position, quat: quatFromForward(forward), target };
    }
    const position = { x: 0, y: 1.52, z: 0 };
    const quat = quatFromYawPitch(previewYaw, previewPitch);
    return {
      position,
      quat,
      target: vecAdd(position, quatRotVec(quat, { x: 0, y: 0, z: -1 })),
    };
  }

  function previewRayAt(clientX, clientY) {
    if (!previewCanvas) return null;
    const rect = previewCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    let localX = clientX - rect.left;
    let viewWidth = rect.width;
    if (previewStereo) {
      viewWidth *= 0.5;
      localX = localX >= viewWidth ? localX - viewWidth : localX;
    }
    const nx = (localX / viewWidth) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const camera = getPreviewCamera();
    const forward = quatRotVec(camera.quat, { x: 0, y: 0, z: -1 });
    const right = quatRotVec(camera.quat, { x: 1, y: 0, z: 0 });
    const up = quatRotVec(camera.quat, { x: 0, y: 1, z: 0 });
    const aspect = viewWidth / rect.height;
    const tanHalf = Math.tan(65 * Math.PI / 360);
    const direction = vecNorm(vecAdd(forward, vecAdd(vecScale(right, nx * aspect * tanHalf), vecScale(up, ny * tanHalf))));
    return { origin: camera.position, direction };
  }

  function getPreviewState() {
    return {
      running: previewRunning,
      cameraMode: previewCameraMode,
      stereo: previewStereo,
      reducedMotion,
      sceneMode,
      renderStats: { ...renderStats },
      views: previewLastViews.slice(),
    };
  }

  function emitPreviewState() {
    try {
      window.dispatchEvent(new CustomEvent('echo:webxr-preview-state', { detail: getPreviewState() }));
    } catch (e) {}
  }

  function resizePreviewCanvas() {
    if (!previewCanvas || !gl) return false;
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(2, Math.round((previewCanvas.clientWidth || 1) * ratio));
    const height = Math.max(2, Math.round((previewCanvas.clientHeight || 1) * ratio));
    if (previewCanvas.width === width && previewCanvas.height === height) return false;
    previewCanvas.width = width;
    previewCanvas.height = height;
    return true;
  }

  function uploadPreviewTextures(time) {
    let hasOverlayComments = false;
    if (sceneMode === 'earth') {
      advanceEarthSpin(time);
      initEarthResources();
      renderEarthLabelCanvas();
    } else {
      updateAmbilightColor(time);
      curGlowColor[0] += (targetGlowColor[0] - curGlowColor[0]) * 0.08;
      curGlowColor[1] += (targetGlowColor[1] - curGlowColor[1]) * 0.08;
      curGlowColor[2] += (targetGlowColor[2] - curGlowColor[2]) * 0.08;

      if (videoElement && videoElement.readyState >= 2 &&
          (hasNewVideoFrame || videoElement.currentTime !== lastVideoTime)) {
        gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
        if (videoTexMode === 'subimage' && videoTexAllocated) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
        } else if (glVideoTextureB && videoTexMode === '2d') {
          const backTex = videoTexFront === 0 ? glVideoTextureB : glVideoTexture;
          gl.bindTexture(gl.TEXTURE_2D, backTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
          videoTexFront = videoTexFront === 0 ? 1 : 0;
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
          videoTexAllocated = true;
        }
        hasNewVideoFrame = false;
        lastVideoTime = videoElement.currentTime;
        renderStats.videoUploads += 1;
      }

      hasOverlayComments = commentsPanelVisible ? false : renderOverlayCanvas();
      if (hasOverlayComments && glOverlayTexture && overlayCanvas) {
        gl.bindTexture(gl.TEXTURE_2D, glOverlayTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlayCanvas);
      }
      if (commentsPanelVisible && commentsPanelCanvas && glCommentsTexture &&
          (vrLastPanelUploadT < 0 || time - vrLastPanelUploadT >= VR_UI_MIN_INTERVAL)) {
        vrLastPanelUploadT = time;
        renderCommentsPanelCanvas();
        gl.bindTexture(gl.TEXTURE_2D, glCommentsTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, commentsPanelCanvas);
      }
    }

    if (controlsVisible && glControlsTexture &&
        (vrLastUiUploadT < 0 || time - vrLastUiUploadT >= VR_UI_MIN_INTERVAL)) {
      vrLastUiUploadT = time;
      renderControlsCanvas();
      gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, controlsCanvas);
    }
    if (sceneMode === 'reels' && controlsVisible && guideCanvas && glGuideTexture && !vrGuideUploaded) {
      renderGuideCanvas();
      gl.bindTexture(gl.TEXTURE_2D, glGuideTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, guideCanvas);
      vrGuideUploaded = true;
    }
    return hasOverlayComments;
  }

  function onPreviewFrame(time) {
    if (!previewRunning || !previewCanvas || !gl) return;
    previewRaf = window.requestAnimationFrame(onPreviewFrame);
    resizePreviewCanvas();

    const camera = getPreviewCamera();
    currentHeadPos = { ...camera.position };
    currentHeadQuat = { ...camera.quat };
    if (sceneMode === 'reels' && previewCameraMode === 'headset') applyLockToViewer();

    const hasOverlayComments = uploadPreviewTextures(time);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.0095, 0.0175, 0.052, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const width = previewCanvas.width;
    const height = previewCanvas.height;
    const viewWidth = previewStereo ? Math.floor(width / 2) : width;
    const forward = quatRotVec(camera.quat, { x: 0, y: 0, z: -1 });
    const right = quatRotVec(camera.quat, { x: 1, y: 0, z: 0 });
    const up = quatRotVec(camera.quat, { x: 0, y: 1, z: 0 });
    const eyes = previewStereo
      ? [{ eye: 'left', offset: -0.032, x: 0 }, { eye: 'right', offset: 0.032, x: viewWidth }]
      : [{ eye: 'none', offset: 0, x: 0 }];
    const projection = mat4Perspective(65 * Math.PI / 180, viewWidth / Math.max(1, height), 0.05, 100);
    previewLastViews = [];
    for (const view of eyes) {
      const eyePos = vecAdd(camera.position, vecScale(right, view.offset));
      const viewMat = mat4LookAt(eyePos, vecAdd(eyePos, forward), up);
      gl.viewport(view.x, 0, viewWidth, height);
      renderSceneView(viewMat, projection, view.eye, time * 0.001, hasOverlayComments);
      previewLastViews.push({ eye: view.eye, viewport: [view.x, 0, viewWidth, height] });
    }
  }

  function updatePreviewPointer(clientX, clientY) {
    const ray = previewRayAt(clientX, clientY);
    if (!ray) return null;
    activeRayOrigin = ray.origin;
    activeRayDir = ray.direction;
    hoveredButton = controlsVisible ? hitTestControls(ray.origin, ray.direction) : -1;
    let hit = null;
    if (hoveredButton >= 0) {
      activeHitDist = getHitDistControls(ray.origin, ray.direction);
      activeIsHovering = true;
    } else if (sceneMode === 'earth') {
      hit = hitTestEarth(ray.origin, ray.direction);
      activeHitDist = hit.hit ? hit.dist : 3;
      activeIsHovering = !!hit.hit;
      setEarthHoveredIndex(hit.hit ? hit.markerIndex : -1);
    } else {
      hit = hitTestCurvedScreen(ray.origin, ray.direction);
      activeHitDist = hit.hit ? hit.dist : 3;
      activeIsHovering = !!hit.hit;
    }
    return { ray, hit, controlIndex: hoveredButton };
  }

  function installPreviewListeners() {
    if (!previewCanvas || previewListeners) return;
    const onPointerDown = function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      previewCanvas.focus();
      try { previewCanvas.setPointerCapture(event.pointerId); } catch (e) {}
      const target = updatePreviewPointer(event.clientX, event.clientY);
      const source = 'preview-pointer-' + event.pointerId;
      previewPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, source };
      if (target && target.controlIndex >= 0) {
        executeControlButton(target.controlIndex);
        previewPointer.control = true;
        return;
      }
      if (sceneMode === 'earth' && target) {
        previewPointer.earth = beginEarthDrag(source, target.hit);
      }
    };
    const onPointerMove = function (event) {
      const target = updatePreviewPointer(event.clientX, event.clientY);
      if (!previewPointer || previewPointer.id !== event.pointerId) return;
      const dx = event.clientX - previewPointer.x;
      const dy = event.clientY - previewPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) previewPointer.moved = true;
      previewPointer.x = event.clientX;
      previewPointer.y = event.clientY;
      if (previewPointer.control) return;
      if (sceneMode === 'earth') {
        if (previewPointer.earth && target && target.hit && target.hit.hit) updateEarthDrag(target.hit.local);
        return;
      }
      const sensitivity = 0.006;
      if (previewCameraMode === 'orbit') {
        previewOrbitYaw -= dx * sensitivity;
        previewOrbitPitch = Math.max(-1.35, Math.min(1.35, previewOrbitPitch + dy * sensitivity));
      } else {
        previewYaw -= dx * sensitivity;
        previewPitch = Math.max(-1.35, Math.min(1.35, previewPitch - dy * sensitivity));
      }
    };
    const finishPointer = function (event) {
      if (!previewPointer || previewPointer.id !== event.pointerId) return;
      const target = updatePreviewPointer(event.clientX, event.clientY);
      if (sceneMode === 'earth' && previewPointer.earth) {
        endEarthDrag(previewPointer.source, target && target.hit);
      } else if (!previewPointer.control && !previewPointer.moved && target) {
        if (target.hit && target.hit.hit) callbacks.onTogglePlay && callbacks.onTogglePlay();
        else toggleControls();
      }
      try { previewCanvas.releasePointerCapture(event.pointerId); } catch (e) {}
      previewPointer = null;
    };
    const onWheel = function (event) {
      event.preventDefault();
      if (sceneMode === 'earth') {
        rotateEarth(event.deltaX * 0.0025, event.deltaY * 0.0018);
        earthInteractionUntil = performance.now() + 900;
      } else if (previewCameraMode === 'orbit') {
        previewOrbitDistance = Math.max(1.2, Math.min(12, previewOrbitDistance + event.deltaY * 0.006));
      }
    };
    const onContextMenu = function (event) { event.preventDefault(); };
    const onResize = function () { resizePreviewCanvas(); };
    previewListeners = { onPointerDown, onPointerMove, finishPointer, onWheel, onContextMenu, onResize };
    previewCanvas.style.touchAction = 'none';
    previewCanvas.addEventListener('pointerdown', onPointerDown);
    previewCanvas.addEventListener('pointermove', onPointerMove);
    previewCanvas.addEventListener('pointerup', finishPointer);
    previewCanvas.addEventListener('pointercancel', finishPointer);
    previewCanvas.addEventListener('wheel', onWheel, { passive: false });
    previewCanvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('resize', onResize);
  }

  function removePreviewListeners() {
    if (!previewCanvas || !previewListeners) return;
    const listeners = previewListeners;
    previewCanvas.removeEventListener('pointerdown', listeners.onPointerDown);
    previewCanvas.removeEventListener('pointermove', listeners.onPointerMove);
    previewCanvas.removeEventListener('pointerup', listeners.finishPointer);
    previewCanvas.removeEventListener('pointercancel', listeners.finishPointer);
    previewCanvas.removeEventListener('wheel', listeners.onWheel);
    previewCanvas.removeEventListener('contextmenu', listeners.onContextMenu);
    window.removeEventListener('resize', listeners.onResize);
    previewListeners = null;
  }

  function resetPreview() {
    previewYaw = 0;
    previewPitch = 0;
    previewOrbitYaw = 0;
    previewOrbitPitch = -0.08;
    previewOrbitDistance = 4.8;
    earthYaw = -0.35;
    earthPitch = -0.12;
    screenPos = { ...DEFAULT_POS };
    screenQuat = { x: 0, y: 0, z: 0, w: 1 };
    screenScale = DEFAULT_SCALE;
    currentHeadPos = { x: 0, y: 1.52, z: 0 };
    currentHeadQuat = { x: 0, y: 0, z: 0, w: 1 };
    if (sceneMode === 'earth') anchorEarthFromHead();
    emitPreviewState();
  }

  function setPreviewCameraMode(mode) {
    previewCameraMode = mode === 'orbit' ? 'orbit' : 'headset';
    lockToViewer = previewCameraMode === 'headset';
    if (lockToViewer) applyLockToViewer();
    emitPreviewState();
    return previewCameraMode;
  }

  function setPreviewStereo(enabled) {
    previewStereo = !!enabled;
    emitPreviewState();
    return previewStereo;
  }

  function setReducedMotion(enabled) {
    reducedMotion = !!enabled;
    emitPreviewState();
    return reducedMotion;
  }

  function setSceneMode(mode) {
    const next = mode === 'earth' ? 'earth' : 'reels';
    if (next === sceneMode) return sceneMode;
    if (next === 'earth') openEarthMode();
    else closeEarthMode();
    emitPreviewState();
    return sceneMode;
  }

  async function requestPreviewFullscreen(target) {
    const element = target || (previewCanvas && previewCanvas.parentElement) || previewCanvas;
    if (!element) return false;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (element.requestFullscreen) await element.requestFullscreen();
      else if (element.webkitRequestFullscreen) element.webkitRequestFullscreen();
      return true;
    } catch (error) {
      console.warn('[WebXRVR] Preview fullscreen request failed:', error);
      return false;
    }
  }

  function startPreview(canvas, options) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('A canvas element is required for immersive preview.');
    }
    if (xrSession) throw new Error('Exit the immersive XR session before starting desktop preview.');
    if (previewRunning || gl) stopPreview();
    const opts = options || {};
    previewCanvas = canvas;
    previewRunning = true;
    previewCameraMode = opts.cameraMode === 'orbit' ? 'orbit' : 'headset';
    previewStereo = !!opts.stereo;
    if (typeof opts.reducedMotion === 'boolean') reducedMotion = opts.reducedMotion;
    sceneMode = 'reels';
    lockToViewer = previewCameraMode === 'headset';
    controlsVisible = opts.showControls !== false;
    renderStats.earthDrawCalls = 0;
    renderStats.reelDrawCalls = 0;
    renderStats.videoUploads = 0;
    resetPreview();
    initControlsCanvas();
    initOverlayCanvas();
    initCommentsPanelCanvas();
    if (!initGL(null, canvas)) {
      cleanup({ preview: true });
      previewCanvas = null;
      throw new Error('WebGL is unavailable for immersive preview.');
    }
    initGuideCanvas();
    setupVideoFrameTracking();
    if (videoElement) {
      videoElement.addEventListener('pause', onVideoPause);
      videoElement.addEventListener('play', onVideoPlay);
    }
    installPreviewListeners();
    resizePreviewCanvas();
    if (opts.sceneMode === 'earth') openEarthMode();
    previewRaf = window.requestAnimationFrame(onPreviewFrame);
    emitPreviewState();
    return getPreviewState();
  }

  function stopPreview() {
    if (!previewRunning && !previewCanvas) return;
    previewRunning = false;
    if (previewRaf) window.cancelAnimationFrame(previewRaf);
    previewRaf = 0;
    removePreviewListeners();
    cleanup({ preview: true });
    previewCanvas = null;
    previewPointer = null;
    previewLastViews = [];
    emitPreviewState();
  }


  // ─── Draw Mesh Grid ──────────────────────────────────────────────────

  function drawGrid(viewMat, projMat, texture, pos, quat, scaleW, scaleH, alpha, curveMode, eyeOff) {
    gl.useProgram(glProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, glGridBuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glGridIndexBuf);
    gl.enableVertexAttribArray(loc_aPos);
    gl.enableVertexAttribArray(loc_aUV);
    gl.vertexAttribPointer(loc_aPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(loc_aUV, 2, gl.FLOAT, false, 20, 12);

    const modelMat = mat4FromRotationTranslationScale(quat, pos, scaleW, scaleH);
    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));

    const modeVal = typeof curveMode === 'number' ? curveMode : (curveMode ? 1.0 : 0.0);
    gl.uniformMatrix4fv(loc_uMVP, false, mvp);
    gl.uniform1f(loc_uCurvatureMode, modeVal);

    const isStereo = typeof eyeOff === 'number';
    gl.uniform1f(loc_uStereo, isStereo && stereoMode ? 1.0 : 0.0);
    gl.uniform1f(loc_uEyeOff, isStereo ? eyeOff : 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc_uTex, 0);
    gl.uniform1f(loc_uAlpha, alpha);

    gl.drawElements(gl.TRIANGLES, glGridIndexCount, gl.UNSIGNED_SHORT, 0);
  }

  function drawTexturedMesh(viewMat, projMat, buffer, indexBuffer, indexCount, texture, pos, quat, alpha) {
    if (!buffer || !indexBuffer || !indexCount || !texture) return;
    gl.useProgram(glProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.enableVertexAttribArray(loc_aPos);
    gl.enableVertexAttribArray(loc_aUV);
    gl.vertexAttribPointer(loc_aPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(loc_aUV, 2, gl.FLOAT, false, 20, 12);
    const modelMat = mat4FromRotationTranslationScale(quat, pos, 1, 1);
    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));
    gl.uniformMatrix4fv(loc_uMVP, false, mvp);
    gl.uniform1f(loc_uCurvatureMode, 0);
    gl.uniform1f(loc_uStereo, 0);
    gl.uniform1f(loc_uEyeOff, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc_uTex, 0);
    gl.uniform1f(loc_uAlpha, alpha);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }

  function drawEarthMarkers(viewMat, projMat) {
    if (!glEarthMarkerProgram || !glEarthMarkerBuf || !glEarthMarkerCount) return;
    gl.useProgram(glEarthMarkerProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, glEarthMarkerBuf);
    gl.enableVertexAttribArray(loc_earthMarker_aPos);
    gl.enableVertexAttribArray(loc_earthMarker_aHeat);
    gl.enableVertexAttribArray(loc_earthMarker_aState);
    gl.vertexAttribPointer(loc_earthMarker_aPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(loc_earthMarker_aHeat, 1, gl.FLOAT, false, 20, 12);
    gl.vertexAttribPointer(loc_earthMarker_aState, 1, gl.FLOAT, false, 20, 16);
    const modelMat = mat4FromRotationTranslationScale(earthRotationQuat(), earthCenter, 1, 1);
    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));
    gl.uniformMatrix4fv(loc_earthMarker_uMVP, false, mvp);
    gl.depthMask(false);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, glEarthMarkerCount);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
  }

  function drawEarthScene(viewMat, projMat) {
    if (!initEarthResources()) return;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    drawTexturedMesh(
      viewMat, projMat, glEarthSphereBuf, glEarthSphereIndexBuf, glEarthSphereIndexCount,
      glEarthTexture, earthCenter, earthRotationQuat(), 1
    );
    drawEarthMarkers(viewMat, projMat);
    drawTexturedMesh(
      viewMat, projMat, glEarthRimBuf, glEarthRimIndexBuf, glEarthRimIndexCount,
      glEarthRimTexture, earthCenter, { x: 0, y: 0, z: 0, w: 1 }, 1
    );
    gl.disable(gl.DEPTH_TEST);
    if (glEarthLabelTexture) {
      const labelPos = { x: earthCenter.x, y: earthCenter.y + 0.73, z: earthCenter.z };
      drawGrid(viewMat, projMat, glEarthLabelTexture, labelPos, quatFaceViewerLevel(labelPos, currentHeadPos), 0.86, 0.15, 0.98, 0);
    }
    renderStats.earthDrawCalls += 1;
  }


  // Front video texture of the double-buffer pair (the back one is being
  // uploaded to). Falls back to A if B failed to allocate.
  function frontVideoTexture() {
    if (videoTexFront === 1 && glVideoTextureB) return glVideoTextureB;
    return glVideoTexture;
  }

  // Video-screen draw. Uses the OES external-texture program + target when the
  // zero-copy path is armed; otherwise delegates to the standard 2D path.
  function drawVideoGrid(viewMat, projMat, pos, quat, scaleW, scaleH, alpha, curveMode, eyeOff) {
    if (videoTexMode === 'external' && glVideoProgram && glVideoTextureExt) {
      gl.useProgram(glVideoProgram);

      gl.bindBuffer(gl.ARRAY_BUFFER, glGridBuf);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glGridIndexBuf);
      gl.enableVertexAttribArray(loc2_aPos);
      gl.enableVertexAttribArray(loc2_aUV);
      gl.vertexAttribPointer(loc2_aPos, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(loc2_aUV, 2, gl.FLOAT, false, 20, 12);

      const modelMat = mat4FromRotationTranslationScale(quat, pos, scaleW, scaleH);
      const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));

      const modeVal = typeof curveMode === 'number' ? curveMode : (curveMode ? 1.0 : 0.0);
      gl.uniformMatrix4fv(loc2_uMVP, false, mvp);
      gl.uniform1f(loc2_uCurvatureMode, modeVal);

      const isStereo = typeof eyeOff === 'number';
      gl.uniform1f(loc2_uStereo, isStereo && stereoMode ? 1.0 : 0.0);
      gl.uniform1f(loc2_uEyeOff, isStereo ? eyeOff : 0.0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_EXTERNAL_OES, glVideoTextureExt);
      gl.uniform1i(loc2_uTex, 0);
      gl.uniform1f(loc2_uAlpha, alpha);

      gl.drawElements(gl.TRIANGLES, glGridIndexCount, gl.UNSIGNED_SHORT, 0);
      return;
    }
    drawGrid(viewMat, projMat, frontVideoTexture(), pos, quat, scaleW, scaleH, alpha, curveMode, eyeOff);
  }

  // ─── Draw Celestial Starfield & Dynamic Ambilight Glow ───────────────

  function drawStarfield(viewMat, projMat, timeSec) {
    if (!glStarProgram || !glStarBuf) return;
    gl.useProgram(glStarProgram);

    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // Additive blending for stars

    gl.bindBuffer(gl.ARRAY_BUFFER, glStarBuf);
    gl.enableVertexAttribArray(loc_star_aPos);
    gl.enableVertexAttribArray(loc_star_aData);
    gl.vertexAttribPointer(loc_star_aPos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(loc_star_aData, 3, gl.FLOAT, false, 24, 12);

    const vp = mat4Mul(projMat, viewMat);
    gl.uniformMatrix4fv(loc_star_uVP, false, vp);
    gl.uniform3f(loc_star_uHeadPos, currentHeadPos.x, currentHeadPos.y, currentHeadPos.z);
    gl.uniform1f(loc_star_uTime, timeSec);

    gl.drawArrays(gl.POINTS, 0, STAR_COUNT);

    gl.depthMask(true);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  function drawAmbientGlow(viewMat, projMat, pos, quat, scaleW, scaleH, curveMode) {
    if (!glGlowProgram || !glGridBuf || !glGridIndexBuf) return;
    gl.useProgram(glGlowProgram);

    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // Additive glow against dark blue sky

    gl.bindBuffer(gl.ARRAY_BUFFER, glGridBuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glGridIndexBuf);
    gl.enableVertexAttribArray(loc_glow_aPos);
    gl.enableVertexAttribArray(loc_glow_aUV);
    gl.vertexAttribPointer(loc_glow_aPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(loc_glow_aUV, 2, gl.FLOAT, false, 20, 12);

    const modelMat = mat4FromRotationTranslationScale(quat, pos, scaleW, scaleH);
    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));

    const modeVal = typeof curveMode === 'number' ? curveMode : (curveMode ? 1.0 : 0.0);
    gl.uniformMatrix4fv(loc_glow_uMVP, false, mvp);
    gl.uniform1f(loc_glow_uCurvatureMode, modeVal);
    gl.uniform3f(loc_glow_uColor, curGlowColor[0], curGlowColor[1], curGlowColor[2]);
    gl.uniform1f(loc_glow_uIntensity, 0.78);

    gl.drawElements(gl.TRIANGLES, glGridIndexCount, gl.UNSIGNED_SHORT, 0);

    gl.depthMask(true);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    gl.uniform1f(loc_uCurvatureMode, 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glReticleTexture);
    gl.uniform1i(loc_uTex, 0);
    gl.uniform1f(loc_uAlpha, 0.85);

    gl.drawArrays(gl.LINES, 0, 2);

    const dotScale = activeIsHovering ? 0.06 : 0.04;
    drawGrid(viewMat, projMat, glReticleTexture, hitP, screenQuat, dotScale, dotScale, 0.95, false);
  }

  function drawControlsDock(viewMat, projMat, includeGuide) {
    if (!controlsVisible || !glControlsTexture) return;
    const ctrlPos = getControlsCenter();
    const ctrlScale = getControlsScale();
    const ctrlW = ctrlScale * 0.82;
    const ctrlH = ctrlW * (CONTROLS_H / CONTROLS_W);
    const ctrlQuat = getControlsQuat();
    drawGrid(viewMat, projMat, glControlsTexture, ctrlPos, ctrlQuat, ctrlW, ctrlH, 0.96, 0);
    if (includeGuide && glGuideTexture) {
      const guidePos = getGuideCenter();
      const guideQuat = quatFaceViewerLevel(guidePos, currentHeadPos);
      const guideW = ctrlScale * 0.4212;
      const guideH = guideW * (GUIDE_H / GUIDE_W);
      drawGrid(viewMat, projMat, glGuideTexture, guidePos, guideQuat, guideW, guideH, 0.92, 0);
    }
  }

  function renderSceneView(viewMat, projMat, eye, timeSec, hasOverlayComments) {
    drawStarfield(viewMat, projMat, reducedMotion ? 0 : timeSec);

    if (sceneMode === 'earth') {
      drawEarthScene(viewMat, projMat);
      drawControlsDock(viewMat, projMat, false);
      drawLaserPointer(viewMat, projMat);
      return;
    }

    drawAmbientGlow(viewMat, projMat, screenPos, screenQuat, screenScale * 1.34, screenScale * 1.34, curvatureMode);
    const videoEye = stereoMode ? (eye === 'right' ? 0.5 : 0.0) : undefined;
    drawVideoGrid(viewMat, projMat, screenPos, screenQuat, screenScale, screenScale, 1, curvatureMode, videoEye);
    if (hasOverlayComments && glOverlayTexture) {
      drawGrid(viewMat, projMat, glOverlayTexture, screenPos, screenQuat, screenScale, screenScale, 0.98, curvatureMode);
    }
    drawControlsDock(viewMat, projMat, true);
    if (commentsPanelVisible && glCommentsTexture) {
      const cpPos = getCommentsPanelCenter();
      const cpQuat = getCommentsPanelQuat();
      const cpSize = getCommentsPanelSize();
      drawGrid(viewMat, projMat, glCommentsTexture, cpPos, cpQuat, cpSize.w, cpSize.h, 0.96, 0);
    }
    drawLaserPointer(viewMat, projMat);
    renderStats.reelDrawCalls += 1;
  }


  // ─── XR Frame Loop ──────────────────────────────────────────────────

  function onXRFrame(time, frame) {
    if (!xrSession) return;
    window.__xrPresented = window.__xrPresented || 1;
    xrSession.requestAnimationFrame(onXRFrame);
    try {
      _postDiag(time);

      // Adaptive stride bookkeeping: sustained frame misses → back off the
      // video-upload rate; sustained calm → ease back toward the file's floor.
      if (vrLastFrameT >= 0) {
        const fdt = time - vrLastFrameT;
        if (fdt > 25) { vrStallFrames += 1; vrCalmFrames = 0; }
        else if (fdt < 18) { vrCalmFrames += 1; }
        else { vrCalmFrames = 0; }
        if (vrStallFrames >= 8) {
          const maxStride = (videoElement && (videoElement.videoWidth || 0) >= 3000) ? 3 : 2;
          if (vrUploadStride < maxStride) vrUploadStride += 1;
          vrStallFrames = 0; vrCalmFrames = 0;
        } else if (vrCalmFrames >= 240 && vrUploadStride > vrMinStride()) {
          vrUploadStride -= 1;
          vrCalmFrames = 0; vrStallFrames = 0;
        }
      }
      vrLastFrameT = time;

    const pose = frame.getViewerPose(xrRefSpace);
    if (!pose) return;

    if (pose.transform) {
      currentHeadPos = {
        x: pose.transform.position.x,
        y: pose.transform.position.y,
        z: pose.transform.position.z,
      };
      currentHeadQuat = {
        x: pose.transform.orientation.x,
        y: pose.transform.orientation.y,
        z: pose.transform.orientation.z,
        w: pose.transform.orientation.w,
      };

      if (!isInitialPoseSet) {
        if (!lockToViewer) {
          const initDir = quatRotVec(currentHeadQuat, { x: 0, y: 0, z: -1 });
          screenQuat = quatLevelFromDir(initDir);
          screenPos = {
            x: currentHeadPos.x + initDir.x * 2.24,
            y: currentHeadPos.y,
            z: currentHeadPos.z + initDir.z * 2.24,
          };
        }
        isInitialPoseSet = true;
      }

      if (lockToViewer) {
        applyLockToViewer();
      }
    }

    processInput(frame);

    if (sceneMode === 'reels' && videoElement && videoElement.paused && !controlsVisible) {
      showControls();
    }

    if (!glLayer || !gl) return;

    let hasOverlayComments = false;
    if (sceneMode === 'earth') {
      advanceEarthSpin(time);
      initEarthResources();
      renderEarthLabelCanvas();
      if (controlsVisible && (vrLastUiUploadT < 0 || (time - vrLastUiUploadT) >= VR_UI_MIN_INTERVAL)) {
        vrLastUiUploadT = time;
        renderControlsCanvas();
        gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, controlsCanvas);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
      gl.clearColor(0.0095, 0.0175, 0.052, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
    // Update real-time Ambilight video color extraction and smooth interpolation
    updateAmbilightColor(time);
    curGlowColor[0] += (targetGlowColor[0] - curGlowColor[0]) * 0.08;
    curGlowColor[1] += (targetGlowColor[1] - curGlowColor[1]) * 0.08;
    curGlowColor[2] += (targetGlowColor[2] - curGlowColor[2]) * 0.08;

    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    // Deep midnight blue celestial background (20% darker for enhanced contrast)
    gl.clearColor(0.0095, 0.0175, 0.052, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (videoElement && videoElement.readyState >= 2) {
      // Strict gate: upload ONLY on a newly decoded frame. totalVideoFrames
      // ticks once per decoded frame (~video fps). The old `hasNewVideoFrame
      // ||` bypass re-fired from rVFC with zero new decoded frames (live
      // telemetry: 49 uploads/sec, 0 decoded) — that bypass is removed.
      // Adaptive stride then drops intermediate frames on high-res/stalled
      // sessions so the re-spec flush fires less often (low-res keeps every
      // frame → full motion; 4K backs off to 1/2–1/3 rate → far fewer flashes).
      const vf = (videoElement.getVideoPlaybackQuality?.()?.totalVideoFrames ?? -1);
      // Fallback: if the browser lacks getVideoPlaybackQuality, vf stays -1
      // and we must trust the rVFC flag as before.
      const vChanged = (vf === -1) ? hasNewVideoFrame : (vf !== lastVideoFrameCount);
      if (vChanged) vrSkipCounter += 1;
      if (vChanged && vrSkipCounter >= vrUploadStride) {
        vrSkipCounter = 0;
        const _u0 = performance.now();
        if (videoTexMode === 'external' && glVideoTextureExt) {
          // Zero-copy bind: points the external texture at the decoder surface.
          // No re-spec of a sampled 2D texture → no GPU pipeline flush.
          gl.bindTexture(gl.TEXTURE_EXTERNAL_OES, glVideoTextureExt);
          gl.texImage2D(gl.TEXTURE_EXTERNAL_OES, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
        } else {
          gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
          if (videoTexMode === 'subimage') {
            // Allocate the 4K storage ONCE, then update in place per decoded
            // frame. texSubImage2D (valid only in WebGL2 for video sources)
            // avoids re-specifying the sampled texture → no pipeline flush.
            if (!videoTexAllocated) {
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
              videoTexAllocated = true;
            } else {
              gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
            }
          } else if (glVideoTextureB) {
            // Double-buffered re-spec: upload into the BACK texture (sampled
            // by no in-flight draw) then flip, so the GPU never re-specifies
            // the texture it is currently sampling → no pipeline bubble.
            const backTex = (videoTexFront === 0) ? glVideoTextureB : glVideoTexture;
            gl.bindTexture(gl.TEXTURE_2D, backTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
            videoTexFront = (videoTexFront === 0) ? 1 : 0;
          } else {
            gl.bindTexture(gl.TEXTURE_2D, glVideoTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
          }
        }
        _diagUploadMaxMs = Math.max(_diagUploadMaxMs, performance.now() - _u0);
        _diagTexUploads++;
        renderStats.videoUploads += 1;
        hasNewVideoFrame = false;
        lastVideoTime = videoElement.currentTime;
        lastVideoFrameCount = vf;
      } else if (vChanged) {
        // Skipped by stride: advance the counter so frames never backlog —
        // this decoded frame is dropped from the VR texture, the next one
        // within stride gets uploaded.
        hasNewVideoFrame = false;
        lastVideoTime = videoElement.currentTime;
        lastVideoFrameCount = vf;
      } else {
        // Stale rVFC ping with no decoded frame: clear the flag, never upload.
        hasNewVideoFrame = false;
      }
    }

    // Transport controls: 10Hz re-upload is visually smooth in VR and removes
    // ~70 re-spec flushes/sec vs the old every-XR-frame upload.
    if (controlsVisible && (vrLastUiUploadT < 0 || (time - vrLastUiUploadT) >= VR_UI_MIN_INTERVAL)) {
      vrLastUiUploadT = time;
      renderControlsCanvas();
      gl.bindTexture(gl.TEXTURE_2D, glControlsTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, controlsCanvas);
    }

    // Guide panel is static artwork: render + upload once per session (and
    // once more if the controller image finishes loading late).
    if (controlsVisible && guideCanvas && glGuideTexture && !vrGuideUploaded) {
      renderGuideCanvas();
      gl.bindTexture(gl.TEXTURE_2D, glGuideTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, guideCanvas);
      vrGuideUploaded = true;
    }

    // Suppress the live in-screen time-synced overlay while the comments panel is open
    hasOverlayComments = commentsPanelVisible ? false : renderOverlayCanvas();
    if (hasOverlayComments && glOverlayTexture && overlayCanvas) {
      gl.bindTexture(gl.TEXTURE_2D, glOverlayTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlayCanvas);
    }

    // Upload VR comments panel texture (throttled to 10Hz: keeps the SYNC
    // clock fresh; the old per-frame re-raster was another full re-spec
    // flush on every XR frame while the panel was open).
    if (commentsPanelVisible && commentsPanelCanvas && glCommentsTexture &&
        (vrLastPanelUploadT < 0 || (time - vrLastPanelUploadT) >= VR_UI_MIN_INTERVAL)) {
      vrLastPanelUploadT = time;
      renderCommentsPanelCanvas();
      gl.bindTexture(gl.TEXTURE_2D, glCommentsTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, commentsPanelCanvas);
    }
    }

    const timeSec = time * 0.001;

    for (const view of pose.views) {
      const vp = glLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      const viewMat = view.transform.inverse.matrix;
      const projMat = view.projectionMatrix;

      renderSceneView(viewMat, projMat, view.eye, timeSec, hasOverlayComments);
    }
    } catch (err) {
      // Record the first render-loop error so post-abort CDP can read WHY the
      // session died (runtime abort vs our exception). Loop stays alive — the
      // next frame was already scheduled at the top of this callback.
      if (!window.__xrErr) {
        window.__xrErr = 'onXRFrame: ' + String(err);
        console.error('[WebXRVR] onXRFrame error:', err);
      }
    }
  }

  // ─── Controller Input Processing ─────────────────────────────────────

  function processInput(frame) {
    if (!xrSession) return;
    let nextEarthHover = -1;
    let earthRayPriority = -1;
    if (sceneMode === 'earth') {
      activeRayOrigin = null;
      activeRayDir = null;
    }

    for (const source of xrSession.inputSources) {
      const gp = source.gamepad || null;
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
      if (sceneMode === 'earth') {
        const priority = earthDragInputSource === source ? 3 : (hand === 'right' ? 2 : (hand === 'left' ? 1 : 0));
        if (controllerPos && controllerDir && priority >= earthRayPriority) {
          earthRayPriority = priority;
          activeRayOrigin = controllerPos;
          activeRayDir = controllerDir;
          let hitDist = -1;
          let isHover = false;
          let markerIndex = -1;
          if (controlsVisible) {
            const btnIdx = hitTestControls(controllerPos, controllerDir);
            hoveredButton = btnIdx;
            if (btnIdx >= 0) {
              hitDist = getHitDistControls(controllerPos, controllerDir);
              isHover = true;
            }
          }
          if (!isHover) {
            const earthHit = hitTestEarth(controllerPos, controllerDir);
            if (earthHit.hit) {
              hitDist = earthHit.dist;
              markerIndex = earthHit.markerIndex;
              isHover = true;
              if (earthDragging && (!earthDragInputSource || earthDragInputSource === source)) {
                updateEarthDrag(earthHit.local);
                earthInteractionUntil = performance.now() + 900;
              }
            }
          }
          nextEarthHover = markerIndex;
          activeHitDist = hitDist > 0 ? hitDist : 3;
          activeIsHovering = isHover;
        }
        if (gp) {
          const axes = gp.axes || [];
          const thumbX = axes.length >= 4 ? (axes[2] || 0) : (axes[0] || 0);
          const thumbY = axes.length >= 4 ? (axes[3] || 0) : (axes[1] || 0);
          if (Math.abs(thumbX) > 0.12 || Math.abs(thumbY) > 0.12) {
            rotateEarth(thumbX * 0.035, -thumbY * 0.025);
            earthInteractionUntil = performance.now() + 900;
          }
          if (hand === 'right') {
            const bPressed = gp.buttons.length > 5 && gp.buttons[5].pressed;
            if (bPressed && !prevBtnState.rightB) toggleControls();
            prevBtnState.rightB = bPressed;
          }
        }
        continue;
      }

      if (!gp) continue;

      // ── Grip: 6DOF Natural Grab & Reposition (DeoVR / Skybox style) ──
      const gripPressed = gp.buttons.length > 1 && gp.buttons[1].pressed;
      if (lockToViewer) {
        isGrabbing = false;
        grabControllerIdx = -1;
      } else if (gripPressed && controllerPos && controllerDir) {
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

          // Rotate screen tangent to viewer POV (facing head, 100% horizontally level)
          screenQuat = quatFaceViewerLevel(screenPos, currentHeadPos);
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

        // Comments panel has ray priority over controls & screen
        if (commentsPanelVisible) {
          const cpHit = hitTestCommentsPanel(controllerPos, controllerDir);
          if (cpHit) {
            cPanelHover = cpHit;
            hoveredButton = -1;
            hitDist = getHitDistCommentsPanel(controllerPos, controllerDir);
            isHover = true;
          } else {
            cPanelHover = null;
          }
        }

        if (!isHover && controlsVisible) {
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

        // Track hover over a pop-up comment on the reels screen (only when panel closed)
        activeOverlayHoverId = null;
        if (!commentsPanelVisible) {
          const ovHit = hitTestCurvedScreen(controllerPos, controllerDir);
          if (ovHit.hit) activeOverlayHoverId = overlayCommentAtHit(ovHit.hitLocal);
        }

        // Continue a trigger-drag scroll on the comments list (content follows the hand)
        if (cPanelDrag) {
          const trigNow = gp.buttons.length > 0 && gp.buttons[0].pressed;
          if (trigNow) {
            const dy = lastCommentsCanvasY - cPanelDragStartCanvasY;
            cPanelScrollY = clampPanelScroll(cPanelDragStartScroll - dy);
          } else {
            cPanelDrag = false;
          }
        }
      }

      // ── 2. Right Joystick Handling ──
      const thumbY = gp.axes[3] || 0;
      const thumbX = gp.axes[2] || 0;
      const pointerOverPanel = commentsPanelVisible && cPanelHover;

      if (gripPressed) {
        // A) GRIP HELD + Joystick Y Up/Down -> Scale Screen Larger / Smaller
        if (Math.abs(thumbY) > FLICK_THRESHOLD) {
          screenScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
            screenScale + (-thumbY) * SCALE_SPEED
          ));
        }
      } else if (pointerOverPanel) {
        // B1) Pointing at the comments panel -> scroll the list with Y
        if (Math.abs(thumbY) > 0.18) {
          cPanelScrollY = clampPanelScroll(cPanelScrollY + thumbY * 6);
          flickedY = false;
        }
      } else {
        // B2) NORMAL Joystick Y Up/Down -> Next / Previous Reel Navigation
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

      // ── 4. B Button: Toggle Guide & UI Controls Panel ──
      const bPressed = gp.buttons.length > 5 && gp.buttons[5].pressed;
      if (bPressed && !prevBtnState.rightB) {
        toggleControls();
      }
      prevBtnState.rightB = bPressed;
    }
    if (sceneMode === 'earth') setEarthHoveredIndex(nextEarthHover);
  }

  // ─── XR Availability ───────────────────────────────────────────────

  function getXR() {
    try { if (window.top && window.top.navigator && window.top.navigator.xr) return window.top.navigator.xr; } catch (e) {}
    try { if (window.parent && window.parent.navigator && window.parent.navigator.xr) return window.parent.navigator.xr; } catch (e) {}
    return navigator.xr;
  }

  // ─── Session Management ──────────────────────────────────────────────

  async function enterVR() {
    if (previewRunning) stopPreview();
    if (xrSession) return;
    window.__xrErr = null;
    window.__xrGL = null;
    window.__xrPresented = 0;
    console.log('[WebXRVR] enterVR() called —', VR_VERSION);

    const xr = getXR();
    if (!xr) {
      alert('WebXR not available. Requires HTTPS or localhost.');
      return;
    }

    // DOM overlay root must exist before the session request so the Quest
    // virtual keyboard can be summoned for VR comment posting.
    initDomOverlay();

    const sessionOpts = {
      optionalFeatures: ['local-floor', 'local', 'dom-overlay', 'hand-tracking'],
    };
    if (domOverlayRoot) sessionOpts.domOverlay = { root: domOverlayRoot };

    try {
      xrSession = await xr.requestSession('immersive-vr', sessionOpts);
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
    currentHeadPos = { x: 0, y: 1.52, z: 0 };
    currentHeadQuat = { x: 0, y: 0, z: 0, w: 1 };
    isInitialPoseSet = false;
    lockToViewer = true;
    controlsVisible = false;
    commentsPanelVisible = false;
    cPanelScrollY = 0;
    cPanelTab = 'all';
    cPanelMaxScroll = 0;
    cPanelHover = null;
    cPanelDrag = false;
    clearPanelHighlight();
    activeOverlayRegions = [];
    activeOverlayHoverId = null;
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    lastVideoFrameCount = -1;
    videoTexAllocated = false;
    vrSkipCounter = 0;
    vrStallFrames = 0;
    vrCalmFrames = 0;
    vrLastFrameT = -1;
    vrLastUiUploadT = -1;
    vrLastPanelUploadT = -1;
    vrGuideUploaded = false;
    vrUploadStride = vrMinStride();
    hoveredButton = -1;
    isGrabbing = false;
    activeRayOrigin = null;
    activeRayDir = null;
    flickedX = false;
    flickedY = false;

    initControlsCanvas();
    initOverlayCanvas();
    initCommentsPanelCanvas();
    // Note: initGuideCanvas() is called after initGL() since it needs glGuideTexture

    try {
      xrRefSpace = await xrSession.requestReferenceSpace('local-floor');
    } catch {
      xrRefSpace = await xrSession.requestReferenceSpace('local');
    }

    let glOk = false;
    try {
      glOk = !!initGL(xrSession);
    } catch (err) {
      console.error('[WebXRVR] initGL threw — ending session:', err);
      window.__xrErr = 'initGL threw: ' + String(err);
      glOk = false;
    }
    if (!glOk) {
      console.error('[WebXRVR] VR GL setup failed — releasing session');
      window.__xrErr = window.__xrErr || 'initGL returned false';
      try { xrSession.end().catch(() => {}); } catch (e) {}
      xrSession = null;
      return;
    }

    // Init guide canvas AFTER initGL so glGuideTexture exists
    try {
      initGuideCanvas();
      setupVideoFrameTracking();

      xrSession.addEventListener('selectstart', onSelectStart);
      xrSession.addEventListener('selectend', onSelectEnd);
      xrSession.addEventListener('end', onSessionEnd);

      if (videoElement) {
        videoElement.addEventListener('pause', onVideoPause);
        videoElement.addEventListener('play', onVideoPlay);
      }

      const frameEl = document.getElementById('reelsFrame');
      if (frameEl) frameEl.classList.add('vr-active');

      if (videoElement) {
        videoElement.muted = false;
        if (callbacks.onUnmute) callbacks.onUnmute();
        if (videoElement.paused) {
          videoElement.play().catch(() => {});
        }
      }

      // Notify host SPA so the global Top Bar can auto-hide for immersive Reels
      notifyVrEnter();

      // Force an immediate telemetry snapshot on the first XR frame so we catch
      // the armed GL path + GL version even if the runtime aborts within seconds.
      _diagForce = true;
      xrSession.requestAnimationFrame(onXRFrame);
    } catch (err) {
      // Never leave an immersive session half-set-up — end it so the runtime
      // doesn't keep reporting "an active immersive XRSession" on retry.
      console.error('[WebXRVR] VR setup threw — releasing session:', err);
      window.__xrErr = 'post-GL setup threw: ' + String(err);
      try { xrSession.end().catch(() => {}); } catch (e) {}
      xrSession = null;
      cleanup();
    }
  }

  function onVideoPause() {
    if (xrSession || previewRunning) showControls();
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
    if (sceneMode === 'earth') {
      if (controlsVisible && rayOrigin && rayDir) {
        const controlIndex = hitTestControls(rayOrigin, rayDir);
        if (controlIndex >= 0) {
          executeControlButton(controlIndex);
          return;
        }
      }
      if (rayOrigin && rayDir) beginEarthDrag(source, hitTestEarth(rayOrigin, rayDir));
      return;
    }

    // 1. VR Comments Panel — highest priority
    if (commentsPanelVisible && cPanelHover) {
      executeCommentAction(cPanelHover);
      return;
    }

    // 2. Check UI Controls Button Click
    if (controlsVisible && hoveredButton >= 0) {
      executeControlButton(hoveredButton);
      return;
    }

    // 2. Check Click on Main Video Screen
    if (rayOrigin && rayDir) {
      const mainHit = hitTestCurvedScreen(rayOrigin, rayDir);
      if (mainHit.hit) {
        // Clicking a pop-up comment opens the panel and jumps to it
        if (!commentsPanelVisible) {
          const cid = overlayCommentAtHit(mainHit.hitLocal);
          if (cid) {
            openCommentsPanelToComment(cid);
            return;
          }
        }
        callbacks.onTogglePlay && callbacks.onTogglePlay();
        toggleControls();
        return;
      }
    }

    // 3. Click outside screen -> toggle controls visibility
    toggleControls();
  }

  function onSelectEnd(ev) {
    if (sceneMode !== 'earth' || !earthDragging) return;
    const source = ev.inputSource;
    if (!source || (earthDragInputSource && earthDragInputSource !== source)) return;
    let hit = null;
    if (source.targetRaySpace && ev.frame && xrRefSpace) {
      const rayPose = ev.frame.getPose(source.targetRaySpace, xrRefSpace);
      if (rayPose) {
        const t = rayPose.transform;
        const matrix = t.matrix || rayPose.transform.matrix;
        if (matrix) {
          hit = hitTestEarth(
            { x: t.position.x, y: t.position.y, z: t.position.z },
            { x: -matrix[8], y: -matrix[9], z: -matrix[10] }
          );
        }
      }
    }
    endEarthDrag(source, hit);
  }


  function onSessionEnd() {
    cleanup();
  }

  async function exitVR() {
    const session = xrSession;
    if (!session) {
      if (previewRunning) stopPreview();
      return;
    }
    try {
      await session.end();
    } catch (e) {}
  }

  function releaseGLResources() {
    if (!gl) return;
    const buffers = [
      glGridBuf, glGridIndexBuf, glLaserBuf, glStarBuf,
      glEarthSphereBuf, glEarthSphereIndexBuf, glEarthRimBuf,
      glEarthRimIndexBuf, glEarthMarkerBuf,
    ];
    const textures = [
      glVideoTexture, glVideoTextureB, glVideoTextureExt, glControlsTexture,
      glOverlayTexture, glGuideTexture, glCommentsTexture, glReticleTexture,
      glEarthTexture, glEarthRimTexture, glEarthLabelTexture,
    ];
    const programs = [glProgram, glVideoProgram, glStarProgram, glGlowProgram, glEarthMarkerProgram];
    buffers.forEach((buffer) => { if (buffer) try { gl.deleteBuffer(buffer); } catch (e) {} });
    textures.forEach((texture) => { if (texture) try { gl.deleteTexture(texture); } catch (e) {} });
    programs.forEach((program) => { if (program) try { gl.deleteProgram(program); } catch (e) {} });
  }

  function cleanup(options) {
    const opts = options || {};
    const session = xrSession;
    const wasXR = !!session && !opts.preview;
    const wasEarth = sceneMode === 'earth';
    const resumeAfterEarth = earthResumePlayback;
    if (session) {
      try { session.removeEventListener('selectstart', onSelectStart); } catch (e) {}
      try { session.removeEventListener('selectend', onSelectEnd); } catch (e) {}
      try { session.removeEventListener('end', onSessionEnd); } catch (e) {}
    }
    previewRunning = false;
    if (previewRaf) window.cancelAnimationFrame(previewRaf);
    previewRaf = 0;
    removePreviewListeners();
    earthActivityGeneration += 1;
    earthSelectionGeneration += 1;
    if (earthActivityAbort) {
      earthActivityAbort.abort();
      earthActivityAbort = null;
    }
    if (videoElement) {
      videoElement.removeEventListener('pause', onVideoPause);
      videoElement.removeEventListener('play', onVideoPlay);
    }
    stopVideoFrameTracking();
    clearAutoHideTimer();
    releaseGLResources();
    xrSession = null;
    xrRefSpace = null;
    gl = null;
    glLayer = null;
    glProgram = null;
    glVideoTexture = null;
    glVideoTextureB = null;
    videoTexFront = 0;
    glVideoTextureExt = null;
    glVideoProgram = null;
    loc2_aPos = -1;
    loc2_aUV = -1;
    loc2_uMVP = null;
    loc2_uTex = null;
    loc2_uAlpha = null;
    loc2_uCurvatureMode = null;
    loc2_uStereo = null;
    loc2_uEyeOff = null;
    videoTexMode = '2d';
    videoTexAllocated = false;
    vrUploadStride = 1;
    vrSkipCounter = 0;
    vrStallFrames = 0;
    vrCalmFrames = 0;
    vrLastFrameT = -1;
    vrLastUiUploadT = -1;
    vrLastPanelUploadT = -1;
    vrGuideUploaded = false;
    vrProxyCanvas = null;
    vrProxyCtx = null;
    glControlsTexture = null;
    glOverlayTexture = null;
    glGuideTexture = null;
    glCommentsTexture = null;
    glReticleTexture = null;
    overlayCanvas = null;
    overlayCtx = null;
    commentsPanelVisible = false;
    commentsPanelCanvas = null;
    commentsPanelCtx = null;
    cPanelScrollY = 0;
    cPanelTab = 'all';
    cPanelMaxScroll = 0;
    cPanelHover = null;
    cPanelDrag = false;
    clearPanelHighlight();
    activeOverlayRegions = [];
    activeOverlayHoverId = null;
    glGridBuf = null;
    glGridIndexBuf = null;
    glGridIndexCount = 0;
    glLaserBuf = null;
    loc_aPos = -1;
    loc_aUV = -1;
    loc_uMVP = null;
    loc_uTex = null;
    loc_uAlpha = null;
    loc_uCurvatureMode = null;
    glStarProgram = null;
    glStarBuf = null;
    glGlowProgram = null;
    glEarthSphereBuf = null;
    glEarthSphereIndexBuf = null;
    glEarthSphereIndexCount = 0;
    glEarthRimBuf = null;
    glEarthRimIndexBuf = null;
    glEarthRimIndexCount = 0;
    glEarthMarkerProgram = null;
    glEarthMarkerBuf = null;
    glEarthMarkerCount = 0;
    glEarthTexture = null;
    glEarthRimTexture = null;
    glEarthLabelTexture = null;
    earthLabelCanvas = null;
    earthLabelCtx = null;
    earthLabelSignature = '';
    earthResourcesReady = false;
    earthTextureReady = false;
    earthHoveredIndex = -1;
    earthSelectedIndex = -1;
    earthDragging = false;
    earthDragSource = null;
    earthDragLastDir = null;
    earthDragInputSource = null;
    earthPressMarker = -1;
    earthLastFrameTime = -1;
    earthInteractionUntil = 0;
    sceneMode = 'reels';
    ambilightCanvas = null;
    ambilightCtx = null;
    controlsCanvas = null;
    controlsCtx = null;
    guideCanvas = null;
    guideCtx = null;
    controlsVisible = false;
    isGrabbing = false;
    currentHeadQuat = { x: 0, y: 0, z: 0, w: 1 };
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    lastVideoFrameCount = -1;
    hoveredButton = -1;
    activeRayOrigin = null;
    activeRayDir = null;
    flickedX = false;
    flickedY = false;
    _diagGLInfo = null;

    if (wasXR && wasEarth && callbacks.onEarthClose) {
      try { callbacks.onEarthClose(resumeAfterEarth); } catch (e) {}
    }

    const frameEl = document.getElementById('reelsFrame');
    if (frameEl) frameEl.classList.remove('vr-active');

    if (wasXR) {
      // Final telemetry: record why the session ended, best-effort before teardown.
      try {
        fetch('/api/reels/diag', { method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'session_end',
            xrErr: window.__xrErr || null,
            glPath: window.__xrGL || null,
            presented: window.__xrPresented || 0,
          }) }).catch(() => {});
      } catch (e) {}
      notifyVrExit();
    }
  }

  function onVideoChange() {
    hasNewVideoFrame = true;
    lastVideoTime = -1;
    lastVideoFrameCount = -1;
    videoTexAllocated = false;
    // New file → re-derive stride from its resolution (guide art is static,
    // so its uploaded flag survives across videos).
    vrUploadStride = vrMinStride();
    vrSkipCounter = 0;
    vrStallFrames = 0;
    vrCalmFrames = 0;
    cPanelScrollY = 0;
    cPanelMaxScroll = 0;
    clearPanelHighlight();
    activeOverlayRegions = [];
    activeOverlayHoverId = null;
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
    startPreview,
    stopPreview,
    resetPreview,
    setPreviewCameraMode,
    setPreviewStereo,
    setReducedMotion,
    setSceneMode,
    requestPreviewFullscreen,
    getPreviewState,
    onVideoChange,

    /** Enable/disable SBS stereoscopic sampling of the video frame. */
    setStereo(enabled) {
      stereoMode = !!enabled;
      console.log('[WebXRVR] Stereo (SBS) mode:', stereoMode ? 'ON' : 'OFF');
    },

    __test: {
      locationToUnit,
      raySphereHit,
      hitTestEarth,
      setLocationActivity,
      beginEarthDrag,
      updateEarthDrag,
      endEarthDrag,
      advanceEarthSpin,
      cleanup,
      setEarthPose(yaw, pitch, center) {
        earthYaw = Number(yaw) || 0;
        earthPitch = Number(pitch) || 0;
        if (center) earthCenter = { x: center.x, y: center.y, z: center.z };
        earthLastFrameTime = -1;
      },
      getEarthState() {
        return {
          center: { ...earthCenter },
          yaw: earthYaw,
          pitch: earthPitch,
          dragging: earthDragging,
          resourcesReady: earthResourcesReady,
          locationSlugs: earthLocations.map((location) => location.slug),
          renderStats: { ...renderStats },
        };
      },
    },
  };
})();
