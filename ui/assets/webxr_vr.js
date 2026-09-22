/**
 * ECHO WebXR VR Module for Reels — v8.10 (Pure Three.js Engine with Path A Curvature)
 *
 * Fully overhauled using Three.js (r186) scene graph, THREE.OrbitControls,
 * and decoupled 2D In-VR UI Canvas (window.VRUICanvas).
 */
window.WebXRVR = window.WebXRVR || (function () {
  'use strict';

  const VR_VERSION = 'v8.18-20260922-earth-zoom-map';
  console.log('[WebXRVR] Module loaded:', VR_VERSION);

  // ─── Constants & Configuration ──────────────────────────────────────
  const VR_TEX_CAP = 2048;
  const EARTH_RADIUS = 0.676;
  const EARTH_MAP_W = 2048;
  const EARTH_MAP_H = 1024;
  const EARTH_PIN_CAP = 64;
  // Earth zoom map (docs/earth-zoom-map-plan.md Z1): globe scale 1 = full
  // globe … EARTH_ZOOM_MAX ≈ street band. Taps below the city band zoom
  // (Snap pinch equivalent); taps at/above it select the feed. Grip+stickY
  // (XR) and the wheel (preview) zoom continuously, exponentially.
  // Z2 mapping: tileZ = log2(S) + 3.3 keeps ~4.6 tiles across the screen
  // footprint at the 1.15 m comfort distance at every scale (verified:
  // bounded 7×7 visible sets from country S=4 to street S=16384/z17).
  const EARTH_ZOOM_MAX = 16384;
  const EARTH_ZOOM_CITY = 8;
  const EARTH_ZOOM_STEP = 2.6;
  const EARTH_ZOOM_ANIM_MS = 450;
  const EARTH_ZOOM_SURFACE_DIST = 1.15; // m — focused surface point keeps this head distance
  // Base photo tried in order: Vite-served public asset (dev) then the
  // backend route (production/Quest). Procedural fallback covers failure.
  const EARTH_TEXTURE_URLS = [
    '/assets/earth-natural-1024x512.jpg',
    '/api/reels/earth-texture',
  ];
  const ARC_ANGLE = 0.65; // ~37.24 deg
  const SPHERE_RADIUS = 1 / ARC_ANGLE; // ~1.5385m

  // ─── State ──────────────────────────────────────────────────────────
  let videoElement = null;
  let callbacks = {};
  let xrSession = null;
  let xrRefSpace = null;
  let previewRunning = false;
  let previewAnimId = null;
  let previewCanvas = null;
  let previewCameraMode = 'headset'; // 'headset' | 'orbit'
  let sceneMode = 'reels'; // 'reels' | 'earth'
  let curvatureMode = 1; // 1: DOME, 2: SQ CURVE, 0: FLAT
  let isCurved = true;
  let stereoMode = false;
  let lockToViewer = false;
  let reducedMotion = !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ─── Screen transform (v8.3 lock-to-viewer + PlayVR scale/distance) ──
  // Upstream v5.2 screen state verbatim, plus the v8.3 screenDistance control
  // (grip + stick X): locked pose = head-forward × screenDistance.
  const DEFAULT_POS = { x: 0, y: 1.52, z: -2.24 };
  const DEFAULT_SCALE = 4.0;
  const MIN_SCALE = 1.0;
  const MAX_SCALE = 10.0;
  const SCALE_SPEED = 0.04;
  const SCREEN_CENTER_Y = 1.52; // used by the locked-mode dock anchor
  const MIN_DIST = 1.2;
  const MAX_DIST = 6.0;
  const DIST_SPEED = 0.03;
  const FLICK_THRESHOLD = 0.5;
  const FLICK_RESET = 0.3;
  const VR_UI_MIN_INTERVAL = 100; // ms between UI texture re-renders
  const CONTROLS_AUTO_HIDE_MS = 5000;
  // Side-panel layout (upstream factors): side gap from the screen edge and
  // the slight forward (viewer-side) offset, in screen-local meters.
  const PANEL_SIDE_GAP = 0.384;
  const PANEL_FWD_OFFSET = -0.15;
  const CPANEL_SCALE_FACTOR = 0.432;
  const GUIDE_SCALE_FACTOR = 0.4212;

  // v8.4 video upload path A/B: 'subimage' (three same-size updates, default)
  // vs 'respec' (force full texImage2D re-spec per upload, legacy behavior).
  let videoUploadMode = 'subimage';

  // v8.5 on-device bisection flags (URL query, read once in init()):
  // ?lock=0 (no face-following — pre-lock builds), ?overlay=0, ?guide=0,
  // ?glow=0 (+ ?vrTexMode=respec). Each flag removes exactly one v8.3+
  // addition so the black-square source can be isolated in-headset.
  // v8.6 additions: ?dockfreeze=1 (paint the dock once, then freeze its
  // texture re-uploads — isolates dock/panel sub-image tears), ?glowprobe=0
  // (keep the glow mesh, kill the getImageData readback sync).
  // v8.13 additions: ?vrtex=video (bind a direct THREE.VideoTexture of the
  // video element to the screen instead of the canvas-proxy blit + re-upload
  // — the path other Quest video sites use; §3.7 A/B verdict).
  // v8.14 additions: ?xrminimal=1 (request the minimal session options the
  // three.js webxr_vr_video standard uses — local-floor/local only, no
  // bounded-floor/hand-tracking/dom-overlay, antialias/alpha off. The AB
  // page (§3.8, flash-free) differs from the engine only by these + UI
  // meshes; Godot's 2024 Quest black-void regression was triggered by
  // bounded-floor in session options).
  // v8.15: the minimal session request is the DEFAULT (§3.10 verdict — the
  // xrminimal session fixed the flashes; the engine never consumes hand
  // joints, bounds geometry, or the overlay layer except the VR keyboard
  // path, which degrades to a dock notification). ?xrfull=1 restores the
  // legacy request.
  // v8.17: the full xrminimal stack is the default — the v8.15 split (minimal
  // session, legacy AA-on renderer) flashed identically to pre-fix, while the
  // proven-clean xrminimal run had minimal session AND antialias/alpha off.
  // three r186 forces alpha:true on the XR layer regardless, so antialias
  // (MSAA resolve on the XR layer) is the isolated variable. ?xrfull=1
  // restores the entire legacy stack (session + renderer).
  const debugFlags = {
    lock: true, overlay: true, guide: true, glow: true,
    dockfreeze: false, glowprobe: true, domoverlay: true, vrtex: false,
    xrminimal: false, xrfull: false, earthmap: true, earthstyle: 'holo',
  };
  // Full legacy stack iff explicitly requested (?xrfull=1) and not overridden
  // by explicit minimal (?xrminimal=1). Everything else runs the minimal
  // stack that proved flash-free on-device.
  function useFullStack() { return debugFlags.xrfull && !debugFlags.xrminimal; }
  function readDebugFlags() {
    try {
      const q = (typeof location !== 'undefined' && location.search) || '';
      const has = (k, v) => new RegExp('(?:\\?|&)' + k + '=' + v + '(?:&|$)').test(q);
      if (has('lock', '0')) debugFlags.lock = false;
      if (has('overlay', '0')) debugFlags.overlay = false;
      if (has('guide', '0')) debugFlags.guide = false;
      if (has('glow', '0')) debugFlags.glow = false;
      if (has('dockfreeze', '1')) debugFlags.dockfreeze = true;
      if (has('glowprobe', '0')) debugFlags.glowprobe = false;
      if (has('domoverlay', '0')) debugFlags.domoverlay = false;
      if (has('vrtex', 'video')) debugFlags.vrtex = true;
      if (has('xrminimal', '1')) debugFlags.xrminimal = true;
      if (has('xrfull', '1')) debugFlags.xrfull = true;
      if (has('earthmap', '0')) debugFlags.earthmap = false;
      if (has('earthstyle', 'raw')) debugFlags.earthstyle = 'raw';
    } catch (e) {}
  }
  // Face-following applies only when locked AND not bisected off.
  function lockApplies() { return lockToViewer && debugFlags.lock; }
  let screenPos = { x: DEFAULT_POS.x, y: DEFAULT_POS.y, z: DEFAULT_POS.z };
  let screenQuat = null; // THREE.Quaternion once Three loads (identity until then)
  let screenScale = DEFAULT_SCALE;
  let screenDistance = -DEFAULT_POS.z; // 2.24
  let isInitialPoseSet = false;
  let controlsVisible = true;

  // 6DOF Grab state (upstream DeoVR / Skybox style)
  let isGrabbing = false;
  let grabControllerIdx = -1;
  let grabRelPos = null;
  let grabRelQuat = null;

  // Preview camera state (restored custom drag-look; OrbitControls only in orbit mode)
  let previewYaw = 0;
  let previewPitch = 0;
  let previewOrbitYaw = 0;
  let previewOrbitPitch = -0.08;
  let previewOrbitDistance = 4.8;
  let previewPointer = null;
  let previewListeners = null;
  let previewResizeHandler = null;

  // Earth Mode State
  let earthCenter = { x: 0, y: 1.12, z: -1.3 };
  let earthYaw = 0;
  let earthPitch = 0;
  let earthDragging = false;
  // Hold-to-engage drag machine (upstream parity): single-axis lock, tap
  // chord, flick chord. Pitch factor is upstream-verbatim; yaw is reduced
  // per owner request.
  let earthDragLastDir = null;
  let earthDragStartDir = null;
  let earthDragMoved = false;
  let earthDragEngaged = false;
  let earthDragCumX = 0;
  let earthDragCumY = 0;
  let earthDragAxis = null;
  let earthPressTime = 0;
  let earthPressZone = -1;
  let earthDragSource = null;
  let earthResumePlayback = false;
  let earthLocations = [];
  let earthHoveredIndex = -1;
  let earthPreviewLocationIndex = -1;
  let earthPreviewStatus = 'idle';
  let earthPreviewItems = [];
  let earthPreviewIndex = 0;
  let earthPreviewVideo = null;
  let earthPreviewTimer = null;
  let earthPreviewGeneration = 0;
  let earthSelectedIndex = -1;
  let earthSelectionGeneration = 0;
  let earthLastFrameTime = -1;
  let earthResourcesReady = false;
  // Earth zoom map state machine (Z1). earthZoom is the live eased scale;
  // earthZoomTarget is where stick/wheel/dock input is steering. Focus +
  // anchor pin one lat/lon's surface point to a fixed world spot while
  // zoomed (the world comes to the user, never the reverse).
  let earthZoom = 1;
  let earthZoomTarget = 1;
  let earthFocus = null;
  let earthZoomAnchor = null;
  let earthZoomAnim = null;
  let earthZoomApplied = -1;
  let earthLabelDetail = '';
  let earthLabelTitle = '';
  // Z3 clustering state (docs/earth-zoom-map-plan.md §8): the activity fetch
  // follows the slippy tile band so heat resolves finer as the viewer zooms.
  let earthActivityZoom = null;      // zoom param of the last successful fetch
  let earthActivityRefetchTimer = null;
  let earthHeatGroup = null;         // heat sprite overlay (above the tiles)
  let earthHeatSprites = [];         // [{ mesh, material, location, baseScale }]
  let earthHeatTexture = null;       // shared radial-gradient alpha sprite
  // Z2 slippy tile layer state (docs/earth-zoom-map-plan.md §7).
  let earthTileGroup = null;   // child of earthMesh: inherits yaw/pitch + zoom scale
  let earthTiles = new Map();  // 'z/x/y' → { mesh, material, texture, state, lastUse }
  let earthTileQueue = [];     // [{key, z, x, y, dist}] pending fetch, center-sorted
  let earthTileInFlight = 0;
  let earthTileZ = -1;         // tile band currently materialized (-1 = none)
  let earthTileCenterKey = ''; // center tile of the last maintenance run
  let earthTileLastMaintain = -1;
  let earthTileAvailable = true; // false → crossfade never engages (offline/flag)
  let earthTileFailures = 0;
  let earthTileBaseFade = -1;  // last opacity pushed to the base globe material
  let earthTileClock = -1;     // high-water frame time (probe scheduling)
  let earthTileProbeAt = -1;   // degraded-mode re-arm deadline (frame clock)
  let earthTileLoadRatio = 1;  // ready / (ready + pending); 1 = nothing waited on
  let earthTilePrefetch = new Map(); // 'z/x/y' → { z, x, y, state: 'loading'|'ready', img } next-band warm cache

  // Notification State
  let notificationText = '';
  let notificationUntil = 0;

  // Input & Hover State
  let hoveredButton = -1;
  let pressedButton = -1;
  let lastControlsCanvasX = 0;
  let lastControlsCanvasY = 0;
  let lastCommentsCanvasX = 0;
  let lastCommentsCanvasY = 0;
  let cPanelTab = 'all';
  let cPanelScrollY = 0;
  let cPanelMaxScroll = 0;
  let cPanelHover = '';
  let cPanelHighlightId = null;
  let cPanelHighlightTimer = null;
  let cPanelDrag = false;
  let cPanelDragStartCanvasY = 0;
  let cPanelDragStartScroll = 0;
  let cPanelDragMoved = false;
  let commentsPanelVisible = false;
  // XR gamepad edge-trigger bookkeeping (upstream processInput state)
  let prevBtnState = { rightA: false, rightB: false };
  let flickedX = false;
  let flickedY = false;
  // Controls auto-hide (upstream: dock hides 5s after last interaction
  // while playing; B / tap / pause reveals it again).
  let controlsAutoHideTimer = null;
  // In-screen popup comment overlay state
  let overlayRegions = [];
  let overlayHoverId = null;
  let overlayHasPopups = false;
  let lastOverlayUploadT = -1;
  let lastOverlayKey = '';
  // Guide panel upload-once state
  let vrGuideUploaded = false;
  // ?dockfreeze=1 painted flag (reset per session in cleanup).
  let dockFreezePainted = false;
  // VR comment keyboard (DOM overlay) state
  let domOverlayRoot = null;
  let domOverlayInput = null;
  let pendingSyncTime = null;

  // Telemetry & Render Stats
  const renderStats = {
    earthDrawCalls: 0,
    reelDrawCalls: 0,
    starDrawCalls: 0,
    videoUploads: 0,
    earthPreviewUploads: 0,
    overlayUploads: 0,
    dockUploads: 0,
    panelUploads: 0,
    guideUploads: 0,
    // Transition diagnostics (v8.6 black-square attribution): source-change
    // notifications, black-clear fills, and video uploads skipped while the
    // element is still buffering.
    transChanges: 0,
    transClears: 0,
    transNotReady: 0,
  };
  let lastPreviewEmitTime = 0;

  // Video upload gating (avoids re-uploading identical frames every tick)
  let lastVisualKind = '';
  let lastVisualVersion = '';
  let lastVisualElement = null;
  let lastVideoTime = -1;
  let lastVideoFrameCount = -1;
  // v8.11: monotonic ms of the last successful video upload (throttle gate).
  let lastVideoUploadMs = 0;
  // ~30/s ceiling for video uploads (30fps masters; §3.6 gate-leak fix).
  const VR_VIDEO_UPLOAD_MIN_MS = 33;

  // Decoded-frame counter for upload gating (legacy Fix #1 verbatim): the
  // currentTime float advances every XR frame while playing, so keying on it
  // re-uploaded every frame (~90/s). totalVideoFrames ticks once per decoded
  // frame (~source fps) instead. -1 when the API is absent (old browsers,
  // mocks) → falls back to the currentTime check.
  function decodedFrameCount(element) {
    try {
      const q = element && element.getVideoPlaybackQuality ? element.getVideoPlaybackQuality() : null;
      const vf = q ? Number(q.totalVideoFrames) : NaN;
      return Number.isFinite(vf) && vf >= 0 ? Math.floor(vf) : -1;
    } catch (e) { return -1; }
  }

  // Three.js Core Instances
  let THREE = (typeof window !== 'undefined' && window.THREE) || null;
  let renderer = null;
  let lastRendererOpts = null; // effective {alpha, antialias} at creation (diag + tests)
  let lastSessionRequestedFeatures = null; // optionalFeatures sent with the session request (diag proof)
  let scene = null;
  let camera = null;
  let orbitControls = null;
  let raycaster = null;
  let scratchVec = null;
  let glContext = null;

  // Video Frame Tracking
  let hasNewVideoFrame = true;
  let videoFrameCallbackId = null;
  let videoFrameTrackingGeneration = 0;

  // Earth async management
  let earthActivityGeneration = 0;
  let earthActivityAbort = null;
  let earthPreviewAbortController = null;

  // 3D Objects & Meshes
  let screenMesh = null;
  let ambilightMesh = null;
  let overlayMesh = null;
  let guideMesh = null;
  let laserLine = null;
  let laserPositions = null;
  let reticleMesh = null;
  let reticleTexture = null;
  // Last pointer-handler exception (never let a canvas handler die
  // silently: surface it for telemetry instead).
  let lastPointerError = '';
  // Last mouse-driven hover ray in preview (persistent head-ray endpoint).
  let previewHoverRay = null;
  // Reticle hover offset off the hit surface (meters along the ray).
  const RETICLE_PULLBACK = 0.02;
  // Active XR ray shown by the shared laser (per-frame copy + source hand).
  // Trigger clicks from the same hand reuse it (see chooseSelectRay).
  let activeRayOrigin = null;
  let activeRayDir = null;
  let activeRayHandedness = '';

  function capturePointerError(where, e) {
    lastPointerError = where + ': ' + String((e && e.message) || e).slice(0, 200);
    try { console.warn('[WebXRVR] Pointer handler failed (' + where + '):', e); } catch (e2) {}
  }
  let scratchMat4 = null;
  let scratchVec2 = null;
  let scratchVec3 = null;
  let headQuat = null;
  let glowAlphaTexture = null;
  let glowProbeCanvas = null;
  let glowProbeCtx = null;
  // Ambient glow color state (upstream updateAmbilightColor semantics:
  // 8x8 video probe, enhance, lerp toward target).
  let glowColor = [0.10, 0.24, 0.62];
  let glowTarget = [0.10, 0.24, 0.62];
  let lastGlowSample = -1;
  let controlsMesh = null;
  let commentsMesh = null;
  let starfieldPoints = null;
  let earthGroup = null;
  let earthMesh = null;
  let earthPinsGroup = null;
  let earthPreviewMesh = null;
  let earthMapCanvas = null;
  let earthMapCtx = null;
  let earthMapTexture = null;
  let earthMapDirty = true;
  let earthBaseSource = 'fallback';
  let earthBaseTried = false;
  let earthBaseStale = true;
  let earthLabelCanvas = null;
  let earthLabelCtx = null;
  let earthLabelTexture = null;
  let earthLabelMesh = null;
  let lastEarthLabelKey = '';
  let lastEarthPreviewUpdate = -1;
  let pinSharedGeo = null;
  let heatSpriteGeo = null; // shared unit quad for the Z3 heat overlay

  // 2D Canvases & Textures
  let vrProxyCanvas = null;
  let vrProxyCtx = null;
  let videoTexture = null;
  // v8.13 direct path (?vrtex=video): THREE.VideoTexture bound straight to
  // the screen material, bypassing the canvas blit + re-upload entirely.
  let directVideoTexture = null;
  let directVideoElement = null;
  let screenMapBeforeDebug = null;
  let controlsCanvas = null;
  let controlsCtx = null;
  let controlsTexture = null;
  let commentsCanvas = null;
  let commentsCtx = null;
  let commentsTexture = null;
  let overlayCanvas = null;
  let overlayCtx = null;
  let overlayTexture = null;
  let guideCanvas = null;
  let guideCtx = null;
  let guideTexture = null;
  let earthPreviewCanvas = null;
  let earthPreviewCtx = null;
  let earthPreviewTexture = null;

  function getXR() {
    return typeof navigator !== 'undefined' && navigator.xr ? navigator.xr : null;
  }

  function getUICanvas() {
    return (typeof window !== 'undefined' && window.VRUICanvas) || null;
  }

  function ensureThree() {
    if (!THREE && typeof window !== 'undefined' && window.THREE) {
      THREE = window.THREE;
    }
    if (!raycaster && THREE) {
      raycaster = new THREE.Raycaster();
    }
    return THREE;
  }

  // Legacy-identical texture sampling (v5.2 set LINEAR / no mipmaps on every
  // texture): crisper UI text than three's mipmapped CanvasTexture default,
  // and no mipmap regeneration cost on every re-upload. Applied to every
  // CanvasTexture the engine creates.
  function applyLinearSampling(tex) {
    if (!tex) return tex;
    try {
      if (THREE) {
        if (THREE.LinearFilter !== undefined) {
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
        }
        tex.generateMipmaps = false;
      }
    } catch (e) {}
    return tex;
  }

  // ─── Preview sizing & camera ──────────────────────────────────────
  // Mirrors the old raw-WebGL resizePreviewCanvas(): keeps the drawing
  // buffer in sync with CSS layout every frame instead of freezing the
  // first-observed clientWidth forever.
  function updatePreviewSize(canvas) {
    const target = canvas || previewCanvas;
    if (!target || !renderer || !camera) return false;
    const cssW = (target.clientWidth || 960);
    const cssH = (target.clientHeight || 540);
    const ratio = (typeof window !== 'undefined' && renderer.getPixelRatio)
      ? renderer.getPixelRatio()
      : 1;
    const width = Math.max(2, Math.round(cssW * ratio));
    const height = Math.max(2, Math.round(cssH * ratio));
    let resized = false;
    if (target.width !== width || target.height !== height) {
      try {
        renderer.setSize(cssW, cssH, false);
        if (target.width !== width || target.height !== height) {
          target.width = width;
          target.height = height;
        }
      } catch (e) {}
      resized = true;
    }
    const aspect = cssW / Math.max(1, cssH);
    if (Math.abs(camera.aspect - aspect) > 0.0001) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      resized = true;
    }
    return resized;
  }

  // ─── v8.3 Screen-anchored UI layout ─────────────────────────────────
  // Upstream-faithful: the dock hangs below the screen bottom edge and
  // faces the viewer with locked roll; the comments panel flanks the
  // screen on the LEFT and the guide on the RIGHT (upstream geometry
  // verbatim). Pure math so the Node harness can assert clearances
  // without GL. v8.3 deviation: the locked-mode anchor tracks
  // screenDistance and all sizes track the live screenScale, so scale +
  // distance changes keep the control panel on the reel player.
  const DOCK_GAP = 0.08;
  // Earth-station console: floats before + below the globe (front surface
  // z≈-0.62, bottom y≈0.44) so it is reachable, fully visible, and carries
  // the ride back to reels. Station chosen with the viewer tilt applied:
  // the tilted top edge still clears the sphere (see dock test).
  const EARTH_DOCK_POS = { x: 0, y: 0.20, z: -0.85 };

  // Target world sizes (meters) for a given screen base size.
  function dockTargetSize(base) {
    const w = base * 0.82;
    return { w, h: w * (384 / 1024) };
  }
  function commentsPanelTargetSize(base) {
    const ui = getUICanvas();
    const aspect = ui ? (ui.CPANEL_H / ui.CPANEL_W) : (680 / 560);
    const w = base * CPANEL_SCALE_FACTOR;
    return { w, h: w * aspect };
  }
  function guideTargetSize(base) {
    const ui = getUICanvas();
    const aspect = ui ? (ui.GUIDE_H / ui.GUIDE_W) : (760 / 440);
    const w = base * GUIDE_SCALE_FACTOR;
    return { w, h: w * aspect };
  }

  // Legacy-exact lock semantics (v5.2 verbatim, owner-confirmed 2026-09-20):
  // LOCKED = head-locked screen, room-fixed UI (dock/panels stay at the
  // default screen spot, sized at DEFAULT_SCALE). UNLOCKED = free screen with
  // UI derived screen-relative at live screenScale. (The v8.4 tandem rig was
  // reverted per owner request.)
  function getLockedAnchor() {
    return { x: DEFAULT_POS.x, y: DEFAULT_POS.y, z: DEFAULT_POS.z };
  }

  function ensureScreenQuat() {
    ensureThree();
    if (!screenQuat && THREE) {
      try { screenQuat = new THREE.Quaternion(); } catch (e) { screenQuat = null; }
    }
    return screenQuat;
  }

  // Screen-local offset → world offset via the screen orientation
  // (identity when Three is unavailable, e.g. early Node harness calls).
  function rotateOffsetByScreenQuat(off) {
    ensureScreenQuat();
    try {
      if (screenQuat && THREE) {
        if (!scratchVec) scratchVec = new THREE.Vector3();
        scratchVec.set(off.x, off.y, off.z).applyQuaternion(screenQuat);
        return { x: scratchVec.x, y: scratchVec.y, z: scratchVec.z };
      }
    } catch (e) {}
    return { x: off.x, y: off.y, z: off.z };
  }

  function screenNormalWorld() {
    ensureScreenQuat();
    try {
      if (screenQuat && THREE) {
        if (!scratchVec2) scratchVec2 = new THREE.Vector3();
        scratchVec2.set(0, 0, 1).applyQuaternion(screenQuat);
        return { x: scratchVec2.x, y: scratchVec2.y, z: scratchVec2.z };
      }
    } catch (e) {}
    return { x: 0, y: 0, z: 1 };
  }

  // Head orientation as a THREE.Quaternion (camera world quaternion).
  // Null when Three is unavailable; callers fall back to forward −Z.
  function getHeadQuaternion() {
    ensureThree();
    try {
      if (!headQuat && THREE) headQuat = new THREE.Quaternion();
      if (camera && headQuat && camera.getWorldQuaternion) {
        camera.getWorldQuaternion(headQuat);
        return headQuat;
      }
    } catch (e) {}
    return null;
  }

  // Head-locked screen mode (upstream applyLockToViewer, Three.js port):
  // keeps the screen at screenDistance in front of the face, perpendicular
  // to the view direction, so the user always looks into the center.
  function applyLockToViewer() {
    const head = getHeadPosition();
    const q = getHeadQuaternion();
    ensureScreenQuat();
    let fx = 0, fy = 0, fz = -1;
    if (q && THREE) {
      try {
        if (!scratchVec) scratchVec = new THREE.Vector3();
        scratchVec.set(0, 0, -1).applyQuaternion(q);
        fx = scratchVec.x; fy = scratchVec.y; fz = scratchVec.z;
      } catch (e) {}
    }
    screenPos = {
      x: head.x + fx * screenDistance,
      y: head.y + fy * screenDistance,
      z: head.z + fz * screenDistance,
    };
    if (screenQuat && q) {
      try { screenQuat.copy(q); } catch (e) {}
    }
  }

  // Pure pose math for the locked screen (head pos + head forward unit
  // vector + distance). Test seam for the lock geometry (no THREE needed).
  function computeLockedPose(headPos, headFwd, dist) {
    const hx = (headPos && Number(headPos.x)) || 0;
    const hy = (headPos && Number(headPos.y)) || 1.52;
    const hz = (headPos && Number(headPos.z)) || 0;
    const fx = (headFwd && Number(headFwd.x)) || 0;
    const fy = (headFwd && Number(headFwd.y)) || 0;
    const fz = (headFwd && Number(headFwd.z) !== undefined) ? Number(headFwd.z) : -1;
    const d = (dist === undefined || dist === null) ? screenDistance : Number(dist);
    return {
      x: hx + fx * d,
      y: hy + fy * d,
      z: hz + fz * d,
    };
  }

  function clampScreenScale(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return screenScale;
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, n));
  }

  function clampScreenDistance(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return screenDistance;
    return Math.max(MIN_DIST, Math.min(MAX_DIST, n));
  }

  function computeDockPose(headPos, mode) {
    const m = mode || sceneMode;
    let pos;
    if (m === 'earth') {
      pos = { x: EARTH_DOCK_POS.x, y: EARTH_DOCK_POS.y, z: EARTH_DOCK_POS.z };
    } else if (lockToViewer) {
      // Legacy-exact: the transport panel stays fixed and level in the room
      // at the default screen spot while the locked screen follows the gaze.
      const a = getLockedAnchor();
      pos = { x: a.x, y: a.y - DEFAULT_SCALE / 2 - DOCK_GAP, z: a.z };
    } else {
      const off = rotateOffsetByScreenQuat({ x: 0, y: -screenScale / 2 - DOCK_GAP, z: 0 });
      pos = { x: screenPos.x + off.x, y: screenPos.y + off.y, z: screenPos.z + off.z };
    }
    const hx = (headPos && Number(headPos.x)) || 0;
    const hy = (headPos && Number(headPos.y)) || 1.6;
    const hz = (headPos && Number(headPos.z)) || 0;
    const dx = hx - pos.x;
    const dy = hy - pos.y;
    const dz = hz - pos.z;
    return {
      pos,
      yaw: Math.atan2(dx, dz),
      pitch: -Math.atan2(dy, Math.hypot(dx, dz)),
    };
  }

  // Side-panel world layout (upstream getCommentsPanelCenter/Size +
  // getGuideCenter verbatim, LEFT comments / RIGHT guide).
  // Legacy-exact panel geometry: locked = room-fixed at the default screen
  // spot sized at DEFAULT_SCALE; unlocked = screen-relative at live scale
  // (upstream getCommentsPanelCenter/Size + getGuideCenter verbatim).
  function getCommentsPanelLayout() {
    const base = lockToViewer ? DEFAULT_SCALE : screenScale;
    const size = commentsPanelTargetSize(base);
    let center;
    if (lockToViewer) {
      const a = getLockedAnchor();
      center = {
        x: a.x - base / 2 - size.w / 2 - PANEL_SIDE_GAP,
        y: a.y,
        z: a.z + PANEL_FWD_OFFSET,
      };
    } else {
      const off = rotateOffsetByScreenQuat({
        x: -base / 2 - size.w / 2 - PANEL_SIDE_GAP, y: 0, z: PANEL_FWD_OFFSET,
      });
      center = { x: screenPos.x + off.x, y: screenPos.y + off.y, z: screenPos.z + off.z };
    }
    return { center, w: size.w, h: size.h };
  }

  function getGuidePanelLayout() {
    const base = lockToViewer ? DEFAULT_SCALE : screenScale;
    const size = guideTargetSize(base);
    let center;
    if (lockToViewer) {
      const a = getLockedAnchor();
      center = {
        x: a.x + base / 2 + size.w / 2 + PANEL_SIDE_GAP,
        y: a.y,
        z: a.z + PANEL_FWD_OFFSET,
      };
    } else {
      const off = rotateOffsetByScreenQuat({
        x: base / 2 + size.w / 2 + PANEL_SIDE_GAP, y: 0, z: PANEL_FWD_OFFSET,
      });
      center = { x: screenPos.x + off.x, y: screenPos.y + off.y, z: screenPos.z + off.z };
    }
    return { center, w: size.w, h: size.h };
  }

  function getHeadPosition() {
    const out = { x: 0, y: 1.6, z: 0 };
    try {
      if (camera) {
        if (xrSession && camera.getWorldPosition) {
          if (!scratchVec && THREE) scratchVec = new THREE.Vector3();
          if (scratchVec) {
            camera.getWorldPosition(scratchVec);
            out.x = scratchVec.x;
            out.y = scratchVec.y;
            out.z = scratchVec.z;
            return out;
          }
        }
        out.x = camera.position.x;
        out.y = camera.position.y;
        out.z = camera.position.z;
      }
    } catch (e) {}
    return out;
  }

  // Yaw/pitch face the viewer with zero roll (upstream quatFaceViewerLevel).
  function faceViewerLevel(obj, headPos, pitchOverride) {
    if (!obj || !headPos) return;
    const dx = headPos.x - obj.position.x;
    const dy = headPos.y - obj.position.y;
    const dz = headPos.z - obj.position.z;
    obj.rotation.order = 'YXZ';
    obj.rotation.set(
      pitchOverride !== undefined ? pitchOverride : -Math.atan2(dy, Math.hypot(dx, dz)),
      Math.atan2(dx, dz),
      0
    );
  }

  // Commits the screen transform to the screen + glow + overlay meshes
  // (called every frame after lock/grab/scale/distance updates).
  function commitScreenTransform() {
    if (!screenMesh || !THREE) return;
    ensureScreenQuat();
    // Uniform scale (upstream: the dome scales as R_world = R·screenScale —
    // scaling x/y only would leave the curvature depth baked at the 2.4 m
    // base and flatten the dome at larger sizes).
    try {
      screenMesh.position.set(screenPos.x, screenPos.y, screenPos.z);
      if (screenQuat) screenMesh.quaternion.copy(screenQuat);
      const s = screenScale / 2.4; // geometry is built at 2.4 m
      screenMesh.scale.set(s, s, s);
    } catch (e) {}
    if (ambilightMesh) {
      try {
        const n = screenNormalWorld();
        ambilightMesh.position.set(
          screenPos.x - n.x * 0.06,
          screenPos.y - n.y * 0.06,
          screenPos.z - n.z * 0.06
        );
        if (screenQuat) ambilightMesh.quaternion.copy(screenQuat);
        const s = screenScale / 2.4; // glow geometry is pre-sized 1.34x
        ambilightMesh.scale.set(s, s, s);
      } catch (e) {}
    }
    if (overlayMesh) {
      try {
        overlayMesh.position.set(screenPos.x, screenPos.y, screenPos.z);
        if (screenQuat) overlayMesh.quaternion.copy(screenQuat);
        const s = screenScale / 2.4;
        overlayMesh.scale.set(s, s, s);
      } catch (e) {}
    }
  }

  function layoutCommentsPanel(headPos) {
    if (!commentsMesh) return;
    const layout = getCommentsPanelLayout();
    commentsMesh.position.set(layout.center.x, layout.center.y, layout.center.z);
    try { commentsMesh.scale.set(layout.w / 1.05, layout.h / 1.28, 1); } catch (e) {}
    faceViewerLevel(commentsMesh, headPos);
  }

  function layoutGuidePanel(headPos) {
    if (!guideMesh) return;
    const layout = getGuidePanelLayout();
    guideMesh.position.set(layout.center.x, layout.center.y, layout.center.z);
    try {
      const ui = getUICanvas();
      const aspect = ui ? (ui.GUIDE_H / ui.GUIDE_W) : (760 / 440);
      guideMesh.scale.set(layout.w, layout.h / aspect, 1);
    } catch (e) {}
    faceViewerLevel(guideMesh, headPos);
  }

  function layoutControlsDock() {
    if (!controlsMesh) return;
    const headPos = getHeadPosition();
    const pose = computeDockPose(headPos);
    controlsMesh.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
    if (!lockToViewer && sceneMode !== 'earth' && screenQuat) {
      // Unlocked: the dock rides with the screen (upstream getControlsQuat).
      try { controlsMesh.quaternion.copy(screenQuat); } catch (e) {}
    } else {
      controlsMesh.rotation.order = 'YXZ';
      controlsMesh.rotation.set(pose.pitch, pose.yaw, 0);
    }
    // Legacy-exact dock sizing: earth 1.2, locked DEFAULT_SCALE, else live.
    const base = (sceneMode === 'earth') ? 1.2 : (lockToViewer ? DEFAULT_SCALE : screenScale);
    const size = dockTargetSize(base);
    try { controlsMesh.scale.set(size.w / 1.6, size.h / 0.6, 1); } catch (e) {}
    // Side panels keep their stations but face the viewer too.
    layoutCommentsPanel(headPos);
    layoutGuidePanel(headPos);
  }

  // Applies headset yaw/pitch or orbit spherical position to the camera.
  // Headset mode keeps the old custom drag-look (OrbitControls disabled);
  // orbit mode is fully delegated to THREE.OrbitControls.
  function applyPreviewCamera() {    if (!camera) return;
    if (previewCameraMode === 'orbit') {
      const tx = 0, ty = 1.4, tz = -2.0;
      const d = previewOrbitDistance;
      const cp = Math.cos(previewOrbitPitch), sp = Math.sin(previewOrbitPitch);
      const cy = Math.cos(previewOrbitYaw), sy = Math.sin(previewOrbitYaw);
      camera.position.set(tx + d * sy * cp, ty + d * sp, tz + d * cy * cp);
      camera.lookAt(tx, ty, tz);
      if (orbitControls && orbitControls.target) {
        orbitControls.target.set(tx, ty, tz);
      }
    } else {
      camera.position.set(0, 1.6, 0);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(previewPitch, previewYaw, 0);
    }
  }

  // ─── Visual Source Helper ───────────────────────────────────────────
  function getVisualSource() {
    let source = null;
    if (callbacks.getVisualSource) {
      try { source = callbacks.getVisualSource(); } catch (e) { source = null; }
    }
    if (!source || !source.element) {
      source = {
        kind: 'video',
        element: videoElement,
        ready: !!(videoElement && videoElement.readyState >= 2),
        paused: !videoElement || !!videoElement.paused,
        muted: !videoElement || !!videoElement.muted,
        currentTime: videoElement ? Number(videoElement.currentTime) || 0 : 0,
        duration: videoElement && Number.isFinite(videoElement.duration) ? videoElement.duration : 0,
        version: videoElement ? String(videoElement.currentSrc || videoElement.src || '') : '',
      };
    }
    const kind = source.kind === 'image' || source.kind === 'static-card' ? source.kind : 'video';
    return {
      ...source,
      kind,
      ready: source.ready !== false && !!source.element,
      paused: source.paused !== false,
      muted: source.muted !== false,
      currentTime: Math.max(0, Number(source.currentTime) || 0),
      duration: Math.max(0, Number(source.duration) || 0),
      version: String(source.version === undefined || source.version === null ? '' : source.version),
    };
  }

  // ─── Path A: Screen Geometry Generation ─────────────────────────────
  function createScreenGeometry(mode, width = 2.4, height = 2.4, segX = 48, segY = 48) {
    ensureThree();
    if (!THREE) return null;
    if (mode === 0) {
      return new THREE.PlaneGeometry(width, height);
    }

    const geo = new THREE.PlaneGeometry(width, height, segX, segY);
    const pos = geo.attributes.position;
    const halfW = width / 2;
    const halfH = height / 2;
    const R = SPHERE_RADIUS;
    const alpha = ARC_ANGLE;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      let nx = x, ny = y, nz = 0;

      if (mode === 1) {
        // DOME: Concave spherical radial cap
        const r = Math.sqrt(x * x + y * y);
        if (r > 0.0001) {
          const phi = (r / halfW) * alpha;
          const factor = (R * Math.sin(phi)) / r;
          nx = x * factor;
          ny = y * factor;
          nz = R * (1 - Math.cos(phi));
        }
      } else if (mode === 2) {
        // SQ CURVE: Biaxial pillow curve
        const thX = (x / halfW) * alpha;
        const thY = (y / halfH) * alpha;
        nx = R * Math.sin(thX);
        ny = R * Math.sin(thY);
        nz = R * (1 - Math.cos(thX) * Math.cos(thY));
      }

      pos.setXYZ(i, nx, ny, nz);
    }

    geo.computeVertexNormals();
    return geo;
  }

  // ─── Geographic & Spherical Math ────────────────────────────────────
  function locationToUnit(lat, lon) {
    const phi = (Number(lat) || 0) * (Math.PI / 180);
    const theta = (Number(lon) || 0) * (Math.PI / 180);
    const cosPhi = Math.cos(phi);
    return {
      x: Math.sin(theta) * cosPhi,
      y: Math.sin(phi),
      z: Math.cos(theta) * cosPhi,
    };
  }

  // Z3b: geohash cell geometry (decode mirrors the server's
  // `_geohash_cell_center`, extended to full cell bounds). Cluster
  // blob/hit sizing takes the cell's true angular half-extent so blobs
  // cover their geographic cell at any zoom; the heat floor below keeps
  // fine cells tappable.
  const EARTH_GEOHASH_B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

  function earthGeohashCellBounds(geohash) {
    if (typeof geohash !== 'string' || geohash.length === 0 || geohash.length > 12) return null;
    let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
    let even = true;
    for (let i = 0; i < geohash.length; i++) {
      const idx = EARTH_GEOHASH_B32.indexOf(geohash[i]);
      if (idx < 0) return null;
      for (let mask = 16; mask > 0; mask >>= 1) {
        if (even) {
          const mid = (lonLo + lonHi) / 2;
          if (idx & mask) lonLo = mid; else lonHi = mid;
        } else {
          const mid = (latLo + latHi) / 2;
          if (idx & mask) latLo = mid; else latHi = mid;
        }
        even = !even;
      }
    }
    if (!(latHi > latLo) || !(lonHi > lonLo)) return null;
    return { latLo, latHi, lonLo, lonHi };
  }

  // Angular half-extent (cell center → corner) in radians; 0 when undecodable.
  function earthGeohashCellAngularRadius(geohash) {
    const cell = earthGeohashCellBounds(geohash);
    if (!cell) return 0;
    const midLat = (cell.latLo + cell.latHi) / 2 * Math.PI / 180;
    const dLat = (cell.latHi - cell.latLo) / 2 * Math.PI / 180;
    const dLon = (cell.lonHi - cell.lonLo) / 2 * Math.PI / 180 * Math.cos(midLat);
    return Math.hypot(dLat, dLon);
  }

  function earthZoneAngularRadius(location) {
    const heat = Math.max(0, Math.min(1, Number(location && location.heat) || 0));
    const base = 0.11 + heat * 0.12;
    if (location && location.kind === 'cluster' && typeof location.geohash === 'string') {
      return Math.max(base, earthGeohashCellAngularRadius(location.geohash));
    }
    return base;
  }

  // Standard equirect canvas position (upstream verbatim): x =
  // (lon+180)/360*W, y = (90-lat)/180*H. This matches the Natural Earth
  // photo's own convention AND the pins/hit-test frame once the texture
  // offset below compensates THREE.SphereGeometry's UV seam (u=0 sits on
  // the -X axis, i.e. 90° off standard equirect): with
  // earthMapTexture.offset.x = +0.25 and RepeatWrapping, painted texel,
  // photo texel, pin direction, and hit-test vector all coincide.
  function earthZoneUV(lat, lon, w, h) {
    const lonN = ((Number(lon) + 180) % 360 + 360) % 360;
    return { x: (lonN / 360) * w, y: ((90 - Number(lat)) / 180) * h };
  }

  function earthHeatOf(location) {
    return Math.max(0, Math.min(1, Number(location && location.heat) || 0));
  }

  // Deterministic speckle so repaints don't reshuffle the starfield grain.
  // Pure pixel classifier for the holographic re-style (upstream
  // buildHolographicEarthBase verbatim). Returns 1 for land, 0 for ocean.
  function classifyEarthPixel(r, g, b) {
    return (((r + g) * 0.5 - b) > -10 || (r + g + b) > 720) ? 1 : 0;
  }

  // Pure heat-style lookup (upstream drawEarthHeatZone verbatim).
  function earthHeatStyle(heat, state) {
    const h = Math.max(0, Math.min(1, Number(heat) || 0));
    return {
      stops: [
        [0, 'rgba(255,52,24,' + (0.66 + h * 0.28).toFixed(3) + ')'],
        [0.22, 'rgba(255,119,20,' + (0.60 + h * 0.22).toFixed(3) + ')'],
        [0.52, 'rgba(255,222,45,' + (0.28 + h * 0.20).toFixed(3) + ')'],
        [0.78, 'rgba(34,221,255,0.18)'],
        [1, 'rgba(16,177,255,0)'],
      ],
      ringCount: h > 0.72 ? 3 : (h > 0.36 ? 2 : 1),
      ringColor: state === 2 ? '#FFFFFF' : (state === 1 ? '#9CF4FF' : 'rgba(255,221,84,0.58)'),
    };
  }

  // Holographic tile restyle (follow-up): OSM raster tiles arrive in a
  // light cartographic style that clashes with the dark holographic globe,
  // so each tile is re-graded into the globe palette (the
  // buildHolographicEarthBase land/ocean/edge formulas, reused verbatim).
  // OSM ink (street labels, symbols) and paper (white roads, halos) would
  // vanish on the dark ramp, so they get their own classes and glow:
  //   0 ocean — OSM water blues (the photo classifier already says ocean)
  //   1 land  — fills: beige, parks, urban gray
  //   2 ink   — dark pixels (L < 0.5): text/symbols glow bright cyan-white.
  //     Uniformly bright (no luminance ramp): OSM glyphs are dark cores in
  //     white halos, and a ramped core reads as black-text-on-white-border
  //     ringing at small sizes. The 0.5 threshold also swallows the
  //     anti-aliased fringe so strokes render bold, not hollow.
  //   3 paper — bright achromatic (L ≥ 0.9, saturation < 6): roads glow ice
  function earthHoloTileLuminance(r, g, b) {
    return (r * 0.25 + g * 0.55 + b * 0.20) / 255;
  }

  function earthHoloTileClass(r, g, b) {
    const lum = earthHoloTileLuminance(r, g, b);
    if (lum < 0.5) return 2;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (lum >= 0.9 && (mx - mn) < 6) return 3;
    return classifyEarthPixel(r, g, b);
  }

  // Exact per-pixel output for one class (globe ramp shared with the base).
  function earthHoloTilePixel(r, g, b) {
    const lum = earthHoloTileLuminance(r, g, b);
    const cls = earthHoloTileClass(r, g, b);
    if (cls === 3) {
      return [Math.round(205 + lum * 40), Math.round(228 + lum * 24), Math.round(244 + lum * 11)];
    }
    if (cls === 2) {
      return [200, 240, 255];
    }
    if (cls === 1) {
      return [Math.round(5 + lum * 16), Math.round(50 + lum * 72), Math.round(82 + lum * 105)];
    }
    return [Math.round(1 + lum * 4), Math.round(8 + lum * 13), Math.round(23 + lum * 25)];
  }

  // Two-pass composer over a flat RGBA buffer: classifies every pixel, then
  // paints the cyan edge where land-side meets ocean-side. Ink is excluded
  // from edges so text never gets a cyan box. Returns a new Uint8Array
  // (all outputs fit 0–255, so no clamping type is needed for tests; the
  // canvas wrapper below views it as clamped for putImageData).
  function styleEarthTilePixels(src, w, h) {
    const n = w * h;
    const cls = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      cls[i] = earthHoloTileClass(src[o], src[o + 1], src[o + 2]);
    }
    const landish = (c) => c === 1 || c === 3;
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = i * 4;
        const c = cls[i];
        let edge = false;
        if (c !== 2) {
          const left = cls[y * w + Math.max(0, x - 1)];
          const right = cls[y * w + Math.min(w - 1, x + 1)];
          const up = cls[Math.max(0, y - 1) * w + x];
          const down = cls[Math.min(h - 1, y + 1) * w + x];
          edge = (left !== 2 && landish(left) !== landish(c)) ||
            (right !== 2 && landish(right) !== landish(c)) ||
            (up !== 2 && landish(up) !== landish(c)) ||
            (down !== 2 && landish(down) !== landish(c));
        }
        const rgb = edge ? [42, 222, 255] : earthHoloTilePixel(src[o], src[o + 1], src[o + 2]);
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
        out[o + 3] = src[o + 3];
      }
    }
    return out;
  }

  // Re-grade one tile image into the holo palette. Each call mints a FRESH
  // canvas (never a shared scratch): THREE uploads canvas textures lazily
  // on the next render, so a shared canvas would show every tile the last
  // tile drawn. Returns the styled canvas, or null when styling is off
  // (?earthstyle=raw) or pixel access fails — the caller then falls back
  // to the raw image (stub images in tests take this path).
  function styleEarthTileImage(img) {
    if (!img || debugFlags.earthstyle === 'raw') return null;
    try {
      const w = Math.max(1, Math.min(512, img.naturalWidth || img.width || 0));
      const h = Math.max(1, Math.min(512, img.naturalHeight || img.height || 0));
      if (!w || !h || typeof document === 'undefined') return null;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const src = ctx.getImageData(0, 0, w, h);
      if (!src || !src.data) return null;
      const out = styleEarthTilePixels(src.data, w, h);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), w, h), 0, 0);
      return canvas;
    } catch (e) {
      return null;
    }
  }

  function earthTileStyleMode() {
    return debugFlags.earthstyle === 'raw' ? 'raw' : 'holo';
  }

  // Instant fallback base (upstream drawHolographicEarthFallback verbatim).
  function paintEarthBase(ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, EARTH_MAP_H);
    gradient.addColorStop(0, '#061D37');
    gradient.addColorStop(0.5, '#020B1A');
    gradient.addColorStop(1, '#06172D');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, EARTH_MAP_W, EARTH_MAP_H);
  }

  // Graticule overlay (upstream drawHolographicGrid verbatim).
  function paintEarthGrid(ctx) {
    if (!ctx) return;
    try { ctx.save(); } catch (e) {}
    for (let lon = -180; lon <= 180; lon += 10) {
      const x = ((lon + 180) / 360) * EARTH_MAP_W;
      const major = lon % 30 === 0;
      ctx.strokeStyle = major ? 'rgba(62, 202, 242, 0.18)' : 'rgba(42, 148, 188, 0.07)';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, EARTH_MAP_H);
      ctx.stroke();
    }
    for (let lat = -80; lat <= 80; lat += 10) {
      const y = ((90 - lat) / 180) * EARTH_MAP_H;
      const major = lat % 30 === 0;
      ctx.strokeStyle = major ? 'rgba(62, 202, 242, 0.18)' : 'rgba(42, 148, 188, 0.07)';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(EARTH_MAP_W, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(91, 221, 255, 0.028)';
    for (let y = 1; y < EARTH_MAP_H; y += 6) ctx.fillRect(0, y, EARTH_MAP_W, 1);
    try { ctx.restore(); } catch (e) {}
  }

  // Holographic re-style of the Natural Earth photo (upstream
  // buildHolographicEarthBase, painted onto the live map canvas instead of
  // a separate base canvas — identical output).
  function buildHolographicEarthBase(image) {
    if (!earthMapCtx) return false;
    paintEarthBase(earthMapCtx);
    if (image) {
      try {
        const sourceCanvas = document.createElement('canvas');
        const sourceW = Math.max(2, Math.min(EARTH_MAP_W, image.naturalWidth || image.width || 1024));
        const sourceH = Math.max(2, Math.min(EARTH_MAP_H, image.naturalHeight || image.height || 512));
        sourceCanvas.width = sourceW;
        sourceCanvas.height = sourceH;
        const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        sourceCtx.drawImage(image, 0, 0, sourceW, sourceH);
        const sourceImage = sourceCtx.getImageData(0, 0, sourceW, sourceH);
        const outputImage = sourceCtx.createImageData(sourceW, sourceH);
        const src = sourceImage.data;
        const out = outputImage.data;
        const land = new Uint8Array(sourceW * sourceH);
        for (let pixel = 0; pixel < land.length; pixel++) {
          const offset = pixel * 4;
          land[pixel] = classifyEarthPixel(src[offset], src[offset + 1], src[offset + 2]);
        }
        for (let y = 0; y < sourceH; y++) {
          const yUp = Math.max(0, y - 1);
          const yDown = Math.min(sourceH - 1, y + 1);
          for (let x = 0; x < sourceW; x++) {
            const pixel = y * sourceW + x;
            const offset = pixel * 4;
            const xLeft = x > 0 ? x - 1 : sourceW - 1;
            const xRight = x + 1 < sourceW ? x + 1 : 0;
            const isLand = land[pixel] === 1;
            const edge = isLand !== (land[y * sourceW + xLeft] === 1) ||
              isLand !== (land[y * sourceW + xRight] === 1) ||
              isLand !== (land[yUp * sourceW + x] === 1) ||
              isLand !== (land[yDown * sourceW + x] === 1);
            const luminance = (src[offset] * 0.25 + src[offset + 1] * 0.55 + src[offset + 2] * 0.20) / 255;
            if (edge) {
              out[offset] = 42;
              out[offset + 1] = 222;
              out[offset + 2] = 255;
            } else if (isLand) {
              out[offset] = Math.round(5 + luminance * 16);
              out[offset + 1] = Math.round(50 + luminance * 72);
              out[offset + 2] = Math.round(82 + luminance * 105);
            } else {
              out[offset] = Math.round(1 + luminance * 4);
              out[offset + 1] = Math.round(8 + luminance * 13);
              out[offset + 2] = Math.round(23 + luminance * 25);
            }
            out[offset + 3] = 255;
          }
        }
        sourceCtx.putImageData(outputImage, 0, 0);
        earthMapCtx.imageSmoothingEnabled = true;
        earthMapCtx.imageSmoothingQuality = 'high';
        earthMapCtx.drawImage(sourceCanvas, 0, 0, EARTH_MAP_W, EARTH_MAP_H);
        earthBaseSource = 'photo';
        // Photo base is now live: prevent refreshEarthTexture() from
        // repainting the fallback gradient over it.
        earthBaseStale = false;
      } catch (error) {
        console.warn('[WebXRVR] Holographic Earth conversion failed; using grid fallback:', error);
        paintEarthBase(earthMapCtx);
        earthBaseSource = 'fallback';
      }
    } else {
      earthBaseSource = 'fallback';
    }
    paintEarthGrid(earthMapCtx);
    earthMapDirty = true;
    refreshEarthTexture();
    return true;
  }

  // Photo loader: tries each URL in order, once. Never throws; the
  // procedural fallback is always usable underneath.
  function loadEarthBasePhoto() {
    if (earthBaseTried || typeof Image === 'undefined') return;
    earthBaseTried = true;
    const urls = EARTH_TEXTURE_URLS.slice();
    function tryNext() {
      if (!urls.length) return;
      const url = urls.shift();
      try {
        const image = new Image();
        try { image.decoding = 'async'; } catch (e) {}
        image.onload = function () {
          try {
            buildHolographicEarthBase(image);
          } catch (e) {}
        };
        image.onerror = function () {
          console.warn('[WebXRVR] Earth texture unavailable at ' + url);
          tryNext();
        };
        image.src = url;
      } catch (e) {
        tryNext();
      }
    }
    tryNext();
  }

  function earthZonePixelRadius(location) {
    const rad = earthZoneAngularRadius(location);
    const rY = Math.max(24, (rad / Math.PI) * EARTH_MAP_H);
    const latRad = Math.abs(Number(location && location.lat) || 0) * (Math.PI / 180);
    const rX = Math.min(rY * 3.2, rY / Math.max(0.32, Math.cos(latRad)));
    return { x: rX, y: rY };
  }

  // Repaints the equirect heat map only when dirty (activity load or mode
  // entry), never per frame. The base layer (photo re-style or fallback)
  // is painted only when stale — repainting it here used to obliterate an
  // asynchronously arrived photo base. Heat fill is upstream
  // drawEarthHeatZone verbatim (4-stop gradient + state rings).
  function refreshEarthTexture() {
    if (!earthMapDirty || !earthMapCtx) return;
    earthMapDirty = false;
    const ctx = earthMapCtx;
    try {
      if (earthBaseStale) {
        paintEarthBase(ctx);
        paintEarthGrid(ctx);
        earthBaseStale = false;
      }
      paintHeatZones(ctx);
    } catch (e) {}
    if (earthMapTexture) {
      try { earthMapTexture.needsUpdate = true; } catch (e) {}
    }
  }

  function paintHeatZones(ctx) {
    try {
      const zoneState = (loc) => {
        if (earthSelectedIndex >= 0 && earthLocations[earthSelectedIndex] === loc) return 2;
        if (earthHoveredIndex >= 0 && earthLocations[earthHoveredIndex] === loc) return 1;
        return 0;
      };
      const sorted = earthLocations.slice().sort((a, b) => {
        const sa = zoneState(a);
        const sb = zoneState(b);
        if (sa !== sb) return sa - sb;
        return earthHeatOf(a) - earthHeatOf(b);
      });
      ctx.globalCompositeOperation = 'lighter';
      for (const loc of sorted) {
        const u = earthZoneUV(loc.lat, loc.lon, EARTH_MAP_W, EARTH_MAP_H);
        const r = earthZonePixelRadius(loc);
        const heat = earthHeatOf(loc);
        const state = zoneState(loc);
        const style = earthHeatStyle(heat, state);
        for (let k = -1; k <= 1; k++) {
          const px = u.x + k * EARTH_MAP_W;
          if (px < -r.x || px > EARTH_MAP_W + r.x) continue;
          ctx.save();
          ctx.translate(px, u.y);
          ctx.scale(Math.max(0.2, r.x / Math.max(1, r.y)), 1);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r.y);
          for (const stop of style.stops) g.addColorStop(stop[0], stop[1]);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(0, 0, r.y, 0, Math.PI * 2);
          ctx.fill();
          // State rings (upstream counts/widths/colors).
          ctx.strokeStyle = style.ringColor;
          ctx.lineWidth = state ? 4 : 2;
          for (let ring = 0; ring < style.ringCount; ring++) {
            ctx.beginPath();
            ctx.arc(0, 0, r.y * (0.48 + ring * 0.18), 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    } catch (e) {}
    if (earthMapTexture) {
      try { earthMapTexture.needsUpdate = true; } catch (e) {}
    }
  }

  // 3D pulsing pins at exact location vectors (same convention as
  // hitTestEarth, so hover and visuals can never disagree).
  function rebuildEarthPins() {
    if (!earthPinsGroup || !THREE) return;
    try {
      while (earthPinsGroup.children.length > 0) {
        const child = earthPinsGroup.children[0];
        earthPinsGroup.remove(child);
        if (child.material) {
          try { child.material.dispose(); } catch (e) {}
        }
      }
      if (!pinSharedGeo) pinSharedGeo = new THREE.ConeGeometry(0.022, 0.07, 10);
      const up = new THREE.Vector3(0, 1, 0);
      const ranked = earthLocations.slice()
        .sort((a, b) => earthHeatOf(b) - earthHeatOf(a))
        .slice(0, EARTH_PIN_CAP);
      ranked.forEach((loc, i) => {
        const u = locationToUnit(loc.lat, loc.lon);
        const heat = earthHeatOf(loc);
        const color = heat > 0.66 ? 0xff5a3c : (heat > 0.33 ? 0xffb43c : 0x55e7ff);
        const mesh = new THREE.Mesh(pinSharedGeo, new THREE.MeshBasicMaterial({ color }));
        const dir = new THREE.Vector3(u.x, u.y, u.z);
        mesh.position.copy(dir).multiplyScalar(EARTH_RADIUS + 0.035);
        mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
        mesh.userData.pulsePhase = i * 0.7;
        mesh.userData.baseScale = 0.8 + heat * 0.9;
        mesh.scale.setScalar(mesh.userData.baseScale);
        earthPinsGroup.add(mesh);
      });
    } catch (e) {}
  }

  // ─── Z3 heat sprite overlay ──────────────────────────────────────────
  // Once the tile layer covers the holographic canvas, painted heat zones
  // would be hidden under the basemap. Heat therefore also exists as
  // additive billboard quads tangent to the sphere — ANGULAR size, so the
  // world footprint grows with zoom exactly like the canvas zones did, while
  // remaining legible over tiles at any scale (Snap's heat-over-basemap).
  function ensureEarthHeatTexture() {
    if (earthHeatTexture || typeof document === 'undefined') return earthHeatTexture;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.72, 'rgba(255,255,255,0.16)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(64, 64, 62, 0, Math.PI * 2);
      ctx.fill();
      earthHeatTexture = applyLinearSampling(new THREE.CanvasTexture(canvas));
      try { if (THREE.SRGBColorSpace !== undefined) earthHeatTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    } catch (e) {
      earthHeatTexture = null;
    }
    return earthHeatTexture;
  }

  function disposeEarthHeatSprites() {
    try {
      for (const sprite of earthHeatSprites) {
        if (sprite.mesh && earthHeatGroup) earthHeatGroup.remove(sprite.mesh);
        if (sprite.material) sprite.material.dispose();
      }
    } catch (e) {}
    earthHeatSprites = [];
  }

  function rebuildEarthHeatSprites() {
    if (!earthHeatGroup || !THREE) return;
    try {
      disposeEarthHeatSprites();
      const texture = ensureEarthHeatTexture();
      if (!texture) return;
      if (!heatSpriteGeo) heatSpriteGeo = new THREE.PlaneGeometry(2, 2);
      const zAxis = new THREE.Vector3(0, 0, 1);
      const ranked = earthLocations.slice()
        .sort((a, b) => earthHeatOf(b) - earthHeatOf(a))
        .slice(0, EARTH_PIN_CAP);
      ranked.forEach((loc) => {
        const heat = earthHeatOf(loc);
        const angular = earthZoneAngularRadius(loc);
        const halfExtent = EARTH_RADIUS * Math.sin(angular);
        const dir = locationToUnit(loc.lat, loc.lon);
        const color = heat > 0.66 ? 0xff5a3c : (heat > 0.33 ? 0xffb43c : 0x55e7ff);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          color,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.FrontSide,
        });
        const mesh = new THREE.Mesh(heatSpriteGeo, material);
        const vec = new THREE.Vector3(dir.x, dir.y, dir.z);
        mesh.position.copy(vec).multiplyScalar(EARTH_RADIUS + EARTH_TILE_RADIUS_EPS * 2 / Math.max(1, earthZoom));
        mesh.quaternion.setFromUnitVectors(zAxis, vec.clone().normalize());
        mesh.scale.setScalar(halfExtent);
        mesh.renderOrder = 3;
        earthHeatGroup.add(mesh);
        earthHeatSprites.push({ mesh, material, location: loc, baseScale: halfExtent });
      });
    } catch (e) {}
  }

  // Per-frame fade/state for the heat overlay (visible only over tiles).
  function updateEarthHeatSprites(fade) {
    if (!earthHeatGroup) return;
    const visible = fade > 0.02 && earthHeatSprites.length > 0;
    earthHeatGroup.visible = visible;
    if (!visible) return;
    const hovered = earthHoveredIndex;
    const selected = earthSelectedIndex;
    for (let i = 0; i < earthHeatSprites.length; i++) {
      const sprite = earthHeatSprites[i];
      let boost = 1;
      try {
        const idx = earthLocations.indexOf(sprite.location);
        if (idx >= 0 && idx === selected) boost = 1.35;
        else if (idx >= 0 && idx === hovered) boost = 1.18;
      } catch (e) {}
      sprite.material.opacity = Math.min(1, fade * 0.85) * (boost > 1 ? 1.15 : 1);
      sprite.mesh.scale.setScalar(sprite.baseScale * boost);
    }
  }

  function refreshEarthLabel() {
    if (!earthLabelCtx || !earthLabelTexture) return;
    const hovered = (earthHoveredIndex >= 0 && earthHoveredIndex < earthLocations.length)
      ? earthLocations[earthHoveredIndex]
      : null;
    const selected = (!hovered && earthSelectedIndex >= 0 && earthSelectedIndex < earthLocations.length)
      ? earthLocations[earthSelectedIndex]
      : null;
    const featured = hovered || selected;
    // Z2 attribution suffix (license requirement whenever tiles are visible)
    // or the offline notice when the layer degraded while zoomed.
    const tileOffline = !earthTileAvailable && (earthZoom > 1.02 || earthZoomTarget > 1.02);
    const tileSuffix = tileOffline
      ? '|offline'
      : (earthTileFade() > 0.02 ? '|osm' : '');
    // Z4 breadcrumb: once zoomed, the title roots the view at WORLD and
    // carries the log-scale zoom share; the detail line (and its license
    // suffix) is untouched.
    const zoomed = earthZoom > 1.02 || earthZoomTarget > 1.02;
    const zoomPct = earthZoomPercent();
    const key = earthLocations.length + '|' + (featured ? featured.slug : '') + tileSuffix +
      '|' + (zoomed ? zoomPct : 'g');
    if (key === lastEarthLabelKey) return;
    lastEarthLabelKey = key;
    try {
      const ctx = earthLabelCtx;
      const title = featured && featured.name
        ? (zoomed ? 'WORLD › ' + featured.name + ' · ' + zoomPct + '%' : featured.name)
        : (zoomed ? 'WORLD · ' + zoomPct + '%' : 'EARTH ACTIVITY');
      let detail;
      if (featured) {
        const heat = Math.round(earthHeatOf(featured) * 100);
        const cityCount = Number(featured.location_count) || 0;
        if (featured.kind === 'cluster' && cityCount > 1) {
          detail = cityCount + ' CITIES · ' + heat + '% HEAT';
        } else {
          detail = heat + '% HEAT · ' + (Number(featured.active_reel_count) || 0) + ' ACTIVE';
        }
      } else if (earthLocations.length === 0) {
        detail = 'NO RECENT ACTIVITY';
      } else {
        const clusters = earthLocations.filter((row) => row.kind === 'cluster').length;
        detail = clusters > 0 && clusters === earthLocations.length
          ? earthLocations.length + (earthLocations.length === 1 ? ' CLUSTER' : ' CLUSTERS')
          : earthLocations.length + (earthLocations.length === 1 ? ' ZONE' : ' ZONES');
      }
      if (tileOffline) detail = OSM_ATTRIBUTION_OFFLINE;
      else if (tileSuffix === '|osm') detail = (detail + ' · ' + OSM_ATTRIBUTION_TEXT).slice(0, 44);
      ctx.clearRect(0, 0, 640, 112);
      ctx.fillStyle = 'rgba(7,12,24,0.94)';
      ctx.fillRect(0, 0, 640, 112);
      ctx.strokeStyle = featured ? '#FFB11F' : '#3A506B';
      ctx.lineWidth = 3;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(2, 2, 636, 108, 14);
        ctx.stroke();
      } else {
        ctx.strokeRect(2, 2, 636, 108);
      }
      ctx.fillStyle = '#F7FAFC';
      ctx.font = '700 28px Archivo, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(title).slice(0, 30), 320, 43);
      ctx.fillStyle = '#B8C6D9';
      ctx.font = '700 15px "JetBrains Mono", monospace';
      ctx.fillText(String(detail).slice(0, 44), 320, 84);
      earthLabelTitle = String(title).slice(0, 30);
      earthLabelDetail = String(detail).slice(0, 44);
      earthLabelTexture.needsUpdate = true;
    } catch (e) {}
  }

  function updateEarthPreviewBillboard(time) {
    if (!earthPreviewMesh) return;
    if (sceneMode !== 'earth') {
      earthPreviewMesh.visible = false;
      return;
    }
    if (time - lastEarthPreviewUpdate < 150) return;
    lastEarthPreviewUpdate = time;
    const loc = (earthPreviewLocationIndex >= 0 && earthPreviewLocationIndex < earthLocations.length)
      ? earthLocations[earthPreviewLocationIndex]
      : null;
    if (!loc || !earthPreviewItems.length) {
      earthPreviewMesh.visible = false;
      return;
    }
    const ui = getUICanvas();
    if (ui && earthPreviewCtx) {
      try {
        ui.renderEarthPreviewCanvas(earthPreviewCtx, {
          location: loc,
          previewVideo: earthPreviewVideo,
          earthPreviewStatus,
          earthPreviewItems,
          earthPreviewIndex,
          reducedMotion,
        });
        if (earthPreviewTexture) earthPreviewTexture.needsUpdate = true;
      } catch (e) {}
    }
    earthPreviewMesh.visible = true;
  }

  // Per-frame earth dressing for both loops: billboards face the head,
  // pins pulse (unless reduced motion), textures refresh when dirty.
  // Z1: label/preview are scene-rooted and re-stationed here; pins are
  // counter-scaled + surface-hugged so their world size never grows with zoom.
  function updateEarthDressing(time) {
    if (!earthGroup || earthGroup.visible === false) return;
    try {
      const head = getHeadPosition();
      const center = earthLiveCenter();
      const S = Math.max(1, earthZoom);
      if (S <= 1.001) {
        // Globe scale: legacy layout, verbatim world positions.
        if (earthLabelMesh) earthLabelMesh.position.set(center.x, center.y + EARTH_RADIUS + 0.28, center.z);
        if (earthPreviewMesh) earthPreviewMesh.position.set(center.x + 0.94, center.y + 0.17, center.z);
      } else {
        // Zoomed: anchor beside the surface point facing the head.
        let fx = head.x - center.x, fy = head.y - center.y, fz = head.z - center.z;
        const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
        fx /= fl; fy /= fl; fz /= fl;
        const R = EARTH_RADIUS * S;
        const sx = center.x + fx * R, sy = center.y + fy * R, sz = center.z + fz * R;
        // right = normalize(cross(facing, up)) = (−fz, 0, fx)
        let rx = -fz, rz = fx;
        const rl = Math.sqrt(rx * rx + rz * rz) || 1;
        rx /= rl; rz /= rl;
        if (earthLabelMesh) earthLabelMesh.position.set(sx, sy + 0.3, sz);
        if (earthPreviewMesh) earthPreviewMesh.position.set(sx + rx * 0.62, sy + 0.05, sz + rz * 0.62);
      }
      if (earthLabelMesh) earthLabelMesh.lookAt(head.x, head.y, head.z);
      if (earthPreviewMesh && earthPreviewMesh.visible) {
        earthPreviewMesh.lookAt(head.x, head.y, head.z);
      }
    } catch (e) {}
    if (earthPinsGroup) {
      try {
        const invZoom = 1 / Math.max(1, earthZoom);
        const surfaceRadius = EARTH_RADIUS + 0.035 * invZoom;
        const kids = earthPinsGroup.children;
        for (let i = 0; i < kids.length; i++) {
          const p = kids[i];
          const base = p.userData.baseScale || 1;
          const pulse = reducedMotion
            ? 1
            : (1 + 0.22 * Math.sin(time * 0.003 + (p.userData.pulsePhase || 0)));
          // Counter the group scale: constant world size at every zoom.
          p.scale.setScalar(Math.max(0.05, base * pulse) * invZoom);
          // Constant world surface offset (0.035 m) instead of S× growth.
          const pl = Math.sqrt(
            p.position.x * p.position.x + p.position.y * p.position.y + p.position.z * p.position.z
          ) || 1;
          if (Math.abs(pl - surfaceRadius) > 1e-6) {
            const k = surfaceRadius / pl;
            p.position.set(p.position.x * k, p.position.y * k, p.position.z * k);
          }
        }
      } catch (e) {}
    }
    refreshEarthTexture();
    refreshEarthLabel();
    updateEarthTiles(time);
    updateEarthPreviewBillboard(time);
  }

  function raySphereHit(rayOrigin, rayDir, center, radius) {
    const oc = { x: rayOrigin.x - center.x, y: rayOrigin.y - center.y, z: rayOrigin.z - center.z };
    const a = rayDir.x * rayDir.x + rayDir.y * rayDir.y + rayDir.z * rayDir.z;
    const b = 2 * (oc.x * rayDir.x + oc.y * rayDir.y + oc.z * rayDir.z);
    const c = (oc.x * oc.x + oc.y * oc.y + oc.z * oc.z) - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const sqrtD = Math.sqrt(disc);
    const t1 = (-b - sqrtD) / (2 * a);
    const t2 = (-b + sqrtD) / (2 * a);
    if (t1 > 0) return t1;
    if (t2 > 0) return t2;
    return -1;
  }

  function hitTestEarth(rayOrigin, rayDir) {
    const liveCenter = earthLiveCenter();
    const liveRadius = EARTH_RADIUS * Math.max(1, earthZoom) * 1.08;
    const hitDist = raySphereHit(rayOrigin, rayDir, liveCenter, liveRadius);
    if (hitDist <= 0) return { hit: false, dist: -1, zoneIndex: -1 };

    const hitP = {
      x: rayOrigin.x + rayDir.x * hitDist,
      y: rayOrigin.y + rayDir.y * hitDist,
      z: rayOrigin.z + rayDir.z * hitDist,
    };

    // Local sphere coordinates in the fixed geographic frame: unrotate
    // the world hit by the globe's yaw*pitch so zones track the drag.
    const local = earthLocalFromWorld(hitP);

    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < earthLocations.length; i++) {
      const u = locationToUnit(earthLocations[i].lat, earthLocations[i].lon);
      const rad = earthZoneAngularRadius(earthLocations[i]);
      const dist = Math.hypot(local.x - u.x, local.y - u.y, local.z - u.z);
      if (dist < rad && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    return {
      hit: true,
      dist: hitDist,
      zoneIndex: bestIdx,
      point: hitP,
      local,
    };
  }

  // Drag tuning (upstream constants verbatim except yaw sensitivity,
  // reduced per owner request): pitch dy*2.24, yaw dx*1.7 (was 2.8).
  const EARTH_DRAG_HOLD_MS = 280;
  const EARTH_TAP_CHORD = 0.06;
  const EARTH_DRAG_CHORD = 0.12;
  const EARTH_AXIS_LOCK = 0.012;
  const EARTH_YAW_SENSITIVITY = 1.7;
  const EARTH_PITCH_SENSITIVITY = 2.24;

  function rotateEarth(deltaYaw, deltaPitch) {
    earthYaw = (earthYaw + deltaYaw) % (Math.PI * 2);
    earthPitch = Math.max(-1.2, Math.min(1.2, (earthPitch || 0) + (deltaPitch || 0)));
    applyEarthRotation();
  }

  // Mesh rotation mirrors upstream yawQ*pitchQ (pitch about the yawed X
  // axis): THREE euler order 'YXZ' composes R = Ry * Rx. Hit-testing
  // applies the exact inverse so hover zones track the turned globe.
  function applyEarthRotation() {
    if (!earthMesh) return;
    try {
      earthMesh.rotation.order = 'YXZ';
      earthMesh.rotation.set(earthPitch || 0, earthYaw || 0, 0);
    } catch (e) {}
    // Zoomed + focused: re-pin the focus surface point to the comfort anchor
    // so drags pivot the globe around the viewed spot (map-rotate feel)
    // instead of swinging the viewed area on a multi-meter lever arm.
    if (earthFocus && earthZoom > 1.0001) applyEarthZoom();
  }

  // Inverse of Ry(yaw)*Rx(pitch) applied to a world point, yielding
  // normalized fixed-frame local coordinates for zone matching.
  function earthLocalFromWorld(world) {
    const c = earthLiveCenter();
    const ox = world.x - c.x;
    const oy = world.y - c.y;
    const oz = world.z - c.z;
    const cosY = Math.cos(earthYaw || 0);
    const sinY = Math.sin(earthYaw || 0);
    const x1 = ox * cosY - oz * sinY;
    const z1 = ox * sinY + oz * cosY;
    const cosP = Math.cos(earthPitch || 0);
    const sinP = Math.sin(earthPitch || 0);
    const nx = x1;
    const ny = oy * cosP + z1 * sinP;
    const nz = -oy * sinP + z1 * cosP;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { x: nx / l, y: ny / l, z: nz / l };
  }

  // ─── Earth zoom map (docs/earth-zoom-map-plan.md Z1) ──────────────────
  function clampEarthZoom(value) {
    return Math.max(1, Math.min(EARTH_ZOOM_MAX, Number(value) || 1));
  }

  // Slippy-map tile zoom band for the current scale (drives the Z2 tile
  // layer and Z3 clustered activity). log2(S)+3.3 keeps the on-screen tile
  // size constant (~4.6 across the FOV) at every zoom: S=1→z3, S=8→z6
  // (city), S=512→z12 (streets), S=16384→z17 (max raster detail).
  function earthTileZoom() {
    return Math.max(0, Math.min(17, Math.round(Math.log2(Math.max(1, earthZoom)) + 3.3)));
  }

  // Z4: breadcrumb zoom readout — log-scale share of the S=1→MAX range
  // (S=1→0%, S=8→21%, S=16384→100%).
  function earthZoomPercent() {
    return Math.round(100 * Math.log2(Math.max(1, earthZoomTarget)) / Math.log2(EARTH_ZOOM_MAX));
  }

  // Inverse of locationToUnit: unit vector → geographic lat/lon.
  function unitToLatLon(u) {
    const y = Math.max(-1, Math.min(1, Number(u && u.y) || 0));
    return {
      lat: Math.asin(y) * 180 / Math.PI,
      lon: Math.atan2(Number(u && u.x) || 0, Number(u && u.z) || 0) * 180 / Math.PI,
    };
  }

  // Forward Ry(yaw)*Rx(pitch) applied to a unit vector — the exact inverse
  // of earthLocalFromWorld's unrotation (verified against the YXZ euler).
  function rotateEarthDir(u, yaw, pitch) {
    const cP = Math.cos(pitch || 0);
    const sP = Math.sin(pitch || 0);
    const y1 = u.y * cP - u.z * sP;
    const z1 = u.y * sP + u.z * cP;
    const cY = Math.cos(yaw || 0);
    const sY = Math.sin(yaw || 0);
    return { x: cY * u.x + sY * z1, y: y1, z: -sY * u.x + cY * z1 };
  }

  // Live globe center: the group's world position (moves while zoomed),
  // falling back to the docked earthCenter before the scene exists.
  function earthLiveCenter() {
    if (earthGroup && earthGroup.position) {
      return { x: earthGroup.position.x, y: earthGroup.position.y, z: earthGroup.position.z };
    }
    return earthCenter;
  }

  // Solve yaw/pitch so the rotated focus unit vector faces targetDir (unit,
  // world frame). Pitch candidates are clamped to the existing ±1.2 drag
  // clamp; the one nearest the current pitch wins. Degenerate polar foci
  // keep the current pose (the clamp makes exact polar centering impossible).
  function solveEarthFocusRotation(lat, lon, targetDir) {
    const v = locationToUnit(lat, lon);
    const t = targetDir;
    const clampPitch = (p) => Math.max(-1.2, Math.min(1.2, p));
    const r = Math.hypot(v.y, v.z);
    let pitch = earthPitch || 0;
    if (r > 1e-6) {
      const phi0 = Math.atan2(v.z, v.y); // v.y = r·cos φ0, v.z = r·sin φ0
      const cosArg = Math.max(-1, Math.min(1, t.y / r));
      const a1 = Math.acos(cosArg) - phi0;
      const a2 = -Math.acos(cosArg) - phi0;
      const c1 = clampPitch(a1);
      const c2 = clampPitch(a2);
      // Prefer the clamped candidate that lands closest to t.y, then the
      // one nearest the current pitch (no gratuitous flips).
      const err1 = Math.abs((v.y * Math.cos(c1) - v.z * Math.sin(c1)) - t.y);
      const err2 = Math.abs((v.y * Math.cos(c2) - v.z * Math.sin(c2)) - t.y);
      if (Math.abs(err1 - err2) > 1e-9) pitch = err1 < err2 ? c1 : c2;
      else pitch = Math.abs(c1 - earthPitch) <= Math.abs(c2 - earthPitch) ? c1 : c2;
    }
    const cP = Math.cos(pitch);
    const sP = Math.sin(pitch);
    const v1 = { x: v.x, y: v.y * cP - v.z * sP, z: v.y * sP + v.z * cP };
    const yaw = Math.atan2(t.x, t.z) - Math.atan2(v1.x, v1.z);
    return { yaw, pitch };
  }

  // Push the zoom state into the scene graph: scale the globe group, and
  // while focused+zoomed, pin the focus surface point to the comfort anchor
  // (groupPos = anchor − focusDir·R·S). At globe scale this reproduces the
  // legacy docked position exactly.
  function applyEarthZoom() {
    if (!earthGroup) return;
    const S = Math.max(1, earthZoom);
    try { earthGroup.scale.setScalar(S); } catch (e) {}
    if (earthFocus && earthZoomAnchor && S > 1.0001) {
      const dir = rotateEarthDir(locationToUnit(earthFocus.lat, earthFocus.lon), earthYaw, earthPitch);
      const d = EARTH_RADIUS * S;
      earthGroup.position.set(
        earthZoomAnchor.x - dir.x * d,
        earthZoomAnchor.y - dir.y * d,
        earthZoomAnchor.z - dir.z * d
      );
    } else {
      earthGroup.position.set(earthCenter.x, earthCenter.y, earthCenter.z);
    }
    earthZoomApplied = S;
  }

  // Compute the comfort anchor from the current view axis: 1.15 m from the
  // head toward the globe. Locked for the duration of a zoom gesture so the
  // globe never swims with head motion (VR comfort).
  function lockEarthZoomAnchor() {
    const head = getHeadPosition();
    const c = earthLiveCenter();
    let ax = c.x - head.x, ay = c.y - head.y, az = c.z - head.z;
    const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= al; ay /= al; az /= al;
    earthZoomAnchor = {
      x: head.x + ax * EARTH_ZOOM_SURFACE_DIST,
      y: head.y + ay * EARTH_ZOOM_SURFACE_DIST,
      z: head.z + az * EARTH_ZOOM_SURFACE_DIST,
    };
    return { x: ax, y: ay, z: az };
  }

  // The lat/lon of the globe point currently facing the head (any point on
  // the head↔center ray works — earthLocalFromWorld normalizes).
  function earthFacingLatLon() {
    const head = getHeadPosition();
    return unitToLatLon(earthLocalFromWorld(head));
  }

  // Animate zoom toward a lat/lon (tap-to-zoom): ease scale + solved
  // focus rotation together so the target lands centered on the view axis.
  function zoomEarthTo(lat, lon, targetZoom) {
    const toZoom = clampEarthZoom(targetZoom);
    const viewAxis = lockEarthZoomAnchor();
    earthFocus = { lat: Number(lat) || 0, lon: Number(lon) || 0 };
    const solved = solveEarthFocusRotation(earthFocus.lat, earthFocus.lon, viewAxis);
    let dYaw = solved.yaw - (earthYaw || 0);
    dYaw = ((dYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI; // shortest arc
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    earthZoomAnim = {
      t0,
      dur: EARTH_ZOOM_ANIM_MS,
      fromZoom: earthZoom,
      toZoom,
      fromYaw: earthYaw || 0,
      toYaw: (earthYaw || 0) + dYaw,
      fromPitch: earthPitch || 0,
      toPitch: solved.pitch,
    };
    // The target flips immediately (earthZoom eases behind it) so a second
    // tap during the animation dispatches against where we're heading.
    earthZoomTarget = toZoom;
    if (reducedMotion) advanceEarthZoom(t0); // snaps: k forced to 1
    return toZoom;
  }

  // Continuous zoom (grip+stick / wheel / dock): exponential, toward the
  // facing point when no focus is set yet. Zooming back out to 1 releases
  // the focus so the globe returns to free spin at the docked position.
  function adjustEarthZoom(factor) {
    const prev = earthZoomTarget;
    const next = clampEarthZoom(prev * (Number(factor) || 1));
    if (next === prev) return earthZoomTarget;
    if (next > 1 && !earthFocus) {
      earthFocus = earthFacingLatLon();
      lockEarthZoomAnchor();
    }
    earthZoomTarget = next;
    earthZoomAnim = null; // continuous input supersedes any tap animation
    if (next <= 1) {
      earthFocus = null;
      earthZoomAnchor = null;
    }
    if (reducedMotion) advanceEarthZoom(0);
    return earthZoomTarget;
  }

  // Back to the full globe (dock GLOBE RESET button).
  function resetEarthZoom() {
    earthFocus = null;
    earthZoomAnchor = null;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    earthZoomAnim = {
      t0, dur: EARTH_ZOOM_ANIM_MS,
      fromZoom: earthZoom, toZoom: 1,
      fromYaw: earthYaw || 0, toYaw: earthYaw || 0,
      fromPitch: earthPitch || 0, toPitch: earthPitch || 0,
    };
    earthZoomTarget = 1;
    if (reducedMotion) advanceEarthZoom(t0);
  }

  // Instant reset (mode exit / teardown): re-entry always starts globe-view.
  function resetEarthZoomImmediate() {
    earthZoom = 1;
    earthZoomTarget = 1;
    earthFocus = null;
    earthZoomAnchor = null;
    earthZoomAnim = null;
    applyEarthZoom();
  }

  // Per-frame zoom advance for both loops: run the focus animation, else
  // ease the continuous target. Returns true while a tap animation is active.
  function advanceEarthZoom(time) {
    if (earthZoomAnim) {
      const anim = earthZoomAnim;
      const k = reducedMotion ? 1 : Math.max(0, Math.min(1, ((Number(time) || 0) - anim.t0) / Math.max(1, anim.dur)));
      const e = 1 - Math.pow(1 - k, 3); // cubic-out
      earthZoom = anim.fromZoom + (anim.toZoom - anim.fromZoom) * e;
      earthYaw = anim.fromYaw + (anim.toYaw - anim.fromYaw) * e;
      earthPitch = anim.fromPitch + (anim.toPitch - anim.fromPitch) * e;
      applyEarthRotation();
      if (k >= 1) {
        earthZoom = anim.toZoom;
        earthZoomTarget = anim.toZoom;
        earthYaw = anim.toYaw;
        earthPitch = anim.toPitch;
        earthZoomAnim = null;
        applyEarthRotation();
      }
      applyEarthZoom();
      return true;
    }
    if (earthZoom !== earthZoomTarget) {
      const next = reducedMotion
        ? earthZoomTarget
        : earthZoom + (earthZoomTarget - earthZoom) * 0.18;
      earthZoom = Math.abs(next - earthZoomTarget) < 0.004 ? earthZoomTarget : next;
      applyEarthZoom();
    }
    return false;
  }

  // Tap dispatch (Z1 UX): below the city band a zone tap zooms into it
  // (Snap pinch equivalent); at/above the band it keeps the legacy flow —
  // preview → accept → location feed. A clean tap on open globe zooms one
  // step toward the tapped point. Drag releases never reach here.
  function handleEarthTap(zoneIndex, hit) {
    const idx = Number(zoneIndex);
    if (idx >= 0 && idx < earthLocations.length) {
      const loc = earthLocations[idx];
      const isCluster = loc.kind === 'cluster' && (Number(loc.location_count) || 0) > 1;
      if (isCluster) {
        // Z3: clusters always zoom (their member cities resolve at city
        // band); identical taps keep drilling until the member set is the
        // city rows themselves.
        const toZoom = earthZoomTarget >= EARTH_ZOOM_CITY
          ? Math.min(EARTH_ZOOM_MAX, earthZoomTarget * EARTH_ZOOM_STEP)
          : EARTH_ZOOM_CITY;
        zoomEarthTo(loc.lat, loc.lon, toZoom);
        return 'zoom-cluster';
      }
      if (earthZoomTarget >= EARTH_ZOOM_CITY) {
        selectEarthLocation(idx);
        return 'select';
      }
      zoomEarthTo(loc.lat, loc.lon, Math.max(EARTH_ZOOM_CITY, earthZoomTarget * EARTH_ZOOM_STEP));
      return 'zoom-zone';
    }
    if (hit && hit.hit && hit.local) {
      const geo = unitToLatLon(hit.local);
      zoomEarthTo(geo.lat, geo.lon, Math.min(EARTH_ZOOM_MAX, earthZoomTarget * EARTH_ZOOM_STEP));
      return 'zoom-point';
    }
    return 'none';
  }

  // ─── Z2: slippy-map tile layer (docs/earth-zoom-map-plan.md §7) ───────
  // Raster OSM tiles draped as curved sphere patches, keyed off our own
  // zoom state machine (no external tile-globe library — see §7.1 fork
  // note). Fetches go through the same-origin disk-cached proxy (Z0).
  const EARTH_TILE_SEGMENTS = 8;        // grid per tile patch (curvature)
  const EARTH_TILE_RADIUS_EPS = 0.005;  // world meters above the base sphere
  const EARTH_TILE_RING = 3;            // visible radius → ≤ 7×7 = 49 tiles
  const EARTH_TILE_CACHE_MAX = 140;     // LRU across zoom levels
  const EARTH_TILE_FETCH_CONCURRENCY = 6;
  const EARTH_TILE_CROSSFADE_LO = 4;    // S band [4, 8]: hologram → tiles
  const EARTH_TILE_CROSSFADE_HI = 8;
  const EARTH_TILE_FAIL_LIMIT = 4;      // consecutive failures → offline mode
  const EARTH_TILE_PROBE_MS = 5000;     // degraded-mode re-arm cadence
  const OSM_ATTRIBUTION_TEXT = '© OPENSTREETMAP CONTRIBUTORS';
  const OSM_ATTRIBUTION_OFFLINE = 'MAP OFFLINE — CITY VIEW';

  // Web-Mercator row for a latitude (0 = north pole edge, 1 = south).
  function earthMercatorYFrac(lat) {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, Number(lat) || 0));
    const phi = clamped * Math.PI / 180;
    const s = Math.sin(phi);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  // Inverse: y fraction in [0, 1] → latitude degrees.
  function earthMercatorYToLat(yf) {
    const y = Math.max(0, Math.min(1, Number(yf) || 0));
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
  }

  // Slippy tile coordinates (float): x east from the antimeridian, y south
  // from the north pole — the standard XYZ scheme the proxy serves.
  function earthTileXY(lat, lon, z) {
    const n = 1 << Math.max(0, Math.min(17, Number(z) || 0));
    const lonN = ((Number(lon) + 180) % 360 + 360) % 360;
    return { x: (lonN / 360) * n, y: earthMercatorYFrac(lat) * n };
  }

  function earthTileKey(z, x, y) {
    return z + '/' + x + '/' + y;
  }

  // Bounded visible set around a lat/lon: (2·ring+1)² tiles centered on the
  // facing/focused point, sorted by ring distance (fetch priority order).
  function earthTileVisibleSet(z, lat, lon, ring) {
    const zz = Math.max(0, Math.min(17, Number(z) || 0));
    const n = 1 << zz;
    const r = Math.max(1, Math.min(6, Number(ring) || EARTH_TILE_RING));
    const c = earthTileXY(lat, lon, zz);
    const cx = Math.max(0, Math.min(n - 1, Math.floor(c.x)));
    const cy = Math.max(0, Math.min(n - 1, Math.floor(c.y)));
    const out = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= n || y < 0 || y >= n) continue; // poles: no wrap
        out.push({ key: earthTileKey(zz, x, y), z: zz, x, y, dist: Math.abs(dx) + Math.abs(dy) });
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  // Crossfade weight S ∈ [4, 8]: 0 = pure hologram, 1 = pure tiles. While
  // tiles are still streaming the base globe lingers (≥ 25% opacity) so the
  // surface never blanks out waiting on the network.
  function earthTileFade() {
    if (!earthTileAvailable || !debugFlags.earthmap) return 0;
    const S = Math.max(1, earthZoom);
    const band = S <= EARTH_TILE_CROSSFADE_LO
      ? 0
      : (S >= EARTH_TILE_CROSSFADE_HI
        ? 1
        : (() => {
          const k = (S - EARTH_TILE_CROSSFADE_LO) / (EARTH_TILE_CROSSFADE_HI - EARTH_TILE_CROSSFADE_LO);
          return k * k * (3 - 2 * k); // smoothstep
        })());
    if (band <= 0) return 0;
    return band * (0.25 + 0.75 * earthTileLoadRatio);
  }

  // Load-progress proxy for the fade gate (ready vs still-pending patches).
  function refreshEarthTileLoadRatio() {
    let ready = 0;
    let pending = 0;
    try {
      for (const entry of earthTiles.values()) {
        if (entry.state === 'ready') ready += 1;
        else if (entry.state === 'queued' || entry.state === 'loading') pending += 1;
      }
    } catch (e) {}
    earthTileLoadRatio = pending === 0 ? 1 : ready / (ready + pending);
  }

  // Injectable image seam (tests stub this; production uses Image()).
  let earthTileImageLoader = null;
  function loadEarthTileImage(url, onLoad, onError) {
    if (earthTileImageLoader) {
      try { earthTileImageLoader(url, onLoad, onError); } catch (e) { onError(e); }
      return;
    }
    try {
      const img = new Image();
      img.onload = () => onLoad(img);
      img.onerror = () => onError(new Error('tile image failed: ' + url));
      img.src = url;
    } catch (e) { onError(e); }
  }

  // Curved sphere patch for one tile, in earthMesh-local (geographic) frame.
  // Mercator y is non-linear in latitude, so each grid row samples its own
  // latitude — the raster rows then land on their true latitudes.
  function buildEarthTileGeometry(z, tx, ty, radius) {
    const n = 1 << z;
    const segs = EARTH_TILE_SEGMENTS;
    const positions = new Float32Array((segs + 1) * (segs + 1) * 3);
    const uvs = new Float32Array((segs + 1) * (segs + 1) * 2);
    const indices = [];
    let p = 0, u = 0;
    for (let j = 0; j <= segs; j++) {
      const lat = earthMercatorYToLat((ty + j / segs) / n);
      for (let i = 0; i <= segs; i++) {
        const lon = ((tx + i / segs) / n) * 360 - 180;
        const dir = locationToUnit(lat, lon);
        positions[p++] = dir.x * radius;
        positions[p++] = dir.y * radius;
        positions[p++] = dir.z * radius;
        uvs[u++] = i / segs;
        uvs[u++] = 1 - j / segs; // image row 0 = north = top
      }
    }
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i;
        const b = a + 1;
        const c = a + segs + 1;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
  }

  function disposeEarthTile(entry) {
    if (!entry) return;
    try {
      if (entry.mesh && earthTileGroup) earthTileGroup.remove(entry.mesh);
      if (entry.material) entry.material.dispose();
      if (entry.texture) entry.texture.dispose();
      if (entry.mesh && entry.mesh.geometry) entry.mesh.geometry.dispose();
    } catch (e) {}
  }

  function retireEarthTiles(predicate) {
    try {
      for (const [key, entry] of Array.from(earthTiles.entries())) {
        if (predicate(key, entry)) {
          disposeEarthTile(entry);
          earthTiles.delete(key);
        }
      }
    } catch (e) {}
  }

  // Shared mesh builder: network-loaded tiles and idle-prefetched images
  // materialize through the same path. Prefetched entries arrive without
  // geometry (built here at band time with the live radius); queued
  // entries reuse the geometry from planning. Returns false on failure
  // with entry.img cleared so the caller can fall back to a queued fetch.
  function materializeEarthTile(entry, tile, radius) {
    const img = entry ? entry.img : null;
    if (!entry || !img || !earthTileGroup) {
      if (entry) entry.img = null;
      return false;
    }
    try {
      if (!entry.geometry) {
        if (!(radius > 0)) {
          entry.state = 'error';
          entry.img = null;
          return false;
        }
        entry.geometry = buildEarthTileGeometry(tile.z, tile.x, tile.y, radius);
      }
      const styled = styleEarthTileImage(img);
      const texture = applyLinearSampling(styled ? new THREE.CanvasTexture(styled) : new THREE.Texture(img));
      try { if (THREE.SRGBColorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace; } catch (e2) {}
      texture.needsUpdate = true;
      entry.texture = texture;
      entry.material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: earthTileFade(),
        depthWrite: false,
        side: THREE.FrontSide,
      });
      entry.mesh = new THREE.Mesh(entry.geometry, entry.material);
      entry.mesh.renderOrder = 2; // above the base sphere, below UI
      earthTileGroup.add(entry.mesh);
      entry.state = 'ready';
      entry.img = null;
      return true;
    } catch (e) {
      entry.state = 'error';
      entry.img = null;
      return false;
    }
  }

  function pumpEarthTileQueue() {
    if (!earthTileGroup) return;
    while (earthTileInFlight < EARTH_TILE_FETCH_CONCURRENCY && earthTileQueue.length > 0) {
      const job = earthTileQueue.shift();
      const entry = earthTiles.get(job.key);
      if (!entry || entry.state !== 'queued') continue;
      entry.state = 'loading';
      earthTileInFlight += 1;
      loadEarthTileImage('/api/reels/map-tiles/' + job.z + '/' + job.x + '/' + job.y + '.png', (img) => {
        earthTileInFlight = Math.max(0, earthTileInFlight - 1);
        const current = earthTiles.get(job.key);
        if (!current || current.state === 'retired') {
          pumpEarthTileQueue();
          return; // evicted mid-flight
        }
        if (current.state === 'ready' && current.texture) {
          pumpEarthTileQueue();
          return; // prefetch race: the warmed image materialized first
        }
        current.img = img;
        if (materializeEarthTile(current, job, 0)) {
          earthTileFailures = 0; // a success re-arms the online verdict
          earthTileAvailable = true;
        }
        pumpEarthTileQueue();
      }, () => {
        earthTileInFlight = Math.max(0, earthTileInFlight - 1);
        const current = earthTiles.get(job.key);
        if (current) current.state = 'error';
        earthTileFailures += 1;
        if (earthTileFailures >= EARTH_TILE_FAIL_LIMIT) {
          // Offline / rate-limited / flag-off: degrade to the hologram (§7.4),
          // then re-probe on a slow cadence instead of latching forever.
          earthTileAvailable = false;
          earthTileQueue = [];
          earthTilePrefetch.clear();
          retireEarthTiles(() => true);
          earthTileZ = -1;
          earthTileCenterKey = '';
          earthTileProbeAt = earthTileClock + EARTH_TILE_PROBE_MS;
          lastEarthLabelKey = ''; // force the MAP OFFLINE label repaint
        }
        pumpEarthTileQueue();
      });
    }
  }

  // Per-frame (throttled) tile maintenance: keep the visible set materialized
  // at the current tile band, evict the rest, and drive the crossfade.
  function updateEarthTiles(time) {
    if (!earthTileGroup || !earthMesh) return;
    if (!debugFlags.earthmap) {
      if (earthTileZ !== -1) retireEarthTiles(() => true);
      earthTilePrefetch.clear();
      earthTileZ = -1;
      earthTileCenterKey = '';
      return;
    }
    const now = Number(time) || 0;
    earthTileClock = Math.max(earthTileClock, now);
    refreshEarthTileLoadRatio();
    // Z3: follow the zoom band with the activity fetch (debounced inside).
    scheduleEarthActivityRefetch();
    // Degraded-mode re-arm: retry once per EARTH_TILE_PROBE_MS so transient
    // network loss heals without a re-entry; failures re-degrade immediately.
    if (!earthTileAvailable) {
      if (earthZoom <= EARTH_TILE_CROSSFADE_LO) {
        earthTileProbeAt = -1; // nothing to fetch at globe scale
        return;
      }
      if (earthTileProbeAt >= 0 && now < earthTileProbeAt) return;
      earthTileAvailable = true;
      earthTileFailures = 0;
      earthTileProbeAt = -1;
      lastEarthLabelKey = ''; // repaint attribution/offline line
    }
    const fade = earthTileFade();
    updateEarthHeatSprites(fade);
    if (earthMesh.material && Math.abs(fade - earthTileBaseFade) > 0.004) {
      try {
        earthMesh.material.transparent = fade > 0.001;
        earthMesh.material.opacity = 1 - fade;
        earthMesh.material.needsUpdate = true;
        earthTileBaseFade = fade;
      } catch (e) {}
      // Sync already-ready tile opacities to the new fade weight.
      try {
        for (const entry of earthTiles.values()) {
          if (entry.material) entry.material.opacity = fade;
        }
      } catch (e) {}
    }
    if (fade <= 0.001) {
      if (earthTileZ !== -1) {
        retireEarthTiles(() => true);
        earthTilePrefetch.clear();
        earthTileQueue = [];
        earthTileInFlight = 0;
        earthTileZ = -1;
        earthTileCenterKey = '';
      }
      return;
    }
    if (!earthTileAvailable) return;
    // Re-plan at most ~7 Hz.
    if (earthTileLastMaintain >= 0 && time - earthTileLastMaintain < 150) return;
    earthTileLastMaintain = time;
    const z = earthTileZoom();
    const anchor = earthFocus || earthFacingLatLon();
    const center = earthTileXY(anchor.lat, anchor.lon, z);
    const n = 1 << z;
    const centerKey = earthTileKey(z,
      Math.max(0, Math.min(n - 1, Math.floor(center.x))),
      Math.max(0, Math.min(n - 1, Math.floor(center.y))));
    if (z === earthTileZ && centerKey === earthTileCenterKey && earthTiles.size > 0) {
      maintainEarthTilePrefetch(z, center);
      return;
    }
    earthTileZ = z;
    earthTileCenterKey = centerKey;

    const visible = earthTileVisibleSet(z, anchor.lat, anchor.lon, EARTH_TILE_RING);
    const radius = EARTH_RADIUS + EARTH_TILE_RADIUS_EPS / Math.max(1, earthZoom);
    const wanted = new Set();
    earthTileQueue = [];
    for (const tile of visible) {
      wanted.add(tile.key);
      let entry = earthTiles.get(tile.key);
      if (!entry) {
        const pre = earthTilePrefetch.get(tile.key);
        if (pre && pre.state === 'ready' && pre.img) {
          // Idle-warmed child from the previous band: adopt the image.
          entry = { state: 'queued', geometry: null, mesh: null, material: null, texture: null, img: pre.img };
          earthTiles.set(tile.key, entry);
          earthTilePrefetch.delete(tile.key);
        } else {
          try {
            entry = {
              state: 'queued',
              geometry: buildEarthTileGeometry(tile.z, tile.x, tile.y, radius),
              mesh: null, material: null, texture: null,
            };
            earthTiles.set(tile.key, entry);
          } catch (e) {
            continue;
          }
        }
      } else if (entry.state === 'ready') {
        earthTilePrefetch.delete(tile.key); // prefetch/normal race leftover
      }
      entry.lastUse = time;
      if (entry.state === 'queued') {
        if (entry.img) {
          // Warmed image: materialize now. On failure the entry is 'error'
          // (img cleared) and re-plans on the next band change, like every
          // other failed tile — pumping it would be a no-op.
          materializeEarthTile(entry, tile, radius);
        } else {
          earthTileQueue.push({ z: tile.z, x: tile.x, y: tile.y, dist: tile.dist, key: tile.key });
        }
      }
    }
    // Evict everything outside the visible set (also drops stale zoom bands).
    retireEarthTiles((key) => !wanted.has(key));
    earthTileQueue.sort((a, b) => a.dist - b.dist);
    pumpEarthTileQueue();
    // Hard LRU cap across bands (safety net; the visible set already bounds us).
    if (earthTiles.size > EARTH_TILE_CACHE_MAX) {
      const entries = Array.from(earthTiles.entries())
        .sort((a, b) => (a[1].lastUse || 0) - (b[1].lastUse || 0));
      while (earthTiles.size > EARTH_TILE_CACHE_MAX && entries.length > 0) {
        const [key, entry] = entries.shift();
        disposeEarthTile(entry);
        earthTiles.delete(key);
      }
    }
  }

  // Z4 idle prefetch: once the band settles, warm the 4 children of the
  // center tile one level down in a side cache (never rendered, never
  // counted in the visible-set bound). The next zoom step adopts them with
  // zero new fetches. Runs only when the main queue is fully idle so map
  // interaction always wins the fetch budget; prefetch errors are silent
  // (they must never trip the §7.4 offline degrade).
  function maintainEarthTilePrefetch(z, center) {
    if (z >= 17 || earthZoomAnim || earthZoom !== earthZoomTarget ||
        !earthTileAvailable || !debugFlags.earthmap) return;
    const n = 1 << z;
    const tcx = Math.max(0, Math.min(n - 1, Math.floor(center.x)));
    const tcy = Math.max(0, Math.min(n - 1, Math.floor(center.y)));
    const cn = 1 << (z + 1);
    const wanted = new Set();
    for (let oy = 0; oy <= 1; oy++) {
      for (let ox = 0; ox <= 1; ox++) {
        const px = Math.max(0, Math.min(cn - 1, 2 * tcx + ox));
        const py = Math.max(0, Math.min(cn - 1, 2 * tcy + oy));
        wanted.add(earthTileKey(z + 1, px, py));
      }
    }
    for (const key of Array.from(earthTilePrefetch.keys())) {
      if (!wanted.has(key)) {
        earthTilePrefetch.delete(key);
        continue;
      }
      const stale = earthTiles.get(key);
      if (stale && stale.state === 'ready') earthTilePrefetch.delete(key);
    }
    if (earthTileQueue.length > 0 || earthTileInFlight > 0 || earthTileLoadRatio < 1) return;
    for (const key of wanted) {
      if (earthTilePrefetch.has(key)) continue; // loading or ready
      const parts = key.split('/').map(Number);
      const job = { z: parts[0], x: parts[1], y: parts[2], key };
      earthTilePrefetch.set(key, { z: job.z, x: job.x, y: job.y, state: 'loading', img: null });
      earthTileInFlight += 1;
      loadEarthTileImage('/api/reels/map-tiles/' + job.z + '/' + job.x + '/' + job.y + '.png', (img) => {
        earthTileInFlight = Math.max(0, earthTileInFlight - 1);
        const current = earthTilePrefetch.get(key);
        if (current && current.state === 'loading') {
          current.state = 'ready';
          current.img = img;
        }
        pumpEarthTileQueue();
      }, () => {
        earthTileInFlight = Math.max(0, earthTileInFlight - 1);
        earthTilePrefetch.delete(key); // silent: never counts toward degrade
        pumpEarthTileQueue();
      });
    }
  }

  function advanceEarthSpin(time) {
    // Idle spin only at globe scale with no gesture running: spinning a
    // zoomed-in map would rip the viewed region away from the user.
    if (reducedMotion || earthDragging || earthZoomAnim || earthZoomTarget > 1.02) return 0;
    if (earthLastFrameTime < 0) {
      earthLastFrameTime = time;
      return 0;
    }
    const dt = Math.max(0, Math.min(100, time - earthLastFrameTime));
    earthLastFrameTime = time;
    const delta = (Math.PI / 60) * (dt / 1000);
    rotateEarth(delta, 0);
    return delta;
  }

  // ─── Three.js Scene Setup ───────────────────────────────────────────
  function initThreeScene(canvas, context) {
    ensureThree();
    if (!THREE) return null;

    if (context) {
      glContext = context;
    }

    if (!vrProxyCanvas && typeof document !== 'undefined') {
      vrProxyCanvas = document.createElement('canvas');
      vrProxyCanvas.width = VR_TEX_CAP;
      vrProxyCanvas.height = VR_TEX_CAP;
      vrProxyCtx = vrProxyCanvas.getContext('2d');
    }

    if (!renderer) {
      // v8.17: the renderer follows the full/minimal stack like the session
      // (the v8.15 session-only split flashed; the proven-clean xrminimal run
      // had antialias/alpha off). ?xrfull=1 restores legacy AA-on.
      const fullStack = useFullStack();
      const opts = fullStack
        ? { canvas, alpha: true, antialias: true, powerPreference: 'high-performance' }
        : { canvas, alpha: false, antialias: false, powerPreference: 'high-performance' };
      lastRendererOpts = { alpha: !!opts.alpha, antialias: !!opts.antialias };
      if (context) opts.context = context;
      renderer = new THREE.WebGLRenderer(opts);
      if (!glContext && renderer.getContext) {
        try { glContext = renderer.getContext(); } catch (e) {}
      }
      renderer.setPixelRatio(typeof window !== 'undefined' ? Math.max(1, Math.min(2, window.devicePixelRatio || 1)) : 1);
      updatePreviewSize(canvas);
      if (renderer.xr) renderer.xr.enabled = true;
      try {
        if (renderer.setClearColor) renderer.setClearColor(0x020612, 1);
      } catch (e) {}
    }

    if (!scene) {
      scene = new THREE.Scene();
      try {
        scene.background = new THREE.Color(0x020612);
      } catch (e) {}
    }

    if (!camera) {
      const aspect = (canvas.clientWidth || 960) / Math.max(1, canvas.clientHeight || 540);
      camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 100);
      camera.position.set(0, 1.6, 0);
    }

    // Video Screen Mesh
    if (!videoTexture && vrProxyCanvas) {
      videoTexture = applyLinearSampling(new THREE.CanvasTexture(vrProxyCanvas));
      try { if (THREE.SRGBColorSpace !== undefined) videoTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    }
    if (!screenMesh) {
      ensureScreenQuat();
      const screenGeo = createScreenGeometry(curvatureMode);
      const screenMat = new THREE.MeshBasicMaterial({
        map: videoTexture,
        side: THREE.DoubleSide,
      });
      screenMesh = new THREE.Mesh(screenGeo, screenMat);
      scene.add(screenMesh);
      commitScreenTransform();
    }

    // Ambilight Glow — radial-falloff quad slightly larger than the screen
    // (upstream: 1.34x, same curvature, additive, exp falloff). The old flat
    // solid-color square showed a hard border behind the reels; the alphaMap
    // gradient removes the edge entirely.
    if (typeof document !== 'undefined' && !glowAlphaTexture && THREE) {
      try {
        const glowAlphaCanvas = document.createElement('canvas');
        glowAlphaCanvas.width = 256;
        glowAlphaCanvas.height = 256;
        const gtx = glowAlphaCanvas.getContext('2d');
        if (gtx) {
          const grad = gtx.createRadialGradient(128, 128, 8, 128, 128, 128);
          grad.addColorStop(0, '#ffffff');
          grad.addColorStop(0.45, '#b0b0b0');
          grad.addColorStop(0.75, '#404040');
          grad.addColorStop(1, '#000000');
          gtx.fillStyle = grad;
          gtx.fillRect(0, 0, 256, 256);
          glowAlphaTexture = applyLinearSampling(new THREE.CanvasTexture(glowAlphaCanvas));
        }
      } catch (e) {
        glowAlphaTexture = null;
      }
    }
    if (!glowProbeCanvas && typeof document !== 'undefined') {
      try {
        glowProbeCanvas = document.createElement('canvas');
        glowProbeCanvas.width = 8;
        glowProbeCanvas.height = 8;
        // v8.11: willReadFrequently forces a software-backed canvas, so the
        // 120ms ambilight getImageData can no longer flush/sync the GPU
        // command queue inside the XR frame loop (black-flash suspect, §3.6).
        glowProbeCtx = glowProbeCanvas.getContext('2d', { willReadFrequently: true });
      } catch (e) {
        glowProbeCanvas = null;
        glowProbeCtx = null;
      }
    }
    // ?glow=0 skips the ambient glow entirely (fill-rate bisection).
    if (!ambilightMesh && debugFlags.glow) {
      const glowGeo = createScreenGeometry(curvatureMode, 2.4 * 1.34, 2.4 * 1.34, 24, 24) ||
        new THREE.PlaneGeometry(3.2, 3.2);
      const glowMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(glowColor[0], glowColor[1], glowColor[2]),
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      if (glowAlphaTexture) glowMat.alphaMap = glowAlphaTexture;
      ambilightMesh = new THREE.Mesh(glowGeo, glowMat);
      scene.add(ambilightMesh);
      commitScreenTransform();
    }

    // In-screen popup comment overlay mesh (upstream overlay quad): shares
    // the screen pose/scale, drawn transparently just above the video.
    // ?overlay=0 skips it entirely (pre-overlay builds).
    const uiOverlay = getUICanvas();
    if (!overlayCanvas && typeof document !== 'undefined' && debugFlags.overlay) {
      overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = uiOverlay ? uiOverlay.OVERLAY_W : 1024;
      overlayCanvas.height = uiOverlay ? uiOverlay.OVERLAY_H : 1024;
      overlayCtx = overlayCanvas.getContext('2d');
    }
    if (!overlayTexture && overlayCanvas && debugFlags.overlay) {
      overlayTexture = applyLinearSampling(new THREE.CanvasTexture(overlayCanvas));
      try { if (THREE.SRGBColorSpace !== undefined) overlayTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    }
    if (!overlayMesh && overlayTexture && debugFlags.overlay) {
      const ovGeo = createScreenGeometry(curvatureMode);
      const ovMat = new THREE.MeshBasicMaterial({
        map: overlayTexture,
        transparent: true,
        // Legacy painter's order: UI quads always paint over the video
        // screen regardless of geometry (v5.2 drew with DEPTH_TEST off).
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      overlayMesh = new THREE.Mesh(ovGeo, ovMat);
      overlayMesh.renderOrder = 2;
      overlayMesh.visible = false;
      scene.add(overlayMesh);
      commitScreenTransform();
    }

    // Controls Dock Mesh
    const ui = getUICanvas();
    if (!controlsCanvas && typeof document !== 'undefined') {
      controlsCanvas = document.createElement('canvas');
      controlsCanvas.width = ui ? ui.CONTROLS_W : 1024;
      controlsCanvas.height = ui ? ui.CONTROLS_H : 384;
      controlsCtx = controlsCanvas.getContext('2d');
    }
    if (!controlsTexture && controlsCanvas) {
      controlsTexture = applyLinearSampling(new THREE.CanvasTexture(controlsCanvas));
      try { if (THREE.SRGBColorSpace !== undefined) controlsTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    }
    if (!controlsMesh && controlsTexture) {
      const ctrlGeo = new THREE.PlaneGeometry(1.6, 0.6);
      const ctrlMat = new THREE.MeshBasicMaterial({
        map: controlsTexture,
        transparent: true,
        // Legacy painter's order (v5.2 drew with DEPTH_TEST off): the dock
        // always paints over the video screen (renderOrder ladder below).
        depthTest: false,
        side: THREE.DoubleSide,
      });
      controlsMesh = new THREE.Mesh(ctrlGeo, ctrlMat);
      controlsMesh.renderOrder = 3;
      controlsMesh.visible = controlsVisible;
      scene.add(controlsMesh);
      layoutControlsDock();
    }

    // Comments Panel Mesh
    if (!commentsCanvas && typeof document !== 'undefined') {
      commentsCanvas = document.createElement('canvas');
      commentsCanvas.width = ui ? ui.CPANEL_W : 560;
      commentsCanvas.height = ui ? ui.CPANEL_H : 680;
      commentsCtx = commentsCanvas.getContext('2d');
    }
    if (!commentsTexture && commentsCanvas) {
      commentsTexture = applyLinearSampling(new THREE.CanvasTexture(commentsCanvas));
      try { if (THREE.SRGBColorSpace !== undefined) commentsTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    }
    if (!commentsMesh && commentsTexture) {
      const cpGeo = new THREE.PlaneGeometry(1.05, 1.28);
      const cpMat = new THREE.MeshBasicMaterial({
        map: commentsTexture,
        transparent: true,
        // Legacy painter's order: the panel always paints over the video.
        depthTest: false,
        side: THREE.DoubleSide,
      });
      commentsMesh = new THREE.Mesh(cpGeo, cpMat);
      commentsMesh.renderOrder = 4;
      commentsMesh.visible = false;
      scene.add(commentsMesh);
      layoutCommentsPanel(getHeadPosition());
    }

    // Controller guide mesh (upstream guide panel, RIGHT of the player).
    // ?guide=0 skips it entirely.
    if (!guideCanvas && typeof document !== 'undefined' && debugFlags.guide) {
      guideCanvas = document.createElement('canvas');
      guideCanvas.width = uiOverlay ? uiOverlay.GUIDE_W : 440;
      guideCanvas.height = uiOverlay ? uiOverlay.GUIDE_H : 760;
      guideCtx = guideCanvas.getContext('2d');
    }
    if (!guideTexture && guideCanvas && debugFlags.guide) {
      guideTexture = applyLinearSampling(new THREE.CanvasTexture(guideCanvas));
      try { if (THREE.SRGBColorSpace !== undefined) guideTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    }
    if (!guideMesh && guideTexture && debugFlags.guide) {
      const aspect = ui ? (ui.GUIDE_H / ui.GUIDE_W) : (760 / 440);
      const gGeo = new THREE.PlaneGeometry(1, aspect);
      const gMat = new THREE.MeshBasicMaterial({
        map: guideTexture,
        transparent: true,
        // Legacy painter's order: the guide always paints over the video.
        depthTest: false,
        side: THREE.DoubleSide,
      });
      guideMesh = new THREE.Mesh(gGeo, gMat);
      guideMesh.renderOrder = 4;
      guideMesh.visible = false;
      scene.add(guideMesh);
      if (guideCtx && ui && typeof ui.renderGuideCanvas === 'function') {
        try {
          ui.renderGuideCanvas(guideCtx);
          guideTexture.needsUpdate = true;
          vrGuideUploaded = true;
        } catch (e) {}
      }
      layoutGuidePanel(getHeadPosition());
    }

    // Laser pointer + reticle (all-red, upstream drawLaserPointer look:
    // thin line from the ray origin plus a billboarded dot at the hit).
    if (!laserPositions) {
      try {
        laserPositions = new Float32Array(6);
      } catch (e) {
        laserPositions = null;
      }
    }
    if (!laserLine && laserPositions && THREE) {
      const laserGeo = new THREE.BufferGeometry();
      laserGeo.setAttribute('position', new THREE.BufferAttribute(laserPositions, 3));
      const laserMat = new THREE.LineBasicMaterial({
        color: 0xff2a1a,
        transparent: true,
        opacity: 0.8,
        // Legacy parity: the beam always paints over the scene (v5.2 drew
        // the laser last with DEPTH_TEST off).
        depthTest: false,
        depthWrite: false,
      });
      laserLine = new THREE.Line(laserGeo, laserMat);
      laserLine.frustumCulled = false;
      laserLine.renderOrder = 999;
      laserLine.visible = false;
      scene.add(laserLine);
    }
    if (!reticleTexture && typeof document !== 'undefined' && THREE) {
      try {
        const rc = document.createElement('canvas');
        rc.width = 64;
        rc.height = 64;
        const rx = rc.getContext('2d');
        if (rx) {
          const rg = rx.createRadialGradient(32, 32, 2, 32, 32, 30);
          rg.addColorStop(0, '#ffffff');
          rg.addColorStop(0.25, '#ff2a1a');
          rg.addColorStop(0.6, 'rgba(255,42,26,0.55)');
          rg.addColorStop(1, 'rgba(255,42,26,0)');
          rx.fillStyle = rg;
          rx.fillRect(0, 0, 64, 64);
          rx.strokeStyle = '#ff2a1a';
          rx.lineWidth = 3;
          rx.beginPath();
          rx.arc(32, 32, 20, 0, Math.PI * 2);
          rx.stroke();
          rx.fillStyle = '#ffffff';
          rx.beginPath();
          rx.arc(32, 32, 5, 0, Math.PI * 2);
          rx.fill();
          reticleTexture = applyLinearSampling(new THREE.CanvasTexture(rc));
        }
      } catch (e) {
        reticleTexture = null;
      }
    }
    if (!reticleMesh && reticleTexture) {
      const reticleMat = new THREE.MeshBasicMaterial({
        map: reticleTexture,
        transparent: true,
        opacity: 0.9,
        // Never depth-clipped: with the pullback above, oblique hits on the
        // curved screen can't bury half the dot (the reported half circle).
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      reticleMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), reticleMat);
      reticleMesh.renderOrder = 1000;
      reticleMesh.visible = false;
      scene.add(reticleMesh);
    }

    // Starfield Points
    if (!starfieldPoints) {
      const starGeo = new THREE.BufferGeometry();
      const starCount = 1500;
      const starPositions = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        const u = Math.random();
        const v = Math.random();
        const th = u * 2 * Math.PI;
        const ph = Math.acos(2 * v - 1);
        const r = 25 + Math.random() * 15;
        starPositions[i * 3] = r * Math.sin(ph) * Math.cos(th);
        starPositions[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        starPositions[i * 3 + 2] = r * Math.cos(ph);
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
      const starMat = new THREE.PointsMaterial({ color: 0x99ccff, size: 0.08, transparent: true, opacity: 0.8 });
      starfieldPoints = new THREE.Points(starGeo, starMat);
      scene.add(starfieldPoints);
    }

    // Earth Subsystem — textured holographic globe (upstream visual parity):
    // dark equirect base map + painted heat zones, 3D pulsing pins at exact
    // location vectors, atmospheric rim, label + hover-preview billboards.
    if (!earthMapCanvas && typeof document !== 'undefined') {
      try {
        earthMapCanvas = document.createElement('canvas');
        earthMapCanvas.width = EARTH_MAP_W;
        earthMapCanvas.height = EARTH_MAP_H;
        earthMapCtx = earthMapCanvas.getContext('2d');
      } catch (e) {
        earthMapCanvas = null;
        earthMapCtx = null;
      }
    }
    if (!earthMapTexture && earthMapCanvas && THREE) {
      earthMapTexture = applyLinearSampling(new THREE.CanvasTexture(earthMapCanvas));
      try { if (THREE.SRGBColorSpace !== undefined) earthMapTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
      try {
        // Compensate the SphereGeometry UV seam (see earthZoneUV): shift
        // the texture +90° so standard-equirect texels land on the matching
        // geographic directions. Repeat wrap is mandatory — Clamp would
        // smear the dateline edge.
        if (THREE.RepeatWrapping !== undefined) earthMapTexture.wrapS = THREE.RepeatWrapping;
        earthMapTexture.offset.x = 0.25;
      } catch (e) {}
      earthMapDirty = true;
    }
    // Kick off the Natural Earth photo re-style (async; fallback paints now).
    loadEarthBasePhoto();
    if (!earthGroup) {
      earthGroup = new THREE.Group();
      earthGroup.position.set(earthCenter.x, earthCenter.y, earthCenter.z);

      const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 48, 32);
      const earthMat = new THREE.MeshBasicMaterial({
        map: earthMapTexture || null,
        color: earthMapTexture ? 0xffffff : 0x0d2a3f,
      });
      earthMesh = new THREE.Mesh(earthGeo, earthMat);
      earthGroup.add(earthMesh);

      earthPinsGroup = new THREE.Group();
      earthMesh.add(earthPinsGroup);
      rebuildEarthPins();

      // Z2 tile layer: child of the mesh so patches inherit the geographic
      // frame (same convention as pins/hit-test) plus the group's zoom scale.
      earthTileGroup = new THREE.Group();
      earthTileGroup.renderOrder = 1;
      earthMesh.add(earthTileGroup);
      earthTileZ = -1;
      earthTileCenterKey = '';

      // Z3 heat overlay: additive sprites that stay visible over the tiles.
      earthHeatGroup = new THREE.Group();
      earthHeatGroup.visible = false;
      earthMesh.add(earthHeatGroup);
      rebuildEarthHeatSprites();

      // NOTE: no platform deck under the globe. An early port added a dark
      // truncated cone here, but in-headset it read as a panel slicing the
      // earth into a hemisphere, so it was removed per owner request. The
      // globe floats free against the starfield.

      if (!earthLabelCanvas && typeof document !== 'undefined') {
        try {
          earthLabelCanvas = document.createElement('canvas');
          earthLabelCanvas.width = 640;
          earthLabelCanvas.height = 112;
          earthLabelCtx = earthLabelCanvas.getContext('2d');
        } catch (e) {
          earthLabelCanvas = null;
          earthLabelCtx = null;
        }
      }
      if (!earthLabelTexture && earthLabelCanvas && THREE) {
        earthLabelTexture = applyLinearSampling(new THREE.CanvasTexture(earthLabelCanvas));
        try { if (THREE.SRGBColorSpace !== undefined) earthLabelTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
      }
      if (!earthLabelMesh && earthLabelTexture) {
        const labelMat = new THREE.MeshBasicMaterial({
          map: earthLabelTexture,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        earthLabelMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.15), labelMat);
        // Scene-rooted (Z1): the zoomed globe group scales/moves, while the
        // label must stay a fixed world-size billboard. updateEarthDressing
        // stations it every frame (legacy spot at globe scale).
        earthLabelMesh.position.set(earthCenter.x, earthCenter.y + EARTH_RADIUS + 0.28, earthCenter.z);
        scene.add(earthLabelMesh);
        lastEarthLabelKey = '';
      }

      if (!earthPreviewCanvas && typeof document !== 'undefined') {
        try {
          earthPreviewCanvas = document.createElement('canvas');
          earthPreviewCanvas.width = 512;
          earthPreviewCanvas.height = 512;
          earthPreviewCtx = earthPreviewCanvas.getContext('2d');
        } catch (e) {
          earthPreviewCanvas = null;
          earthPreviewCtx = null;
        }
      }
      if (!earthPreviewTexture && earthPreviewCanvas && THREE) {
        earthPreviewTexture = applyLinearSampling(new THREE.CanvasTexture(earthPreviewCanvas));
        try { if (THREE.SRGBColorSpace !== undefined) earthPreviewTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
      }
      if (!earthPreviewMesh && earthPreviewTexture) {
        const pvMat = new THREE.MeshBasicMaterial({
          map: earthPreviewTexture,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        earthPreviewMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), pvMat);
        // Scene-rooted like the label (Z1 zoom safety); updateEarthDressing
        // re-stations it per frame.
        earthPreviewMesh.position.set(earthCenter.x + 0.94, earthCenter.y + 0.17, earthCenter.z);
        earthPreviewMesh.visible = false;
        scene.add(earthPreviewMesh);
      }

      earthGroup.visible = (sceneMode === 'earth');
      scene.add(earthGroup);
      earthResourcesReady = true;
    }

    applySceneVisibility();
    return renderer;
  }

  // ─── Texture Blitting ───────────────────────────────────────────────
  // Uploads go through THREE.CanvasTexture (vrProxyCanvas → videoTexture).
  // The old raw-WebGL build called gl.texImage2D directly; doing that here
  // with hand-rolled args would corrupt Three's GL state tracking, so the
  // raw calls were removed. Uploads are gated (new frame / new visual /
  // time moved) instead of re-uploading 16 MiB every tick.
  // `lastUploadedSource` mirrors the upload for the Node test harness,
  // which previously spied on mock gl.texImage2D.
  let lastUploadedSource = null;
  let pendingClearedFor = '';
  // v8.10 first-frame hold: monotonic start of the current fresh (just-
  // switched) video visual. 0 when no fresh visual is pending.
  let freshVisualSince = 0;
  // Max time to hold the previous frame waiting for clean first frames
  // before showing whatever the decoder has (safety valve on slow tunnels).
  const FRESH_VISUAL_MAX_HOLD_MS = 2500;

  function nowMs() {
    try {
      if (typeof performance !== 'undefined' && performance.now) return performance.now();
    } catch (e) {}
    try {
      if (typeof Date !== 'undefined' && Date.now) return Date.now();
    } catch (e) {}
    return 0;
  }
  // v8.9 hold-last-frame: once a visual has displayed, reel switches keep
  // showing it until the new source is ready (no black-clear flash mid-
  // playlist). Clears happen only with nothing displayed yet (session start).
  let hasDisplayedVisual = false;

  function visualSourceSignature(source) {
    return String(source.kind || '') + '|' + String(source.version || '');
  }

  function bindScreenMap(tex) {
    try {
      if (screenMesh && screenMesh.material && screenMesh.material.map !== tex) {
        screenMesh.material.map = tex;
        screenMesh.material.needsUpdate = true;
      }
    } catch (e) {}
  }

  function directVideoEligible(source) {
    return !!(debugFlags.vrtex && source && source.kind === 'video' && source.element &&
      typeof THREE !== 'undefined' && THREE.VideoTexture && screenMesh && screenMesh.material);
  }

  // v8.13 (?vrtex=video): keep a direct THREE.VideoTexture of the video
  // element bound to the screen — the same hardware path other Quest video
  // sites use. Fresh elements wait for HAVE_FUTURE_DATA (v8.10 rule) so the
  // previous map holds until clean frames exist; steady elements stay bound
  // (three uploads the current frame per render, no app gating). Static
  // cards/images keep the canvas path. Returns true when this source is
  // showing through the direct texture.
  function updateDirectVideoBinding(source, force) {
    if (!directVideoEligible(source)) return false;
    const el = source.element;
    if (directVideoTexture && directVideoElement === el &&
        screenMesh.material.map === directVideoTexture) {
      return true;
    }
    const rs = Number((el && el.readyState) || 0);
    const isFresh = !directVideoTexture || directVideoElement !== el;
    const need = isFresh ? 3 : 2;
    if (rs < need && !force) return false; // hold previous map
    try {
      if (directVideoTexture) { try { directVideoTexture.dispose(); } catch (e) {} }
      directVideoTexture = applyLinearSampling(new THREE.VideoTexture(el));
      try { if (THREE.SRGBColorSpace !== undefined) directVideoTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    } catch (e) {
      directVideoTexture = null;
      return false;
    }
    directVideoElement = el;
    bindScreenMap(directVideoTexture);
    lastUploadedSource = el;
    lastVisualKind = source.kind;
    lastVisualVersion = visualSourceSignature(source);
    lastVisualElement = el;
    lastVideoTime = Number(source.currentTime) || 0;
    // NOTE: lastVideoFrameCount is intentionally NOT updated here — the
    // caller compares it to count newly decoded frames into videoUploads.
    hasNewVideoFrame = false;
    pendingClearedFor = '';
    freshVisualSince = 0;
    return true;
  }

  function releaseDirectVideoBinding() {
    if (directVideoTexture) { try { directVideoTexture.dispose(); } catch (e) {} }
    directVideoTexture = null;
    directVideoElement = null;
  }

  function shouldUploadVisual(source) {
    if (!source || !source.element) return false;
    const sig = visualSourceSignature(source);
    const visualChanged = source.kind !== lastVisualKind ||
      sig !== lastVisualVersion ||
      source.element !== lastVisualElement;
    if (visualChanged) return true;
    if (source.kind === 'video') {
      // v8.11 upload throttle: steady-playback telemetry measured 41–73/s
      // uploads against 30fps masters (~1.2 GB/s texture traffic loading the
      // GL queue behind the glow readback; §3.6). Cap video uploads at ~30/s;
      // visual changes and seek jumps bypass so nothing goes stale.
      // Frozen/unchanged clocks (test mocks) never throttle: only a positive
      // sub-interval gap blocks.
      const seekJump = Math.abs(Number(source.currentTime) - Number(lastVideoTime)) > 0.25;
      const sinceUploadMs = nowMs() - lastVideoUploadMs;
      if (!hasNewVideoFrame && !seekJump && sinceUploadMs > 0 && sinceUploadMs < VR_VIDEO_UPLOAD_MIN_MS) {
        return false;
      }
      if (hasNewVideoFrame) return true;
      const vf = decodedFrameCount(source.element);
      if (vf >= 0) {
        if (vf !== lastVideoFrameCount) return true;
        // Paused seeks can land on cached frames without new decodes or
        // rVFC pings — catch time jumps so the texture never goes stale.
        if (seekJump) return true;
        return false;
      }
      if (Number(source.currentTime) !== Number(lastVideoTime)) return true;
      return false;
    }
    // Static cards / images only re-upload when something changed.
    return false;
  }

  function uploadVideoFrame(force) {
    const source = getVisualSource();
    if (!vrProxyCtx || !source.element) return false;
    // v8.13: sources that don't use the direct texture (static cards/images,
    // or the flag off) render through the canvas proxy — make sure it is bound.
    if (!(debugFlags.vrtex && source.kind === 'video')) bindScreenMap(videoTexture);
    if (!force && !shouldUploadVisual(source)) return false;
    try {
      if (source.kind === 'static-card' || source.kind === 'image') {
        // Trust the caller's ready flag: a genuinely incomplete image
        // surfaces as a drawImage exception below (→ false, retried next
        // frame). Refusing here would stall mock/test elements that carry
        // no complete/naturalWidth signals.
        if (source.ready === false && !force) return false;
        vrProxyCtx.clearRect(0, 0, VR_TEX_CAP, VR_TEX_CAP);
        try {
          vrProxyCtx.drawImage(source.element, 0, 0, VR_TEX_CAP, VR_TEX_CAP);
        } catch (drawErr) {
          return false;
        }
      } else if (source.element.readyState >= 2) {
        // v8.10 first-frame hold: a just-switched visual waits for forward-
        // buffered data (HAVE_FUTURE_DATA) so the first shown frames are
        // past decoder resync garbage — HAVE_CURRENT_DATA alone can be a
        // corrupt partial. Steady visuals upload as before. A wall-clock
        // cap bounds the hold on slow tunnels. `force` bypasses the hold.
        const justSwitched = !force && (
          visualSourceSignature(source) !== lastVisualVersion ||
          source.element !== lastVisualElement
        );
        if (justSwitched && source.element.readyState < 3) {
          if (!freshVisualSince) freshVisualSince = nowMs();
          if (nowMs() - freshVisualSince < FRESH_VISUAL_MAX_HOLD_MS) {
            renderStats.transNotReady += 1;
            return false;
          }
        }
        try {
          vrProxyCtx.drawImage(source.element, 0, 0, VR_TEX_CAP, VR_TEX_CAP);
        } catch (drawErr) {
          return false;
        }
      } else {
        return false;
      }
      if (videoTexture) {
        // v8.4 A/B: 'respec' forces a full texImage2D re-specification per
        // upload (legacy behavior) instead of three's same-size
        // texSubImage2D path — decisive test for the Quest sub-image driver
        // suspicion behind the black-square glitches. Default stays subimage.
        if (videoUploadMode === 'respec') {
          try { videoTexture.dispose(); } catch (e) {}
        }
        videoTexture.needsUpdate = true;
      }
      lastUploadedSource = source.element;
      lastVisualKind = source.kind;
      lastVisualVersion = visualSourceSignature(source);
      lastVisualElement = source.element;
      if (source.kind === 'video') {
        lastVideoTime = Number(source.currentTime) || 0;
        lastVideoFrameCount = decodedFrameCount(source.element);
        lastVideoUploadMs = nowMs();
      }
      hasNewVideoFrame = false;
      pendingClearedFor = '';
      freshVisualSince = 0;
      hasDisplayedVisual = true;
      renderStats.videoUploads += 1;
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearPendingTexture() {
    const source = getVisualSource();
    const sig = visualSourceSignature(source);
    // Clear once per pending visual (old clearPendingVisual2D semantics);
    // clearing every frame while a video loads causes black flicker.
    if (pendingClearedFor === sig) return;
    pendingClearedFor = sig;
    // Hold the last displayed frame across switches instead of flashing
    // black (v8.9: the black clear is now session-start-only).
    if (hasDisplayedVisual) return;
    renderStats.transClears += 1;
    if (vrProxyCtx) {
      try {
        vrProxyCtx.clearRect(0, 0, VR_TEX_CAP, VR_TEX_CAP);
        vrProxyCtx.fillStyle = '#000';
        vrProxyCtx.fillRect(0, 0, VR_TEX_CAP, VR_TEX_CAP);
      } catch (e) {}
    }
    if (videoTexture) videoTexture.needsUpdate = true;
    lastUploadedSource = '__cleared__';
  }

  // Samples the playing video at 8x8 and steers the ambient glow color
  // (upstream updateAmbilightColor: average, enhance, lerp 0.08/frame).
  function updateGlowColor(time, intervalMs) {
    if (!ambilightMesh || !glowProbeCtx) return;
    // ?glowprobe=0 keeps the glow mesh but kills the getImageData readback
    // sync (diagnostic: isolates readback stalls from fill-rate cost).
    if (!debugFlags.glowprobe) return;
    if (time - lastGlowSample < intervalMs) return;
    lastGlowSample = time;
    const source = getVisualSource();
    if (!source.ready || source.kind !== 'video' || source.paused || !source.element) return;
    try {
      glowProbeCtx.drawImage(source.element, 0, 0, 8, 8);
      const d = glowProbeCtx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = (d.length / 4) * 255;
      glowTarget = [
        Math.min(1, (r / n) * 1.35 + 0.03),
        Math.min(1, (g / n) * 1.35 + 0.05),
        Math.min(1, (b / n) * 1.45 + 0.09),
      ];
    } catch (e) {}
  }

  function applyGlowColor() {
    if (!ambilightMesh || !ambilightMesh.material || !ambilightMesh.material.color) return;
    glowColor[0] += (glowTarget[0] - glowColor[0]) * 0.08;
    glowColor[1] += (glowTarget[1] - glowColor[1]) * 0.08;
    glowColor[2] += (glowTarget[2] - glowColor[2]) * 0.08;
    try {
      ambilightMesh.material.color.setRGB(glowColor[0], glowColor[1], glowColor[2]);
    } catch (e) {}
  }

  function getAutoNext() {
    try {
      if (callbacks.getAutoNext) return callbacks.getAutoNext() !== false;
    } catch (e) {}
    return true;
  }

  // Max scroll for the comments list (upstream renderCommentsPanelCanvas math).
  function refreshPanelScrollBounds(comments) {
    const ui = getUICanvas();
    if (!ui || ui.CP_LIST_TOP === undefined) return;
    let filtered = comments;
    if (cPanelTab === 'sync') {
      filtered = comments.filter((c) => c.timestamp !== null && c.timestamp !== undefined);
    } else if (cPanelTab === 'general') {
      filtered = comments.filter((c) => c.timestamp === null || c.timestamp === undefined);
    }
    const listH = ui.CP_LIST_BOTTOM - ui.CP_LIST_TOP;
    const contentH = filtered.length * (ui.CP_ITEM_H + ui.CP_ITEM_GAP);
    cPanelMaxScroll = Math.max(0, contentH - listH);
    if (cPanelScrollY > cPanelMaxScroll) cPanelScrollY = cPanelMaxScroll;
    if (cPanelScrollY < 0) cPanelScrollY = 0;
  }

  function clampPanelScroll(v) {
    return Math.max(0, Math.min(cPanelMaxScroll, Number(v) || 0));
  }

  function clearPanelHighlight() {
    if (cPanelHighlightTimer) {
      try { clearTimeout(cPanelHighlightTimer); } catch (e) {}
      cPanelHighlightTimer = null;
    }
    cPanelHighlightId = null;
  }

  // Re-renders + re-uploads the popup-comment overlay ONLY when dirty: the
  // visible popup set changed, or the hover changed. Fade animation repaints
  // at the UI interval while popups are visible; with zero popups nothing
  // re-renders and the texture is never re-uploaded (v8.4: the old
  // currentTime-driven key re-spec'd 1024² ~10×/s during ALL playback —
  // the exact upload-churn class flagged in the playback investigation).
  function refreshOverlayTexture(time, force) {
    const ui = getUICanvas();
    if (!debugFlags.overlay) {
      if (overlayHasPopups) {
        overlayHasPopups = false;
        overlayRegions = [];
        overlayHoverId = null;
        applySceneVisibility();
      }
      return false;
    }
    if (!ui || !overlayCtx || typeof ui.renderOverlayCanvas !== 'function' ||
        typeof ui.filterOverlayComments !== 'function') {
      if (overlayHasPopups) {
        overlayHasPopups = false;
        overlayRegions = [];
        overlayHoverId = null;
        applySceneVisibility();
      }
      return false;
    }
    const source = getVisualSource();
    // Suppressed while the comments panel is open (upstream parity).
    const comments = (commentsPanelVisible || source.kind !== 'video' || !callbacks.getComments)
      ? []
      : (callbacks.getComments() || []);
    let activeIds = '';
    try {
      activeIds = ui.filterOverlayComments(comments, source.currentTime)
        .map((c) => String(c.id)).join(',');
    } catch (e) { activeIds = ''; }
    const key = activeIds + '|' + (overlayHoverId || '');
    const hasActive = activeIds.length > 0;
    const due = (time === undefined) || (lastOverlayUploadT < 0) ||
      ((time - lastOverlayUploadT) >= VR_UI_MIN_INTERVAL);
    if (!force && key === lastOverlayKey) {
      // Same set, same hover: repaint only for the fade while visible.
      if (!hasActive || !due) return overlayHasPopups;
    }
    lastOverlayKey = key;
    if (time !== undefined) lastOverlayUploadT = time;
    let regions = [];
    try {
      regions = ui.renderOverlayCanvas(overlayCtx, {
        comments,
        currentTime: source.currentTime,
        overlayHoverId,
      }) || [];
    } catch (e) { regions = []; }
    overlayRegions = regions;
    if (overlayHoverId && !regions.some((r) => r.id === overlayHoverId)) overlayHoverId = null;
    const had = overlayHasPopups;
    overlayHasPopups = regions.length > 0;
    if (overlayTexture) {
      overlayTexture.needsUpdate = true;
      renderStats.overlayUploads = (renderStats.overlayUploads || 0) + 1;
    }
    if (had !== overlayHasPopups) applySceneVisibility();
    return overlayHasPopups;
  }

  function updateUiTextures() {
    const ui = getUICanvas();
    if (!ui) return;
    const source = getVisualSource();
    let itemState = {};
    if (callbacks.getCurrentItemState) {
      try { itemState = callbacks.getCurrentItemState() || {}; } catch (e) {}
    }

    // ?dockfreeze=1 paints the dock once per session, then freezes its
    // texture re-uploads (diagnostic: isolates dock sub-image tears).
    if (controlsCtx && !(debugFlags.dockfreeze && dockFreezePainted)) {
      ui.renderControlsCanvas(controlsCtx, {
        source,
        itemState,
        packMode: isPackExperience(),
        packContext: getPackContext(),
        playlist: callbacks.getPlaylist ? callbacks.getPlaylist() : [],
        idx: callbacks.getCurrentIndex ? callbacks.getCurrentIndex() : 0,
        comments: callbacks.getComments ? callbacks.getComments() : [],
        hoveredButton,
        pressedButton,
        isCurved,
        curvatureMode,
        lockToViewer,
        autoNext: getAutoNext(),
        sceneMode,
        notificationText,
        notificationUntil,
        callbacks,
      });
      if (controlsTexture) {
        controlsTexture.needsUpdate = true;
        renderStats.dockUploads += 1;
      }
      dockFreezePainted = true;
    }

    // Guide panel is static artwork: render once (covers late creation
    // ordering; vrGuideUploaded is reset on session entry/cleanup). The
    // controller photo arrives asynchronously — re-render + re-upload while
    // the artwork-dirty flag is set (legacy vrGuideUploaded=false semantics).
    let guideDirty = false;
    try {
      guideDirty = !!(ui.isGuideArtworkDirty && ui.isGuideArtworkDirty());
    } catch (e) { guideDirty = false; }
    if (guideCtx && guideTexture && (!vrGuideUploaded || guideDirty) &&
        typeof ui.renderGuideCanvas === 'function') {
      try {
        ui.renderGuideCanvas(guideCtx);
        guideTexture.needsUpdate = true;
        renderStats.guideUploads += 1;
        vrGuideUploaded = true;
        if (ui.clearGuideArtworkDirty) ui.clearGuideArtworkDirty();
      } catch (e) {}
    }

    if (commentsCtx && commentsPanelVisible) {
      const comments = callbacks.getComments ? callbacks.getComments() : [];
      refreshPanelScrollBounds(comments);
      ui.renderCommentsPanelCanvas(commentsCtx, {
        comments,
        cPanelTab,
        cPanelScrollY,
        cPanelHover,
        cPanelHighlightId,
        user: callbacks.getCurrentUser ? callbacks.getCurrentUser() : null,
        currentTime: source.currentTime,
      });
      if (commentsTexture) {
        commentsTexture.needsUpdate = true;
        renderStats.panelUploads += 1;
      }
    }
  }

  // ─── Telemetry Event Dispatcher ─────────────────────────────────────
  function emitPreviewState() {
    if (typeof window === 'undefined') return;
    const state = getPreviewState();
    try {
      window.dispatchEvent(new CustomEvent('echo:webxr-preview-state', { detail: state }));
    } catch (e) {}
  }

  function getPreviewState() {
    return {
      running: !!previewRunning,
      presenting: !!xrSession,
      xrCompat: xrCompatStatus,
      cameraMode: previewCameraMode,
      sceneMode,
      stereo: stereoMode,
      reducedMotion,
      curvatureMode: getCurvatureMode(),
      lockToViewer,
      controlsVisible,
      hoveredButton,
      pressedButton,
      renderStats: { ...renderStats },
      earthState: getEarthState(),
    };
  }

  // ─── Frame Rendering Loop ───────────────────────────────────────────
  let vrLastUiUploadT = -1;
  let lastRenderError = '';
  let renderErrorWarned = false;

  function renderStereoPair() {
    const cssW = (previewCanvas && previewCanvas.clientWidth) || 960;
    const cssH = (previewCanvas && previewCanvas.clientHeight) || 540;
    const halfW = cssW / 2;
    renderer.setScissorTest(true);
    camera.position.x -= 0.032;
    camera.updateMatrixWorld();
    renderer.setViewport(0, 0, halfW, cssH);
    renderer.setScissor(0, 0, halfW, cssH);
    renderer.render(scene, camera);
    camera.position.x += 0.064;
    camera.updateMatrixWorld();
    renderer.setViewport(halfW, 0, cssW - halfW, cssH);
    renderer.setScissor(halfW, 0, cssW - halfW, cssH);
    renderer.render(scene, camera);
    camera.position.x -= 0.032;
    camera.updateMatrixWorld();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, cssW, cssH);
  }

  function onPreviewFrame(time) {
    if (!previewRunning) return;

    updatePreviewSize(previewCanvas);
    applySceneVisibility();

    if (sceneMode === 'reels') {
      const source = getVisualSource();
      if (debugFlags.vrtex && source && source.kind === 'video' && source.element) {
        // v8.13 direct-texture path: no canvas blit/re-upload; three uploads
        // the current frame per render. Telemetry counts decoded frames.
        if (updateDirectVideoBinding(source, false)) {
          const vf = decodedFrameCount(source.element);
          if (vf >= 0 && vf !== lastVideoFrameCount) {
            renderStats.videoUploads += 1;
            lastVideoFrameCount = vf;
          }
          lastVideoTime = Number(source.currentTime) || 0;
          hasDisplayedVisual = true;
        } else {
          // Fresh element below HAVE_FUTURE_DATA or source not ready: hold
          // the previous map (v8.9 semantics), count the wait.
          renderStats.transNotReady += 1;
        }
      } else if (source && source.ready === false) {
        // Frames spent waiting for data (buffering/seeking at transitions):
        // counted so on-device telemetry attributes stalls to buffering.
        if (source.element) renderStats.transNotReady += 1;
        clearPendingTexture();
      } else {
        uploadVideoFrame();
      }
      updateGlowColor(time, 120);
      applyGlowColor();
      refreshOverlayTexture(time);
      renderStats.earthDrawCalls = 0;
      renderStats.reelDrawCalls = 1;
    } else if (sceneMode === 'earth') {
      advanceEarthZoom(time);
      advanceEarthSpin(time);
      updateEarthDressing(time);
      renderStats.earthDrawCalls = 1;
      renderStats.starDrawCalls = 1;
      renderStats.reelDrawCalls = 0;
      if (earthPreviewLocationIndex >= 0 && earthPreviewItems.length > 0) {
        renderStats.earthPreviewUploads = (renderStats.earthPreviewUploads || 0) + 1;
      }
    }

    // UI canvases redraw at ~10 Hz (old VR_UI_MIN_INTERVAL semantics);
    // every-frame 1024×384 redraws stall software GL.
    if (vrLastUiUploadT < 0 || (time - vrLastUiUploadT) >= 100) {
      vrLastUiUploadT = time;
      updateUiTextures();
    }

    if (previewCameraMode === 'orbit') {
      if (orbitControls) orbitControls.update();
      else applyPreviewCamera();
    } else {
      applyPreviewCamera();
    }
    // Headset POV mirrors the XR lock: the screen stays perpendicular and
    // centered on the simulated gaze (upstream parity).
    if (sceneMode === 'reels' && lockApplies() && previewCameraMode === 'headset' && !isPackExperience()) {
      applyLockToViewer();
    }
    commitScreenTransform();
    layoutControlsDock();
    updatePreviewLaser();

    if (renderer && scene && camera) {
      if (stereoMode && previewCanvas) {
        try {
          renderStereoPair();
        } catch (e) {
          lastRenderError = String((e && e.message) || e);
          if (!renderErrorWarned) {
            renderErrorWarned = true;
            console.warn('[WebXRVR] Stereo preview render failed:', e);
          }
          try {
            renderer.setScissorTest(false);
            renderer.render(scene, camera);
          } catch (e2) {
            lastRenderError = String((e2 && e2.message) || e2);
          }
        }
      } else {
        try {
          renderer.setScissorTest(false);
          renderer.render(scene, camera);
        } catch (e) {
          lastRenderError = String((e && e.message) || e);
          if (!renderErrorWarned) {
            renderErrorWarned = true;
            console.warn('[WebXRVR] Preview render failed:', e);
          }
        }
      }
    }

    // Throttle telemetry event dispatches (every 250ms)
    if (time - lastPreviewEmitTime >= 250) {
      lastPreviewEmitTime = time;
      emitPreviewState();
    }

    if (typeof window !== 'undefined' && previewRunning) {
      previewAnimId = window.requestAnimationFrame(onPreviewFrame);
    }
  }

  // ─── Preview Management ─────────────────────────────────────────────
  function ensureOrbitControls(canvas) {
    ensureThree();
    if (!THREE || !THREE.OrbitControls || orbitControls || !camera) return orbitControls;
    try {
      const hasDocListener = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
      const hasCanvasOwner = canvas && canvas.ownerDocument && typeof canvas.ownerDocument.addEventListener === 'function';
      if (!hasDocListener && !hasCanvasOwner) return null;
      orbitControls = new THREE.OrbitControls(camera, canvas);
      orbitControls.enableDamping = true;
      orbitControls.dampingFactor = 0.05;
      orbitControls.enabled = (previewCameraMode === 'orbit');
    } catch (e) {
      orbitControls = null;
    }
    return orbitControls;
  }

  // Raycasts a client-pixel pointer into the shared scene. Restores the old
  // preview hover behavior (controls dock UV hit → button index, earth
  // heat-zone hit) that the first shrink dropped.
  function previewRayAt(clientX, clientY) {
    if (!previewCanvas || !camera || !THREE) return null;
    let rect = null;
    try {
      rect = previewCanvas.getBoundingClientRect ? previewCanvas.getBoundingClientRect() : null;
    } catch (e) { rect = null; }
    const w = (rect && rect.width) || previewCanvas.clientWidth || 960;
    const h = (rect && rect.height) || previewCanvas.clientHeight || 540;
    if (!raycaster) ensureThree();
    if (!raycaster) return null;
    const ndc = new THREE.Vector2(
      (((clientX - (rect ? rect.left : 0)) / Math.max(1, w)) * 2) - 1,
      -(((clientY - (rect ? rect.top : 0)) / Math.max(1, h)) * 2) + 1
    );
    try {
      raycaster.setFromCamera(ndc, camera);
      return { origin: raycaster.ray.origin.clone(), direction: raycaster.ray.direction.clone() };
    } catch (e) {
      return null;
    }
  }

  function updatePreviewHover(clientX, clientY) {
    const ray = previewRayAt(clientX, clientY);
    if (!ray) return null;
    // Cache for the persistent preview head-ray (Workstream D).
    previewHoverRay = { origin: ray.origin, direction: ray.direction };
    let controlIndex = -1;
    if (controlsVisible && controlsMesh && controlsMesh.visible !== false && controlsCanvas) {
      try {
        raycaster.set(ray.origin, ray.direction);
        const hits = raycaster.intersectObject(controlsMesh, false);
        if (hits.length > 0 && hits[0].uv) {
          controlIndex = controlIndexFromUV(hits[0].uv);
        }
      } catch (e) {}
    }
    hoveredButton = controlIndex;
    // Comments panel hover (shared region resolver; also feeds cPanelHover
    // for stick-scroll targeting in preview).
    let panelDesc = '';
    if (sceneMode !== 'earth' && controlIndex < 0 && commentsPanelVisible &&
        commentsMesh && commentsMesh.visible !== false && raycaster) {
      try {
        raycaster.set(ray.origin, ray.direction);
        const hits = raycaster.intersectObject(commentsMesh, false);
        if (hits.length > 0 && hits[0].uv) {
          panelDesc = commentsRegionFromUV(hits[0].uv);
          cPanelHover = panelDesc;
        }
      } catch (e) {}
    }
    if (sceneMode === 'earth' && controlIndex < 0) {
      const hit = hitTestEarth(ray.origin, ray.direction);
      setEarthHoveredIndex(hit.hit ? hit.zoneIndex : -1);
      return { ray, hit, controlIndex, panelDesc };
    }
    return { ray, hit: null, controlIndex, panelDesc };
  }

  // Maps a controls-dock UV hit to a button index (shared by preview
  // hover, XR hover, and XR select handling).
  function controlIndexFromUV(uv) {
    if (!uv) return -1;
    const ui = getUICanvas();
    if (!ui) return -1;
    const w = controlsCanvas ? controlsCanvas.width : 1024;
    const h = controlsCanvas ? controlsCanvas.height : 384;
    const cx = uv.x * w;
    const cy = (1 - uv.y) * h;
    const source = getVisualSource();
    let itemState = {};
    if (callbacks.getCurrentItemState) {
      try { itemState = callbacks.getCurrentItemState() || {}; } catch (e) {}
    }
    try {
      return ui.resolveControlsHit(cx, cy, {
        source,
        itemState,
        sceneMode,
        packMode: isPackExperience(),
      });
    } catch (e) {
      return -1;
    }
  }

  // Shared per-frame laser updater (both loops). Raycast order mirrors
  // upstream: reels → dock, comments panel, screen; earth → dock, globe.
  // Returns the hovered dock button index (or -1).
  function updateLaserPointer(origin, direction) {
    if (!laserLine || !reticleMesh || !origin || !direction || !raycaster) return -1;
    let dist = 3;
    let hovering = -1;
    let overScreen = false;
    let screenHitUv = null;
    // Panel hover region is recomputed from the ray every frame (drives
    // hover highlighting + stick-scroll targeting in both loops).
    cPanelHover = '';
    try {
      raycaster.set(origin, direction);
      if (sceneMode === 'earth') {
        if (controlsVisible && controlsMesh && controlsMesh.visible !== false) {
          const hits = raycaster.intersectObject(controlsMesh, false);
          if (hits.length > 0) {
            dist = hits[0].distance;
            hovering = hits[0].uv ? controlIndexFromUV(hits[0].uv) : -1;
          }
        }
        if (hovering < 0 && earthMesh && earthGroup && earthGroup.visible !== false) {
          const hit = hitTestEarth(origin, direction);
          if (hit.hit) {
            dist = hit.dist;
            hovering = hit.zoneIndex >= 0 ? -2 : -1; // -2 = globe hover (no dock button)
          }
        }
      } else {
        if (controlsVisible && controlsMesh && controlsMesh.visible !== false) {
          const hits = raycaster.intersectObject(controlsMesh, false);
          if (hits.length > 0) {
            dist = hits[0].distance;
            hovering = hits[0].uv ? controlIndexFromUV(hits[0].uv) : -1;
          }
        }
        if (hovering < 0 && commentsMesh && commentsMesh.visible !== false) {
          const hits = raycaster.intersectObject(commentsMesh, false);
          if (hits.length > 0) {
            dist = hits[0].distance;
            hovering = -2;
            // Resolve the panel region (tab / scroll / like / seek / ...).
            try {
              const ui = getUICanvas();
              if (hits[0].uv && ui && typeof ui.resolveCommentsPanelRegion === 'function') {
                const w = commentsCanvas ? commentsCanvas.width : ui.CPANEL_W;
                const h = commentsCanvas ? commentsCanvas.height : ui.CPANEL_H;
                lastCommentsCanvasX = hits[0].uv.x * w;
                lastCommentsCanvasY = (1 - hits[0].uv.y) * h;
                const comments = callbacks.getComments ? callbacks.getComments() : [];
                cPanelHover = ui.resolveCommentsPanelRegion(
                  lastCommentsCanvasX, lastCommentsCanvasY,
                  { comments, cPanelTab, cPanelScrollY }) || '';
              }
            } catch (e) {}
          }
        }
        if (hovering < 0 && screenMesh && screenMesh.visible !== false) {
          const hits = raycaster.intersectObject(screenMesh, false);
          if (hits.length > 0) {
            dist = hits[0].distance;
            overScreen = true;
            screenHitUv = hits[0].uv || null;
          }
        }
      }
      // Track hover over a pop-up comment on the reels screen (panel closed).
      overlayHoverId = null;
      if (!commentsPanelVisible && overScreen && screenHitUv && overlayRegions.length > 0) {
        try {
          const ui = getUICanvas();
          if (ui && typeof ui.resolveOverlayCommentAt === 'function') {
            const w = overlayCanvas ? overlayCanvas.width : ui.OVERLAY_W;
            const h = overlayCanvas ? overlayCanvas.height : ui.OVERLAY_H;
            overlayHoverId = ui.resolveOverlayCommentAt(
              screenHitUv.x * w, (1 - screenHitUv.y) * h, overlayRegions);
          }
        } catch (e) {}
      }
    } catch (e) {}
    const isHover = hovering >= 0 || overScreen || hovering === -2;
    dist = Math.max(0.2, Math.min(30, dist));
    try {
      laserPositions[0] = origin.x;
      laserPositions[1] = origin.y;
      laserPositions[2] = origin.z;
      laserPositions[3] = origin.x + direction.x * dist;
      laserPositions[4] = origin.y + direction.y * dist;
      laserPositions[5] = origin.z + direction.z * dist;
      laserLine.geometry.attributes.position.needsUpdate = true;
      laserLine.material.opacity = isHover ? 1.0 : 0.7;
      // The billboarded reticle floats just off the surface (never buried in
      // it) and ignores depth like the legacy always-on-top dot, so oblique
      // hits on the curved screen can never clip it into a half circle.
      const pull = Math.min(RETICLE_PULLBACK, Math.max(0, dist - 0.05));
      reticleMesh.position.set(
        origin.x + direction.x * (dist - pull),
        origin.y + direction.y * (dist - pull),
        origin.z + direction.z * (dist - pull)
      );
      if (camera) {
        try { reticleMesh.quaternion.copy(camera.quaternion); } catch (e2) {}
      }
      const s = isHover ? 0.07 : 0.045;
      reticleMesh.scale.set(s, s, 1);
      reticleMesh.material.opacity = isHover ? 1.0 : 0.85;
    } catch (e) {}
    return hovering;
  }

  // Persistent preview head-ray: follows the cached mouse hover ray, else
  // fires from the head straight ahead (always visible per requirement).
  function updatePreviewLaser() {
    let origin = null;
    let direction = null;
    if (previewHoverRay && previewHoverRay.origin && previewHoverRay.direction) {
      origin = previewHoverRay.origin;
      direction = previewHoverRay.direction;
    } else if (camera && THREE) {
      origin = camera.position;
      try {
        if (!scratchVec2) scratchVec2 = new THREE.Vector3();
        direction = scratchVec2.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize().clone();
      } catch (e) {
        direction = null;
      }
    }
    if (origin && direction) {
      const hovered = updateLaserPointer(origin, direction);
      if (hovered >= 0) hoveredButton = hovered;
    }
  }

  // Shared-laser source preference (upstream pointerEligible): the right
  // hand drives the laser/hover when tracked, else the first source. Pure
  // (testable) — handedness comes straight from the XR input source.
  function pickPointerSource(sources) {
    const list = (sources || []).filter(Boolean);
    if (list.length === 0) return null;
    const right = list.find((s) => s && s.handedness === 'right');
    return right || list[0];
  }

  // The ray the laser currently shows (per-frame copy). Trigger clicks from
  // the same hand reuse it, so a click always honors the visible highlight
  // instead of a fresh (moved) ray.
  function chooseSelectRay(evHandedness) {
    try {
      if (activeRayOrigin && activeRayDir && activeRayHandedness &&
          evHandedness && evHandedness === activeRayHandedness) {
        return { origin: activeRayOrigin, direction: activeRayDir, reused: true };
      }
    } catch (e) {}
    return null;
  }

  // XR per-frame: the preferred controller drives the shared laser and
  // hover highlight (upstream processInput, single active ray). The ray is
  // stored so onVRSelect can reuse exactly what the user saw highlighted.
  function updateControllerLasers(frame, sessionOverride) {
    if (!renderer || !raycaster || !THREE) return;
    try {
      if (!activeRayOrigin) activeRayOrigin = new THREE.Vector3();
      if (!activeRayDir) activeRayDir = new THREE.Vector3();
      const session = sessionOverride || xrSession;
      let origin = null, direction = null, handedness = '';
      if (session) {
        let sources = [];
        try { sources = Array.from(session.inputSources || []); } catch (e) {}
        const preferred = pickPointerSource(sources);
        if (preferred) {
          const pose = sourceTargetPose(preferred, frame);
          if (pose && pose.dir) {
            origin = pose.pos;
            direction = pose.dir;
            handedness = preferred.handedness || '';
          }
        }
      }
      if ((!origin || !direction) && vrControllers.length > 0) {
        // Fallback: first tracked controller matrix (frame pose unavailable).
        const controller = vrControllers[0];
        if (controller) {
          if (!scratchMat4) scratchMat4 = new THREE.Matrix4();
          if (!scratchVec) scratchVec = new THREE.Vector3();
          if (!scratchVec2) scratchVec2 = new THREE.Vector3();
          scratchMat4.identity().extractRotation(controller.matrixWorld);
          scratchVec.setFromMatrixPosition(controller.matrixWorld);
          scratchVec2.set(0, 0, -1).applyMatrix4(scratchMat4).normalize();
          origin = { x: scratchVec.x, y: scratchVec.y, z: scratchVec.z };
          direction = { x: scratchVec2.x, y: scratchVec2.y, z: scratchVec2.z };
          handedness = '';
        }
      }
      if (!origin || !direction) return;
      activeRayOrigin.set(origin.x, origin.y, origin.z);
      activeRayDir.set(direction.x, direction.y, direction.z).normalize();
      activeRayHandedness = handedness;
      const hovered = updateLaserPointer(activeRayOrigin, activeRayDir);
      hoveredButton = hovered >= 0 ? hovered : -1;
    } catch (e) {}
  }

  function toggleControlsVisibility() {
    controlsVisible = !controlsVisible;
    applySceneVisibility();
    vrLastUiUploadT = -1;
    emitPreviewState();
    return controlsVisible;
  }

  // ─── Controls visibility (upstream show/hide + 5 s auto-hide) ────────
  // The B button (and empty-space taps) toggle the dock + guide together.
  function resetAutoHideTimer() {
    clearAutoHideTimer();
    if (!getVisualSource().paused) {
      try {
        controlsAutoHideTimer = setTimeout(function() {
          controlsVisible = false;
          applySceneVisibility();
        }, CONTROLS_AUTO_HIDE_MS);
      } catch (e) { controlsAutoHideTimer = null; }
    }
  }

  function clearAutoHideTimer() {
    if (controlsAutoHideTimer) {
      try { clearTimeout(controlsAutoHideTimer); } catch (e) {}
      controlsAutoHideTimer = null;
    }
  }

  function showControls() {
    controlsVisible = true;
    applySceneVisibility();
    resetAutoHideTimer();
  }

  function hideControls() {
    controlsVisible = false;
    applySceneVisibility();
    clearAutoHideTimer();
  }

  function toggleControls() {
    if (controlsVisible) hideControls();
    else showControls();
  }

  // v8.4 XR telemetry (playback-investigation §4 workflow): per-frame
  // intervals + upload counters POSTed ~1 Hz to the existing
  // /api/reels/diag endpoint while presenting. dtMaxMs spikes attribute
  // stalls to upload vs idle frames (uploadMaxMs measures JS return only).
  let xrDiagFrames = 0;
  let xrDiagMaxDt = 0;
  let xrDiagLastT = -1;
  let xrDiagLastPost = 0;
  const xrDiagBases = {};

  function resetXRDiag() {
    xrDiagFrames = 0;
    xrDiagMaxDt = 0;
    xrDiagLastT = -1;
    xrDiagLastPost = 0;
    for (const k of ['videoUploads', 'overlayUploads', 'dockUploads', 'panelUploads',
                     'guideUploads', 'transChanges', 'transClears', 'transNotReady']) {
      xrDiagBases[k] = renderStats[k] || 0;
    }
  }

  function xrDiagDelta(k) {
    return (renderStats[k] || 0) - (xrDiagBases[k] || 0);
  }

  function postXRDiag(time) {
    try {
      if (xrDiagLastT >= 0) {
        const dt = time - xrDiagLastT;
        xrDiagFrames += 1;
        if (dt > xrDiagMaxDt) xrDiagMaxDt = dt;
      }
      xrDiagLastT = time;
      if (time - xrDiagLastPost < 1000) return;
      // v8.12: current video source basename so capture sessions are
      // self-describing (condition + file need no out-of-band narration).
      // v8.17: requested vs granted session features — on-device proof of
      // the session configuration behind each run.
      let visualSrc = '';
      try {
        const vs = typeof getVisualSource === 'function' ? getVisualSource() : null;
        const raw = (vs && vs.element && (vs.element.currentSrc || vs.element.src)) || '';
        visualSrc = String(raw).split('?')[0].split('/').pop().slice(-80);
      } catch (e) { visualSrc = ''; }
      let grantedFeatures = null;
      try {
        const ef = xrSession && xrSession.enabledFeatures;
        grantedFeatures = ef ? Array.from(ef) : null;
      } catch (e) { grantedFeatures = null; }
      const payload = {
        engine: VR_VERSION,
        src: visualSrc,
        sessionFeatures: {
          requested: lastSessionRequestedFeatures,
          granted: grantedFeatures,
          renderer: lastRendererOpts,
        },
        xrFrames: xrDiagFrames,
        dtMaxMs: Math.round(xrDiagMaxDt * 10) / 10,
        videoUploads: xrDiagDelta('videoUploads'),
        overlayUploads: xrDiagDelta('overlayUploads'),
        dockUploads: xrDiagDelta('dockUploads'),
        panelUploads: xrDiagDelta('panelUploads'),
        guideUploads: xrDiagDelta('guideUploads'),
        transChanges: xrDiagDelta('transChanges'),
        transClears: xrDiagDelta('transClears'),
        transNotReady: xrDiagDelta('transNotReady'),
        screenScale,
        screenDistance,
        uploadMode: videoUploadMode,
        locked: lockToViewer,
        flags: { ...debugFlags },
      };
      xrDiagFrames = 0;
      xrDiagMaxDt = 0;
      resetXRDiag();
      xrDiagLastT = time;
      xrDiagLastPost = time;
      if (typeof fetch === 'function') {
        fetch('/api/reels/diag', {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    } catch (e) {}
  }

  // Haptic click on XR interactions (upstream pulseInput).
  function pulseInput(source) {
    const actuator = source && source.gamepad && source.gamepad.hapticActuators &&
      source.gamepad.hapticActuators[0];
    if (!actuator || typeof actuator.pulse !== 'function') return;
    try {
      const r = actuator.pulse(0.45, 120);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {}
  }

  function installPreviewListeners() {
    if (!previewCanvas || previewListeners) return;
    if (typeof previewCanvas.addEventListener !== 'function') return;
    const onPointerDown = function (event) {
      try {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.preventDefault) { try { event.preventDefault(); } catch (e) {} }
      try { if (previewCanvas.focus) previewCanvas.focus(); } catch (e) {}
      try { if (previewCanvas.setPointerCapture) previewCanvas.setPointerCapture(event.pointerId); } catch (e) {}
      const target = updatePreviewHover(event.clientX, event.clientY);
      const source = 'preview-pointer-' + (event.pointerId === undefined ? 'mouse' : event.pointerId);
      previewPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, source };
      if (target && target.controlIndex >= 0) {
        executeControlButton(target.controlIndex);
        vrLastUiUploadT = -1;
        previewPointer.control = true;
        return;
      }
      // Press on the comments panel: list/scrollbar begins a drag-scroll,
      // every other region clicks on release.
      if (sceneMode !== 'earth' && target && target.panelDesc) {
        previewPointer.panel = true;
        previewPointer.panelDesc = target.panelDesc;
        if (target.panelDesc === 'list' || target.panelDesc === 'scrollbar') {
          executeCommentAction(target.panelDesc);
          cPanelDragMoved = false;
        }
        vrLastUiUploadT = -1;
        return;
      }
      if (sceneMode === 'earth' && target && target.hit) {
        beginEarthDrag(source, target.hit);
        previewPointer.earth = true;
      }
      } catch (e) { capturePointerError('pointerdown', e); }
    };
    const onPointerMove = function (event) {
      try {
      const target = updatePreviewHover(event.clientX, event.clientY);
      if (!previewPointer || previewPointer.id !== event.pointerId) return;
      const dx = event.clientX - previewPointer.x;
      const dy = event.clientY - previewPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) previewPointer.moved = true;
      previewPointer.x = event.clientX;
      previewPointer.y = event.clientY;
      if (previewPointer.control) return;
      // Continue a mouse-drag scroll on the comments list (content follows
      // the cursor); the drag owns the gesture until release.
      if (previewPointer.panel && sceneMode !== 'earth') {
        if (cPanelDrag && cPanelHover) {
          const before = cPanelScrollY;
          cPanelScrollY = clampPanelScroll(cPanelDragStartScroll - (lastCommentsCanvasY - cPanelDragStartCanvasY));
          if (cPanelScrollY !== before) {
            cPanelDragMoved = true;
            previewPointer.moved = true;
            vrLastUiUploadT = -1;
          }
        }
        return;
      }
      if (sceneMode === 'earth') {
        if (previewPointer.earth && target && target.hit && target.hit.hit && target.hit.local) {
          updateEarthDrag(target.hit.local);
        }
        return;
      }
      // In orbit mode OrbitControls owns the drag; otherwise custom yaw/pitch.
      if (previewCameraMode === 'orbit' && orbitControls && orbitControls.enabled) return;
      const sensitivity = 0.006;
      if (previewCameraMode === 'orbit') {
        previewOrbitYaw -= dx * sensitivity;
        previewOrbitPitch = Math.max(-1.35, Math.min(1.35, previewOrbitPitch + dy * sensitivity));
      } else {
        previewYaw -= dx * sensitivity;
        previewPitch = Math.max(-1.35, Math.min(1.35, previewPitch - dy * sensitivity));
      }
      applyPreviewCamera();
      } catch (e) { capturePointerError('pointermove', e); }
    };
    const finishPointer = function (event) {
      try {
      if (!previewPointer || previewPointer.id !== event.pointerId) return;
      const target = updatePreviewHover(event.clientX, event.clientY);
      if (sceneMode === 'earth' && previewPointer.earth) {
        endEarthDrag(previewPointer.source, target && target.hit);
      } else if (!previewPointer.control && target) {
        if (previewPointer.panel) {
          // Release on the panel: a real drag scroll consumes the gesture,
          // otherwise the pressed region clicks.
          const wasDrag = cPanelDragMoved;
          cPanelDrag = false;
          cPanelDragMoved = false;
          if (!wasDrag) {
            const desc = (target && target.panelDesc) || previewPointer.panelDesc || cPanelHover;
            if (desc) executeCommentAction(desc);
          }
          vrLastUiUploadT = -1;
        } else if (!previewPointer.moved) {
          if (target.hit && target.hit.hit) {
            if (callbacks.onTogglePlay) { try { callbacks.onTogglePlay(); } catch (e) {} }
          } else if (target.controlIndex < 0 && raycaster && screenMesh && screenMesh.visible !== false) {
            // Tap on the video screen: a pop-up comment opens the panel at
            // it, otherwise playback toggles (static pack cards route
            // through the pack select handler first).
            let screenHit = null;
            try {
              const ray = previewRayAt(event.clientX, event.clientY);
              if (ray) {
                raycaster.set(ray.origin, ray.direction);
                const hits = raycaster.intersectObject(screenMesh, false);
                if (hits.length > 0) screenHit = hits[0];
              }
            } catch (e) {}
            if (screenHit) {
              const source = getVisualSource();
              let handled = false;
              if (!commentsPanelVisible && screenHit.uv) {
                const cid = overlayCommentFromUV(screenHit.uv);
                if (cid) {
                  openCommentsPanelToComment(cid);
                  handled = true;
                }
              }
              if (!handled && source.kind === 'static-card' && callbacks.onMainScreenSelect && screenHit.uv) {
                try {
                  handled = callbacks.onMainScreenSelect({
                    u: screenHit.uv.x,
                    v: 1 - screenHit.uv.y,
                  });
                } catch (e) { handled = false; }
              }
              if (!handled && callbacks.onTogglePlay) {
                try { callbacks.onTogglePlay(); } catch (e) {}
              }
            } else {
              toggleControlsVisibility();
            }
          } else if (target.controlIndex < 0) {
            toggleControlsVisibility();
          }
        }
      }
      pressedButton = -1;
      cPanelDrag = false;
      cPanelDragMoved = false;
      vrLastUiUploadT = -1;
      try { if (previewCanvas.releasePointerCapture) previewCanvas.releasePointerCapture(event.pointerId); } catch (e) {}
      previewPointer = null;
      } catch (e) { capturePointerError('pointerup', e); }
    };
    const onWheel = function (event) {
      try {
      if (event.preventDefault) { try { event.preventDefault(); } catch (e) {} }
      if (sceneMode === 'earth') {
        // Wheel Y = map zoom (Google-Maps convention), wheel X = yaw.
        if (event.deltaY) adjustEarthZoom(Math.exp(-(event.deltaY || 0) * 0.0016));
        if (event.deltaX) rotateEarth((event.deltaX || 0) * 0.0025, 0);
        return;
      }
      // Wheel over the comments panel scrolls the list (upstream parity).
      if (commentsPanelVisible && cPanelHover) {
        cPanelScrollY = clampPanelScroll(cPanelScrollY + (event.deltaY || 0) * 0.5);
        vrLastUiUploadT = -1;
        return;
      }
      if (previewCameraMode === 'orbit') {
        previewOrbitDistance = Math.max(1.2, Math.min(12, previewOrbitDistance + (event.deltaY || 0) * 0.006));
        applyPreviewCamera();
      }
      } catch (e) { capturePointerError('wheel', e); }
    };
    const onPointerLeave = function () {
      if (previewPointer) return;
      hoveredButton = -1;
      if (sceneMode === 'earth') setEarthHoveredIndex(-1);
    };
    const onContextMenu = function (event) { if (event.preventDefault) event.preventDefault(); };
    previewListeners = { onPointerDown, onPointerMove, finishPointer, onWheel, onPointerLeave, onContextMenu };
    try { previewCanvas.style.touchAction = 'none'; } catch (e) {}
    previewCanvas.addEventListener('pointerdown', onPointerDown);
    previewCanvas.addEventListener('pointermove', onPointerMove);
    previewCanvas.addEventListener('pointerup', finishPointer);
    previewCanvas.addEventListener('pointercancel', finishPointer);
    previewCanvas.addEventListener('pointerleave', onPointerLeave);
    previewCanvas.addEventListener('wheel', onWheel, { passive: false });
    previewCanvas.addEventListener('contextmenu', onContextMenu);
  }

  function removePreviewListeners() {
    if (!previewCanvas || !previewListeners) {
      previewListeners = null;
      return;
    }
    const listeners = previewListeners;
    try {
      previewCanvas.removeEventListener('pointerdown', listeners.onPointerDown);
      previewCanvas.removeEventListener('pointermove', listeners.onPointerMove);
      previewCanvas.removeEventListener('pointerup', listeners.finishPointer);
      previewCanvas.removeEventListener('pointercancel', listeners.finishPointer);
      previewCanvas.removeEventListener('pointerleave', listeners.onPointerLeave);
      previewCanvas.removeEventListener('wheel', listeners.onWheel);
      previewCanvas.removeEventListener('contextmenu', listeners.onContextMenu);
    } catch (e) {}
    previewListeners = null;
  }
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

  function startPreview(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('A canvas element is required for immersive preview.');
    }
    if (xrSession) {
      throw new Error('Exit the immersive XR session before starting desktop preview.');
    }
    ensureThree();
    if (!THREE) {
      throw new Error('Three.js runtime did not load (three.min.js missing?).');
    }
    const opts = options || {};
    // Tear down any previous preview so the singleton renderer/scene is
    // rebuilt with fresh (non-disposed) textures — restarting on a disposed
    // CanvasTexture rendered black.
    if (previewRunning || renderer) stopPreview();

    previewCanvas = canvas;
    previewCameraMode = opts.cameraMode === 'orbit' ? 'orbit' : 'headset';
    stereoMode = !!opts.stereo;
    if (typeof opts.reducedMotion === 'boolean') reducedMotion = opts.reducedMotion;
    controlsVisible = opts.showControls !== false;
    previewYaw = 0;
    previewPitch = 0;
    previewOrbitYaw = 0;
    previewOrbitPitch = -0.08;
    previewOrbitDistance = 4.8;
    renderStats.earthDrawCalls = 0;
    renderStats.reelDrawCalls = 0;
    renderStats.starDrawCalls = 0;
    renderStats.videoUploads = 0;
    renderStats.earthPreviewUploads = 0;
    lastVisualKind = '';
    lastVisualVersion = '';
    lastVisualElement = null;
    lastVideoTime = -1;
    lastUploadedSource = null;
    pendingClearedFor = '';
    hasNewVideoFrame = true;
    vrLastUiUploadT = -1;
    sceneMode = 'reels';

    initThreeScene(canvas, opts.gl || null);
    if (!renderer || !scene || !camera) {
      throw new Error('WebGL context creation failed. Enable hardware acceleration (Chrome: Settings → System → Use graphics acceleration), disable --disable-gpu, and reload. Headless/software-GL browsers need SwiftShader (`--use-gl=swiftshader`).');
    }

    ensureOrbitControls(canvas);
    applyPreviewCamera();
    installPreviewListeners();
    if (typeof window !== 'undefined' && previewResizeHandler === null &&
        typeof window.addEventListener === 'function') {
      previewResizeHandler = function () { updatePreviewSize(previewCanvas); };
      window.addEventListener('resize', previewResizeHandler);
    }

    setupVideoFrameTracking();
    previewRunning = true;
    lockToViewer = previewCameraMode === 'headset' && !isPackExperience();
    if (controlsMesh) controlsMesh.visible = controlsVisible;
    if (opts.sceneMode === 'earth' && !isPackExperience()) {
      setSceneMode('earth');
    }
    emitPreviewState();

    if (typeof window !== 'undefined') {
      previewAnimId = window.requestAnimationFrame(onPreviewFrame);
    }

    return getPreviewState();
  }

  function stopPreview() {
    previewRunning = false;
    if (typeof window !== 'undefined' && previewAnimId) {
      window.cancelAnimationFrame(previewAnimId);
      previewAnimId = null;
    }
    stopVideoFrameTracking();
    cleanup();
    // Reset to the known-good baseline so the next mount, route, or XR
    // session never inherits stale mode, canvas, or camera state. The SPA
    // keeps this module singleton across routes (upstream forced
    // sceneMode='reels' in cleanup for the same reason).
    sceneMode = 'reels';
    previewCanvas = null;
    controlsVisible = true;
    commentsPanelVisible = false;
    previewCameraMode = 'headset';
    stereoMode = false;
    previewYaw = 0;
    previewPitch = 0;
    // Reset the screen transform + panel state to the known-good baseline.
    screenPos = { x: DEFAULT_POS.x, y: DEFAULT_POS.y, z: DEFAULT_POS.z };
    screenScale = DEFAULT_SCALE;
    screenDistance = -DEFAULT_POS.z;
    lockToViewer = false;
    cPanelTab = 'all';
    cPanelScrollY = 0;
    cPanelMaxScroll = 0;
    cPanelHover = '';
    clearPanelHighlight();
    emitPreviewState();
  }

  function resetPreview() {
    previewYaw = 0;
    previewPitch = 0;
    previewOrbitYaw = 0;
    previewOrbitPitch = -0.08;
    previewOrbitDistance = 4.8;
    earthYaw = 0;
    earthPitch = 0;
    earthLastFrameTime = -1;
    applyEarthRotation();
    if (orbitControls && typeof orbitControls.reset === 'function') {
      try { orbitControls.reset(); } catch (e) {}
    }
    applyPreviewCamera();
    emitPreviewState();
  }

  function setPreviewCameraMode(mode) {
    previewCameraMode = mode === 'orbit' ? 'orbit' : 'headset';
    lockToViewer = previewCameraMode === 'headset' && !isPackExperience();
    if (previewCanvas) ensureOrbitControls(previewCanvas);
    if (orbitControls) {
      orbitControls.enabled = (previewCameraMode === 'orbit');
      if (previewCameraMode === 'orbit' && camera) {
        camera.position.set(0, 1.6, 2.5);
        try {
          orbitControls.target.set(0, 1.4, -2.0);
          orbitControls.update();
        } catch (e) {}
      } else {
        previewYaw = 0;
        previewPitch = 0;
      }
    }
    applyPreviewCamera();
    emitPreviewState();
    return previewCameraMode;
  }

  async function requestPreviewFullscreen(target) {
    const element = target || (previewCanvas && previewCanvas.parentElement) || previewCanvas;
    if (!element) return false;
    try {
      if (typeof document !== 'undefined' && document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (element.requestFullscreen) {
        await element.requestFullscreen();
      } else if (element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen();
      }
      return true;
    } catch (error) {
      console.warn('[WebXRVR] Preview fullscreen request failed:', error);
      return false;
    }
  }

  function setCurvatureMode(mode) {
    if (typeof mode === 'string') {
      const key = mode.toLowerCase();
      // 'curved' is the legacy alias kept for older CDP probes/callers.
      mode = key === 'dome' ? 1 : (key === 'sq_curve' || key === 'curved' ? 2 : 0);
    }
    curvatureMode = Number(mode) || 0;
    isCurved = (curvatureMode !== 0);
    if (screenMesh) {
      if (screenMesh.geometry) screenMesh.geometry.dispose();
      screenMesh.geometry = createScreenGeometry(curvatureMode);
    }
    if (overlayMesh) {
      if (overlayMesh.geometry) overlayMesh.geometry.dispose();
      overlayMesh.geometry = createScreenGeometry(curvatureMode);
    }
    if (ambilightMesh) {
      if (ambilightMesh.geometry) ambilightMesh.geometry.dispose();
      ambilightMesh.geometry = createScreenGeometry(curvatureMode, 2.4 * 1.34, 2.4 * 1.34, 24, 24) ||
        new THREE.PlaneGeometry(3.2, 3.2);
    }
    commitScreenTransform();
    emitPreviewState();
  }

  function getCurvatureMode() {
    return curvatureMode === 1 ? 'dome' : (curvatureMode === 2 ? 'sq_curve' : 'flat');
  }

  function setSceneMode(mode) {
    const next = mode === 'earth' && !isPackExperience() ? 'earth' : 'reels';
    const prev = sceneMode;
    sceneMode = next;
    applySceneVisibility();
    if (next === 'earth' && prev !== 'earth') {
      openEarthPlayback();
    } else if (next !== 'earth' && prev === 'earth') {
      closeEarthPlayback();
      // Re-entry always starts at the full globe (Z1): no stale deep zoom.
      resetEarthZoomImmediate();
    }
    emitPreviewState();
    return sceneMode;
  }

  // Playback handoff (upstream openEarthMode/closeEarthMode parity): earth
  // entry freezes whatever is actually playing (video element, image dwell
  // handled by the host via onEarthOpen) and records whether to resume;
  // reels return resumes exactly that via onEarthClose.
  function openEarthPlayback() {
    const source = getVisualSource();
    earthResumePlayback = (source.kind === 'video' || source.kind === 'image') && !source.paused;
    const el = source.element;
    if (el && typeof el.pause === 'function' && !source.paused) {
      try { el.pause(); } catch (e) {}
    }
    if (callbacks.onPause) {
      try { callbacks.onPause(); } catch (e) {}
    }
    if (callbacks.onEarthOpen) {
      try { callbacks.onEarthOpen(earthResumePlayback); } catch (e) {}
    }
    loadEarthActivity();
  }

  function closeEarthPlayback(resume) {
    const shouldResume = resume !== false && earthResumePlayback;
    earthResumePlayback = false;
    if (callbacks.onEarthClose) {
      try { callbacks.onEarthClose(shouldResume); } catch (e) {}
    } else if (shouldResume) {
      const source = getVisualSource();
      const el = source.element;
      if (el && typeof el.play === 'function' && source.kind === 'video') {
        try {
          const r = el.play();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch (e) {}
      }
    }
  }

  // ─── Scene visibility (single source of truth) ──────────────────────
  // Mirrors upstream renderSceneView branches: reels shows screen + glow +
  // dock; earth shows globe + dock. Previously flags were written in three
  // places (creation, setSceneMode, mesh defaults) and enterVR inherited
  // stale state — the globe leaked into reels mode in-headset. Enforced
  // here, from setSceneMode, initThreeScene, and both frame loops.
  function applySceneVisibility() {
    const isEarth = (sceneMode === 'earth');
    if (earthGroup) earthGroup.visible = isEarth;
    // Label/preview are scene-rooted (Z1 zoom), so they gate explicitly.
    if (earthLabelMesh) earthLabelMesh.visible = isEarth;
    if (earthPreviewMesh && !isEarth) earthPreviewMesh.visible = false;
    if (screenMesh) screenMesh.visible = !isEarth;
    if (ambilightMesh) ambilightMesh.visible = !isEarth && debugFlags.glow;
    if (overlayMesh) {
      const source = getVisualSource();
      overlayMesh.visible = !isEarth && !commentsPanelVisible && overlayHasPopups &&
        source.kind === 'video' && debugFlags.overlay;
    }
    if (controlsMesh) controlsMesh.visible = controlsVisible;
    if (commentsMesh) commentsMesh.visible = (!isEarth && commentsPanelVisible);
    if (guideMesh) guideMesh.visible = (!isEarth && controlsVisible && debugFlags.guide);
    if (starfieldPoints) starfieldPoints.visible = true;
    const pointerActive = !!(xrSession || previewRunning);
    if (laserLine) laserLine.visible = pointerActive;
    if (reticleMesh) reticleMesh.visible = pointerActive;
  }

  function setPreviewStereo(enabled) {
    stereoMode = !!enabled;
    emitPreviewState();
  }

  function setReducedMotion(enabled) {
    reducedMotion = !!enabled;
    emitPreviewState();
  }

  function showNotification(message) {
    notificationText = String(message || '');
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    notificationUntil = (Number(now) || 0) + 5000;
  }

  // ─── Earth Mode Logic ───────────────────────────────────────────────
  function setLocationActivity(rows) {
    earthLocations = Array.isArray(rows) ? rows.slice(0, 128) : [];
    earthMapDirty = true;
    lastEarthLabelKey = '';
    earthSelectedIndex = -1;
    earthSelectionGeneration += 1;
    rebuildEarthPins();
    rebuildEarthHeatSprites();
  }

  // Z3: the activity request follows the zoom band (null = legacy city rows).
  // Server keeps city rows for z ≥ 12 (privacy floor), so the client simply
  // mirrors the slippy band that drives the tile layer.
  function earthActivityRequestZoom() {
    if (earthZoom <= EARTH_TILE_CROSSFADE_LO) return null;
    return earthTileZoom();
  }

  // Z3b: visible-patch bbox for the activity window. Same anchor and
  // ring as the tile layer (updateEarthTiles) so clustered heat covers
  // exactly the rendered map; null at globe scale (legacy full-set fetch).
  // The tile set never wraps (it clips at the dateline), so the box is
  // always a valid west<east rectangle; the ≥350° guard is belt-and-braces
  // for future ring sizes (the server degrades to the full set anyway).
  function earthVisibleBbox() {
    const zoomParam = earthActivityRequestZoom();
    if (zoomParam === null) return null;
    const anchor = earthFocus || earthFacingLatLon();
    const lat = Math.max(-90, Math.min(90, Number(anchor && anchor.lat) || 0));
    const lon = Number(anchor && anchor.lon) || 0;
    const visible = earthTileVisibleSet(zoomParam, lat, lon, EARTH_TILE_RING);
    if (!visible.length) return null;
    const n = 1 << zoomParam;
    let minX = n, maxX = -1, minY = n, maxY = -1;
    for (const t of visible) {
      if (t.x < minX) minX = t.x;
      if (t.x > maxX) maxX = t.x;
      if (t.y < minY) minY = t.y;
      if (t.y > maxY) maxY = t.y;
    }
    const west = minX / n * 360 - 180;
    const east = (maxX + 1) / n * 360 - 180;
    if (east - west >= 350) return null;
    const north = earthMercatorYToLat(minY / n);
    const south = earthMercatorYToLat((maxY + 1) / n);
    const round4 = (v) => Math.round(Number(v) * 10000) / 10000;
    return { west: round4(west), south: round4(south), east: round4(east), north: round4(north) };
  }

  function earthActivityUrl(zoomParam) {
    let url = '/api/reels/locations/activity?window_days=7&limit=128' +
      (zoomParam === null ? '' : '&zoom=' + zoomParam);
    if (zoomParam !== null) {
      const bbox = earthVisibleBbox();
      if (bbox) {
        url += '&bbox=' + bbox.west + ',' + bbox.south + ',' + bbox.east + ',' + bbox.north;
      }
    }
    return url;
  }

  // Debounced refetch when the zoom band crosses (Snap's per-zoom heat).
  // Runs every frame from updateEarthTiles, so it must never re-arm a
  // pending countdown (that would starve the fetch while frames run):
  // the first frame in a new band arms the timer, which fires once with
  // the band read live — fetch-what-you-see, skipping bands zoomed past
  // and zooms that settled back before the window elapsed.
  function scheduleEarthActivityRefetch() {
    if (sceneMode !== 'earth') return;
    const wanted = earthActivityRequestZoom();
    if (wanted === earthActivityZoom) return;
    if (earthActivityRefetchTimer) return; // countdown already running
    try {
      earthActivityRefetchTimer = setTimeout(() => {
        earthActivityRefetchTimer = null;
        if (earthActivityRequestZoom() === earthActivityZoom) return;
        loadEarthActivity();
      }, 300);
    } catch (e) {
      loadEarthActivity();
    }
  }

  async function loadEarthActivity() {
    if (earthActivityAbort) {
      try { earthActivityAbort.abort(); } catch (e) {}
    }
    const generation = ++earthActivityGeneration;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    earthActivityAbort = controller;
    const zoomParam = earthActivityRequestZoom();
    try {
      const fetchFn = typeof fetch !== 'undefined' ? fetch : null;
      if (!fetchFn) return;
      const response = await fetchFn(earthActivityUrl(zoomParam), {
        credentials: 'include',
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) throw new Error('Activity request failed (' + response.status + ')');
      const payload = await response.json();
      if (generation !== earthActivityGeneration || sceneMode !== 'earth') return;
      earthActivityZoom = zoomParam;
      setLocationActivity(payload.locations || []);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (generation !== earthActivityGeneration || sceneMode !== 'earth') return;
      console.error('[WebXRVR] Earth activity load failed:', error);
    } finally {
      if (earthActivityAbort === controller) earthActivityAbort = null;
    }
  }

  function setEarthHoveredIndex(index) {
    index = Number(index);
    const changed = index !== earthHoveredIndex;
    earthHoveredIndex = index;
    earthPreviewLocationIndex = index;
    if (index < 0) {
      if (earthPreviewAbortController) {
        try { earthPreviewAbortController.abort(); } catch (e) {}
        earthPreviewAbortController = null;
      }
      earthPreviewStatus = 'idle';
      earthPreviewItems = [];
    } else if (changed && sceneMode === 'earth') {
      // Hovering a new zone fetches its reels for the 3D billboard
      // (upstream scheduleEarthPreview; change-guarded, no per-move spam).
      earthPreviewGeneration += 1;
      loadEarthPreviewForIndex(index, earthPreviewGeneration);
    }
  }

  function loadEarthPreviewForIndex(index, generation) {
    if (index < 0 || index >= earthLocations.length) return Promise.resolve([]);
    if (earthPreviewAbortController) {
      try { earthPreviewAbortController.abort(); } catch (e) {}
    }
    earthPreviewAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = earthPreviewAbortController ? earthPreviewAbortController.signal : null;
    const loc = earthLocations[index];
    earthPreviewStatus = 'loading';
    if (callbacks.onPreviewLocation) {
      return Promise.resolve(callbacks.onPreviewLocation(loc, { signal }))
        .then((items) => {
          if (earthPreviewGeneration === generation && (!signal || !signal.aborted)) {
            earthPreviewItems = Array.isArray(items) ? items.slice(0, 3) : [];
            earthPreviewStatus = earthPreviewItems.length ? 'ready' : 'idle';
          }
          return earthPreviewItems;
        })
        .catch(() => {
          if (earthPreviewGeneration === generation) {
            earthPreviewStatus = 'error';
          }
          return [];
        });
    }
    return Promise.resolve([]);
  }

  // Zone tap → location reel playlist (upstream selectEarthLocation
  // parity): the host page swaps the feed (2D switchToLocationFeed); on
  // accept we return to reels mode so the new playlist plays in-VR, on
  // reject we stay on the globe with a status message.
  function selectEarthLocation(index) {
    const location = earthLocations[index];
    if (!location || typeof callbacks.onSelectLocation !== 'function') {
      return Promise.resolve(false);
    }
    const generation = ++earthSelectionGeneration;
    earthSelectedIndex = index;
    earthMapDirty = true;
    lastEarthLabelKey = '';
    let accepted;
    try {
      accepted = callbacks.onSelectLocation(location);
    } catch (error) {
      console.error('[WebXRVR] Location feed switch failed:', error);
      showNotification('LOCATION FEED ERROR');
      return Promise.resolve(false);
    }
    return Promise.resolve(accepted).then(
      (result) => {
        if (generation !== earthSelectionGeneration || sceneMode !== 'earth') return result;
        if (result === false) {
          showNotification('NO RECENT REELS IN THIS LOCATION');
          return false;
        }
        showNotification('📍 ' + String(location.name || location.slug || '').toUpperCase().slice(0, 30));
        // The new location feed takes over playback; never resume the old reel.
        earthResumePlayback = false;
        setSceneMode('reels');
        return true;
      },
      (error) => {
        if (generation !== earthSelectionGeneration || sceneMode !== 'earth') return false;
        console.error('[WebXRVR] Location feed switch failed:', error);
        showNotification('LOCATION FEED ERROR');
        return false;
      }
    );
  }

  function beginEarthDrag(source, hit) {    if (!hit || !hit.hit) return false;
    earthDragging = true;
    earthDragSource = source || 'pointer';
    earthDragLastDir = hit.local ? { ...hit.local } : null;
    earthDragStartDir = hit.local ? { ...hit.local } : null;
    earthDragMoved = false;
    earthDragEngaged = false;
    earthDragCumX = 0;
    earthDragCumY = 0;
    earthDragAxis = null;
    try {
      earthPressTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    } catch (e) {
      earthPressTime = 0;
    }
    earthPressZone = (hit && hit.zoneIndex >= 0) ? hit.zoneIndex : -1;
    return true;
  }

  function updateEarthDrag(direction) {
    if (!earthDragging || !direction) return;
    const len = Math.sqrt(
      (direction.x || 0) * (direction.x || 0) +
      (direction.y || 0) * (direction.y || 0) +
      (direction.z || 0) * (direction.z || 0)
    ) || 1;
    const normalized = { x: (direction.x || 0) / len, y: (direction.y || 0) / len, z: (direction.z || 0) / len };
    if (earthDragLastDir) {
      const dx = normalized.x - earthDragLastDir.x;
      const dy = normalized.y - earthDragLastDir.y;
      // Cumulative travel decides the locked axis; tremor roughly cancels
      // while deliberate motion dominates.
      earthDragCumX += dx;
      earthDragCumY += dy;
      // Tap-vs-drag is measured from the press point, not accumulated.
      let chord = -1;
      if (earthDragStartDir) {
        const sx = normalized.x - earthDragStartDir.x;
        const sy = normalized.y - earthDragStartDir.y;
        const sz = normalized.z - earthDragStartDir.z;
        chord = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (!earthDragMoved && chord > EARTH_TAP_CHORD) earthDragMoved = true;
      }
      // Rotation engages on hold (>=280 ms) or deliberate flick; until
      // then the globe stays frozen so clicks can't fight zone selection.
      if (!earthDragEngaged) {
        let heldLong = false;
        try {
          heldLong = (typeof performance !== 'undefined' && performance.now)
            ? (performance.now() - earthPressTime) >= EARTH_DRAG_HOLD_MS
            : false;
        } catch (e) {}
        if (heldLong || chord > EARTH_DRAG_CHORD) earthDragEngaged = true;
      }
      if (earthDragEngaged) {
        // Single-axis lock decided once per drag from cumulative travel.
        if (!earthDragAxis) {
          const ax = Math.abs(earthDragCumX);
          const ay = Math.abs(earthDragCumY);
          if (ax > EARTH_AXIS_LOCK || ay > EARTH_AXIS_LOCK) {
            earthDragAxis = ax >= ay ? 'yaw' : 'pitch';
          }
        }
        if (earthDragAxis === 'pitch') {
          rotateEarth(0, dy * EARTH_PITCH_SENSITIVITY);
        } else if (earthDragAxis === 'yaw') {
          rotateEarth(dx * EARTH_YAW_SENSITIVITY, 0);
        } else {
          // Engaged but no dominant direction yet: yaw only, so
          // hold-still never tilts the globe.
          rotateEarth(dx * EARTH_YAW_SENSITIVITY, 0);
        }
      }
    }
    earthDragLastDir = normalized;
  }

  function endEarthDrag(source, hit) {
    if (!earthDragging) return false;
    if (hit && hit.hit) updateEarthDrag(hit.local);
    // Tap-to-select with press/hover/release fallback: a clean tap (never
    // moved past the tap chord) selects the release zone, else the press
    // zone, else the hovered zone.
    const releaseZone = (hit && hit.hit && hit.zoneIndex >= 0) ? hit.zoneIndex : -1;
    let selected = -1;
    if (!earthDragMoved) {
      if (releaseZone >= 0) selected = releaseZone;
      else if (earthPressZone >= 0) selected = earthPressZone;
      else if (earthHoveredIndex >= 0) selected = earthHoveredIndex;
    }
    earthDragging = false;
    earthDragSource = null;
    earthDragLastDir = null;
    earthDragStartDir = null;
    earthDragEngaged = false;
    earthDragCumX = 0;
    earthDragCumY = 0;
    earthDragAxis = null;
    earthPressZone = -1;
    if (selected >= 0) {
      // Z1 tap dispatch: below the city band this zooms into the zone;
      // at/above the band it selects the location feed (legacy behavior).
      return handleEarthTap(selected, hit) !== 'none';
    }
    if (!earthDragMoved && hit && hit.hit) {
      // Clean tap on open ocean/land: zoom one step toward the tapped point.
      return handleEarthTap(-1, hit) !== 'none';
    }
    return false;
  }

  function getEarthState() {
    return {
      center: { ...earthCenter },
      liveCenter: earthLiveCenter(),
      yaw: earthYaw,
      pitch: earthPitch,
      dragging: earthDragging,
      zoom: earthZoom,
      zoomTarget: earthZoomTarget,
      tileZoom: earthTileZoom(),
      focus: earthFocus ? { ...earthFocus } : null,
      anchor: earthZoomAnchor ? { ...earthZoomAnchor } : null,
      animating: !!earthZoomAnim,
      tiles: {
        available: !!earthTileAvailable && !!debugFlags.earthmap,
        fade: earthTileFade(),
        band: earthTileZ,
        loaded: Array.from(earthTiles.values()).filter((e) => e.state === 'ready').length,
        queued: earthTileQueue.length,
        inFlight: earthTileInFlight,
        failures: earthTileFailures,
        tracked: earthTiles.size,
      },
      zoneCount: earthLocations.length,
      visualStyle: 'holographic-zones',
      previewLocationIndex: earthPreviewLocationIndex,
      previewStatus: earthPreviewStatus,
      previewItemCount: earthPreviewItems.length,
      resourcesReady: earthResourcesReady,
      locationSlugs: earthLocations.map((l) => l.slug),
      renderStats: { ...renderStats },
      notificationText,
      notificationUntil,
    };
  }

  // ─── WebXR Lifecycle ────────────────────────────────────────────────
  let vrControllers = [];
  // Dedicated immersive canvas (rebuilt per entry, removed on rebuild).
  // Never reuse the preview canvas: it may be detached after SPA route
  // changes, which made entry succeed-or-fail depending on browse history.
  let xrCanvas = null;
  // Preview resume snapshot: captured before enterVR tears the preview
  // down, restored on session end so the desktop inspector comes back.
  let previewResumeOpts = null;
  // Last xrCompatible outcome for diagnostics ('unknown' | 'compatible' |
  // 'made-compatible' | 'unavailable' | 'failed:<msg>').
  let xrCompatStatus = 'unknown';

  // Roll-free quaternion facing the head from a world position
  // (upstream quatFaceViewerLevel, Three.js port).
  function levelQuatFacingHead(pos, head) {
    ensureThree();
    if (!THREE) return null;
    try {
      const dx = head.x - pos.x, dy = head.y - pos.y, dz = head.z - pos.z;
      const e = new THREE.Euler(
        -Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0, 'YXZ');
      return new THREE.Quaternion().setFromEuler(e);
    } catch (e2) { return null; }
  }

  function sourceTargetPose(source, frame) {
    if (!source || !source.targetRaySpace || !frame || !xrRefSpace) return null;
    try {
      const rayPose = frame.getPose(source.targetRaySpace, xrRefSpace);
      if (!rayPose) return null;
      const t = rayPose.transform;
      const m = t.matrix;
      return {
        pos: { x: t.position.x, y: t.position.y, z: t.position.z },
        quat: { x: t.orientation.x, y: t.orientation.y, z: t.orientation.z, w: t.orientation.w },
        dir: m ? { x: -m[8], y: -m[9], z: -m[10] } : null,
      };
    } catch (e) { return null; }
  }

  // ─── Controller Input Processing (upstream processInput, v8.3) ──────
  // Gamepad mappings: grip+stickY = scale, grip+stickX = distance (v8.3),
  // stickY flick = next/prev, stickX flick = seek, A = play/pause,
  // B = toggle dock+guide, grip = 6DOF grab when unlocked. Pointer hover
  // itself stays in updateControllerLasers (shared laser path).
  function processXRInput(frame, sessionOverride) {
    const session = sessionOverride || xrSession;
    if (!session) return;
    let sources = [];
    try { sources = Array.from(session.inputSources || []); } catch (e) { sources = []; }
    if (sources.length === 0) return;
    ensureThree();
    const headPos = getHeadPosition();
    const hasRightInput = sources.some((s) => s && s.handedness === 'right');

    if (sceneMode === 'earth') {
      for (const source of sources) {
        const gp = source && source.gamepad;
        if (!gp) continue;
        const axes = gp.axes || [];
        const thumbX = axes.length >= 4 ? (axes[2] || 0) : (axes[0] || 0);
        const thumbY = axes.length >= 4 ? (axes[3] || 0) : (axes[1] || 0);
        const gripPressed = gp.buttons.length > 1 && !!gp.buttons[1].pressed;
        if (gripPressed && Math.abs(thumbY) > 0.12) {
          // Grip + stickY = map zoom (stick up = zoom in), exponential like
          // map apps. Grip+stickX stays unbound in earth mode; while
          // grip-zooming the stick never rotates the globe.
          adjustEarthZoom(Math.exp(-thumbY * 0.045));
          continue;
        }
        if (Math.abs(thumbX) > 0.12 || Math.abs(thumbY) > 0.12) {
          // Single-axis like drags: follow the dominant stick direction.
          const yawMag = Math.abs(thumbX) > 0.12 ? Math.abs(thumbX) : -1;
          const pitchMag = Math.abs(thumbY) > 0.12 ? Math.abs(thumbY) : -1;
          if (yawMag >= pitchMag) rotateEarth(thumbX * 0.035, 0);
          else rotateEarth(0, -thumbY * 0.024);
        }
      }
    } else {
      // ── Grip: 6DOF Natural Grab & Reposition (DeoVR / Skybox style) ──
      for (const source of sources) {
        const gp = source && source.gamepad;
        if (!gp || !THREE) continue;
        const hand = source.handedness;
        const pose = sourceTargetPose(source, frame);
        const gripPressed = gp.buttons.length > 1 && !!gp.buttons[1].pressed;
        if (lockToViewer) {
          isGrabbing = false;
          grabControllerIdx = -1;
        } else if (gripPressed && pose) {
          const idx = hand === 'right' ? 1 : 0;
          if (!isGrabbing) {
            isGrabbing = true;
            grabControllerIdx = idx;
            try {
              const cq = new THREE.Quaternion(pose.quat.x, pose.quat.y, pose.quat.z, pose.quat.w);
              const inv = cq.clone().invert();
              const rel = new THREE.Vector3(
                screenPos.x - pose.pos.x, screenPos.y - pose.pos.y, screenPos.z - pose.pos.z
              ).applyQuaternion(inv);
              grabRelPos = { x: rel.x, y: rel.y, z: rel.z };
              ensureScreenQuat();
              const relQ = screenQuat ? inv.clone().multiply(screenQuat) : inv.clone();
              grabRelQuat = { x: relQ.x, y: relQ.y, z: relQ.z, w: relQ.w };
            } catch (e) { isGrabbing = false; grabControllerIdx = -1; }
          }
          if ((hand === 'right' && grabControllerIdx === 1) ||
              (hand === 'left' && grabControllerIdx === 0)) {
            try {
              const cq = new THREE.Quaternion(pose.quat.x, pose.quat.y, pose.quat.z, pose.quat.w);
              const rotated = new THREE.Vector3(grabRelPos.x, grabRelPos.y, grabRelPos.z)
                .applyQuaternion(cq);
              screenPos = {
                x: pose.pos.x + rotated.x,
                y: pose.pos.y + rotated.y,
                z: pose.pos.z + rotated.z,
              };
              // Rotate screen tangent to viewer POV (facing head, level).
              ensureScreenQuat();
              const lq = levelQuatFacingHead(screenPos, headPos);
              if (lq && screenQuat) screenQuat.copy(lq);
            } catch (e) {}
          }
        } else if (isGrabbing && ((hand === 'right' && grabControllerIdx === 1) ||
                   (hand === 'left' && grabControllerIdx === 0))) {
          isGrabbing = false;
          grabControllerIdx = -1;
        }
      }
    }

    // Prefer the right controller, but keep every core action usable with
    // only a left controller connected.
    const eligible = sources.find((s) => s && s.handedness === 'right' && s.gamepad) ||
      (!hasRightInput ? sources.find((s) => s && s.gamepad) : null);
    if (!eligible || !eligible.gamepad) return;
    const gp = eligible.gamepad;
    const axes = gp.axes || [];
    const thumbY = axes.length >= 4 ? (axes[3] || 0) : (axes[1] || 0);
    const thumbX = axes.length >= 4 ? (axes[2] || 0) : (axes[0] || 0);
    const gripPressed = gp.buttons.length > 1 && !!gp.buttons[1].pressed;
    const pointerOverPanel = commentsPanelVisible && !!cPanelHover;
    const cardOpen = sceneMode !== 'earth' && getVisualSource().kind === 'static-card';

    if (sceneMode !== 'earth') {
      if (gripPressed) {
        // A) GRIP HELD + stick Y up/down -> scale screen larger / smaller.
        if (Math.abs(thumbY) > FLICK_THRESHOLD) {
          screenScale = clampScreenScale(screenScale + (-thumbY) * SCALE_SPEED);
        }
        // A2) GRIP HELD + stick X right/left -> screen further / closer.
        if (Math.abs(thumbX) > 0.18) {
          if (lockToViewer) {
            screenDistance = clampScreenDistance(screenDistance + thumbX * DIST_SPEED);
          } else {
            const hx = headPos.x, hy = headPos.y, hz = headPos.z;
            const dx = screenPos.x - hx, dy = screenPos.y - hy, dz = screenPos.z - hz;
            const len = Math.hypot(dx, dy, dz) || screenDistance;
            const newLen = clampScreenDistance(len + thumbX * DIST_SPEED);
            const k = newLen / len;
            screenPos = { x: hx + dx * k, y: hy + dy * k, z: hz + dz * k };
          }
        }
        // While gripped, stick X drives distance — never a seek flick.
        if (Math.abs(thumbX) >= FLICK_RESET) flickedX = true;
        else if (Math.abs(thumbX) < FLICK_RESET) flickedX = false;
      } else if (pointerOverPanel) {
        // B1) Pointing at the comments panel -> scroll the list with Y.
        if (Math.abs(thumbY) > 0.18) {
          cPanelScrollY = clampPanelScroll(cPanelScrollY + thumbY * 6);
          vrLastUiUploadT = -1;
        }
      } else {
        // B2) NORMAL stick Y up/down -> next / previous reel navigation.
        if (Math.abs(thumbY) > FLICK_THRESHOLD && !flickedY) {
          flickedY = true;
          if (!cardOpen) {
            if (thumbY > 0) {
              if (callbacks.onNext) callbacks.onNext();
            } else {
              if (callbacks.onPrev) callbacks.onPrev();
            }
          }
          showControls();
        } else if (Math.abs(thumbY) < FLICK_RESET) {
          flickedY = false;
        }
      }

      // C) Stick X left/right -> seek ±5s (never while gripped: distance).
      if (!gripPressed) {
        if (Math.abs(thumbX) > FLICK_THRESHOLD && !flickedX) {
          flickedX = true;
          if (!cardOpen && callbacks.onSeek) callbacks.onSeek(thumbX > 0 ? 5 : -5);
          showControls();
        } else if (Math.abs(thumbX) < FLICK_RESET) {
          flickedX = false;
        }
      }

      // ── A button: toggle play / pause (disabled on static cards) ──
      const aPressed = gp.buttons.length > 4 && !!gp.buttons[4].pressed;
      if (aPressed && !prevBtnState.rightA) {
        if (!cardOpen && callbacks.onTogglePlay) callbacks.onTogglePlay();
        showControls();
      }
      prevBtnState.rightA = aPressed;

      // Continue a trigger-drag scroll on the comments list (content
      // follows the hand; the laser pass refreshes lastCommentsCanvasY).
      if (cPanelDrag && cPanelHover) {
        const before = cPanelScrollY;
        cPanelScrollY = clampPanelScroll(cPanelDragStartScroll - (lastCommentsCanvasY - cPanelDragStartCanvasY));
        if (cPanelScrollY !== before) {
          cPanelDragMoved = true;
          vrLastUiUploadT = -1;
        }
      }
    }

    // ── B button: toggle guide & controls panel ──
    const bPressed = gp.buttons.length > 5 && !!gp.buttons[5].pressed;
    if (bPressed && !prevBtnState.rightB) {
      toggleControls();
    }
    prevBtnState.rightB = bPressed;
  }

  // Screen UV → comments-panel region descriptor (shared XR/preview).
  function commentsRegionFromUV(uv) {
    const ui = getUICanvas();
    if (!uv || !ui || typeof ui.resolveCommentsPanelRegion !== 'function') return '';
    try {
      const w = commentsCanvas ? commentsCanvas.width : ui.CPANEL_W;
      const h = commentsCanvas ? commentsCanvas.height : ui.CPANEL_H;
      lastCommentsCanvasX = uv.x * w;
      lastCommentsCanvasY = (1 - uv.y) * h;
      const comments = callbacks.getComments ? callbacks.getComments() : [];
      return ui.resolveCommentsPanelRegion(lastCommentsCanvasX, lastCommentsCanvasY,
        { comments, cPanelTab, cPanelScrollY }) || '';
    } catch (e) { return ''; }
  }

  // Screen UV → pop-up overlay comment id (shared XR/preview).
  function overlayCommentFromUV(uv) {
    const ui = getUICanvas();
    if (!uv || !ui || typeof ui.resolveOverlayCommentAt !== 'function') return null;
    if (!overlayRegions || overlayRegions.length === 0) return null;
    try {
      const w = overlayCanvas ? overlayCanvas.width : ui.OVERLAY_W;
      const h = overlayCanvas ? overlayCanvas.height : ui.OVERLAY_H;
      return ui.resolveOverlayCommentAt(uv.x * w, (1 - uv.y) * h, overlayRegions);
    } catch (e) { return null; }
  }

  function setupVRControllers() {
    if (!renderer || !renderer.xr || vrControllers.length > 0) return;
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      controller.addEventListener('selectstart', onVRSelectStart);
      controller.addEventListener('selectend', onVRSelectEnd);
      controller.addEventListener('select', onVRSelect);
      scene.add(controller);
      vrControllers.push(controller);
    }
  }

  function onVRSelectStart() {
    pressedButton = hoveredButton;
    // Begin a trigger-drag scroll when pressing on the panel list/scrollbar.
    if (commentsPanelVisible && cPanelHover &&
        (cPanelHover === 'list' || cPanelHover === 'scrollbar')) {
      executeCommentAction(cPanelHover);
      cPanelDragMoved = false;
    }
    emitPreviewState();
  }

  function onVRSelectEnd() {
    pressedButton = -1;
    cPanelDrag = false;
    cPanelDragMoved = false;
    emitPreviewState();
  }

  // XR click priority (upstream onSelectStart): comments panel → dock →
  // pop-up overlay comment → video screen → empty space. Clicks from the
  // hand the laser is showing reuse that exact ray, so the action always
  // matches the visible highlight; other hands raycast fresh.
  function onVRSelect(ev) {
    const controller = ev.target;
    let handled = false;
    const evHand = ev.data && ev.data.handedness;
    const stored = chooseSelectRay(evHand);
    let rayOrigin = stored ? stored.origin : null;
    let rayDir = stored ? stored.direction : null;
    if ((!rayOrigin || !rayDir) && raycaster && controller && scene) {
      try {
        const tempMatrix = new THREE.Matrix4();
        tempMatrix.identity().extractRotation(controller.matrixWorld);
        rayOrigin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
        rayDir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
      } catch (e) { rayOrigin = null; rayDir = null; }
    }
    if (raycaster && scene && rayOrigin && rayDir) {
      raycaster.set(rayOrigin, rayDir);

      if (sceneMode === 'earth' && earthMesh) {
        const hit = hitTestEarth(rayOrigin, rayDir);
        if (hit.hit) {
          // Z1 tap dispatch: zone taps zoom below the city band and select
          // at/above it; clean taps on open globe zoom one step.
          const tapAction = handleEarthTap(hit.zoneIndex, hit);
          if (tapAction !== 'none') {
            pulseInput(ev.data);
            handled = true;
          }
        }
      } else {
        // 1. Comments panel — highest priority.
        if (!handled && commentsPanelVisible && commentsMesh && commentsMesh.visible !== false) {
          const hits = raycaster.intersectObject(commentsMesh, false);
          if (hits.length > 0 && hits[0].uv) {
            const desc = commentsRegionFromUV(hits[0].uv) || cPanelHover;
            if (desc) {
              if ((desc === 'list' || desc === 'scrollbar') && cPanelDragMoved) {
                // A scroll drag just ended — consume, don't click.
                cPanelDragMoved = false;
                cPanelDrag = false;
              } else {
                executeCommentAction(desc);
                pulseInput(ev.data);
                vrLastUiUploadT = -1;
              }
              handled = true;
            }
          }
        }
        // 2. Controls dock buttons.
        if (!handled && controlsMesh && controlsMesh.visible) {
          const hits = raycaster.intersectObject(controlsMesh);
          if (hits.length > 0 && hits[0].uv) {
            const index = controlIndexFromUV(hits[0].uv);
            if (index >= 0) {
              executeControlButton(index);
              pulseInput(ev.data);
              handled = true;
            }
          }
        }
        // 3. Pop-up overlay comment (panel closed) → open the panel at it.
        // 4. Main video screen tap; 5. empty space toggles the UI.
        if (!handled && screenMesh && screenMesh.visible !== false) {
          const hits = raycaster.intersectObject(screenMesh, false);
          if (hits.length > 0) {
            if (!commentsPanelVisible && hits[0].uv) {
              const cid = overlayCommentFromUV(hits[0].uv);
              if (cid) {
                openCommentsPanelToComment(cid);
                pulseInput(ev.data);
                handled = true;
              }
            }
            if (!handled) {
              const visualSource = getVisualSource();
              if (visualSource.kind === 'static-card' && callbacks.onMainScreenSelect && hits[0].uv) {
                let cardHandled = false;
                try {
                  cardHandled = callbacks.onMainScreenSelect({
                    u: hits[0].uv.x,
                    v: 1 - hits[0].uv.y,
                  });
                } catch (e) { cardHandled = false; }
                if (cardHandled) {
                  pulseInput(ev.data);
                  showControls();
                  handled = true;
                } else {
                  // Card shown but tap missed all card buttons — show
                  // controls only (upstream: never toggle the hidden clock).
                  pulseInput(ev.data);
                  showControls();
                  handled = true;
                }
              } else if (visualSource.kind === 'static-card') {
                pulseInput(ev.data);
                showControls();
                handled = true;
              } else {
                if (callbacks.onTogglePlay) callbacks.onTogglePlay();
                pulseInput(ev.data);
                toggleControls();
                handled = true;
              }
            }
          }
        }
      }
    }

    if (!handled) toggleControls();
  }

  // Phase 4 gate logic (mirrored in ui/assets/reels.html click handler):
  // supported → always attempt; localhost/127.0.0.1 or ?forceXR=1 →
  // attempt anyway so DevTools / Immersive Web Emulator sessions that
  // report isSessionSupported=false can still try requestSession;
  // otherwise block with HEADSET NOT DETECTED.
  function shouldAttemptXR(opts) {
    const o = opts || {};
    if (o.isSupported) return true;
    if (o.forceXR) return true;
    const host = String(o.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
    return false;
  }

  // Quest Browser requires an XR-compatible GL context. Three.js r186
  // creates a WebGL2 context internally, so the supported path is:
  // renderer.getContext().makeXRCompatible() before setSession.
  // Best-effort: records outcome in xrCompatStatus, never throws.
  async function ensureXRCompatibleContext() {
    let gl = null;
    try {
      gl = renderer && renderer.getContext ? renderer.getContext() : (glContext || null);
    } catch (e) { gl = null; }
    if (!gl) {
      xrCompatStatus = 'unavailable';
      return false;
    }
    try {
      if (typeof gl.makeXRCompatible === 'function') {
        await gl.makeXRCompatible();
        xrCompatStatus = 'made-compatible';
        return true;
      }
      const attrs = (typeof gl.getContextAttributes === 'function') ? gl.getContextAttributes() : null;
      if (attrs && attrs.xrCompatible) {
        xrCompatStatus = 'compatible';
        return true;
      }
      // No makeXRCompatible API (e.g. mock contexts in tests): treat the
      // existing context as usable rather than blocking entry.
      xrCompatStatus = 'compatible';
      return true;
    } catch (e) {
      xrCompatStatus = 'failed:' + String((e && e.message) || e).slice(0, 120);
      return false;
    }
  }

  // Machine-readable entry failure: logs, notifies the host page via
  // callbacks.onVRError(reason, detail) for user-visible feedback, and
  // returns null (legacy callers only check truthiness).
  function notifyVRError(reason, detail) {
    try {
      console.error('[WebXRVR] enterVR failed (' + reason + '):', detail || '');
    } catch (e) {}
    if (callbacks && typeof callbacks.onVRError === 'function') {
      try {
        callbacks.onVRError(reason, detail ? String((detail && detail.message) || detail) : '');
      } catch (e) {}
    }
    return null;
  }

  // Fresh-session state (upstream enterVR reset block): the screen returns
  // to its default pose/scale, feed playback keeps its head lock while
  // pack cards stay room-stable, and all interaction state is cleared.
  function resetXRSessionState() {
    screenPos = { x: DEFAULT_POS.x, y: DEFAULT_POS.y, z: DEFAULT_POS.z };
    ensureScreenQuat();
    if (screenQuat) {
      try { screenQuat.identity(); } catch (e) {}
    }
    screenScale = DEFAULT_SCALE;
    screenDistance = -DEFAULT_POS.z;
    isInitialPoseSet = false;
    lockToViewer = !isPackExperience();
    controlsVisible = false;
    commentsPanelVisible = false;
    cPanelScrollY = 0;
    cPanelMaxScroll = 0;
    cPanelTab = 'all';
    cPanelHover = '';
    cPanelDrag = false;
    clearPanelHighlight();
    overlayRegions = [];
    overlayHoverId = null;
    overlayHasPopups = false;
    lastOverlayKey = '';
    lastOverlayUploadT = -1;
    hoveredButton = -1;
    pressedButton = -1;
    isGrabbing = false;
    grabControllerIdx = -1;
    flickedX = false;
    flickedY = false;
    prevBtnState.rightA = false;
    prevBtnState.rightB = false;
    vrGuideUploaded = false;
    clearAutoHideTimer();
    resetXRDiag();
    commitScreenTransform();
  }

  // Best-effort restore of the desktop preview torn down on entry.
  // Clears the snapshot; skips silently if the canvas detached (SPA
  // navigated away). Shared by the bind-failure path and session end.
  function restorePreviewSnapshot() {
    const resume = previewResumeOpts;
    previewResumeOpts = null;
    if (resume && resume.canvas && typeof resume.canvas.getContext === 'function') {
      try {
        if (resume.canvas.isConnected === false) return false;
        startPreview(resume.canvas, resume.options || {});
        return true;
      } catch (e) {
        console.warn('[WebXRVR] Preview restore after XR session failed:', e);
        return false;
      }
    }
    return false;
  }

  async function enterVR(options = {}) {
    if (xrSession) return xrSession;
    const xr = (options && options.xr) || getXR();
    if (!xr) {
      return notifyVRError('webxr-unavailable', 'navigator.xr is absent (needs HTTPS or localhost)');
    }

    ensureThree();
    if (!THREE) {
      return notifyVRError('three-missing', 'three.min.js did not load');
    }

    // Fail fast: request the session BEFORE tearing down the desktop
    // preview or building GL resources, so a rejection leaves any running
    // preview untouched.
    // DOM overlay root must exist before the session request so the Quest
    // virtual keyboard can be summoned for VR comment posting (?domoverlay=0
    // skips it entirely — diagnostic for compositor-layer glitch suspects).
    // ?xrminimal=1 requests the minimal feature set the three.js
    // webxr_vr_video standard uses — the AB page (§3.8) proved it clean.
    // v8.15: minimal is the default (§3.10); ?xrfull=1 restores legacy.
    // v8.17: the whole stack (session + renderer) follows useFullStack().
    const useFullSession = useFullStack();
    if (debugFlags.domoverlay && useFullSession) initDomOverlay();
    let session = null;
    const sessionOpts = useFullSession
      ? { optionalFeatures: ['local-floor', 'local', 'bounded-floor', 'hand-tracking'] }
      : { optionalFeatures: ['local-floor', 'local'] };
    if (debugFlags.domoverlay && useFullSession) {
      sessionOpts.optionalFeatures.push('dom-overlay');
      if (domOverlayRoot) sessionOpts.domOverlay = { root: domOverlayRoot };
    }
    // v8.17: device-grounded proof of what was requested (answers "is the
    // flag applied" permanently — see diag sessionFeatures).
    try {
      lastSessionRequestedFeatures = (sessionOpts.optionalFeatures || []).slice();
    } catch (e) { lastSessionRequestedFeatures = null; }

    try {
      session = await xr.requestSession('immersive-vr', sessionOpts);
    } catch (e1) {
      console.warn('[WebXRVR] Session request with optionalFeatures failed, trying minimal:', e1);
      try {
        session = await xr.requestSession('immersive-vr');
      } catch (e2) {
        return notifyVRError('session-rejected', e2);
      }
    }

    // Snapshot a running desktop preview BEFORE teardown so the session
    // end handler (or a bind failure) can restore it. Null when entering
    // from the 2D page (no preview to restore).
    previewResumeOpts = null;
    if (previewRunning && previewCanvas) {
      try {
        previewResumeOpts = {
          canvas: previewCanvas,
          options: {
            cameraMode: previewCameraMode,
            sceneMode: sceneMode,
            stereo: stereoMode,
            reducedMotion: reducedMotion,
            showControls: controlsVisible,
          },
        };
      } catch (e) { previewResumeOpts = null; }
    }
    // A desktop preview owns the singleton renderer/loop; tear it down so
    // the immersive session starts from a clean slate (upstream parity).
    if (previewRunning) {
      try { stopPreview(); } catch (e) {}
    }

    // Always build a fresh XR canvas. Never reuse previewCanvas (possibly
    // detached after SPA route changes) and never render blind: an
    // unattached canvas still renders, attachment is best-effort.
    if (xrCanvas) {
      try {
        if (xrCanvas.parentNode) xrCanvas.parentNode.removeChild(xrCanvas);
      } catch (e) {}
      xrCanvas = null;
    }
    let canvas = null;
    if (typeof document !== 'undefined') {
      try {
        const old = document.getElementById ? document.getElementById('webxrVrCanvas') : null;
        if (old && old.parentNode) {
          try { old.parentNode.removeChild(old); } catch (e) {}
        }
        canvas = document.createElement('canvas');
        canvas.id = 'webxrVrCanvas';
        canvas.width = 1280;
        canvas.height = 720;
        canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;pointer-events:none;';
        try {
          if (document.body) document.body.appendChild(canvas);
        } catch (e) {}
      } catch (e) {
        canvas = null;
      }
    }
    if (!canvas) {
      return notifyVRError('canvas-unavailable', 'could not create XR canvas');
    }
    xrCanvas = canvas;
    try {
      initThreeScene(canvas);
    } catch (e) {
      return notifyVRError('webgl-unavailable', e);
    }
    if (!renderer || !scene || !camera) {
      return notifyVRError('webgl-unavailable', 'WebGL context creation failed');
    }

    // Quest Browser rejects setSession on a non-XR-compatible context.
    // Standard Three.js path: makeXRCompatible() before setSession.
    // Non-blocking on failure: record status and let setSession decide,
    // so desktops without the API still enter.
    try {
      await ensureXRCompatibleContext();
    } catch (e) {
      xrCompatStatus = 'failed:' + String((e && e.message) || e).slice(0, 120);
    }

    xrSession = session;
    resetXRSessionState();

    if (renderer && renderer.xr) {
      renderer.xr.enabled = true;
      try {
        renderer.xr.setReferenceSpaceType('local-floor');
      } catch (e) {
        try { renderer.xr.setReferenceSpaceType('local'); } catch (e2) {}
      }

      try {
        await renderer.xr.setSession(session);
      } catch (e) {
        try {
          renderer.xr.setReferenceSpaceType('local');
          await renderer.xr.setSession(session);
        } catch (e2) {
          try { session.end(); } catch (e3) {}
          xrSession = null;
          restorePreviewSnapshot();
          return notifyVRError('bind-failed', e2);
        }
      }

      xrRefSpace = renderer.xr.getReferenceSpace();
      setupVRControllers();
      setupVideoFrameTracking();
      // Explicit entry mode (default reels): never inherit a stale mode
      // from a previous preview, route, or session.
      const entryMode = (options && options.mode === 'earth' && !isPackExperience()) ? 'earth' : 'reels';
      setSceneMode(entryMode);
      console.log('[WebXRVR] Entered immersive session in scene mode:', sceneMode);

      if (sceneMode === 'reels') {
        if (videoElement) {
          videoElement.muted = false;
          if (callbacks.onUnmute) callbacks.onUnmute();
          if (videoElement.paused) videoElement.play().catch(() => {});
        }
      }

      if (typeof document !== 'undefined') {
        document.documentElement.classList.add('sx-vr-active');
        if (document.body) document.body.classList.add('sx-vr-active');
      }

      // Single animation loop: clear any stale loop before installing the
      // XR one (preview uses rAF and was torn down above, but be explicit).
      try {
        if (renderer.setAnimationLoop) renderer.setAnimationLoop(null);
      } catch (e) {}
      renderer.setAnimationLoop((time, frame) => {
        applySceneVisibility();
        if (sceneMode === 'reels') {
          const source = getVisualSource();
          if (source && source.ready === false) {
            if (source.element) renderStats.transNotReady += 1;
            clearPendingTexture();
          } else {
            uploadVideoFrame();
          }
          updateGlowColor(time, 800);
          applyGlowColor();
          // Head lock: the screen follows the gaze every frame
          // (skipped under ?lock=0 for bisection).
          if (lockApplies()) applyLockToViewer();
          // Paused reels reveal the dock (upstream parity).
          if (getVisualSource().paused && !controlsVisible) showControls();
        } else {
          advanceEarthZoom(time);
          advanceEarthSpin(time);
          updateEarthDressing(time);
        }
        updateControllerLasers(frame);
        processXRInput(frame);
        commitScreenTransform();
        layoutControlsDock();
        refreshOverlayTexture(time);
        // Transport controls: 10Hz re-render is smooth in VR and avoids a
        // full canvas re-raster on every XR frame (upstream stride).
        if (vrLastUiUploadT < 0 || (time - vrLastUiUploadT) >= VR_UI_MIN_INTERVAL) {
          vrLastUiUploadT = time;
          updateUiTextures();
        }
        renderer.render(scene, camera);
        postXRDiag(time);
      });
    }

    session.addEventListener('end', () => {
      xrSession = null;
      if (renderer) {
        try { renderer.setAnimationLoop(null); } catch (e) {}
      }
      stopVideoFrameTracking();
      if (xrCanvas) {
        try {
          if (xrCanvas.parentNode) xrCanvas.parentNode.removeChild(xrCanvas);
        } catch (e) {}
        xrCanvas = null;
      }
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('sx-vr-active');
        if (document.body) document.body.classList.remove('sx-vr-active');
      }
      if (callbacks.onExitVR) {
        try { callbacks.onExitVR(); } catch (e) {}
      }
      // Restore the desktop preview torn down on entry, if its canvas is
      // still attached (SPA may have navigated away — then skip silently).
      restorePreviewSnapshot();
    });

    return session;
  }

  function exitVR() {
    if (xrSession) {
      try { xrSession.end(); } catch (e) {}
      xrSession = null;
    }
  }

  // ─── Resource Cleanup ───────────────────────────────────────────────
  function cleanup() {
    removePreviewListeners();
    clearAutoHideTimer();
    closeVrKeyboard();
    dockFreezePainted = false;
    hasDisplayedVisual = false;
    freshVisualSince = 0;
    cPanelDrag = false;
    cPanelDragMoved = false;
    cPanelHover = '';
    isGrabbing = false;
    grabControllerIdx = -1;
    flickedX = false;
    flickedY = false;
    prevBtnState.rightA = false;
    prevBtnState.rightB = false;
    overlayRegions = [];
    overlayHoverId = null;
    overlayHasPopups = false;
    lastOverlayKey = '';
    if (typeof window !== 'undefined' && previewResizeHandler) {
      try { window.removeEventListener('resize', previewResizeHandler); } catch (e) {}
      previewResizeHandler = null;
    }
    // Dispose Three-managed GPU resources. Textures are nulled (not just
    // disposed) so the next startPreview() rebuilds them — reusing a
    // disposed CanvasTexture rendered black after restart.
    if (scene) {
      try {
        scene.traverse((obj) => {
          if (obj.geometry) { try { obj.geometry.dispose(); } catch (e) {} }
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => {
              if (m) {
                if (m.map && m.map !== videoTexture && m.map !== controlsTexture &&
                    m.map !== commentsTexture && m.map !== overlayTexture &&
                    m.map !== guideTexture && m.map !== earthPreviewTexture) {
                  try { m.map.dispose(); } catch (e) {}
                }
                try { m.dispose(); } catch (e) {}
              }
            });
          }
        });
      } catch (e) {}
    }
    if (videoTexture) { try { videoTexture.dispose(); } catch (e) {} videoTexture = null; }
    releaseDirectVideoBinding();
    screenMapBeforeDebug = null;
    if (controlsTexture) { try { controlsTexture.dispose(); } catch (e) {} controlsTexture = null; }
    if (commentsTexture) { try { commentsTexture.dispose(); } catch (e) {} commentsTexture = null; }
    if (overlayTexture) { try { overlayTexture.dispose(); } catch (e) {} overlayTexture = null; }
    if (guideTexture) { try { guideTexture.dispose(); } catch (e) {} guideTexture = null; }
    if (earthPreviewTexture) { try { earthPreviewTexture.dispose(); } catch (e) {} earthPreviewTexture = null; }
    const gl = glContext || (renderer && renderer.getContext ? renderer.getContext() : null);
    if (gl && gl.deleteBuffer) {
      try {
        gl.deleteBuffer({});
        gl.deleteTexture({});
        gl.deleteProgram({});
      } catch (e) {}
    }
    if (renderer) {
      try { renderer.dispose(); } catch (e) {}
      renderer = null;
    }
    glContext = null;
    scene = null;
    camera = null;
    orbitControls = null;
    raycaster = null;
    screenMesh = null;
    ambilightMesh = null;
    overlayMesh = null;
    guideMesh = null;
    controlsMesh = null;
    commentsMesh = null;
    starfieldPoints = null;
    earthGroup = null;
    earthMesh = null;
    earthPinsGroup = null;
    earthPreviewMesh = null;
    reticleMesh = null;
    laserLine = null;
    controlsCanvas = null;
    controlsCtx = null;
    commentsCanvas = null;
    commentsCtx = null;
    overlayCanvas = null;
    overlayCtx = null;
    guideCanvas = null;
    guideCtx = null;
    earthPreviewCanvas = null;
    earthPreviewCtx = null;
    glowAlphaTexture = null;
    glowProbeCanvas = null;
    glowProbeCtx = null;
    glowColor = [0.10, 0.24, 0.62];
    glowTarget = [0.10, 0.24, 0.62];
    lastGlowSample = -1;
    earthMapTexture = null;
    earthMapCanvas = null;
    earthMapCtx = null;
    earthMapDirty = true;
    earthBaseSource = 'fallback';
    earthBaseTried = false;
    earthBaseStale = true;
    earthLabelTexture = null;
    earthLabelCanvas = null;
    earthLabelCtx = null;
    earthLabelMesh = null;
    lastEarthLabelKey = '';
    lastEarthPreviewUpdate = -1;
    pinSharedGeo = null;
    laserPositions = null;
    reticleTexture = null;
    previewHoverRay = null;
    scratchMat4 = null;
    scratchVec = null;
    scratchVec2 = null;
    scratchVec3 = null;
    earthResourcesReady = false;
    vrControllers = [];
    previewPointer = null;
    previewListeners = null;
    hoveredButton = -1;
    pressedButton = -1;
    lastPointerError = '';
    // Reset the earth drag machine: a teardown mid-drag (route change,
    // preview restart, XR entry) must never strand dragging=true, which
    // would freeze idle spin and swallow the next gesture.
    earthDragging = false;
    earthDragLastDir = null;
    earthDragStartDir = null;
    earthDragMoved = false;
    earthDragEngaged = false;
    earthDragCumX = 0;
    earthDragCumY = 0;
    earthDragAxis = null;
    earthPressTime = 0;
    earthPressZone = -1;
    earthDragSource = null;
    // Reset the earth zoom machine: teardown mid-gesture must never strand a
    // scaled globe or a pinned focus into the next session/route.
    earthZoom = 1;
    earthZoomTarget = 1;
    earthFocus = null;
    earthZoomAnchor = null;
    earthZoomAnim = null;
    earthZoomApplied = -1;
    // Z2 tile teardown: dispose every patch + texture; the layer rebuilds
    // from scratch on the next earth entry.
    try { retireEarthTiles(() => true); } catch (e) {}
    earthTilePrefetch.clear();
    earthTileQueue = [];
    earthTileInFlight = 0;
    earthTileZ = -1;
    earthTileCenterKey = '';
    earthTileLastMaintain = -1;
    earthTileBaseFade = -1;
    earthTileClock = -1;
    earthTileProbeAt = -1;
    earthTileLoadRatio = 1;
    earthTileFailures = 0;
    earthTileAvailable = true;
    // Z3 teardown: heat overlay + band-tracked activity fetch.
    disposeEarthHeatSprites();
    earthHeatGroup = null;
    heatSpriteGeo = null;
    earthHeatTexture = null;
    earthActivityZoom = null;
    if (earthActivityRefetchTimer) {
      try { clearTimeout(earthActivityRefetchTimer); } catch (e) {}
      earthActivityRefetchTimer = null;
    }
    lastUploadedSource = null;
    lastVisualKind = '';
    lastVisualVersion = '';
    lastVisualElement = null;
    lastVideoTime = -1;
    pendingClearedFor = '';
    vrLastUiUploadT = -1;
  }

  function isPackExperience() {
    return !!(callbacks.isPackMode && callbacks.isPackMode());
  }

  function getPackContext() {
    return callbacks.getPackContext ? callbacks.getPackContext() : null;
  }

  // Screen-local hit (meters, upstream overlayCommentAtHit convention) →
  // normalized UV. Divided by the live screenScale so grip-scaled screens
  // keep mapping the full canvas.
  function visualPointFromHit(hitLocal) {
    if (!hitLocal) return null;
    const s = (Number(screenScale) > 0 ? Number(screenScale) : DEFAULT_SCALE);
    return {
      u: Math.max(0, Math.min(1, (hitLocal.x / s) + 0.5)),
      v: Math.max(0, Math.min(1, 0.5 - (hitLocal.y / s))),
    };
  }

  function executeControlButton(index) {
    const ui = getUICanvas();
    const btns = ui ? ui.CTRL_BUTTONS : [];
    if (index < 0 || index >= btns.length) return;
    const action = btns[index].action;
    pressedButton = index;
    vrLastUiUploadT = -1;
    resetAutoHideTimer();
    switch (action) {
      case 'prev': callbacks.onPrev && callbacks.onPrev(); break;
      case 'next': callbacks.onNext && callbacks.onNext(); break;
      case 'play': callbacks.onTogglePlay && callbacks.onTogglePlay(); break;
      case 'rew':  callbacks.onSeek && callbacks.onSeek(-5); break;
      case 'fwd':  callbacks.onSeek && callbacks.onSeek(5); break;
      case 'mode': callbacks.onToggleMode && callbacks.onToggleMode(); break;
      case 'curve': setCurvatureMode((curvatureMode + 1) % 3); break;
      case 'lock':
        if (!debugFlags.lock) {
          showNotification('LOCK DISABLED (?lock=0)');
          break;
        }
        lockToViewer = !lockToViewer;
        if (lockToViewer) {
          isGrabbing = false;
          grabControllerIdx = -1;
        }
        break;
      case 'mute':
        if (callbacks.onToggleMute) callbacks.onToggleMute();
        else if (videoElement) videoElement.muted = !videoElement.muted;
        break;
      case 'comments': toggleCommentsPanel(); break;
      case 'earth':
        if (isPackExperience() && callbacks.onTogglePackQueue) callbacks.onTogglePackQueue();
        else setSceneMode(sceneMode === 'earth' ? 'reels' : 'earth');
        break;
      // Earth zoom map dock actions (earth mode only, Z1).
      case 'earth_zoom_out':
        if (sceneMode === 'earth') adjustEarthZoom(1 / EARTH_ZOOM_STEP);
        break;
      case 'earth_reset':
        if (sceneMode === 'earth') resetEarthZoom();
        break;
      case 'earth_open_feed':
        if (sceneMode === 'earth') {
          const feedIdx = earthHoveredIndex >= 0 ? earthHoveredIndex : earthSelectedIndex;
          const row = (feedIdx >= 0 && feedIdx < earthLocations.length) ? earthLocations[feedIdx] : null;
          if (row && row.kind === 'cluster' && Number(row.location_count) > 1) {
            // Clusters have no feed of their own — drill into the cell first.
            handleEarthTap(feedIdx, null);
          } else if (row) {
            selectEarthLocation(feedIdx);
          } else {
            showNotification('POINT AT A ZONE FIRST');
          }
        }
        break;
      case 'like': callbacks.onLike && callbacks.onLike(); break;
      case 'save_reel': callbacks.onSaveReel && callbacks.onSaveReel(); break;
      case 'share_reel': callbacks.onShareReel && callbacks.onShareReel(); break;
      case 'follow': callbacks.onFollow && callbacks.onFollow(); break;
      case 'profile': callbacks.onOpenCurrentProfile && callbacks.onOpenCurrentProfile(); break;
      case 'report': callbacks.onReportReel && callbacks.onReportReel(); break;
      case 'save_pack': callbacks.onSavePack && callbacks.onSavePack(); break;
      case 'share_pack': callbacks.onSharePack && callbacks.onSharePack(); break;
      case 'collect': callbacks.onCollectReel && callbacks.onCollectReel(); break;
      case 'exit': xrSession ? exitVR() : stopPreview(); break;
    }
  }

  // ─── Comments panel actions (upstream executeCommentAction verbatim) ─
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
      vrLastUiUploadT = -1;
      return true;
    }
    if (desc === 'close') {
      commentsPanelVisible = false;
      cPanelHover = null;
      applySceneVisibility();
      return true;
    }
    if (desc === 'add') {
      openVrKeyboard();
      return true;
    }
    if (desc === 'scrollup') {
      const ui = getUICanvas();
      const step = ui ? (ui.CP_ITEM_H + ui.CP_ITEM_GAP) : 112;
      cPanelScrollY = clampPanelScroll(cPanelScrollY - step);
      vrLastUiUploadT = -1;
      return true;
    }
    if (desc === 'scrolldown') {
      const ui = getUICanvas();
      const step = ui ? (ui.CP_ITEM_H + ui.CP_ITEM_GAP) : 112;
      cPanelScrollY = clampPanelScroll(cPanelScrollY + step);
      vrLastUiUploadT = -1;
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
    applySceneVisibility();
    vrLastUiUploadT = -1;
  }

  // Open the comments panel, scroll to and highlight a specific comment
  // (usually triggered by clicking a pop-up overlay comment).
  function openCommentsPanelToComment(commentId) {
    commentsPanelVisible = true;
    cPanelTab = 'all';
    const ui = getUICanvas();
    const comments = callbacks.getComments ? callbacks.getComments() : [];
    const idx = comments.findIndex((c) => c.id === commentId);
    const listH = ui ? (ui.CP_LIST_BOTTOM - ui.CP_LIST_TOP) : 520;
    const itemH = ui ? (ui.CP_ITEM_H + ui.CP_ITEM_GAP) : 112;
    if (idx >= 0) {
      const itemTop = idx * itemH;
      cPanelScrollY = Math.max(0, itemTop - (listH - (itemH - 8)) / 2);
    }
    setPanelHighlight(commentId);
    applySceneVisibility();
    vrLastUiUploadT = -1;
  }

  function setPanelHighlight(commentId) {
    clearPanelHighlight();
    cPanelHighlightId = commentId;
    try {
      cPanelHighlightTimer = setTimeout(() => {
        cPanelHighlightId = null;
        cPanelHighlightTimer = null;
      }, 4000);
    } catch (e) { cPanelHighlightTimer = null; }
  }

  // ── Quest virtual keyboard (DOM Overlay) for posting comments ──
  function initDomOverlay() {
    if (domOverlayRoot || typeof document === 'undefined') return;
    try {
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
    } catch (e) { domOverlayRoot = null; domOverlayInput = null; }
  }

  function openVrKeyboard() {
    if (!debugFlags.domoverlay) {
      showNotification('KEYBOARD DISABLED (?domoverlay=0)');
      return;
    }
    // v8.16: the minimal session (v8.15 default) doesn't request the
    // dom-overlay layer, so focusing the input would summon no keyboard —
    // fail explicitly instead of stranding the user on an invisible field.
    // ?xrfull=1 restores the layer.
    let overlayGranted = false;
    try {
      overlayGranted = !!(xrSession && xrSession.enabledFeatures &&
        xrSession.enabledFeatures.includes('dom-overlay'));
    } catch (e) { overlayGranted = false; }
    if (!overlayGranted) {
      showNotification('KEYBOARD NEEDS FULL SESSION (?xrfull=1)');
      return;
    }
    initDomOverlay();
    if (!domOverlayInput) return;
    const source = getVisualSource();
    pendingSyncTime = source.kind === 'static-card' ? null : Math.round(source.currentTime * 10) / 10;
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
      if (e.preventDefault) e.preventDefault();
      const text = domOverlayInput ? domOverlayInput.value.trim() : '';
      closeVrKeyboard();
      if (text && callbacks.onPostComment) {
        callbacks.onPostComment(text, pendingSyncTime);
      }
    } else if (e.key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      closeVrKeyboard();
    }
  }

  function onCommentInputBlur() {
    setTimeout(() => {
      try {
        if (domOverlayInput && document.activeElement !== domOverlayInput) {
          domOverlayInput.style.display = 'none';
        }
      } catch (e) {}
    }, 150);
  }

  // v8.4 video upload path A/B ('subimage' default | 'respec' forces full
  // texImage2D re-spec per upload — decisive on-device test for the Quest
  // sub-image driver suspicion). Also honours ?vrTexMode=respec.
  function setVideoUploadMode(mode) {
    videoUploadMode = (mode === 'respec') ? 'respec' : 'subimage';
    return videoUploadMode;
  }

  // ─── Public Module API ──────────────────────────────────────────────
  return {
    init(video, cbs) {
      videoElement = video;
      callbacks = cbs || {};
      lockToViewer = !isPackExperience();
      try {
        const q = (typeof location !== 'undefined' && location.search) || '';
        if (/(?:\?|&)vrTexMode=respec(?:&|$)/.test(q)) videoUploadMode = 'respec';
      } catch (e) {}
      readDebugFlags();
      console.log('[WebXRVR] Initialised', VR_VERSION);
    },
    setVideoUploadMode,

    async isSupported() {
      const xr = getXR();
      if (!xr) return false;
      try { return await xr.isSessionSupported('immersive-vr'); } catch { return false; }
    },

    enterVR,
    exitVR,
    isPresenting() { return !!xrSession; },
    isPreviewRunning() { return !!previewRunning; },
    startPreview,
    stopPreview,
    resetPreview,
    setPreviewCameraMode,
    setPreviewStereo,
    setReducedMotion,
    setSceneMode,
    requestPreviewFullscreen,
    toggleControls: toggleControlsVisibility,
    version: VR_VERSION,
    getCurvatureMode,
    setCurvatureMode,
    getThree() { return THREE || (typeof window !== 'undefined' && window.THREE) || null; },
    get THREE() { return THREE || (typeof window !== 'undefined' && window.THREE) || null; },
    getPreviewState,
    onVideoChange() {
      hasNewVideoFrame = true;
      renderStats.transChanges += 1;
      const source = getVisualSource();
      if (source && source.ready === false) {
        // Held when a visual is already displayed (no black flash, no
        // wasteful re-upload of the unchanged canvas).
        clearPendingTexture();
      } else if (videoTexture) {
        videoTexture.needsUpdate = true;
      }
    },
    showNotification,
    setStereo(enabled) { stereoMode = !!enabled; },

    __test: {
      locationToUnit,
      earthZoneAngularRadius,
      earthZoneUV,
      classifyEarthPixel,
      earthHeatStyle,
      computeDockPose,
      controlIndexFromUV,
      // v8.3 lock/scale/distance/panel seams.
      computeLockedPose,
      clampScreenScale,
      clampScreenDistance,
      dockTargetSize,
      commentsPanelTargetSize,
      guideTargetSize,
      getCommentsPanelLayout,
      getGuidePanelLayout,
      applyLockToViewer,
      commitScreenTransform,
      lockApplies,
      pickPointerSource,
      updateLaserPointer,
      updateControllerLasers,
      getActiveRay() {
        return {
          origin: activeRayOrigin
            ? { x: activeRayOrigin.x, y: activeRayOrigin.y, z: activeRayOrigin.z } : null,
          direction: activeRayDir
            ? { x: activeRayDir.x, y: activeRayDir.y, z: activeRayDir.z } : null,
          handedness: activeRayHandedness,
        };
      },
      setActiveRay(origin, direction, handedness) {
        ensureThree();
        if (!THREE) return false;
        try {
          if (!activeRayOrigin) activeRayOrigin = new THREE.Vector3();
          if (!activeRayDir) activeRayDir = new THREE.Vector3();
          if (origin) activeRayOrigin.set(origin.x, origin.y, origin.z);
          if (direction) activeRayDir.set(direction.x, direction.y, direction.z).normalize();
          activeRayHandedness = handedness || '';
          return true;
        } catch (e) { return false; }
      },
      fireVRSelect(ev) { onVRSelect(ev || {}); },
      getDebugFlags() { return { ...debugFlags }; },
      setDebugFlags(patch) {
        const p = patch || {};
        for (const k of ['lock', 'overlay', 'guide', 'glow', 'dockfreeze', 'glowprobe', 'domoverlay', 'vrtex', 'xrminimal', 'xrfull', 'earthmap']) {
          if (p[k] !== undefined) debugFlags[k] = !!p[k];
        }
        if (p.earthstyle !== undefined) debugFlags.earthstyle = p.earthstyle === 'raw' ? 'raw' : 'holo';
        return { ...debugFlags };
      },
      processXRInput,
      executeCommentAction,
      toggleCommentsPanel,
      openCommentsPanelToComment,
      refreshPanelScrollBounds,
      commentsRegionFromUV,
      overlayCommentFromUV,
      refreshOverlayTexture,
      getTextureFilterInfo() {
        const describe = (tex) => tex ? {
          minFilter: tex.minFilter,
          magFilter: tex.magFilter,
          generateMipmaps: !!tex.generateMipmaps,
        } : null;
        return {
          video: describe(videoTexture),
          controls: describe(controlsTexture),
          comments: describe(commentsTexture),
          overlay: describe(overlayTexture),
          guide: describe(guideTexture),
        };
      },
      getScreenState() {
        return {
          pos: { ...screenPos },
          scale: screenScale,
          distance: screenDistance,
          locked: lockToViewer,
          grabbing: isGrabbing,
          uploadMode: videoUploadMode,
          overlayUploads: renderStats.overlayUploads || 0,
          controlsVisible,
          commentsPanelVisible,
          cPanelTab,
          cPanelScrollY,
          cPanelMaxScroll,
          cPanelHover,
          overlayPopups: overlayRegions.length,
          guideUploaded: vrGuideUploaded,
        };
      },
      setScreenState(patch) {
        const p = patch || {};
        if (p.pos) screenPos = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
        if (p.scale !== undefined) screenScale = clampScreenScale(p.scale);
        if (p.distance !== undefined) screenDistance = clampScreenDistance(p.distance);
        if (p.locked !== undefined) lockToViewer = !!p.locked;
      },
      shouldAttemptXR,
      getXrCompatStatus() { return xrCompatStatus; },
      hasPreviewResume() { return !!previewResumeOpts; },
      getLastPointerError() { return lastPointerError; },
      // Test seam: engine ray for a client pixel (null when no preview).
      previewRayFor(clientX, clientY) {
        const ray = previewRayAt(clientX, clientY);
        if (!ray) return null;
        return {
          origin: { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z },
          direction: { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z },
        };
      },
      // Test seam: invoke a stored preview pointer handler with a synthetic
      // event (the mock canvas swallows listeners, so this drives the
      // pointer→raycast→action chain in Node).
      firePreviewPointer(type, event) {
        if (!previewListeners) return false;
        const map = {
          pointerdown: 'onPointerDown',
          pointermove: 'onPointerMove',
          pointerup: 'finishPointer',
          pointercancel: 'finishPointer',
          wheel: 'onWheel',
        };
        const fn = previewListeners[map[type]];
        if (typeof fn !== 'function') return false;
        fn(event || {});
        return true;
      },
      getLastUploadedSource() { return lastUploadedSource; },
      getLastRenderError() { return lastRenderError; },
      // Downsampled mean/variance of the earth base canvas: photo re-style
      // has high variance (land/ocean/edges), flat fallback has low variance.
      // Proves an arrived photo survives subsequent zone repaints.
      getEarthBaseSample() {
        try {
          if (!earthMapCtx || typeof document === 'undefined') return { err: 'no-canvas' };
          const probe = document.createElement('canvas');
          probe.width = 8;
          probe.height = 8;
          const pctx = probe.getContext('2d');
          if (!pctx) return { err: 'no-2d' };
          pctx.drawImage(earthMapCanvas, 0, 0, 8, 8);
          const d = pctx.getImageData(0, 0, 8, 8).data;
          let n = 0, sum = 0, sum2 = 0;
          for (let i = 0; i < d.length; i += 4) {
            const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
            sum += v;
            sum2 += v * v;
            n++;
          }
          const mean = sum / n;
          return { mean: Math.round(mean), variance: Math.round(sum2 / n - mean * mean) };
        } catch (e) {
          return { err: String((e && e.message) || e) };
        }
      },
      // Pixel-level proof for CDP probes: renders once and reads back the
      // center 8x8 synchronously in the same task (works without
      // preserveDrawingBuffer, unlike readPixels-after-present or screenshots
      // in headless compositing where WebGL layers may not be captured).
      readCenterPixels() {
        try {
          if (!renderer || !scene || !camera) return { err: 'no-renderer' };
          renderer.render(scene, camera);
          const gl = renderer.getContext();
          const w = gl.drawingBufferWidth || 1;
          const h = gl.drawingBufferHeight || 1;
          const px = new Uint8Array(8 * 8 * 4);
          gl.readPixels(Math.floor(w / 2) - 4, Math.floor(h / 2) - 4, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let r = 0, g = 0, b = 0;
          for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
          const n = px.length / 4;
          return { mean: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], size: [w, h] };
        } catch (e) {
          return { err: String((e && e.message) || e) };
        }
      },
      // CDP/manual diagnosis only: tint the video screen a solid color
      // (pass null/undefined to restore the video texture). Proves whether
      // the mesh+camera path renders when the picture stays black.
      setScreenDebugColor(hex) {
        if (!screenMesh || !screenMesh.material) return false;
        try {
          if (hex === null || hex === undefined) {
            screenMesh.material.color.set(0xffffff);
            // Restore whichever map the current path uses (v8.13 direct or
            // canvas proxy) instead of assuming the canvas texture.
            screenMesh.material.map = screenMapBeforeDebug || videoTexture;
            screenMapBeforeDebug = null;
          } else {
            if (!screenMapBeforeDebug) screenMapBeforeDebug = screenMesh.material.map;
            screenMesh.material.map = null;
            screenMesh.material.color.set(hex);
          }
          screenMesh.material.needsUpdate = true;
          return true;
        } catch (e) {
          return false;
        }
      },
      // Scene-graph introspection for the Node harness and live CDP probes:
      // reports real THREE renderer stats (not the telemetry counters).
      getSceneInfo() {
        const info = { hasRenderer: !!renderer, hasScene: !!scene, hasCamera: !!camera };
        try {
          if (renderer && THREE) {
            const sz = new THREE.Vector2();
                            try { renderer.getSize(sz); } catch (e) {}
            info.rendererSize = [sz.x, sz.y];
            try { info.pixelRatio = renderer.getPixelRatio ? renderer.getPixelRatio() : 1; } catch (e) {}
            info.drawCalls = renderer.info && renderer.info.render ? { ...renderer.info.render } : null;
          }
          if (camera) {
            info.camera = {
              pos: [camera.position.x, camera.position.y, camera.position.z],
              rot: [camera.rotation.x, camera.rotation.y, camera.rotation.z],
              fov: camera.fov,
              aspect: camera.aspect,
            };
          }
          if (scene) info.sceneChildren = scene.children.length;
          if (screenMesh) {
            info.screen = {
              visible: screenMesh.visible,
              pos: [screenMesh.position.x, screenMesh.position.y, screenMesh.position.z],
              verts: screenMesh.geometry && screenMesh.geometry.attributes && screenMesh.geometry.attributes.position
                ? screenMesh.geometry.attributes.position.count
                : -1,
              hasMap: !!(screenMesh.material && screenMesh.material.map),
              mapSize: (screenMesh.material && screenMesh.material.map && screenMesh.material.map.image)
                ? [screenMesh.material.map.image.width, screenMesh.material.map.image.height]
                : null,
            };
          }
          // UI paint-order ladder (legacy painter's order): screen 0, overlay
          // 2, dock 3, comments/guide 4 — all UI quads depthTest:false so they
          // always paint over the video screen.
          const paintFlags = (mesh) => mesh ? {
            visible: mesh.visible,
            renderOrder: mesh.renderOrder,
            depthTest: !!(mesh.material && mesh.material.depthTest),
          } : null;
          if (screenMesh) info.screen.paint = paintFlags(screenMesh);
          if (controlsMesh) info.controls = paintFlags(controlsMesh);
          if (commentsMesh) info.comments = paintFlags(commentsMesh);
          if (overlayMesh) {
            info.overlay = paintFlags(overlayMesh);
            info.overlay.popups = overlayRegions.length;
          }
          if (guideMesh) info.guide = paintFlags(guideMesh);
          info.screenState = {
            pos: { ...screenPos },
            scale: screenScale,
            distance: screenDistance,
            locked: lockToViewer,
          };
          if (earthGroup) info.earth = { visible: earthGroup.visible };
          if (controlsMesh) {
            info.dock = {
              pos: [controlsMesh.position.x, controlsMesh.position.y, controlsMesh.position.z],
              rot: [controlsMesh.rotation.x, controlsMesh.rotation.y, controlsMesh.rotation.z],
            };
          }
          info.glow = {
            visible: !!(ambilightMesh && ambilightMesh.visible),
            color: glowColor.map((c) => Math.round(c * 1000) / 1000),
          };
          info.laser = { visible: !!(laserLine && laserLine.visible) };
          // Pointer diagnostics: beam endpoints, always-on-top flags, and
          // the reticle pose (proves the pullback + billboard live).
          try {
            if (laserLine) {
              info.pointer = {
                renderOrder: laserLine.renderOrder,
                depthTest: !!(laserLine.material && laserLine.material.depthTest),
                beam: laserPositions ? {
                  start: [laserPositions[0], laserPositions[1], laserPositions[2]],
                  end: [laserPositions[3], laserPositions[4], laserPositions[5]],
                } : null,
              };
            }
            if (reticleMesh) {
              info.reticle = {
                visible: reticleMesh.visible,
                renderOrder: reticleMesh.renderOrder,
                depthTest: !!(reticleMesh.material && reticleMesh.material.depthTest),
                pos: [reticleMesh.position.x, reticleMesh.position.y, reticleMesh.position.z],
                scale: [reticleMesh.scale.x, reticleMesh.scale.y],
              };
            }
          } catch (e) {}
          info.xr = {
            presenting: !!xrSession,
            previewRunning: !!previewRunning,
            compat: xrCompatStatus,
            hasResume: !!previewResumeOpts,
          };
          info.earthMap = {
            hasTexture: !!(earthMesh && earthMesh.material && earthMesh.material.map),
            base: earthBaseSource,
            baseTried: !!earthBaseTried,
            mapOffset: earthMapTexture ? earthMapTexture.offset.x : null,
            pinCount: earthPinsGroup ? earthPinsGroup.children.length : 0,
            hasLabel: !!earthLabelMesh,
            // Z1 counter-scale probes: world size must stay constant across
            // zoom (pinScale · groupScale invariant), pins hug the surface.
            groupScale: earthGroup && earthGroup.scale ? earthGroup.scale.x : 1,
            pinScale: (earthPinsGroup && earthPinsGroup.children[0]) ? earthPinsGroup.children[0].scale.x : null,
            pinRadius: (earthPinsGroup && earthPinsGroup.children[0]) ? Math.sqrt(
              earthPinsGroup.children[0].position.x ** 2 +
              earthPinsGroup.children[0].position.y ** 2 +
              earthPinsGroup.children[0].position.z ** 2
            ) : null,
            zoom: earthZoom,
            labelWorldPos: earthLabelMesh ? {
              x: earthLabelMesh.position.x, y: earthLabelMesh.position.y, z: earthLabelMesh.position.z,
            } : null,
            heatSpriteCount: earthHeatSprites.length,
            heatSpriteScale: earthHeatSprites.length > 0 ? earthHeatSprites[0].mesh.scale.x : null,
            heatSpriteVisible: !!(earthHeatGroup && earthHeatGroup.visible),
            heatSpriteOpacity: earthHeatSprites.length > 0 ? earthHeatSprites[0].material.opacity : null,
          };
          // Mean brightness of the 2048^2 proxy canvas (16x16 downsample).
          // Distinguishes "proxy never painted" from "texture/mesh path broken".
          try {
            if (vrProxyCanvas && typeof document !== 'undefined' && document.createElement) {
              const probe = document.createElement('canvas');
              probe.width = 16;
              probe.height = 16;
              const pctx = probe.getContext('2d');
              if (pctx && vrProxyCtx) {
                pctx.drawImage(vrProxyCanvas, 0, 0, 16, 16);
                const d = pctx.getImageData(0, 0, 16, 16).data;
                let sum = 0;
                for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
                info.proxyMean = Math.round(sum / ((d.length / 4) * 3));
              }
            }
          } catch (e) {
            info.proxyMean = 'err:' + String((e && e.message) || e);
          }
        } catch (e) {
          info.error = String((e && e.message) || e);
        }
        return info;
      },
      getControlButton(action) {
        const ui = getUICanvas();
        const btns = ui ? ui.CTRL_BUTTONS : [];
        const button = btns.find((item) => item.action === action);
        return button ? { ...button } : null;
      },
      getVisibleControlActions() {
        const ui = getUICanvas();
        const btns = ui ? ui.CTRL_BUTTONS : [];
        const source = getVisualSource();
        let itemState = {};
        if (callbacks.getCurrentItemState) {
          try { itemState = callbacks.getCurrentItemState() || {}; } catch (e) {}
        }
        return btns
          .filter((button) => ui.isControlVisible(button.action, source, itemState, isPackExperience(), sceneMode))
          .map((button) => button.action);
      },
      getVisualSourceState() {
        const source = getVisualSource();
        return {
          kind: source.kind,
          ready: source.ready,
          paused: source.paused,
          muted: source.muted,
          currentTime: source.currentTime,
          duration: source.duration,
          version: source.version,
        };
      },
      visualPointFromHit,
      executeControl(action) {
        const ui = getUICanvas();
        const btns = ui ? ui.CTRL_BUTTONS : [];
        const index = btns.findIndex((b) => b.action === action);
        if (index >= 0) executeControlButton(index);
      },
      raySphereHit,
      hitTestEarth,
      setLocationActivity,
      setEarthHoveredIndex,
      selectEarthLocation,
      beginEarthDrag,
      updateEarthDrag,
      endEarthDrag,
      advanceEarthSpin,
      // Earth zoom map seams (Z1).
      clampEarthZoom,
      earthTileZoom,
      unitToLatLon,
      rotateEarthDir,
      solveEarthFocusRotation,
      earthFacingLatLon,
      applyEarthZoom,
      advanceEarthZoom,
      zoomEarthTo,
      adjustEarthZoom,
      resetEarthZoom,
      resetEarthZoomImmediate,
      handleEarthTap,
      // Earth tile layer seams (Z2).
      earthTileXY,
      earthTileKey,
      earthMercatorYFrac,
      earthMercatorYToLat,
      earthTileVisibleSet,
      earthTileFade,
      buildEarthTileGeometry,
      updateEarthTiles,
      pumpEarthTileQueue,
      setEarthTileImageLoader(fn) {
        earthTileImageLoader = (typeof fn === 'function') ? fn : null;
      },
      // Z3 seams: band-tracked activity fetch + heat overlay.
      earthGeohashCellBounds,
      earthGeohashCellAngularRadius,
      earthVisibleBbox,
      earthActivityRequestZoom,
      earthActivityUrl,
      scheduleEarthActivityRefetch,
      loadEarthActivity,
      earthActivityFetchState() {
        return { zoom: earthActivityZoom, pending: !!earthActivityRefetchTimer };
      },
      rebuildEarthHeatSprites,
      updateEarthHeatSprites,
      earthHeatStats() {
        return {
          count: earthHeatSprites.length,
          visible: !!(earthHeatGroup && earthHeatGroup.visible),
          opacity: earthHeatSprites.length > 0 ? earthHeatSprites[0].material.opacity : null,
          scale: earthHeatSprites.length > 0 ? earthHeatSprites[0].mesh.scale.x : null,
        };
      },
      earthTileStats() {
        return {
          available: !!earthTileAvailable,
          fade: earthTileFade(),
          band: earthTileZ,
          tracked: earthTiles.size,
          queued: earthTileQueue.length,
          inFlight: earthTileInFlight,
          failures: earthTileFailures,
          ready: Array.from(earthTiles.values()).filter((e) => e.state === 'ready').length,
          probeAt: earthTileProbeAt,
          loadRatio: earthTileLoadRatio,
        };
      },
      getEarthLabelDetail() { return earthLabelDetail; },
      getEarthLabelTitle() { return earthLabelTitle; },
      earthZoomPercent,
      earthHoloTileLuminance,
      earthHoloTileClass,
      earthHoloTilePixel,
      styleEarthTilePixels,
      styleEarthTileImage,
      earthTileStyleMode,
      earthTilePrefetchStats() {
        let ready = 0;
        try {
          for (const entry of earthTilePrefetch.values()) {
            if (entry && entry.state === 'ready' && entry.img) ready += 1;
          }
        } catch (e) {}
        return { size: earthTilePrefetch.size, ready };
      },
      earthZoomConstants() {
        return {
          max: EARTH_ZOOM_MAX,
          city: EARTH_ZOOM_CITY,
          step: EARTH_ZOOM_STEP,
          animMs: EARTH_ZOOM_ANIM_MS,
          surfaceDist: EARTH_ZOOM_SURFACE_DIST,
        };
      },
      setEarthZoom(z, focus) {
        earthZoom = clampEarthZoom(z);
        earthZoomTarget = earthZoom;
        earthZoomAnim = null;
        earthFocus = focus ? { lat: Number(focus.lat) || 0, lon: Number(focus.lon) || 0 } : null;
        if (!earthFocus) earthZoomAnchor = null;
        else if (!earthZoomAnchor) earthZoomAnchor = { x: 0, y: 1.3, z: -1.15 };
        applyEarthZoom();
        return earthZoom;
      },
      cleanup,
      loadEarthPreviewNow(index) {
        setEarthHoveredIndex(index);
        earthPreviewGeneration += 1;
        return loadEarthPreviewForIndex(index, earthPreviewGeneration);
      },
      setEarthPose(yaw, pitch, center) {
        earthYaw = Number(yaw) || 0;
        earthPitch = Math.max(-1.2, Math.min(1.2, Number(pitch) || 0));
        if (center) earthCenter = { x: center.x, y: center.y, z: center.z };
        earthLastFrameTime = -1;
        applyEarthRotation();
      },
      getEarthState,
    },
  };
})();
