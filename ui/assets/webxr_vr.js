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
  const EARTH_MAP_W = 4096;
  const EARTH_MAP_H = 2048;
  // Canvas-space constants below were tuned at 2048 px wide; scale them so the
  // 4K map keeps the same on-globe line weights and halo sizes.
  const EARTH_MAP_SCALE = EARTH_MAP_W / 2048;
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
    '/assets/earth-natural-4096x2048.jpg',
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
    topdown: true,   // zoomed view faces the focus head-on (?topdown=0 → legacy tilted table)
    horizonhud: false, // bezel ring + compass dial at street zoom (?horizonhud=1 restores)
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
      if (has('topdown', '1')) debugFlags.topdown = true;
      if (has('topdown', '0')) debugFlags.topdown = false;
      if (has('horizonhud', '1')) debugFlags.horizonhud = true;
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
  // v2 pose is quaternion-first. yaw/pitch remain as compatibility telemetry
  // and for the globe-scale legacy drag path.
  let earthQuat = { x: 0, y: 0, z: 0, w: 1 };
  let earthNorthUp = false;
  // Zoomed top-down pose is owned by earthQuat itself (drag, stick, tracking
  // all turn it by minimal rotations). Yaw/pitch cannot express it: facing a
  // high-latitude focus with yaw+pitch alone forces north-up, which spins the
  // whole map around the pole as the focus passes near it. earthRoll carries
  // the leftover twist when the pose is handed back to yaw/pitch (zoom out,
  // tap-zoom) and eases to zero there.
  let earthPoseQuat = false;
  let earthRoll = 0;
  // Step 6.2 gaze accompaniment: soft-spring yaw the street preview panel
  // follows when the head turns, so the reel preview stays in the binocular
  // field without rigid HUD head-locking (critically-damped spring, ±15°).
  let earthPreviewYawOffset = 0;
  let earthPreviewYawVelocity = 0;
  let earthPreviewYawAnchor = null;
  let earthPreviewYawLastTime = -1;
  // Head forward azimuth for the preview accompaniment spring. Desktop
  // preview cameras expose getWorldDirection; the mocked camera in node
  // tests may not — fall back to facing -Z (yaw 0) so math stays testable.
  function headYawAngle() {
    try {
      if (camera && camera.getWorldDirection) {
        const dir = camera.getWorldDirection(new THREE.Vector3());
        if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.z)) {
          return Math.atan2(dir.x, -dir.z);
        }
      }
    } catch (e) {}
    return 0;
  }
  // One critically-damped spring step (stiffness 90, damping 2*sqrt(90)).
  // Pure function of (headYaw, time) + module spring state; clamped to
  // ±15° (Math.PI/12) so the panel stays surface-anchored. Returns the new
  // offset. reducedMotion freezes the panel (offset 0, velocity 0).
  function stepEarthPreviewYaw(headYaw, time) {
    try {
      const now = Number(time);
      const last = Number(earthPreviewYawLastTime);
      const dt = (Number.isFinite(now) && Number.isFinite(last) && last >= 0)
        ? Math.max(1 / 240, Math.min(0.1, (now - last) / 1000))
        : 1 / 60;
      earthPreviewYawLastTime = Number.isFinite(now) ? now : last;
      const yaw = Number(headYaw);
      if (!Number.isFinite(yaw)) return earthPreviewYawOffset;
      if (earthPreviewYawAnchor === null || !Number.isFinite(earthPreviewYawAnchor)) {
        earthPreviewYawAnchor = yaw;
      }
      let err = yaw - earthPreviewYawAnchor - earthPreviewYawOffset;
      err = ((err + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (reducedMotion) {
        earthPreviewYawOffset = 0;
        earthPreviewYawVelocity = 0;
        return 0;
      }
      const stiffness = 90, damping = 2 * Math.sqrt(90);
      earthPreviewYawVelocity += ((stiffness * err) - damping * earthPreviewYawVelocity) * dt;
      earthPreviewYawOffset = Math.max(-Math.PI / 12, Math.min(Math.PI / 12,
        earthPreviewYawOffset + earthPreviewYawVelocity * dt));
      return earthPreviewYawOffset;
    } catch (e) { return earthPreviewYawOffset; }
  }
  function resetEarthPreviewYaw(anchor) {
    earthPreviewYawOffset = 0;
    earthPreviewYawVelocity = 0;
    earthPreviewYawLastTime = -1;
    earthPreviewYawAnchor = (anchor !== undefined) ? anchor : null;
  }
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
  let earthPreviewHoverRegion = ''; // location-card button under the pointer
  let earthLabelHoverRegion = '';   // WORLD › location panel button under the pointer
  let earthRecentHover = { index: -1, at: -1e9 }; // last zone the ray was on (panel reach grace)
  // WORLD › location panel: 640×148 logical (2× canvas), 0.86 m wide. The
  // bottom row holds the RESET ROTATION button.
  const EARTH_LABEL_LOGICAL_W = 640;
  const EARTH_LABEL_LOGICAL_H = 148;
  const EARTH_LABEL_HALF_W = 0.43;
  const EARTH_LABEL_HALF_H = 0.86 * EARTH_LABEL_LOGICAL_H / EARTH_LABEL_LOGICAL_W / 2;
  const EARTH_LABEL_RESET_RECT = { x: 444, y: 112, w: 176, h: 28 };
  const EARTH_PANEL_HOVER_GRACE_MS = 1200;
  let earthFaceAnim = null;         // RESET ROTATION slerp { t0, dur, fromQ, toQ, fromN, toN, lat, lon }
  let earthPreviewStatus = 'idle';
  let earthPreviewItems = [];
  let earthPreviewIndex = 0;
  let earthPreviewVideo = null;
  let activeRayInputSource = null; // XRInputSource driving the laser (haptics)
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
  let earthZoomFrameTime = null;
  let _earthWarpReleased = true; // zoom-out warp-frame release latch (per crossing)
  let earthTileGeometryKey = '';
  let earthLabelDetail = '';
  let earthLabelTitle = '';
  // Zoomed Earth view (default; ?topdown=0 restores the legacy tilted table).
  // The instant the map is zoomed past the globe, the focused point's normal is
  // held on the line to the viewer's head (zero obliquity, Google-Maps style)
  // and a drag turns the WORLD under that fixed viewing spot — the same
  // grab-the-planet feel as the full-globe view — instead of sliding the
  // sphere around the room. The globe centre stays put; only the pose changes.
  // Bearing (north-up) is NOT corrected here: yaw+pitch facing leaves some map
  // rotation; the dock NORTH UP button supplies the roll DOF.
  const EARTH_TOPDOWN_MIN_ZOOM = 1.001; // any zoom past the full globe
  const EARTH_TOPDOWN_MAX_PITCH = 2.9; // relaxed clamp so polar foci still face exactly
  let earthTopdownGrab = null; // { geo, point } the pressed spot while a zoomed drag turns the world
  let earthGrabGeo = null;
  let earthGrabAnchor = null;
  let earthPointerZoom = null;
  function earthTopdownActive() {
    return !!debugFlags.topdown && sceneMode === 'earth' &&
      !!earthFocus && earthZoomTarget >= EARTH_TOPDOWN_MIN_ZOOM;
  }
  function earthTopdownWillBeActive(toZoom) {
    return !!debugFlags.topdown && sceneMode === 'earth' &&
      clampEarthZoom(toZoom) >= EARTH_TOPDOWN_MIN_ZOOM;
  }
  // Live view direction the focus normal must match: surface→head. Null
  // when there is nothing to align (no focus/anchor yet).
  function earthTopdownViewDir() {
    if (!earthFocus || !earthZoomAnchor) return null;
    const head = getHeadPosition();
    const dx = head.x - earthZoomAnchor.x;
    const dy = head.y - earthZoomAnchor.y;
    const dz = head.z - earthZoomAnchor.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    return { x: dx / len, y: dy / len, z: dz / len };
  }
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
  let earthTileLabelsAvailable = true; // false → skip requesting labels layer (e.g. 404/disabled)
  let earthTileFailures = 0;
  let earthTileBaseFade = -1;  // last opacity pushed to the base globe material
  let earthTileClock = -1;     // high-water frame time (probe scheduling)
  let earthTileProbeAt = -1;   // degraded-mode re-arm deadline (frame clock)
  let earthTilePausedUntil = -1; // partial-outage fetch pause deadline (frame clock)
  let earthTileLoadRatio = 1;  // ready / (ready + pending); 1 = nothing waited on
  let earthTilePrefetch = new Map(); // 'z/x/y' → { z, x, y, state: 'loading'|'ready', img } next-band warm cache
  let earthTileGeneration = 0;
  let earthAtmosphereMesh = null;
  let earthTileLodLevels = [];

  // Step 6.3: street-table horizon bezel + interactive north compass badge.
  // A lightweight ring around the active tile ring gives the tangent table a
  // finished model edge; clicking/lasering the compass badge swings the map
  // back to true north via the existing resetEarthNorthUp pose (≤0.5°).
  let earthBezelMesh = null;
  let earthCompassMesh = null;
  let earthCompassCanvas = null;
  let earthCompassCtx = null;
  let earthCompassTexture = null;
  function earthBezelRadius() {
    try {
      const S = Math.max(1, earthZoom);
      if (!(S > 1.02) || !earthFocus) return 0;
      // Frames the comfortable tabletop patch (≈0.8 m), not the multi-metre planet.
      return Math.min(0.8, earthVisibleRadius(S) * 0.24);
    } catch (e) { return 0; }
  }
  function earthBezelVisible() {
    return !!(sceneMode === 'earth' && earthFocus && Math.max(1, earthZoom) >= 16 && earthBezelMesh);
  }
  // Map bearing as the viewer sees it: the clockwise angle (rad) from screen-up
  // to geographic north, measured in the plane perpendicular to the line of
  // sight (head → focus anchor). 0 means the map is north-up on screen — which is
  // exactly what NORTH UP restores, whatever the table tilt does to the world-
  // space north vector. North at the focus is unchanged by the radial warp, so
  // the focus tangent rotated by the live pose is exact.
  function earthViewBasis() {
    const head = getHeadPosition();
    const anchor = earthZoomAnchor || earthLiveCenter();
    let fx = anchor.x - head.x, fy = anchor.y - head.y, fz = anchor.z - head.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let rx = -fz, rz = fx;
    const rl = Math.hypot(rx, rz);
    if (rl < 1e-6) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
    // up = right × forward
    const ux = 0 * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - 0 * fx;
    return { f: { x: fx, y: fy, z: fz }, r: { x: rx, y: 0, z: rz }, u: { x: ux, y: uy, z: uz } };
  }
  function earthMapBearing() {
    try {
      if (!earthFocus) return 0;
      const b = earthGeographicBasis(earthFocus.lat, earthFocus.lon);
      const n = qRotate(earthQuat, b.north);
      const v = earthViewBasis();
      const nr = n.x * v.r.x + n.y * v.r.y + n.z * v.r.z;
      const nu = n.x * v.u.x + n.y * v.u.y + n.z * v.u.z;
      if (Math.hypot(nr, nu) < 1e-6) return 0;
      return Math.atan2(nr, nu);
    } catch (e) { return 0; }
  }
  const EARTH_BEZEL_INNER = 0.86, EARTH_BEZEL_OUTER = 1.08;
  // Surveyor's bezel: static 1024² texture (ticks every 5°, majors every 15°,
  // N/E/S/W lettering, soft inner glow). Drawn once; orientation is applied by
  // rotating the mesh to true north each frame.
  function drawEarthBezelTexture(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const C = 512, rOuter = 512, rIn = rOuter * EARTH_BEZEL_INNER / EARTH_BEZEL_OUTER;
    ctx.clearRect(0, 0, 1024, 1024);
    if (ctx.createRadialGradient) {
      const g = ctx.createRadialGradient(C, C, rIn - 6, C, C, rOuter);
      g.addColorStop(0, 'rgba(57,215,255,0.00)');
      g.addColorStop(0.18, 'rgba(57,215,255,0.20)');
      g.addColorStop(1, 'rgba(10,40,70,0.0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(C, C, rOuter, 0, Math.PI * 2); ctx.arc(C, C, rIn - 6, 0, Math.PI * 2, true); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(120,235,255,0.95)';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(C, C, rIn, 0, Math.PI * 2); ctx.stroke();
    for (let deg = 0; deg < 360; deg += 5) {
      const major = deg % 15 === 0, card = deg % 90 === 0;
      const len = card ? 56 : (major ? 34 : 18);
      const a = (deg - 90) * Math.PI / 180;
      ctx.strokeStyle = card ? '#FFC857' : (major ? 'rgba(190,245,255,0.95)' : 'rgba(120,205,235,0.65)');
      ctx.lineWidth = card ? 7 : (major ? 4 : 2.5);
      ctx.beginPath();
      ctx.moveTo(C + Math.cos(a) * (rIn + 6), C + Math.sin(a) * (rIn + 6));
      ctx.lineTo(C + Math.cos(a) * (rIn + 6 + len), C + Math.sin(a) * (rIn + 6 + len));
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const letters = [['N', 0, '#FFC857', 54], ['E', 90, '#DFF8FF', 40], ['S', 180, '#DFF8FF', 40], ['W', 270, '#DFF8FF', 40]];
    for (const [ch, deg, color, size] of letters) {
      const a = (deg - 90) * Math.PI / 180;
      const r = rIn + 102;
      ctx.fillStyle = color;
      ctx.font = '800 ' + size + 'px Archivo, sans-serif';
      ctx.fillText(ch, C + Math.cos(a) * r, C + Math.sin(a) * r);
    }
    return true;
  }
  function ensureEarthBezel() {
    if (!THREE || !scene || !earthGroup || !debugFlags.horizonhud) return;
    try {
      if (!earthBezelMesh && typeof document !== 'undefined') {
        const bezelCanvas = document.createElement('canvas');
        bezelCanvas.width = 1024;
        bezelCanvas.height = 1024;
        let bezelTexture = null;
        try {
          if (drawEarthBezelTexture(bezelCanvas)) {
            bezelTexture = new THREE.CanvasTexture(bezelCanvas);
            try { if (THREE.SRGBColorSpace !== undefined) bezelTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
            applyLinearSampling(bezelTexture);
          }
        } catch (e) { bezelTexture = null; }
        const geo = new THREE.RingGeometry(EARTH_BEZEL_INNER, EARTH_BEZEL_OUTER, 128);
        const mat = new THREE.MeshBasicMaterial({
          color: bezelTexture ? 0xffffff : 0x39d7ff, map: bezelTexture, transparent: true, opacity: 0.9,
          side: THREE.DoubleSide, depthWrite: false,
        });
        earthBezelMesh = new THREE.Mesh(geo, mat);
        earthBezelMesh.renderOrder = 5;
        earthBezelMesh.frustumCulled = false;
        earthBezelMesh.visible = false;
        scene.add(earthBezelMesh);
      }
      if (!earthCompassCanvas && typeof document !== 'undefined') {
        earthCompassCanvas = document.createElement('canvas');
        earthCompassCanvas.width = 256;
        earthCompassCanvas.height = 256;
        earthCompassCtx = earthCompassCanvas.getContext('2d');
      }
      if (!earthCompassTexture && earthCompassCanvas && THREE) {
        earthCompassTexture = new THREE.CanvasTexture(earthCompassCanvas);
        try { if (THREE.SRGBColorSpace !== undefined) earthCompassTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
      }
      if (!earthCompassMesh && earthCompassTexture) {
        const mat = new THREE.MeshBasicMaterial({
          map: earthCompassTexture, transparent: true,
          depthWrite: false, depthTest: false, side: THREE.DoubleSide,
        });
        earthCompassMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), mat);
        earthCompassMesh.renderOrder = 101;
        earthCompassMesh.frustumCulled = false;
        earthCompassMesh.visible = false;
        earthCompassMesh.userData.compassBadge = true;
        scene.add(earthCompassMesh);
      }
    } catch (e) {}
  }
  // Live compass dial: the card rotates so N always points at true north
  // relative to the viewer; ring glows cyan while the map is locked north-up.
  let earthCompassKey = '';
  function refreshEarthCompassCanvas(relBearing) {
    if (!earthCompassCtx || !earthCompassCanvas) return;
    try {
      const rel = Number.isFinite(relBearing) ? relBearing : 0;
      const deg = Math.round(rel * 180 / Math.PI);
      const aligned = Math.abs(((deg % 360) + 540) % 360 - 180) < 3;
      const key = deg + '|' + (earthNorthUp ? 1 : 0) + '|' + (aligned ? 1 : 0);
      if (key === earthCompassKey) return;
      earthCompassKey = key;
      const ctx = earthCompassCtx;
      ctx.setTransform && ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, 128, 128);
      const accent = (earthNorthUp || aligned) ? '#39D7FF' : '#FFB11F';
      if (ctx.createRadialGradient) {
        const g = ctx.createRadialGradient(64, 56, 6, 64, 64, 62);
        g.addColorStop(0, 'rgba(22,44,72,0.96)');
        g.addColorStop(1, 'rgba(5,10,22,0.97)');
        ctx.fillStyle = g;
      } else ctx.fillStyle = 'rgba(7,12,24,0.95)';
      ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.save();
      ctx.translate(64, 64);
      ctx.rotate(rel);
      for (let d = 0; d < 360; d += 15) {
        const a = d * Math.PI / 180;
        const long = d % 90 === 0;
        ctx.strokeStyle = long ? '#DFF8FF' : 'rgba(140,190,220,0.6)';
        ctx.lineWidth = long ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a) * 52, -Math.cos(a) * 52);
        ctx.lineTo(Math.sin(a) * (long ? 44 : 47), -Math.cos(a) * (long ? 44 : 47));
        ctx.stroke();
      }
      // North needle (amber) + south tail
      ctx.fillStyle = '#FFB11F';
      ctx.beginPath(); ctx.moveTo(0, -40); ctx.lineTo(8, 0); ctx.lineTo(-8, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(190,215,235,0.55)';
      ctx.beginPath(); ctx.moveTo(0, 36); ctx.lineTo(7, 0); ctx.lineTo(-7, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#F7FAFC';
      ctx.font = '800 15px Archivo, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', 0, -30 + 0);
      ctx.restore();
      ctx.fillStyle = '#0B1626';
      ctx.beginPath(); ctx.arc(64, 64, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke();
      // Fixed lubber marker (view-up) at the top edge
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.moveTo(64, 2); ctx.lineTo(71, 12); ctx.lineTo(57, 12); ctx.closePath(); ctx.fill();
      if (earthCompassTexture) earthCompassTexture.needsUpdate = true;
    } catch (e) {}
  }
  function updateEarthBezel() {
    if (!earthBezelMesh || !earthCompassMesh) return;
    try {
      const head = getHeadPosition();
      const center = earthLiveCenter();
      const radius = earthBezelRadius();
      const show = !!(debugFlags.horizonhud && sceneMode === 'earth' && earthFocus && Math.max(1, earthZoom) >= 16 && radius > 0);
      earthBezelMesh.visible = show;
      earthCompassMesh.visible = show;
      if (!show) return;
      const rel = earthMapBearing();
      // Bezel lies IN the map's tangent plane at the focus (a convex planet falls
      // away beneath it, so it reads as a floating surveyor's plate): local
      // +X = east, +Y = true north (texture top), +Z = outward normal.
      const anchor = earthZoomAnchor || { x: center.x, y: center.y, z: center.z };
      const basis = earthGeographicBasis(earthFocus.lat, earthFocus.lon);
      const nW = qRotate(earthQuat, basis.normal);
      const northW = qRotate(earthQuat, basis.north);
      const eastW = vNorm(vCross(northW, nW));
      const lift = 0.012;
      earthBezelMesh.position.set(anchor.x + nW.x * lift, anchor.y + nW.y * lift, anchor.z + nW.z * lift);
      earthBezelMesh.scale.setScalar(Math.max(0.05, radius));
      try {
        const bq = qFromBasis(eastW, northW, nW);
        earthBezelMesh.quaternion.set(bq.x, bq.y, bq.z, bq.w);
      } catch (e2) { earthBezelMesh.lookAt(anchor.x + nW.x, anchor.y + nW.y, anchor.z + nW.z); }
      if (earthBezelMesh.material) {
        earthBezelMesh.material.opacity = reducedMotion ? 0.9 : 0.8 + 0.1 * Math.sin(Date.now() * 0.002);
      }
      // Compass dial rides beside the breadcrumb (camera-plane left of it), so
      // it is always on-screen, never overlaps the label, and stays pointable.
      refreshEarthCompassCanvas(rel);
      const lbl = earthLabelMesh && earthLabelMesh.visible ? earthLabelMesh : null;
      const ls = lbl ? (lbl.scale.x || 1) : 1;
      const gazeFwd = earthHeadForward(), fovHalf = earthViewHalfFov();
      if (lbl) {
        let fx = head.x - lbl.position.x, fy = head.y - lbl.position.y, fz = head.z - lbl.position.z;
        const fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl; fz /= fl;
        let rx = fz, rz = -fx;
        const rl = Math.hypot(rx, rz) || 1;
        rx /= rl; rz /= rl;
        const off = EARTH_LABEL_HALF_W * ls + 0.14 * ls;
        // Candidate slots beside the breadcrumb, in preference order: left,
        // right, above-left, below-left. Take the first that is fully in view
        // and clear of the reel card; else fall back to the least-bad (left).
        const upx = 0, upy = 1;
        const slots = [
          { x: -rx * off, y: 0, z: -rz * off },
          { x: rx * off, y: 0, z: rz * off },
          { x: -rx * 0.33 * ls, y: upy * (EARTH_LABEL_HALF_H + 0.13) * ls, z: -rz * 0.33 * ls },
          { x: -rx * 0.33 * ls, y: -upy * (EARTH_LABEL_HALF_H + 0.13) * ls, z: -rz * 0.33 * ls },
        ];
        let chosen = null;
        for (const sl of slots) {
          const cand = { x: lbl.position.x + sl.x, y: lbl.position.y + sl.y, z: lbl.position.z + sl.z };
          const cc = earthGazeClamp(cand, head, gazeFwd, 0.1 * ls, 0.1 * ls, fovHalf);
          if (cc.clamped) continue;
          if (earthPreviewMesh && earthRectOverlapsPanel(cand, 0.1 * ls, 0.1 * ls, earthPreviewMesh, 0.25, 0.35, gazeFwd, 0.02)) continue;
          let blocked = false;
          for (const k of earthHudKeeps) {
            const ca = earthViewAngles(cand, head, gazeFwd), ka = earthViewAngles(k, head, gazeFwd);
            const rA = Math.atan(0.1 * ls / ca.d) + Math.atan(k.r / ka.d);
            if (Math.abs(ca.yaw - ka.yaw) < rA && Math.abs(ca.pitch - ka.pitch) < rA) { blocked = true; break; }
          }
          if (blocked) continue;
          chosen = cand;
          break;
        }
        if (!chosen) chosen = { x: lbl.position.x + slots[0].x, y: lbl.position.y, z: lbl.position.z + slots[0].z };
        earthCompassMesh.position.set(chosen.x, chosen.y, chosen.z);
      } else {
        earthCompassMesh.position.set(anchor.x, anchor.y + 0.16, anchor.z - radius - 0.1);
      }
      earthCompassMesh.scale.setScalar(ls);
      {
        const cw = earthGazeClamp(earthCompassMesh.position, head, gazeFwd, 0.1 * ls, 0.1 * ls, fovHalf);
        if (cw.clamped) earthCompassMesh.position.set(cw.x, cw.y, cw.z);
        // Never sit on the breadcrumb: slide down-left out of it if they meet.
        if (lbl) earthSeparatePanel(earthCompassMesh, 0.1, 0.1, lbl, EARTH_LABEL_HALF_W, EARTH_LABEL_HALF_H, gazeFwd, head, fovHalf, 'left');
      }
      earthCompassMesh.lookAt(head.x, head.y, head.z);
      earthCompassMesh.userData.worldRadius = 0.14 * ls;
    } catch (e) {}
  }

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
  let earthLegacyGeometry = null;
  let earthAdaptiveGeometry = null;
  let earthAdaptiveTemplate = null;
  let earthAdaptiveKey = '';
  let earthPinsGroup = null;
  let earthPreviewMesh = null;
  let earthMapCanvas = null;
  let earthMapCtx = null;
  let earthMapTexture = null;
  let earthMapDirty = true;
  let earthBaseCanvas = null;
  let earthBaseCtx = null;
  let earthBaseBuildToken = 0;
  let earthHeatPaintedAt = -1e9;
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
    // Street-zoom attenuation: past the city band (S > 256, tileZ ≥ 12)
    // the fixed heat radius would swallow the whole viewport, so hover
    // and tap always match the nearest city and empty-globe zoom dies.
    // Shrinking with zoom keeps zones tappable (~20 km at z17) while the
    // visible patch stays selectable. Globe/city bands unaffected.
    const attenuate = Math.max(1, Math.max(1, earthZoom) / 256);
    if (location && location.kind === 'cluster' && typeof location.geohash === 'string') {
      return Math.max(base, earthGeohashCellAngularRadius(location.geohash)) / attenuate;
    }
    return base / attenuate;
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
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    return (((r + g) * 0.5 - b) > -10 || (r + g + b) > 720 ||
      (mn - 185) - 0.8 * ((mx - mn) - 25) > 0) ? 1 : 0;
  }

  // Thermal-bloom heat style. One continuous ramp drives everything that shows
  // heat (canvas bloom, sprite tint, pins): cool mint → amber → hot
  // coral, with a white-hot core on the hottest zones. A soft gaussian-like
  // falloff replaces the old concentric "radar" rings; rings now carry state
  // only (one hairline contour at rest, a dashed halo on hover, a solid white
  // lock on selection).
  const EARTH_HEAT_LO = [64, 230, 170]; // mint: reads on both the cyan globe and navy tiles
  const EARTH_HEAT_MID = [255, 200, 87];
  const EARTH_HEAT_HI = [255, 77, 109];
  function heatMix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function earthHeatRamp(heat) {
    const h = Math.max(0, Math.min(1, Number(heat) || 0));
    const base = h < 0.5 ? heatMix(EARTH_HEAT_LO, EARTH_HEAT_MID, h / 0.5) : heatMix(EARTH_HEAT_MID, EARTH_HEAT_HI, (h - 0.5) / 0.5);
    return {
      base,
      core: heatMix(base, [255, 255, 255], 0.2 + 0.6 * h * h),
      edge: heatMix(EARTH_HEAT_LO, base, 0.35),
      hex: ((Math.round(base[0]) << 16) | (Math.round(base[1]) << 8) | Math.round(base[2])),
    };
  }
  function earthHeatStyle(heat, state) {
    const h = Math.max(0, Math.min(1, Number(heat) || 0));
    const r = earthHeatRamp(h);
    const rgba = (c, a) => 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a.toFixed(3) + ')';
    const k = 0.85 + 0.15 * h; // strong at every heat: the bloom IS the data
    return {
      stops: [
        [0, rgba(r.core, 1.0 * k)],
        [0.18, rgba(r.base, 0.94 * k)],
        [0.45, rgba(r.base, 0.55 * k)],
        [0.74, rgba(r.edge, 0.20 * k)],
        [1, rgba(r.edge, 0)],
      ],
      // Rings encode STATE, not intensity: hairline contour at rest, plus a
      // second (dashed on hover, solid on select) halo when engaged.
      ringCount: state ? 2 : 1,
      ringDash: state === 1,
      ringColor: state === 2 ? '#FFFFFF' : (state === 1 ? '#9CF4FF' : 'rgba(255,240,205,0.34)'),
      coreAlpha: 0.55 + 0.4 * h,
    };
  }

  // Holographic tile composite (Earth Zoom v2): the proxy serves two CARTO
  // dark @2x layers — label-free geography ("base") and transparent text
  // ("labels"). Geography is tinted into the globe palette with canvas
  // composite ops (GPU-accelerated, no per-pixel loop): 'screen' lifts the
  // R5 decision (owner): base-only GPU tint. The base layer is tinted toward
  // holo cyan in the tile shader; the labels layer stays a separate texture
  // composited untinted on top. Canvas 2D ops never touch color — the canvas
  // only normalizes the base image to ≤512 px (upload size cap). The v1
  // per-pixel OSM re-grade is gone: thresholding dark-glyph-in-white-halo
  // rasters always ringed and fattened text.
  const EARTH_TILE_TINT_LIFT = 'rgb(4,22,44)';     // screen: blacks → deep navy
  const EARTH_TILE_TINT_HUE = 'rgb(120,214,255)';  // multiply: grays → holo cyan
  const EARTH_TILE_LABEL_ALPHA = 0.96;
  // Shader-space twins of the tint consts above (0–1). The fragment replicates
  // the old canvas screen+multiply chain so holo styling is pixel-comparable.
  const EARTH_TILE_TINT_LIFT_VEC = { x: 4 / 255, y: 22 / 255, z: 44 / 255 };
  const EARTH_TILE_TINT_HUE_VEC = { x: 120 / 255, y: 214 / 255, z: 255 / 255 };
  // Depth gain for light-raster defaults (keyless OSM standard): near-white
  // land would otherwise screen/multiply into a near-white cyan wash that
  // blinds a dark VR room and breaks the dark-globe identity. 0.55 lands
  // OSM land at steel-cyan while dark CARTO tiles (keyed opt-in) stay deep
  // navy. Labels composite AFTER this gain, so glyphs keep full contrast.
  const EARTH_TILE_TINT_DEPTH = 0.55;

  function earthTileStyleMode() {
    return debugFlags.earthstyle === 'raw' ? 'raw' : 'holo';
  }

  // Size-normalize one tile's base image into a fresh canvas (upload cap).
  // Each call mints a FRESH canvas (never a shared scratch): THREE uploads
  // canvas textures lazily, so a shared canvas would show every tile the
  // last tile drawn. Color styling lives in the tile shader, not here —
  // this canvas draws the RAW base so GPU tint + raw-bypass stay exact.
  // Returns null when canvas drawing fails (stub images in tests) — the
  // caller then textures the raw base image.
  let earthTileCanvasFactory = null; // test seam: records composite ops
  function composeEarthTileCanvas(pair) {
    const base = pair && pair.base;
    if (!base) return null;
    try {
      const w = Math.max(1, Math.min(512, base.naturalWidth || base.width || 0));
      const h = Math.max(1, Math.min(512, base.naturalHeight || base.height || 0));
      const canvas = earthTileCanvasFactory
        ? earthTileCanvasFactory()
        : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
      if (!canvas) return null;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof ctx.drawImage !== 'function') return null;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(base, 0, 0, w, h);
      return canvas;
    } catch (e) {
      return null;
    }
  }

  // R5 base-only GPU tint: every tile material gets this injection. The base
  // map is tinted toward holo cyan (screen-lift + multiply-hue, same chain as
  // the retired canvas fills); the labels layer is sampled from a SECOND
  // texture and mixed on top by its own alpha, never tinted. ?earthstyle=raw
  // sets uTileTintStrength=0 and full label alpha (exact passthrough).
  // Both maps share the tile UV (same tile, same aspect) so parent-fallback
  // subrects apply to the pair. Uniform-branch (no recompile per tile).
  function installEarthTileShader(material, uniforms) {
    if (!material) return;
    material.userData = material.userData || {};
    material.userData.earthTileUniforms = uniforms;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.labelsMap = uniforms.labelsMap;
      shader.uniforms.uTileTintLift = uniforms.uTileTintLift;
      shader.uniforms.uTileTintHue = uniforms.uTileTintHue;
      shader.uniforms.uTileTintDepth = uniforms.uTileTintDepth;
      shader.uniforms.uTileTintStrength = uniforms.uTileTintStrength;
      shader.uniforms.uTileHasLabels = uniforms.uTileHasLabels;
      shader.uniforms.uTileLabelsAlpha = uniforms.uTileLabelsAlpha;
      shader.uniforms.uTileNight = uniforms.uTileNight || { value: 0 };
      shader.fragmentShader = ('uniform sampler2D labelsMap; uniform vec3 uTileTintLift; uniform vec3 uTileTintHue; uniform float uTileTintDepth; uniform float uTileTintStrength; uniform float uTileHasLabels; uniform float uTileLabelsAlpha; uniform float uTileNight;\n' +
        shader.fragmentShader.replace('#include <map_fragment>', `
          #include <map_fragment>
          {
            vec3 tileLifted = 1.0 - (1.0 - diffuseColor.rgb) * (1.0 - uTileTintLift);
            vec3 tileTinted = tileLifted * uTileTintHue * uTileTintDepth;
            if (uTileNight > 0.5) {
              // Night chart grade for LIGHT rasters (keyless OSM): classify the
              // paper-white source into land / sea / park, then re-light only the
              // ink (labels, casings, coast) and warm road fills as holo-cyan
              // line work. Result: deep navy chart with glowing, legible detail
              // instead of a muddy multiplied wash. Palette is sRGB -> linear.
              vec3 nSrc = diffuseColor.rgb;
              float nLum = dot(nSrc, vec3(0.2126, 0.7152, 0.0722));
              float nWater = smoothstep(0.015, 0.09, nSrc.b - nSrc.r);
              float nGreen = smoothstep(0.012, 0.06, nSrc.g - max(nSrc.r, nSrc.b)) * (1.0 - nWater);
              float nWarm = smoothstep(0.05, 0.26, nSrc.r - nSrc.b) * (1.0 - nGreen);
              float nSat = max(nSrc.r, max(nSrc.g, nSrc.b)) - min(nSrc.r, min(nSrc.g, nSrc.b));
              float nInk = clamp((0.80 - nLum) * 2.6, 0.0, 1.0) * (1.0 - nWater * 0.85) * (1.0 - nGreen) * (1.0 - smoothstep(0.07, 0.24, nSat));
              vec3 nLand = pow(vec3(0.070, 0.150, 0.235), vec3(2.2));
              vec3 nSea = pow(vec3(0.016, 0.052, 0.110), vec3(2.2));
              vec3 nPark = pow(vec3(0.050, 0.190, 0.205), vec3(2.2));
              vec3 nBase = mix(mix(nLand, nSea, nWater), nPark, nGreen);
              vec3 nGlow = mix(pow(vec3(0.20, 0.56, 0.78), vec3(2.2)), pow(vec3(0.84, 0.97, 1.0), vec3(2.2)), smoothstep(0.5, 1.0, nInk));
              tileTinted = mix(nBase, nGlow, clamp(max(nInk, nWarm * 0.75), 0.0, 1.0) * 0.92);
            }
            vec3 tileRgb = mix(diffuseColor.rgb, tileTinted, uTileTintStrength);
            if (uTileHasLabels > 0.5) {
              vec4 tileLabels = texture2D(labelsMap, vMapUv);
              tileRgb = mix(tileRgb, tileLabels.rgb, tileLabels.a * uTileLabelsAlpha);
            }
            diffuseColor.rgb = tileRgb;
          }
        `));
    };
    material.customProgramCacheKey = () => 'earth-tile-holo-v1';
  }

  // Mipmapped + anisotropic sampling for map tiles only (UI textures keep
  // applyLinearSampling). Text on a tilted, receding map minifies hard;
  // without mips it shimmers and aliases under VR resampling.
  function applyEarthTileSampling(tex) {
    if (!tex || !THREE) return tex;
    try {
      tex.generateMipmaps = true;
      if (THREE.LinearMipmapLinearFilter !== undefined) tex.minFilter = THREE.LinearMipmapLinearFilter;
      if (THREE.LinearFilter !== undefined) tex.magFilter = THREE.LinearFilter;
      let aniso = 1;
      try {
        if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
          aniso = Number(renderer.capabilities.getMaxAnisotropy()) || 1;
        }
      } catch (e2) {}
      tex.anisotropy = Math.max(1, Math.min(8, aniso));
    } catch (e) {}
    return tex;
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

  // Graticule overlay (upstream drawHolographicGrid, line weights scaled to
  // the 4K map).
  function paintEarthGrid(ctx) {
    if (!ctx) return;
    const sc = EARTH_MAP_SCALE;
    try { ctx.save(); } catch (e) {}
    // Minor meridians stop at ±80° (like a printed graticule) so the pole
    // isn't a 36-spoke starburst; the 30° majors still meet there.
    const capY = ((90 - 80) / 180) * EARTH_MAP_H;
    for (let lon = -180; lon <= 180; lon += 10) {
      const x = ((lon + 180) / 360) * EARTH_MAP_W;
      const major = lon % 30 === 0;
      ctx.strokeStyle = major ? 'rgba(62, 202, 242, 0.18)' : 'rgba(42, 148, 188, 0.07)';
      ctx.lineWidth = (major ? 2 : 1) * sc;
      ctx.beginPath();
      ctx.moveTo(x, major ? 0 : capY);
      ctx.lineTo(x, major ? EARTH_MAP_H : EARTH_MAP_H - capY);
      ctx.stroke();
    }
    for (let lat = -80; lat <= 80; lat += 10) {
      const y = ((90 - lat) / 180) * EARTH_MAP_H;
      const major = lat % 30 === 0;
      ctx.strokeStyle = major ? 'rgba(62, 202, 242, 0.18)' : 'rgba(42, 148, 188, 0.07)';
      ctx.lineWidth = (major ? 2 : 1) * sc;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(EARTH_MAP_W, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(91, 221, 255, 0.028)';
    for (let y = sc; y < EARTH_MAP_H; y += 6 * sc) ctx.fillRect(0, y, EARTH_MAP_W, sc);
    try { ctx.restore(); } catch (e) {}
  }

  // Persistent base layer (re-styled photo + graticule). The visible map canvas
  // is recomposed from it on every heat repaint, so heat/hover rings never
  // accumulate and the (expensive) re-style runs once per photo load.
  function ensureEarthBaseCanvas() {
    if (earthBaseCanvas || typeof document === 'undefined') return earthBaseCtx;
    try {
      earthBaseCanvas = document.createElement('canvas');
      earthBaseCanvas.width = EARTH_MAP_W;
      earthBaseCanvas.height = EARTH_MAP_H;
      earthBaseCtx = earthBaseCanvas.getContext('2d');
      if (!earthBaseCtx) earthBaseCanvas = null;
    } catch (e) {
      earthBaseCanvas = null;
      earthBaseCtx = null;
    }
    return earthBaseCtx;
  }

  function earthSmoothstep(a, b, x) {
    const t = x <= a ? 0 : (x >= b ? 1 : (x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  // Soft glow either side of the coastline, tabulated over the signed
  // distance range [-EARTH_COAST_RANGE, +EARTH_COAST_RANGE] px.
  const EARTH_COAST_RANGE = 28;
  const EARTH_COAST_LUT_STEP = 0.25;
  let earthCoastLut = null;
  function earthCoastGlowLut() {
    if (earthCoastLut) return earthCoastLut;
    const n = Math.round((EARTH_COAST_RANGE * 2) / EARTH_COAST_LUT_STEP) + 1;
    const lut = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = -EARTH_COAST_RANGE + i * EARTH_COAST_LUT_STEP;
      lut[i] = d >= 0 ? 0.34 * Math.exp(-d / 10) : 0.12 * Math.exp(d / 16);
    }
    earthCoastLut = lut;
    return lut;
  }

  // Polar pre-filter for one output row (RGBA, in place). An equirect row at
  // latitude φ is oversampled by 1/cos φ along longitude, and on the sphere
  // all of it converges into a small ring — near the poles every column's
  // detail became a radial spoke once zoomed. A circular box filter
  // 1/cos φ texels wide resamples the row to its true ground resolution
  // (no-op below ~60°, the whole ring averaged at the pole itself).
  function earthPolarRowFilter(px, j, W, cosLat, sums) {
    const r = Math.min(W >> 1, Math.floor(0.5 / Math.max(1e-4, cosLat) - 0.5));
    if (r < 1) return;
    const base = j * W * 4;
    const n = W + 2 * r + 1; // circular window prefix sums, per channel
    for (let c = 0; c < 3; c++) {
      const off = c * (W * 2 + 2);
      sums[off] = 0;
      for (let i = 0; i < n - 1; i++) {
        const x = ((i - r) % W + W) % W;
        sums[off + i + 1] = sums[off + i] + px[base + x * 4 + c];
      }
    }
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        const off = c * (W * 2 + 2);
        px[base + x * 4 + c] = (sums[off + x + 2 * r + 1] - sums[off + x]) * inv;
      }
    }
  }

  // Holographic re-style of the Natural Earth photo. Evolved from the upstream
  // per-pixel classifier: instead of a binary land mask on the source pixels
  // (stair-stepped coast at any upscale), it keeps the classifier as a
  // continuous signed field, converts it to a pixel distance to the coast and
  // anti-aliases the outline at the 4K output resolution. Works in row bands
  // (a few ms each) so a headset never takes a long main-thread stall.
  function buildHolographicEarthBase(image) {
    const dst = ensureEarthBaseCanvas() ? earthBaseCtx : earthMapCtx;
    if (!dst) return false;
    const token = ++earthBaseBuildToken;
    paintEarthBase(dst);
    const finish = (source) => {
      if (token !== earthBaseBuildToken) return;
      paintEarthGrid(dst);
      earthBaseSource = source;
      // Photo base is now live: prevent refreshEarthTexture() from
      // repainting the fallback gradient over it.
      earthBaseStale = false;
      earthMapDirty = true;
      refreshEarthTexture();
    };
    if (!image || typeof document === 'undefined') {
      finish('fallback');
      return true;
    }
    const W = EARTH_MAP_W;
    const H = EARTH_MAP_H;
    const srcW = Math.max(2, image.naturalWidth || image.width || 1024);
    const srcH = Math.max(2, image.naturalHeight || image.height || 512);
    const bandRows = 64;
    let band = null;
    let bctx = null;
    try {
      band = document.createElement('canvas');
      band.width = W;
      band.height = bandRows + 2;
      bctx = band.getContext('2d', { willReadFrequently: true });
    } catch (e) {
      bctx = null;
    }
    if (!bctx) {
      finish('fallback');
      return true;
    }
    const lut = earthCoastGlowLut();
    const lutN = lut.length;
    const field = new Float32Array(W * (bandRows + 2));
    const rowSums = new Float64Array((W * 2 + 2) * 3);
    let y0 = 0;
    const step = () => {
      if (token !== earthBaseBuildToken) return;
      try {
        const y1 = Math.min(H, y0 + bandRows);
        const m0 = y0 > 0 ? 1 : 0;
        const m1 = y1 < H ? 1 : 0;
        const rows = (y1 - y0) + m0 + m1;
        const outRows = y1 - y0;
        if (band.height !== rows) band.height = rows;
        bctx.imageSmoothingEnabled = true;
        bctx.imageSmoothingQuality = 'high';
        bctx.drawImage(image, 0, ((y0 - m0) * srcH) / H, srcW, (rows * srcH) / H, 0, 0, W, rows);
        const src = bctx.getImageData(0, 0, W, rows).data;
        // Continuous land field: >0 land, <0 ocean. The first two terms are
        // the upstream classifier's tests ((r+g)/2-b > -10, r+g+b > 720).
        // Both sit right at zero on the bluish-white ice sheets (Greenland,
        // Antarctica, Ellesmere), which traced false coastlines all over
        // them — the stair-stepped stripes. The third term claims bright,
        // near-neutral pixels as land: ice scores +40…+65, while every sea
        // (deep, shelf, coastal turquoise) stays well below zero.
        for (let i = 0, n = W * rows; i < n; i++) {
          const o = i * 4;
          const r = src[o], g = src[o + 1], b = src[o + 2];
          const fa = (r + g) * 0.5 - b + 10;
          const fb = r + g + b - 720;
          const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
          const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
          const fc = (mn - 185) - 0.8 * ((mx - mn) - 25);
          field[i] = fa > fb ? (fa > fc ? fa : fc) : (fb > fc ? fb : fc);
        }
        const out = dst.createImageData(W, outRows);
        const px = out.data;
        for (let j = 0; j < outRows; j++) {
          const r = j + m0;
          const up = (r > 0 ? r - 1 : r) * W;
          const dn = (r < rows - 1 ? r + 1 : r) * W;
          const row = r * W;
          const vSpan = (r > 0 ? 1 : 0) + (r < rows - 1 ? 1 : 0) || 1;
          // Distances are measured on the sphere, not in texels: an
          // equirect column spans cos(lat) of a row's ground, so the x slope
          // is rescaled per row. Without it the coast line and shelf glow
          // thinned to nothing east-west near the poles and smeared north-south.
          // Capped at 78°: closer to the pole the stretch would turn JPEG
          // noise on open sea into speckled false coastline.
          const lat = (0.5 - (y0 + j + 0.5) / H) * Math.PI;
          const invCos = 1 / Math.max(0.2, Math.cos(lat));
          for (let x = 0; x < W; x++) {
            const f = field[row + x];
            const gx = (field[row + (x + 1 < W ? x + 1 : 0)] - field[row + (x > 0 ? x - 1 : W - 1)]) * 0.5 * invCos;
            const gy = (field[dn + x] - field[up + x]) / vSpan;
            const mag = Math.sqrt(gx * gx + gy * gy);
            let d = f / (mag > 0.35 ? mag : 0.35);
            if (d > EARTH_COAST_RANGE) d = EARTH_COAST_RANGE;
            else if (d < -EARTH_COAST_RANGE) d = -EARTH_COAST_RANGE;
            const o = (row + x) * 4;
            const lum = (src[o] * 0.25 + src[o + 1] * 0.55 + src[o + 2] * 0.20) / 255;
            const cover = earthSmoothstep(-1.1, 1.1, d);
            // Ocean → land body colour (upstream palette), anti-aliased.
            let rr = (1 + lum * 4) + ((5 + lum * 16) - (1 + lum * 4)) * cover;
            let gg = (8 + lum * 13) + ((50 + lum * 72) - (8 + lum * 13)) * cover;
            let bb = (23 + lum * 25) + ((82 + lum * 105) - (23 + lum * 25)) * cover;
            // Shelf glow hugging the coast on both sides.
            const glow = lut[Math.round((d + EARTH_COAST_RANGE) / EARTH_COAST_LUT_STEP)];
            rr += (24 - rr) * glow;
            gg += (150 - gg) * glow;
            bb += (214 - bb) * glow;
            // Crisp cyan coastline, ~3 px wide, anti-aliased.
            const ad = d < 0 ? -d : d;
            const line = 1 - earthSmoothstep(0.9, 2.1, ad);
            rr += (42 - rr) * line;
            gg += (222 - gg) * line;
            bb += (255 - bb) * line;
            px[(j * W + x) * 4] = rr;
            px[(j * W + x) * 4 + 1] = gg;
            px[(j * W + x) * 4 + 2] = bb;
            px[(j * W + x) * 4 + 3] = 255;
          }
          earthPolarRowFilter(px, j, W, Math.cos(lat), rowSums);
        }
        dst.putImageData(out, 0, y0);
        y0 = y1;
      } catch (error) {
        console.warn('[WebXRVR] Holographic Earth conversion failed; using grid fallback:', error);
        paintEarthBase(dst);
        finish('fallback');
        return;
      }
      if (y0 < H) setTimeout(step, 0);
      else finish('photo');
    };
    step();
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
    // Warp compensation: the warp magnifies surface angles near the focus by
    // k_eff, so an uncompensated geographic radius renders k_eff× too big
    // (giant halos while zooming). Dividing by k_eff keeps the RENDERED halo
    // at its geographic size at every zoom. Hit-testing is unaffected (it
    // matches in unwarped geographic space).
    const rad = earthZoneAngularRadius(location) / Math.max(1, earthEffectiveK(earthZoom));
    const rY = Math.max(24 * EARTH_MAP_SCALE, (rad / Math.PI) * EARTH_MAP_H);
    const latRad = Math.abs(Number(location && location.lat) || 0) * (Math.PI / 180);
    const rX = Math.min(rY * 3.2, rY / Math.max(0.32, Math.cos(latRad)));
    return { x: rX, y: rY };
  }

  // Repaints the equirect heat map only when dirty (activity load or mode
  // entry), never per frame. The base layer (photo re-style or fallback)
  // is painted only when stale — repainting it here used to obliterate an
  // asynchronously arrived photo base. Heat fill is upstream
  // drawEarthHeatZone verbatim (4-stop gradient + state rings).
  // Minimum gap between zoom-drift heat repaints: each repaint re-uploads the
  // whole 4K canvas, so gesture-rate redraws would burn GPU bandwidth. State
  // changes (hover/select/activity) still repaint immediately.
  const EARTH_HEAT_DRIFT_MIN_MS = 180;

  function refreshEarthTexture() {
    // Warp-compensated heat radii depend on zoom: repaint (heat only, never
    // the base) when the effective magnification drifts >3% so halos track
    // gestures without a per-frame 4K canvas repaint.
    if (earthMapCtx) {
      const kq = Math.round(Math.max(1, earthEffectiveK(earthZoom)) * 32) / 32;
      if (kq !== refreshEarthTexture._kq && earthNowMs() - earthHeatPaintedAt >= EARTH_HEAT_DRIFT_MIN_MS) {
        refreshEarthTexture._kq = kq;
        earthMapDirty = true;
      }
    }
    if (!earthMapDirty || !earthMapCtx) return;
    earthMapDirty = false;
    earthHeatPaintedAt = earthNowMs();
    const ctx = earthMapCtx;
    try {
      const baseCtx = ensureEarthBaseCanvas() ? earthBaseCtx : ctx;
      if (earthBaseStale) {
        paintEarthBase(baseCtx);
        paintEarthGrid(baseCtx);
        earthBaseStale = false;
      }
      // Recompose from the persistent base so previous rings are erased.
      if (baseCtx !== ctx) ctx.drawImage(earthBaseCanvas, 0, 0);
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
      // Normal blending (not additive): the Natural-Earth land is already bright
      // cyan, and 'lighter' washed amber/coral into near-white there.
      ctx.globalCompositeOperation = 'source-over';
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
          // State rings on top of the bloom (normal blending reads crisper).
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = style.ringColor;
          ctx.lineWidth = (state ? 3.5 : 1.6) * EARTH_MAP_SCALE;
          ctx.beginPath();
          ctx.arc(0, 0, r.y * 0.5, 0, Math.PI * 2);
          ctx.stroke();
          if (style.ringCount > 1) {
            if (style.ringDash && ctx.setLineDash) ctx.setLineDash([r.y * 0.09, r.y * 0.07]);
            ctx.lineWidth = (state === 2 ? 4.5 : 2.5) * EARTH_MAP_SCALE;
            ctx.beginPath();
            ctx.arc(0, 0, r.y * 0.74, 0, Math.PI * 2);
            ctx.stroke();
            if (style.ringDash && ctx.setLineDash) ctx.setLineDash([]);
          }
          // Pin-point core: marks the exact centroid under the bloom.
          ctx.fillStyle = 'rgba(255,255,255,' + style.coreAlpha.toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(3 * EARTH_MAP_SCALE, r.y * 0.05), 0, Math.PI * 2);
          ctx.fill();
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
  // Each mesh stashes its location row in userData so the per-frame pass can
  // re-seat it in the LIVE warp frame every frame (cheap vector math, no
  // rebuild) — cones track the zoom continuously instead of lagging until
  // the next rebuild gate.
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
      if (!pinSharedGeo) {
        // Map-marker teardrop: tip touches the surface, round head faces out.
        // Falls back to the legacy cone where LatheGeometry is unavailable.
        try {
          const prof = [[0, -0.035], [0.0035, -0.029], [0.010, -0.013], [0.0165, 0.006], [0.0195, 0.021],
            [0.0160, 0.032], [0.0085, 0.0375], [0, 0.0385]].map((p) => new THREE.Vector2(p[0], p[1]));
          pinSharedGeo = new THREE.LatheGeometry(prof, 16);
          const pos = pinSharedGeo.attributes.position;
          const col = new Float32Array(pos.count * 3);
          for (let i = 0; i < pos.count; i++) {
            const t = Math.max(0, Math.min(1, (pos.getY(i) + 0.035) / 0.0735));
            const v = 0.55 + 0.75 * t * t; // darker tip → blown-out highlight on the head
            col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
          }
          pinSharedGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
          pinSharedGeo.userData = { vertexColored: true };
        } catch (e) { pinSharedGeo = new THREE.ConeGeometry(0.022, 0.07, 10); }
      }
      const up = new THREE.Vector3(0, 1, 0);
      const ranked = earthLocations.slice()
        .sort((a, b) => earthHeatOf(b) - earthHeatOf(a))
        .slice(0, EARTH_PIN_CAP);
      ranked.forEach((loc, i) => {
        const u = earthRenderedDirection(loc.lat, loc.lon);
        const heat = earthHeatOf(loc);
        const color = earthHeatRamp(heat).hex;
        const mesh = new THREE.Mesh(pinSharedGeo, new THREE.MeshBasicMaterial(
          pinSharedGeo.userData && pinSharedGeo.userData.vertexColored ? { color, vertexColors: true } : { color }));
        mesh.frustumCulled = false;
        const dir = new THREE.Vector3(u.x, u.y, u.z);
        mesh.position.copy(dir).multiplyScalar(EARTH_RADIUS + 0.035);
        mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
        mesh.userData.pulsePhase = i * 0.7;
        mesh.userData.baseScale = 0.62 + heat * 0.62;
        mesh.userData.location = loc;
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
      // Matches the canvas bloom: hot core, smooth gaussian-ish falloff, a
      // hairline contour at 0.5r and a tiny centroid dot (tinted per sprite).
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 62);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.16, 'rgba(255,255,255,0.80)');
      g.addColorStop(0.40, 'rgba(255,255,255,0.36)');
      g.addColorStop(0.70, 'rgba(255,255,255,0.10)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(64, 64, 62, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(64, 64, 31, 0, Math.PI * 2);
      ctx.stroke();
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
        const dir = earthRenderedDirection(loc.lat, loc.lon);
        const color = earthHeatRamp(heat).hex;
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
        mesh.frustumCulled = false;
        const vec = new THREE.Vector3(dir.x, dir.y, dir.z);
        mesh.position.copy(vec).multiplyScalar(EARTH_RADIUS + EARTH_TILE_RADIUS_EPS * 2 / Math.max(1, earthVisibleRadius(earthZoom) / EARTH_RADIUS));
        mesh.quaternion.setFromUnitVectors(zAxis, vec.clone().normalize());
        mesh.scale.setScalar(halfExtent);
        mesh.renderOrder = 3;
        earthHeatGroup.add(mesh);
        earthHeatSprites.push({ mesh, material, location: loc, baseScale: halfExtent, hex: color });
      });
    } catch (e) {}
  }

    // Per-frame fade/state for the heat overlay (visible only over tiles).
  let earthHeatClock = 0;
  function updateEarthHeatSprites(fade) {
    if (!earthHeatGroup) return;
    earthHeatClock = (typeof performance !== 'undefined' && performance.now) ? performance.now() : earthHeatClock + 16;
    const visible = fade > 0.02 && earthHeatSprites.length > 0;
    earthHeatGroup.visible = visible;
    if (!visible) return;
    const hovered = earthHoveredIndex;
    const selected = earthSelectedIndex;
    // Warp compensation (matches the canvas radii above): sprite quads sit on
    // the magnified surface, so their local scale divides by k_eff to hold a
    // constant geographic footprint. Without this, zooming balloons heat into
    // globe-sized halos.
    const kComp = Math.max(1, earthEffectiveK(earthZoom));
    // Live surface radius (same contract as rebuildEarthHeatSprites): the
    // lift above the sphere shrinks as the group scale grows, so offsets stay
    // constant in world space through the zoom.
    const liveRadius = EARTH_RADIUS + EARTH_TILE_RADIUS_EPS * 2 / Math.max(1, earthVisibleRadius(earthZoom) / EARTH_RADIUS);
    const zAxis = (typeof THREE !== 'undefined' && THREE) ? new THREE.Vector3(0, 0, 1) : null;
    const tmpDir = (typeof THREE !== 'undefined' && THREE) ? new THREE.Vector3() : null;
    for (let i = 0; i < earthHeatSprites.length; i++) {
      const sprite = earthHeatSprites[i];
      let boost = 1;
      try {
        const idx = earthLocations.indexOf(sprite.location);
        if (idx >= 0 && idx === selected) boost = 1.35;
        else if (idx >= 0 && idx === hovered) boost = 1.18;
      } catch (e) {}
      // Re-seat in the LIVE warp frame every frame (same earthRenderedDirection
      // the pins use): heat quads ride the zoom continuously instead of lagging
      // until the next rebuild. Cheap vector math, no rebuild/dispose churn.
      try {
        const loc = sprite.location;
        if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lon)) &&
            sprite.mesh && zAxis && tmpDir) {
          const dir = earthRenderedDirection(loc.lat, loc.lon);
          sprite.mesh.position.set(dir.x * liveRadius, dir.y * liveRadius, dir.z * liveRadius);
          tmpDir.set(dir.x, dir.y, dir.z).normalize();
          sprite.mesh.quaternion.setFromUnitVectors(zAxis, tmpDir);
          // Live footprint for street-zoom attenuation (earthZoneAngularRadius
          // shrinks past S>256): recompute so scale tracks the zoom instantly
          // instead of holding the build-time radius.
          const angular = earthZoneAngularRadius(loc);
          const halfExtent = EARTH_RADIUS * Math.sin(angular);
          if (Number.isFinite(halfExtent) && halfExtent > 0) sprite.baseScale = halfExtent;
        }
      } catch (e) {}
      // Living bloom: a slow breath on colour intensity (not opacity/scale, which
      // are asserted contracts); hotter zones breathe a touch faster/deeper.
      if (sprite.material.color && sprite.material.color.setHex) {
        const heatK = earthHeatOf(sprite.location);
        const breath = reducedMotion ? 1 : 0.9 + 0.1 * Math.sin(earthHeatClock * (0.0016 + heatK * 0.0014) + i * 1.7);
        sprite.material.color.setHex(sprite.hex || 0xffffff);
        if (sprite.material.color.multiplyScalar) sprite.material.color.multiplyScalar(breath * (boost > 1 ? 1.2 : 1));
      }
      sprite.material.opacity = Math.min(1, fade * 0.85) * (boost > 1 ? 1.15 : 1);
      sprite.mesh.scale.setScalar(sprite.baseScale * boost / kComp);
    }
  }

  // ─── Holo Atlas label HUD ───────────────────────────────────────────
  // Zoom realms (v3 plan §2): tier name + accent colour follow the heat ramp
  // (cyan → teal → amber → coral) so the breadcrumb reads as depth at a glance.
  const EARTH_TIERS = [
    { name: 'ORBIT', max: 3, color: '#39D7FF' },
    { name: 'REGION', max: 24, color: '#4FE3C1' },
    { name: 'CITY', max: 200, color: '#FFC857' },
    { name: 'STREET', max: Infinity, color: '#FF8A5B' },
  ];
  function earthTierIndex(scale) {
    const s = Math.max(1, Number(scale) || 1);
    for (let i = 0; i < EARTH_TIERS.length; i++) if (s < EARTH_TIERS[i].max) return i;
    return EARTH_TIERS.length - 1;
  }
  function earthLabelHint(featured, zoomed) {
    if (featured) return earthZoom >= EARTH_ZOOM_CITY ? 'TRIGGER  ▸  OPEN FEED' : 'TRIGGER  ▸  ZOOM IN';
    return zoomed ? '' : 'DRAG TO ROTATE  ·  TRIGGER TO ZOOM';
  }
  function earthRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  function drawEarthLabelPanel(ctx, o) {
    // Logical space is 640×148; the canvas is 2× for crisp text in-headset.
    if (ctx.setTransform) { const k = (earthLabelCanvas && earthLabelCanvas.width / 640) || 1; ctx.setTransform(k, 0, 0, k, 0, 0); }
    ctx.clearRect(0, 0, EARTH_LABEL_LOGICAL_W, EARTH_LABEL_LOGICAL_H);
    const tierIdx = earthTierIndex(o.scale);
    const tier = o.offline ? { name: 'OFFLINE', color: '#FF7A59' } : EARTH_TIERS[tierIdx];
    const accent = o.featured ? '#FFB11F' : tier.color;
    const hasGrad = !!ctx.createLinearGradient;
    // Glass body
    earthRoundRect(ctx, 2, 2, 636, EARTH_LABEL_LOGICAL_H - 4, 20);
    if (hasGrad) {
      const g = ctx.createLinearGradient(0, 2, 0, EARTH_LABEL_LOGICAL_H - 2);
      g.addColorStop(0, 'rgba(18,34,58,0.95)');
      g.addColorStop(1, 'rgba(5,10,22,0.97)');
      ctx.fillStyle = g;
    } else ctx.fillStyle = 'rgba(8,16,30,0.96)';
    ctx.fill();
    // Rim: accent on the left fading to slate on the right
    if (hasGrad) {
      const rg = ctx.createLinearGradient(0, 0, 640, 0);
      rg.addColorStop(0, accent);
      rg.addColorStop(0.55, 'rgba(70,100,134,0.75)');
      rg.addColorStop(1, 'rgba(58,80,107,0.55)');
      ctx.strokeStyle = rg;
    } else ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Top specular line
    if (hasGrad) {
      const sg = ctx.createLinearGradient(20, 0, 620, 0);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, 'rgba(190,235,255,0.35)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = sg;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(24, 4.5); ctx.lineTo(616, 4.5); ctx.stroke();
    }
    ctx.textBaseline = 'middle';
    // Tier chip
    ctx.font = '700 12px "JetBrains Mono", monospace';
    const chipText = tier.name;
    const chipW = Math.ceil((ctx.measureText ? ctx.measureText(chipText).width : chipText.length * 7.5)) + 34;
    earthRoundRect(ctx, 18, 14, chipW, 26, 13);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fill();
    ctx.strokeStyle = tier.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = tier.color;
    ctx.beginPath(); ctx.arc(32, 27, 4, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillText(chipText, 44, 28);
    // Title (the zoom share is carried by the gauge, not repeated in text)
    const titleText = o.zoomed ? String(o.title).replace(/\s·\s\d+%$/, '') : String(o.title);
    const titleX = 18 + chipW + 14;
    const titleMax = 540 - titleX;
    let fs = 25;
    ctx.fillStyle = '#F7FAFC';
    ctx.font = '700 ' + fs + 'px Archivo, sans-serif';
    while (ctx.measureText && fs > 15 && ctx.measureText(titleText).width > titleMax) {
      fs -= 1;
      ctx.font = '700 ' + fs + 'px Archivo, sans-serif';
    }
    ctx.fillText(titleText, titleX, 28);
    // Zoom gauge (right)
    const gx = 592, gy = 34, gr = 20;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(160,190,220,0.18)';
    ctx.beginPath(); ctx.arc(gx, gy, gr, 0, Math.PI * 2); ctx.stroke();
    const frac = Math.max(0, Math.min(1, (Number(o.zoomPct) || 0) / 100));
    if (frac > 0.005) {
      ctx.strokeStyle = tier.color;
      ctx.beginPath(); ctx.arc(gx, gy, gr, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#F7FAFC';
    ctx.font = '700 13px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(o.zoomPct || 0)), gx, gy + 1);
    // Detail line
    ctx.textAlign = 'left';
    ctx.fillStyle = o.offline ? '#FFB199' : '#B8C6D9';
    ctx.font = '700 15px "JetBrains Mono", monospace';
    ctx.fillText(o.detail, 20, 61);
    // Divider
    ctx.fillStyle = 'rgba(140,175,210,0.16)';
    ctx.fillRect(20, 76, 600, 1);
    // Footer row: scale bar (zoomed) or interaction hint, tier ladder right
    if (o.zoomed) {
      ctx.fillStyle = '#7F93AD';
      ctx.font = '700 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('SCALE', 20, 94);
      drawEarthScaleBar(ctx, o.scaleBar);
    } else if (o.hint) {
      ctx.fillStyle = '#7F93AD';
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(o.hint, 20, 94);
    }
    // Action row: trigger hint (zoomed) left, RESET ROTATION button right.
    ctx.fillStyle = 'rgba(140,175,210,0.16)';
    ctx.fillRect(20, 106, 600, 1);
    if (o.zoomed && o.hint) {
      ctx.fillStyle = accent;
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(o.hint, 20, 127);
    }
    {
      const b = EARTH_LABEL_RESET_RECT;
      const on = !!o.resetEnabled, hot = on && !!o.resetHot;
      earthRoundRect(ctx, b.x, b.y, b.w, b.h, 14);
      ctx.fillStyle = on ? (hot ? 'rgba(85,231,255,0.34)' : 'rgba(85,231,255,0.12)') : 'rgba(110,140,170,0.08)';
      ctx.fill();
      ctx.strokeStyle = on ? (hot ? '#BFF5FF' : 'rgba(85,231,255,0.85)') : 'rgba(110,140,170,0.35)';
      ctx.lineWidth = hot ? 2.5 : 1.5;
      ctx.stroke();
      ctx.fillStyle = on ? (hot ? '#F2FDFF' : '#A9F0FF') : '#5F7891';
      ctx.font = '800 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('⟲  RESET ROTATION', b.x + b.w / 2, b.y + b.h / 2 + 1);
    }
    // Realm ladder: four segments, filled through the current realm
    const segW = 36, segGap = 6, ladderX = 620 - (segW * 4 + segGap * 3);
    for (let i = 0; i < EARTH_TIERS.length; i++) {
      const sx = ladderX + i * (segW + segGap);
      ctx.fillStyle = 'rgba(160,190,220,0.16)';
      earthRoundRect(ctx, sx, 91, segW, 6, 3); ctx.fill();
      if (i <= tierIdx) {
        ctx.fillStyle = EARTH_TIERS[i].color;
        earthRoundRect(ctx, sx, 91, segW, 6, 3); ctx.fill();
      }
    }
    // Tile streaming progress hairline along the bottom edge
    if (o.streaming >= 0) {
      ctx.fillStyle = 'rgba(160,190,220,0.16)';
      ctx.fillRect(22, EARTH_LABEL_LOGICAL_H - 6, 596, 2);
      ctx.fillStyle = tier.color;
      ctx.fillRect(22, EARTH_LABEL_LOGICAL_H - 6, Math.max(4, 596 * o.streaming), 2);
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
    // A paused partial outage keeps its tiles on screen, so it keeps the
    // license credit instead of the offline notice.
    const tileOffline = !earthTileAvailable && (earthZoom > 1.02 || earthZoomTarget > 1.02);
    const tileSuffix = tileOffline
      ? '|offline'
      : (earthTileFade() > 0.02 ? '|osm' : '');
    // Z4 breadcrumb: once zoomed, the title roots the view at WORLD and
    // carries the log-scale zoom share; the detail line (and its license
    // suffix) is untouched.
    const zoomed = earthZoom > 1.02 || earthZoomTarget > 1.02;
    const zoomPct = earthZoomPercent();
    const streamQ = (zoomed && earthTileFade() > 0.02 && earthTileLoadRatio < 0.995)
      ? Math.round(earthTileLoadRatio * 20) : -1;
    const resetEnabled = !!earthResetTarget();
    const resetHot = resetEnabled && earthLabelHoverRegion === 'face';
    const key = earthLocations.length + '|' + (featured ? featured.slug : '') + tileSuffix +
      '|' + (zoomed ? zoomPct + ':' + earthZoom.toFixed(4) : 'g') + '|' + streamQ +
      '|' + (resetEnabled ? 1 : 0) + (resetHot ? 'h' : '');
    if (key === lastEarthLabelKey) return;
    lastEarthLabelKey = key;
    try {
      const ctx = earthLabelCtx;
      const title = featured && featured.name
        ? (zoomed ? 'WORLD › ' + featured.name + ' · ' + zoomPct + '%' : featured.name)
        : (zoomed ? 'WORLD · ' + zoomPct + '%' : 'EARTH ACTIVITY');
      const scaleBar = earthScaleBar(earthZoom, earthFocus || earthFacingLatLon());
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
      // R6: truncation must never drop the license (hard requirement) or the
      // zoom share. Detail reserves the attribution tail; the title reserves
      // the zoom tail and truncates the location name middle instead.
      if (tileSuffix === '|osm') {
        const suffix = ' · ' + earthAttributionText;
        detail = String(detail).slice(0, Math.max(0, 44 - suffix.length)) + suffix;
        refreshEarthAttribution(); // upgrade to the served provider's credit
      }
      let titleStr = String(title);
      if (titleStr.length > 30 && zoomed) {
        const tail = ' · ' + zoomPct + '%';
        const head = 'WORLD › ';
        const nameBudget = Math.max(0, 30 - head.length - tail.length);
        const name = featured && featured.name ? String(featured.name) : '';
        titleStr = head + name.slice(0, nameBudget) + tail;
      } else {
        titleStr = titleStr.slice(0, 30);
      }
      drawEarthLabelPanel(ctx, {
        title: titleStr,
        detail: String(detail).slice(0, 44),
        zoomed,
        zoomPct,
        featured: !!featured,
        offline: tileOffline,
        scaleBar,
        scale: Math.max(1, earthZoom),
        streaming: streamQ >= 0 ? streamQ / 20 : -1,
        hint: earthLabelHint(featured, zoomed),
        resetEnabled,
        resetHot,
      });
      earthLabelTitle = titleStr.slice(0, 30);
      earthLabelDetail = String(detail).slice(0, 44);
      earthLabelTexture.needsUpdate = true;
    } catch (e) {}
  }

  // Poster thumbnails for the preview card: same-origin images only
  // (crossOrigin=anonymous keeps the canvas texture upload legal; a failed
  // load simply leaves the placeholder slot).
  const EARTH_PREVIEW_CYCLE_MS = 3200;
  let earthPreviewCycleAt = -1;
  const earthPreviewPosterCache = new Map();
  function earthPreviewPosterImages() {
    const out = [];
    for (let i = 0; i < earthPreviewItems.length && i < 3; i++) {
      const url = earthPreviewItems[i] && (earthPreviewItems[i].poster_url || earthPreviewItems[i].thumbnail_url);
      if (!url || typeof Image === 'undefined') { out.push(null); continue; }
      let img = earthPreviewPosterCache.get(url);
      if (!img) {
        try {
          img = new Image();
          try { img.crossOrigin = 'anonymous'; } catch (e) {}
          img.onerror = () => { img.failed = true; };
          img.src = url;
          earthPreviewPosterCache.set(url, img);
          if (earthPreviewPosterCache.size > 24) earthPreviewPosterCache.delete(earthPreviewPosterCache.keys().next().value);
        } catch (e) { img = null; }
      }
      out.push(img && !img.failed ? img : null);
    }
    return out;
  }

  // ─── Hover autoplay ─────────────────────────────────────────────────────
  // Hovering a heat zone starts the first previewed reel playing (muted, looped
  // per item, advancing through up to three) once the hover has settled for
  // EARTH_PREVIEW_AUTOPLAY_DELAY_MS — so sweeping the laser across the globe
  // never spins up a decoder. One <video> at a time; it is torn down the moment
  // the hover ends, the mode changes, or motion is reduced. The poster stays
  // underneath until the first decoded frame, and any failure (CORS, codec,
  // network) silently falls back to the poster card.
  const EARTH_PREVIEW_AUTOPLAY_DELAY_MS = 350;
  const EARTH_PREVIEW_MAX_ITEM_MS = 9000;
  let earthPreviewVideoUrl = '';
  let earthPreviewVideoFailed = '';
  let earthPreviewHoverSince = -1;
  let earthPreviewVideoStartedAt = -1;

  function disposeEarthPreviewVideo() {
    const v = earthPreviewVideo;
    earthPreviewVideo = null;
    earthPreviewVideoUrl = '';
    earthPreviewVideoStartedAt = -1;
    if (!v) return;
    try { v.pause && v.pause(); } catch (e) {}
    try { v.removeAttribute && v.removeAttribute('src'); v.src = ''; v.load && v.load(); } catch (e) {}
  }

  function earthPreviewAdvance() {
    if (earthPreviewItems.length > 1) {
      earthPreviewIndex = (earthPreviewIndex + 1) % earthPreviewItems.length;
      earthPreviewCycleAt = -1; // re-armed on the next billboard update
    }
  }

  function syncEarthPreviewVideo() {
    const item = earthPreviewItems[earthPreviewIndex];
    const url = item && item.url ? String(item.url) : '';
    const settled = earthPreviewHoverSince >= 0 && (earthNowMs() - earthPreviewHoverSince) >= EARTH_PREVIEW_AUTOPLAY_DELAY_MS;
    const want = (sceneMode === 'earth' && !reducedMotion && settled && earthPreviewLocationIndex >= 0 &&
      url && url !== earthPreviewVideoFailed) ? url : '';
    if (want === earthPreviewVideoUrl) return;
    disposeEarthPreviewVideo();
    if (!want || typeof document === 'undefined' || !document.createElement) return;
    try {
      const v = document.createElement('video');
      if (!v || typeof v.play !== 'function') return;
      v.muted = true;
      v.defaultMuted = true;
      v.loop = earthPreviewItems.length <= 1;
      v.preload = 'auto';
      try { v.crossOrigin = 'anonymous'; } catch (e) {}
      try { v.playsInline = true; v.setAttribute && v.setAttribute('playsinline', ''); v.setAttribute && v.setAttribute('muted', ''); } catch (e) {}
      v.addEventListener && v.addEventListener('ended', () => { if (earthPreviewVideo === v) earthPreviewAdvance(); });
      v.addEventListener && v.addEventListener('error', () => {
        if (earthPreviewVideo === v) { earthPreviewVideoFailed = want; disposeEarthPreviewVideo(); earthPreviewAdvance(); }
      });
      v.src = want;
      earthPreviewVideo = v;
      earthPreviewVideoUrl = want;
      earthPreviewVideoStartedAt = earthNowMs();
      const started = v.play();
      if (started && typeof started.catch === 'function') {
        started.catch(() => { if (earthPreviewVideo === v) { earthPreviewVideoFailed = want; disposeEarthPreviewVideo(); } });
      }
    } catch (e) { disposeEarthPreviewVideo(); }
  }

  function updateEarthPreviewBillboard(time) {
    if (!earthPreviewMesh) return;
    if (sceneMode !== 'earth') {
      earthPreviewMesh.visible = false;
      if (earthPreviewVideo) disposeEarthPreviewVideo();
      return;
    }
    // A decoding video repaints the card at ~30 Hz; otherwise 6–7 Hz is plenty.
    const playing = !!(earthPreviewVideo && earthPreviewVideo.readyState >= 2 && !earthPreviewVideo.paused);
    if (time - lastEarthPreviewUpdate < (playing ? 33 : 150)) return;
    lastEarthPreviewUpdate = time;
    const loc = (earthPreviewLocationIndex >= 0 && earthPreviewLocationIndex < earthLocations.length)
      ? earthLocations[earthPreviewLocationIndex]
      : null;
    if (!loc || !earthPreviewItems.length) {
      earthPreviewMesh.visible = false;
      if (earthPreviewVideo) disposeEarthPreviewVideo();
      return;
    }
    // Cycle the hero through the (≤3) previewed reels. With a live video the
    // clip's own end advances it (capped so one long reel can't hog the card);
    // otherwise a short poster rotation. Frozen under reduced motion.
    if (!reducedMotion && earthPreviewItems.length > 1) {
      if (earthPreviewCycleAt < 0) earthPreviewCycleAt = time;
      const limit = earthPreviewVideo ? EARTH_PREVIEW_MAX_ITEM_MS : EARTH_PREVIEW_CYCLE_MS;
      if (time - earthPreviewCycleAt > limit) {
        earthPreviewCycleAt = time;
        earthPreviewIndex = (earthPreviewIndex + 1) % earthPreviewItems.length;
      }
    }
    syncEarthPreviewVideo();
    const ui = getUICanvas();
    if (ui && earthPreviewCtx) {
      try {
        ui.renderEarthPreviewCanvas(earthPreviewCtx, {
          location: loc,
          previewVideo: earthPreviewVideo,
          earthPreviewStatus,
          earthPreviewItems,
          earthPreviewIndex,
          earthPreviewPosters: earthPreviewPosterImages(),
          earthPreviewHover: earthPreviewHoverRegion,
          reducedMotion,
          time,
        });
        if (earthPreviewTexture) earthPreviewTexture.needsUpdate = true;
      } catch (e) {}
    }
    earthPreviewMesh.visible = true;
  }

  // ─── Gaze-safe HUD placement ────────────────────────────────────────────
  // Label / preview / compass are positioned from world anchors (so they sit
  // naturally by the globe) but must never leave the viewer's field of view
  // when they move around. After the anchored placement, each panel's centre is
  // clamped — in head-relative yaw/pitch, at its own distance — so the WHOLE
  // panel (its angular half-size included) stays inside the central ~80% of the
  // view. The correction is smoothed (τ≈0.12 s), so panels glide to the edge of
  // the comfort zone instead of snapping, and sit exactly on their anchors
  // whenever the anchors are already comfortably visible.
  function earthHeadForward() {
    try {
      if (camera && typeof camera.getWorldDirection === 'function' && THREE) {
        if (!earthGazeVec) earthGazeVec = new THREE.Vector3();
        camera.getWorldDirection(earthGazeVec);
        const l = Math.hypot(earthGazeVec.x, earthGazeVec.y, earthGazeVec.z);
        if (l > 1e-6 && Number.isFinite(l)) return { x: earthGazeVec.x / l, y: earthGazeVec.y / l, z: earthGazeVec.z / l };
      }
    } catch (e) {}
    return { x: 0, y: 0, z: -1 };
  }
  function earthViewHalfFov() {
    // Half-FOV in radians (horizontal, vertical). Preview cameras report it;
    // in XR use conservative Quest-class values (wider than the usable core).
    let v = 0.70, h = 0.78;
    try {
      if (!xrSession && camera && Number(camera.fov) > 10) {
        v = (camera.fov * Math.PI / 180) / 2;
        const aspect = Number(camera.aspect) > 0.3 ? Number(camera.aspect) : 16 / 9;
        h = Math.atan(Math.tan(v) * aspect);
      }
    } catch (e) {}
    return { h, v };
  }
  // Pure: clamp a panel centre into the comfort cone. Returns the new position
  // (or the same coordinates when already inside).
  function earthGazeClamp(pos, head, fwd, halfW, halfH, fov, comfort) {
    const k = comfort === undefined ? 0.8 : comfort;
    const vx = pos.x - head.x, vy = pos.y - head.y, vz = pos.z - head.z;
    const d = Math.hypot(vx, vy, vz);
    if (!(d > 0.05)) return { x: pos.x, y: pos.y, z: pos.z, clamped: false };
    // Head basis: f forward, r = f × up, u = r × f (level-roll assumption).
    let rx = -fwd.z, rz = fwd.x; // right = forward × up
    let rl = Math.hypot(rx, rz);
    if (rl < 1e-4) { rx = 1; rz = 0; rl = 1; }
    rx /= rl; rz /= rl;
    const ux = -rz * fwd.y, uy = rz * fwd.x - rx * fwd.z, uz = rx * fwd.y;
    const x = vx * rx + vz * rz;
    const y = vx * ux + vy * uy + vz * uz;
    const z = vx * fwd.x + vy * fwd.y + vz * fwd.z;
    const yaw = Math.atan2(x, z);
    const pitch = Math.atan2(y, Math.hypot(x, z));
    const halfYaw = Math.atan(halfW / d), halfPitch = Math.atan(halfH / d);
    const yawLim = Math.max(0.04, fov.h * k - halfYaw);
    const pitchLim = Math.max(0.04, fov.v * k - halfPitch);
    const cy = Math.max(-yawLim, Math.min(yawLim, yaw));
    const cp = Math.max(-pitchLim, Math.min(pitchLim, pitch));
    if (Math.abs(cy - yaw) < 1e-6 && Math.abs(cp - pitch) < 1e-6) return { x: pos.x, y: pos.y, z: pos.z, clamped: false, yaw, pitch, halfYaw, halfPitch, yawLim };
    const cyaw = Math.cos(cy), syaw = Math.sin(cy), cpit = Math.cos(cp), spit = Math.sin(cp);
    // direction = cp·(sin(cy)·r + cos(cy)·f) + sin(cp)·u
    const dx = cpit * (syaw * rx + cyaw * fwd.x) + spit * ux;
    const dy = cpit * (cyaw * fwd.y) + spit * uy;
    const dz = cpit * (syaw * rz + cyaw * fwd.z) + spit * uz;
    return { x: head.x + dx * d, y: head.y + dy * d, z: head.z + dz * d, clamped: true, yaw: cy, pitch: cp, halfYaw, halfPitch, yawLim };
  }
  // Non-mutating overlap test between a candidate rectangle (centre p, half
  // extents in world metres) and a panel mesh, in the viewer's right/up plane.
  function earthRectOverlapsPanel(p, hw, hh, mesh, mhw, mhh, fwd, gap) {
    if (!mesh || !mesh.position || mesh.visible === false) return false;
    let rx = -fwd.z, rz = fwd.x;
    const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const ux = -rz * fwd.y, uy = rz * fwd.x - rx * fwd.z, uz = rx * fwd.y;
    const ms = (mesh.scale && mesh.scale.x) || 1;
    const dx3 = p.x - mesh.position.x, dy3 = p.y - mesh.position.y, dz3 = p.z - mesh.position.z;
    const dx = dx3 * rx + dz3 * rz, dy = dx3 * ux + dy3 * uy + dz3 * uz;
    return (hw + mhw * ms + (gap || 0.02) - Math.abs(dx)) > 0 && (hh + mhh * ms + (gap || 0.02) - Math.abs(dy)) > 0;
  }

  // Push `mover` out of `fixed` along the axis of least penetration, measured
  // in the viewer's right/up plane, then re-clamp into the comfort cone.
  // `prefer`: 'up' resolves vertical overlaps upward, 'left'/'right' sideways.
  function earthSeparatePanel(mover, mhw, mhh, fixed, fhw, fhh, fwd, head, fov, prefer) {
    if (!mover || !fixed || !mover.position || !fixed.position) return false;
    let rx = -fwd.z, rz = fwd.x;
    const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const ux = -rz * fwd.y, uy = rz * fwd.x - rx * fwd.z, uz = rx * fwd.y;
    const ms = (mover.scale && mover.scale.x) || 1, fs = (fixed.scale && fixed.scale.x) || 1;
    const dx3 = mover.position.x - fixed.position.x, dy3 = mover.position.y - fixed.position.y, dz3 = mover.position.z - fixed.position.z;
    const dx = dx3 * rx + dz3 * rz;
    const dy = dx3 * ux + dy3 * uy + dz3 * uz;
    const gap = 0.025;
    const ox = (mhw * ms + fhw * fs + gap) - Math.abs(dx);
    const oy = (mhh * ms + fhh * fs + gap) - Math.abs(dy);
    if (!(ox > 0 && oy > 0)) return false;
    let mx = 0, my = 0;
    if (prefer === 'up' || prefer === 'down' || oy <= ox) {
      my = prefer === 'up' ? oy : (prefer === 'down' ? -oy : oy * (dy >= 0 ? 1 : -1));
    } else {
      mx = ox * ((prefer === 'left') ? -1 : (prefer === 'right' ? 1 : (dx >= 0 ? 1 : -1)));
    }
    const np = { x: mover.position.x + rx * mx + ux * my, y: mover.position.y + uy * my, z: mover.position.z + rz * mx + uz * my };
    const c = earthGazeClamp(np, head, fwd, mhw * ms, mhh * ms, fov);
    // If lifting leaves the view, slide sideways instead (away from the label).
    if (c.clamped && prefer === 'up') {
      const sx = ox * (dx >= 0 ? 1 : -1);
      const alt = { x: mover.position.x + rx * sx, y: mover.position.y, z: mover.position.z + rz * sx };
      const c2 = earthGazeClamp(alt, head, fwd, mhw * ms, mhh * ms, fov);
      mover.position.set(c2.x, c2.y, c2.z);
      return true;
    }
    mover.position.set(c.x, c.y, c.z);
    return true;
  }

  // ─── Keep-out zones ──────────────────────────────────────────────────────
  // Panels must never sit on the thing the user is looking AT: the focused map
  // point (zoom anchor) and the hovered / selected zone's pin. Zones are
  // circles in world space; overlap is tested in the viewer's angular space
  // (perspective-correct) and resolved by sliding the panel up first, then
  // sideways, staying inside the comfort cone.
  function earthPinWorld(loc) {
    try {
      const center = earthLiveCenter();
      const dir = qRotate(earthQuat, earthRenderedDirection(loc.lat, loc.lon));
      const R = earthVisibleRadius(earthZoom);
      const head = getHeadPosition();
      // Back-side pins are hidden by the planet: no keep-out needed.
      const facing = dir.x * (head.x - center.x) + dir.y * (head.y - center.y) + dir.z * (head.z - center.z);
      if (facing <= 0) return null;
      const lift = 0.05; // pins stand ~7 cm off the surface
      return { x: center.x + dir.x * (R + lift), y: center.y + dir.y * (R + lift), z: center.z + dir.z * (R + lift) };
    } catch (e) { return null; }
  }
  function earthHudKeepOuts() {
    const out = [];
    try {
      if (earthZoomAnchor && earthZoom > 1.02) out.push({ x: earthZoomAnchor.x, y: earthZoomAnchor.y + 0.03, z: earthZoomAnchor.z, r: 0.11 });
      const idxs = [earthHoveredIndex, earthSelectedIndex];
      for (const idx of idxs) {
        if (idx >= 0 && idx < earthLocations.length) {
          const w = earthPinWorld(earthLocations[idx]);
          if (w) out.push({ x: w.x, y: w.y, z: w.z, r: 0.12 });
        }
      }
    } catch (e) {}
    return out;
  }
  function earthViewAngles(p, head, fwd) {
    const vx = p.x - head.x, vy = p.y - head.y, vz = p.z - head.z;
    const d = Math.hypot(vx, vy, vz) || 1e-6;
    let rx = -fwd.z, rz = fwd.x;
    const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const ux = -rz * fwd.y, uy = rz * fwd.x - rx * fwd.z, uz = rx * fwd.y;
    const x = vx * rx + vz * rz;
    const y = vx * ux + vy * uy + vz * uz;
    const z = vx * fwd.x + vy * fwd.y + vz * fwd.z;
    return { yaw: Math.atan2(x, z), pitch: Math.atan2(y, Math.hypot(x, z)), d, r: { x: rx, z: rz }, u: { x: ux, y: uy, z: uz } };
  }
  function earthAnglesToPos(yaw, pitch, d, head, fwd) {
    let rx = -fwd.z, rz = fwd.x;
    const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const ux = -rz * fwd.y, uy = rz * fwd.x - rx * fwd.z, uz = rx * fwd.y;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const dx = cp * (sy * rx + cy * fwd.x) + sp * ux;
    const dy = cp * (cy * fwd.y) + sp * uy;
    const dz = cp * (sy * rz + cy * fwd.z) + sp * uz;
    return { x: head.x + dx * d, y: head.y + dy * d, z: head.z + dz * d };
  }
  // Move `mesh` off every keep-out circle. Returns true if it moved.
  // `prefer`: 'up' (breadcrumb: sits above what you look at) or 'side'.
  function earthAvoidKeepOuts(mesh, hw, hh, keeps, fwd, head, fov, prefer) {
    if (!mesh || !mesh.position || !keeps || !keeps.length) return false;
    let moved = false;
    for (let pass = 0; pass < 2; pass++) {
      let again = false;
      for (const k of keeps) {
        const sc = (mesh.scale && mesh.scale.x) || 1;
        const a = earthViewAngles(mesh.position, head, fwd);
        const b = earthViewAngles(k, head, fwd);
        const hwA = Math.atan((hw * sc) / a.d), hhA = Math.atan((hh * sc) / a.d), kr = Math.atan(k.r / b.d);
        const gap = 0.012;
        const ox = hwA + kr + gap - Math.abs(a.yaw - b.yaw);
        const oy = hhA + kr + gap - Math.abs(a.pitch - b.pitch);
        if (!(ox > 0 && oy > 0)) continue;
        const sideSign = (a.yaw - b.yaw) >= 0 ? 1 : -1;
        const cands = [];
        const upC = { yaw: a.yaw, pitch: b.pitch + kr + hhA + gap };
        const sideC = { yaw: b.yaw + sideSign * (kr + hwA + gap), pitch: a.pitch };
        const sideO = { yaw: b.yaw - sideSign * (kr + hwA + gap), pitch: a.pitch };
        if (prefer === 'up') cands.push(upC, sideC, sideO); else cands.push(sideC, upC, sideO);
        let placed = null;
        for (const c of cands) {
          const pos = earthAnglesToPos(c.yaw, c.pitch, a.d, head, fwd);
          const cl = earthGazeClamp(pos, head, fwd, hw * sc, hh * sc, fov);
          if (!cl.clamped) { placed = pos; break; }
        }
        if (!placed) {
          // Nothing fits cleanly: take the preferred one, clamped into view.
          const c = cands[0];
          const pos = earthAnglesToPos(c.yaw, c.pitch, a.d, head, fwd);
          const cl = earthGazeClamp(pos, head, fwd, hw * sc, hh * sc, fov);
          placed = { x: cl.x, y: cl.y, z: cl.z };
        }
        mesh.position.set(placed.x, placed.y, placed.z);
        moved = true; again = true;
      }
      if (!again) break;
    }
    return moved;
  }

  const earthHudSlide = { label: null, preview: null };
  function earthHudApply(mesh, key, halfW, halfH, fwd, head, fov) {
    if (!mesh || !mesh.position) return;
    const sc = (mesh.scale && mesh.scale.x) || 1;
    const want = earthGazeClamp(mesh.position, head, fwd, halfW * sc, halfH * sc, fov);
    if (want.clamped) mesh.position.set(want.x, want.y, want.z);
  }
  // Glide: everything the placement pass changed (clamp + keep-out + separation)
  // is applied as a smoothed offset from the anchored position, so panels ease
  // aside instead of popping when a pin, card or head turn forces a move.
  function earthHudGlide(mesh, key, d0, dtSec) {
    if (!mesh || !mesh.position || !d0) return;
    let st = earthHudSlide[key];
    if (!st) st = earthHudSlide[key] = { x: 0, y: 0, z: 0 };
    const a = 1 - Math.exp(-Math.max(0.001, dtSec) / 0.12);
    st.x += ((mesh.position.x - d0.x) - st.x) * a;
    st.y += ((mesh.position.y - d0.y) - st.y) * a;
    st.z += ((mesh.position.z - d0.z) - st.z) * a;
    mesh.position.set(d0.x + st.x, d0.y + st.y, d0.z + st.z);
  }
  let earthGazeVec = null;
  let earthHudLastT = -1;
  function earthHudGazeSafe(time) {
    try {
      const dt = earthHudLastT < 0 ? 0.016 : Math.max(0.001, Math.min(0.1, (time - earthHudLastT) / 1000));
      earthHudLastT = time;
      const head = getHeadPosition();
      const fwd = earthHeadForward();
      const fov = earthViewHalfFov();
      const keeps = earthHudKeepOuts();
      const cardUp = !!(earthPreviewMesh && earthPreviewMesh.visible);
      const d0Label = earthLabelMesh ? { x: earthLabelMesh.position.x, y: earthLabelMesh.position.y, z: earthLabelMesh.position.z } : null;
      const d0Card = cardUp ? { x: earthPreviewMesh.position.x, y: earthPreviewMesh.position.y, z: earthPreviewMesh.position.z } : null;
      // 1) Clamp each panel into the comfort cone.
      earthHudApply(earthLabelMesh, 'label', EARTH_LABEL_HALF_W, EARTH_LABEL_HALF_H, fwd, head, fov);
      if (cardUp) earthHudApply(earthPreviewMesh, 'preview', 0.25, 0.35, fwd, head, fov);
      // 2) The focused point / hovered pin always wins: nothing covers it.
      if (earthLabelMesh) earthAvoidKeepOuts(earthLabelMesh, EARTH_LABEL_HALF_W, EARTH_LABEL_HALF_H, keeps, fwd, head, fov, 'up');
      if (cardUp) earthAvoidKeepOuts(earthPreviewMesh, 0.25, 0.35, keeps, fwd, head, fov, 'side');
      // 3) Panels must not stack. Lift the card off the breadcrumb; if the top
      //    of the view refuses, slide the breadcrumb SIDEWAYS (never down onto
      //    the pin), then re-check the keep-out once more.
      if (cardUp && earthLabelMesh) {
        earthSeparatePanel(earthPreviewMesh, 0.25, 0.35, earthLabelMesh, EARTH_LABEL_HALF_W, EARTH_LABEL_HALF_H, fwd, head, fov, 'up');
        earthAvoidKeepOuts(earthPreviewMesh, 0.25, 0.35, keeps, fwd, head, fov, 'side');
        const ls = earthLabelMesh.scale.x || 1;
        if (earthRectOverlapsPanel(earthLabelMesh.position, EARTH_LABEL_HALF_W * ls, EARTH_LABEL_HALF_H * ls, earthPreviewMesh, 0.25, 0.35, fwd, 0.02)) {
          earthSeparatePanel(earthLabelMesh, EARTH_LABEL_HALF_W, EARTH_LABEL_HALF_H, earthPreviewMesh, 0.25, 0.35, fwd, head, fov, 'left');
          earthAvoidKeepOuts(earthLabelMesh, EARTH_LABEL_HALF_W, EARTH_LABEL_HALF_H, keeps, fwd, head, fov, 'side');
        }
      }
      earthHudKeeps = keeps;
      // 4) Ease into the resolved layout.
      earthHudGlide(earthLabelMesh, 'label', d0Label, dt);
      if (cardUp) earthHudGlide(earthPreviewMesh, 'preview', d0Card, dt);
      if (earthLabelMesh) earthLabelMesh.lookAt(head.x, head.y, head.z);
      if (cardUp) earthPreviewMesh.lookAt(head.x, head.y, head.z);
    } catch (e) {}
  }
  let earthHudKeeps = [];

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
        if (earthLabelMesh) {
          earthLabelMesh.position.set(center.x, center.y + EARTH_RADIUS + 0.28, center.z);
          earthLabelMesh.scale.set(1, 1, 1);
        }
        if (earthPreviewMesh) {
          earthPreviewMesh.position.set(center.x + 0.94, center.y + 0.17, center.z);
          earthPreviewMesh.scale.set(1, 1, 1);
        }
      } else {
        // Zoomed: place panels strictly in front of the earth toward the head,
        // scaled comfortably to the viewer distance (never clipped by the sphere).
        const R = earthVisibleRadius(S);
        let sx, sy, sz;
        if (earthZoomAnchor) {
          sx = earthZoomAnchor.x;
          sy = earthZoomAnchor.y;
          sz = earthZoomAnchor.z;
        } else {
          let fx = head.x - center.x, fy = head.y - center.y, fz = head.z - center.z;
          const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
          fx /= fl; fy /= fl; fz /= fl;
          sx = center.x + fx * R;
          sy = center.y + fy * R;
          sz = center.z + fz * R;
        }

        // Line-of-sight vector from surface towards the viewer's head:
        const vx = head.x - sx, vy = head.y - sy, vz = head.z - sz;
        const distToHead = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
        const fwdX = vx / distToHead, fwdY = vy / distToHead, fwdZ = vz / distToHead;

        // Camera-plane right and up vectors:
        let rx = fwdZ, ry = 0, rz = -fwdX;
        let rl = Math.hypot(rx, rz);
        if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
        rx /= rl; rz /= rl;

        let ux = fwdY * rz - fwdZ * ry;
        let uy = fwdZ * rx - fwdX * rz;
        let uz = fwdX * ry - fwdY * rx;
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;

        // Scale appropriately based on viewer distance:
        const distRatio = distToHead / 1.15;
        const labelScale = Math.max(0.65, Math.min(1.2, distRatio * 0.85));
        const previewScale = Math.max(0.55, Math.min(1.15, distRatio * 0.75));

        // Location label sits cleanly above the focal spot in front of the earth:
        const fwdOffsetLabel = Math.min(0.25, Math.max(0.14, distToHead * 0.16));
        const upOffsetLabel = 0.28 + (labelScale - 0.7) * 0.1;
        if (earthLabelMesh) {
          earthLabelMesh.position.set(
            sx + fwdX * fwdOffsetLabel + ux * upOffsetLabel,
            sy + fwdY * fwdOffsetLabel + uy * upOffsetLabel,
            sz + fwdZ * fwdOffsetLabel + uz * upOffsetLabel
          );
          earthLabelMesh.scale.set(labelScale, labelScale, labelScale);
        }

        // Preview panel sits to the right, elevated so its bottom edge never touches the sphere:
        const rightOffsetPreview = 0.52 * previewScale + 0.15;
        const halfHeight = 0.35 * previewScale;
        const upOffsetPreview = halfHeight + 0.08;
        const fwdOffsetPreview = fwdOffsetLabel + 0.04;
        if (earthPreviewMesh) {
          earthPreviewMesh.position.set(
            sx + fwdX * fwdOffsetPreview + rx * rightOffsetPreview + ux * upOffsetPreview,
            sy + fwdY * fwdOffsetPreview + ry * rightOffsetPreview + uy * upOffsetPreview,
            sz + fwdZ * fwdOffsetPreview + rz * rightOffsetPreview + uz * upOffsetPreview
          );
          earthPreviewMesh.scale.set(previewScale, previewScale, previewScale);
        }
      }
      if (earthLabelMesh) earthLabelMesh.lookAt(head.x, head.y, head.z);
      if (earthPreviewMesh && earthPreviewMesh.visible) {
        // Step 6.2: soft-spring yaw keeps the street preview inside the
        // binocular field on sideways glances (±15° orbit, never head-locked).
        // The panel orbits the surface anchor (sx,sy,sz); at globe scale there
        // is no anchor, so only the spring state tracks (no positional shift).
        const prevYaw = earthPreviewYawOffset;
        earthPreviewYawOffset = stepEarthPreviewYaw(headYawAngle(), time);
        const yawDelta = earthPreviewYawOffset - prevYaw;
        if (yawDelta !== 0 && Number.isFinite(sx) && Number.isFinite(sz)) {
          try {
            const ox = earthPreviewMesh.position.x - sx;
            const oz = earthPreviewMesh.position.z - sz;
            const c = Math.cos(yawDelta), s = Math.sin(yawDelta);
            earthPreviewMesh.position.x = sx + ox * c - oz * s;
            earthPreviewMesh.position.z = sz + ox * s + oz * c;
          } catch (e) {}
        }
        earthPreviewMesh.lookAt(head.x, head.y, head.z);
      }
      earthHudGazeSafe(time);
    } catch (e) {}
    if (earthPinsGroup) {
      try {
        const invZoom = EARTH_RADIUS / Math.max(EARTH_RADIUS, earthVisibleRadius(earthZoom));
        const surfaceRadius = EARTH_RADIUS + 0.035 / Math.max(1, earthVisibleRadius(earthZoom) / EARTH_RADIUS);
        const kids = earthPinsGroup.children;
        const pinUp = new THREE.Vector3(0, 1, 0);
        for (let i = 0; i < kids.length; i++) {
          const p = kids[i];
          const base = p.userData.baseScale || 1;
          const pulse = reducedMotion
            ? 1
            : (1 + 0.22 * Math.sin(time * 0.003 + (p.userData.pulsePhase || 0)));
          // Re-seat in the LIVE warp frame every frame: cones ride the zoom
          // continuously (no rebuild lag). Same earthRenderedDirection the
          // rebuild uses, so settled frames are bit-identical.
          const row = p.userData.location;
          if (row && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon))) {
            try {
              const u = earthRenderedDirection(row.lat, row.lon);
              p.position.set(u.x * surfaceRadius, u.y * surfaceRadius, u.z * surfaceRadius);
              p.quaternion.setFromUnitVectors(pinUp, new THREE.Vector3(u.x, u.y, u.z).normalize());
            } catch (e2) {}
          }
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
    // Limb glow breathes with table tilt (stronger once the map lies "flat").
    if (earthAtmosphereMesh && earthAtmosphereMesh.material) {
      try {
        earthAtmosphereMesh.material.opacity = sceneMode === 'earth' ? 0.30 + tableTilt(earthZoom) * 0.10 : 0;
      } catch (e) {}
    }
    refreshEarthTexture();
    refreshEarthLabel();
    updateEarthTiles(time);
    ensureEarthBezel();
    updateEarthBezel();
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
    // Geographic anchors must use the actual visible surface, not an inflated
    // hover shell: even a constant 5 cm shell introduces oblique-ray parallax.
    const liveRadius = earthVisibleRadius(earthZoom);
    const hitDist = raySphereHit(rayOrigin, rayDir, liveCenter, liveRadius);
    if (hitDist <= 0) return { hit: false, dist: -1, zoneIndex: -1 };

    const hitP = {
      x: rayOrigin.x + rayDir.x * hitDist,
      y: rayOrigin.y + rayDir.y * hitDist,
      z: rayOrigin.z + rayDir.z * hitDist,
    };

    // Unrotate the rendered surface, then inverse-warp exactly once.
    let local = earthLocalFromWorld(hitP);
    let rendered = local;
    if (earthFocus && earthZoom > 1.0001) {
      rendered = local;
      const geographic = earthUnwarpLocal(rendered, earthZoom, locationToUnit(earthFocus.lat, earthFocus.lon));
      if (earthWarpCapFade(rendered, earthZoom) <= 0) return { hit: false, dist: -1, zoneIndex: -1 };
      local = geographic;
    }

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
      renderedLocal: rendered || local,
      ray: { origin: { ...rayOrigin }, direction: { ...rayDir } },
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

  const EARTH_WARP_EXPONENT = 0.45;
  const EARTH_WARP_MAX_RADIUS = 6;
  const EARTH_TABLE_TILT_MAX = 55 * Math.PI / 180;
  const EARTH_TABLE_TILT_LO = 2;
  const EARTH_TABLE_TILT_HI = 16;

  function qNormalize(q) {
    const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
  }
  function qMultiply(a, b) {
    return qNormalize({
      x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
      y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
      z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
      w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    });
  }
  function qConjugate(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
  function qRotate(q, v) {
    const r = qMultiply(qMultiply(q, { x: v.x, y: v.y, z: v.z, w: 0 }), qConjugate(q));
    return { x: r.x, y: r.y, z: r.z };
  }
  function qFromAxisAngle(axis, angle) {
    const h = angle * 0.5, s = Math.sin(h);
    return qNormalize({ x: axis.x*s, y: axis.y*s, z: axis.z*s, w: Math.cos(h) });
  }
  function qFromUnitVectors(from, to) {
    const a = earthSafeUnit(from, { x:0, y:0, z:1 });
    const b = earthSafeUnit(to, { x:0, y:0, z:1 });
    const dot = Math.max(-1, Math.min(1, vDot(a, b)));
    if (dot > 1 - 1e-10) return { x:0, y:0, z:0, w:1 };
    if (dot < -1 + 1e-10) {
      const axis = Math.abs(a.x) < 0.8 ? vNorm(vCross(a, { x:1, y:0, z:0 })) : vNorm(vCross(a, { x:0, y:1, z:0 }));
      return qFromAxisAngle(axis, Math.PI);
    }
    return qNormalize({ x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x, w: 1 + dot });
  }
  function qFromBasis(east, north, normal) {
    const m00=east.x, m01=north.x, m02=normal.x;
    const m10=east.y, m11=north.y, m12=normal.y;
    const m20=east.z, m21=north.z, m22=normal.z;
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      return qNormalize({ x:(m21-m12)/s, y:(m02-m20)/s, z:(m10-m01)/s, w:0.25*s });
    }
    if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1+m00-m11-m22)*2;
      return qNormalize({ x:0.25*s, y:(m01+m10)/s, z:(m02+m20)/s, w:(m21-m12)/s });
    }
    if (m11 > m22) {
      const s = Math.sqrt(1+m11-m00-m22)*2;
      return qNormalize({ x:(m01+m10)/s, y:0.25*s, z:(m12+m21)/s, w:(m02-m20)/s });
    }
    const s = Math.sqrt(1+m22-m00-m11)*2;
    return qNormalize({ x:(m02+m20)/s, y:(m12+m21)/s, z:0.25*s, w:(m10-m01)/s });
  }
  function qSlerp(a, b, t) {
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    let d = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (d > 0.9995) {
      return qNormalize({ x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t, z: a.z + (bz - a.z) * t, w: a.w + (bw - a.w) * t });
    }
    const th = Math.acos(d), sn = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / sn, wb = Math.sin(t * th) / sn;
    return qNormalize({ x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb });
  }
  // Same rotation axis, angle scaled by t (t ∈ [0, 1] eases toward q).
  function qScaleAngle(q, t) {
    const w = Math.max(-1, Math.min(1, q.w));
    const sign = w < 0 ? -1 : 1;
    const half = Math.acos(w * sign);
    const s = Math.sin(half);
    if (s < 1e-9) return { x: 0, y: 0, z: 0, w: 1 };
    return qFromAxisAngle({ x: q.x * sign / s, y: q.y * sign / s, z: q.z * sign / s }, 2 * half * t);
  }
  // Inverse of R = Ry(yaw)·Rx(pitch)·Rz(roll) (three.js 'YXZ' Euler order).
  function earthEulerYXZ(q) {
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const m11 = 1 - 2 * (y * y + z * z), m13 = 2 * (x * z + w * y);
    const m21 = 2 * (x * y + w * z), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x);
    const m31 = 2 * (x * z - w * y), m33 = 1 - 2 * (x * x + y * y);
    const pitch = Math.asin(-Math.max(-1, Math.min(1, m23)));
    if (Math.abs(m23) < 0.9999999) return { yaw: Math.atan2(m13, m33), pitch, roll: Math.atan2(m21, m22) };
    return { yaw: Math.atan2(-m31, m11), pitch, roll: 0 };
  }
  function vDot(a,b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
  function vCross(a,b) { return { x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x }; }
  function vLen(v) { return Math.hypot(v.x, v.y, v.z); }
  function vNorm(v) {
    const l = vLen(v);
    return l > 1e-12 && Number.isFinite(l) ? { x:v.x/l, y:v.y/l, z:v.z/l } : { x:0, y:0, z:0 };
  }
  function earthSafeUnit(v, fallback) {
    const n = vNorm(v || { x:0, y:0, z:0 });
    return vLen(n) > 0 ? n : vNorm(fallback || { x:0, y:0, z:1 });
  }
  function vSub(a,b) { return { x:a.x-b.x, y:a.y-b.y, z:a.z-b.z }; }
  function vScale(v,s) { return { x:v.x*s, y:v.y*s, z:v.z*s }; }
  function earthVisibleRadius(scale) {
    const s = Math.max(1, Number(scale) || 1);
    return Math.min(EARTH_WARP_MAX_RADIUS, EARTH_RADIUS * Math.pow(s, EARTH_WARP_EXPONENT));
  }
  function earthWarpK(scale) {
    return Math.max(1, EARTH_RADIUS * Math.max(1, Number(scale) || 1) / earthVisibleRadius(scale));
  }
  // Warp ramp (feel fix): the full angular magnification k only engages once
  // map tiles arrive (crossfade band S∈[4,8]). At and below S=2 the globe is
  // EXACT (k_eff=1, zero distortion, curvature intact); S∈[2,4] blends in
  // log-space. Without this, even a mild k visibly smears the low-res base
  // texture and balloons heat blobs across the pre-tile zooms, where nothing
  // covers the distortion. earthWarpK stays the pure contract (tests pin it);
  // every render path below uses the effective value.
  // Tiles-absent stand-down: while the tile layer is degraded, disabled, or
  // offline, magnification serves no map detail, so k_eff stays 1 and zooming
  // just grows a clean undistorted globe (heat/pins/hits stay exactly where
  // the globe look expects them). Warp returns with the crossfade when tiles
  // recover. Checked live (not just at plan time) so degrade/re-probe flips
  // take effect mid-zoom.
  function earthWarpTilesLive() {
    try {
      return !!(earthTileAvailable && debugFlags.earthmap);
    } catch (e) { return true; }
  }
  function earthEffectiveK(scale) {
    const s = Math.max(1, Number(scale) || 1);
    if (s <= 2) return 1;
    if (!earthWarpTilesLive()) return 1;
    const k = earthWarpK(s);
    if (s >= 4) return k;
    const t = (Math.log2(s) - 1); // 0→1 across S∈[2,4]
    const e = t * t * (3 - 2 * t); // smoothstep
    return 1 + (k - 1) * e;
  }
  // Warp a geographic direction around the focused point. The focus is
  // magnified as a map, while the visible sphere remains a small curved body.
  // Shared CPU/GLSL contract. The half-angle form is bijective on the full
  // sphere: unlike the old tan(0.49π) clamp it preserves the antipode and
  // never folds the far side into a near-side strip.
  function earthWarpLocal(local, scale, focusLocal) {
    const f = earthSafeUnit(focusLocal, { x:0, y:0, z:1 });
    const n = earthSafeUnit(local, f);
    const k = earthEffectiveK(scale);
    if (k === 1) return n;
    const d = Math.max(-1, Math.min(1, vDot(f, n)));
    if (d > 1 - 1e-12 || d < -1 + 1e-12) return d < 0 ? vScale(f, -1) : f;
    const tangent = earthSafeUnit(vSub(n, vScale(f, d)), { x:1, y:0, z:0 });
    const angle = 2 * Math.atan2(Math.sqrt(Math.max(0, 1 - d)), Math.sqrt(Math.max(0, 1 + d)));
    const warped = 2 * Math.atan(k * Math.tan(angle * 0.5));
    return earthSafeUnit({
      x:f.x*Math.cos(warped)+tangent.x*Math.sin(warped),
      y:f.y*Math.cos(warped)+tangent.y*Math.sin(warped),
      z:f.z*Math.cos(warped)+tangent.z*Math.sin(warped),
    }, f);
  }
  function earthUnwarpLocal(local, scale, focusLocal) {
    const f = earthSafeUnit(focusLocal, { x:0, y:0, z:1 });
    const n = earthSafeUnit(local, f);
    const k = earthEffectiveK(scale);
    if (k === 1) return n;
    const d = Math.max(-1, Math.min(1, vDot(f, n)));
    if (d > 1 - 1e-12 || d < -1 + 1e-12) return d < 0 ? vScale(f, -1) : f;
    const tangent = earthSafeUnit(vSub(n, vScale(f, d)), { x:1, y:0, z:0 });
    const angle = 2 * Math.atan2(Math.sqrt(Math.max(0, 1 - d)), Math.sqrt(Math.max(0, 1 + d)));
    const unwarped = 2 * Math.atan2(Math.tan(angle * 0.5) / k, 1);
    return earthSafeUnit({
      x:f.x*Math.cos(unwarped)+tangent.x*Math.sin(unwarped),
      y:f.y*Math.cos(unwarped)+tangent.y*Math.sin(unwarped),
      z:f.z*Math.cos(unwarped)+tangent.z*Math.sin(unwarped),
    }, f);
  }
  function earthWarpCapFade(local, scale, focusLocal) {
    if (Math.max(1, Number(scale) || 1) <= 1.000001) return 1;
    // No magnification → no cap: the full globe stays rendered + hittable
    // (low zooms inside the ramp, and tiles-absent zoom where the undistorted
    // globe is the whole experience).
    if (earthEffectiveK(scale) <= 1) return 1;
    const focus = focusLocal || (earthFocus ? locationToUnit(earthFocus.lat, earthFocus.lon) : { x:0, y:0, z:1 });
    const d = Math.max(-1, Math.min(1, vDot(earthSafeUnit(local), earthSafeUnit(focus))));
    const angle = Math.acos(d);
    return 1 - Math.max(0, Math.min(1, (angle - Math.PI * 0.5) / (Math.PI * (10 / 180))));
  }
  function installEarthWarpShader(material) {
    if (!material) return;
    material.userData = material.userData || {};
    // Cap contract shared with CPU earthWarpCapFade: rendered fade 90°→100°.
    // Exposed as uniforms (not hardcoded GLSL) so CPU/GLSL stay in sync.
    const uniforms = {
      uEarthFocus: { value: { x: 0, y: 0, z: 1 } },
      uEarthK: { value: 1 },
      uEarthWarpEnabled: { value: 0 },
      uEarthAdaptive: { value: 0 },
      uEarthCapStart: { value: Math.PI * 0.5 },
      uEarthCapEnd: { value: Math.PI * (100 / 180) },
    };
    material.userData.earthWarpUniforms = uniforms;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uEarthFocus = uniforms.uEarthFocus;
      shader.uniforms.uEarthK = uniforms.uEarthK;
      shader.uniforms.uEarthWarpEnabled = uniforms.uEarthWarpEnabled;
      shader.uniforms.uEarthAdaptive = uniforms.uEarthAdaptive;
      shader.uniforms.uEarthCapStart = uniforms.uEarthCapStart;
      shader.uniforms.uEarthCapEnd = uniforms.uEarthCapEnd;
      shader.vertexShader = 'uniform vec3 uEarthFocus; uniform float uEarthK; uniform float uEarthWarpEnabled; uniform float uEarthAdaptive; attribute vec3 earthRendered; varying vec3 vEarthRendered; varying vec3 vEarthGeo;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', `
          vec3 earthGeo = normalize(position);
          vEarthGeo = position;
          float earthDot = clamp(dot(uEarthFocus, earthGeo), -1.0, 1.0);
          vec3 earthTangent = earthGeo - uEarthFocus * earthDot;
          float earthTangentLen = length(earthTangent);
          earthTangent = earthTangentLen > 0.000001 ? earthTangent / earthTangentLen : vec3(1.0, 0.0, 0.0);
          float earthAngle = 2.0 * atan(sqrt(max(0.0, 1.0 - earthDot)), sqrt(max(0.0, 1.0 + earthDot)));
          float earthWarped = 2.0 * atan(uEarthK * tan(earthAngle * 0.5));
          vec3 earthWarpedDir = uEarthWarpEnabled > 0.5
            ? normalize(uEarthFocus * cos(earthWarped) + earthTangent * sin(earthWarped))
            : earthGeo;
          // Inverse-mapped geographic positions retain UV meaning. Their
          // exact rendered counterpart avoids catastrophic float cancellation
          // near the focus at k≈1846; do not warp that attribute a second time.
          vec3 transformed = uEarthAdaptive > 0.5 ? earthRendered : earthWarpedDir * length(position);
          vEarthRendered = normalize(transformed);
        `);
      // Equirect lookup per fragment from the interpolated geographic
      // direction. Per-vertex UVs interpolate linearly across each triangle,
      // which smears and swirls the map wherever longitude turns fast — every
      // triangle near a pole. u = lon/2π + 0.5 folds in both the vertex UV
      // (+0.25) and the texture offset (+0.25). Gradients come from whichever
      // of two u parameterisations is continuous here, so the dateline seam
      // never drops to the smallest mip.
      shader.fragmentShader = 'uniform vec3 uEarthFocus; uniform float uEarthWarpEnabled; uniform float uEarthCapStart; uniform float uEarthCapEnd; varying vec3 vEarthRendered; varying vec3 vEarthGeo;\n' +
        shader.fragmentShader.replace('#include <map_fragment>', `
          #ifdef USE_MAP
            vec3 earthTexDir = normalize(vEarthGeo);
            float earthU = length(earthTexDir.xz) > 1e-7
              ? atan(earthTexDir.x, earthTexDir.z) * 0.15915494309 + 0.5 : 0.5;
            float earthV = asin(clamp(earthTexDir.y, -1.0, 1.0)) * 0.31830988618 + 0.5;
            float earthUAlt = fract(earthU + 0.5) - 0.5;
            vec2 earthDx = vec2(dFdx(earthU), dFdx(earthV));
            vec2 earthDy = vec2(dFdy(earthU), dFdy(earthV));
            vec2 earthDxAlt = vec2(dFdx(earthUAlt), earthDx.y);
            vec2 earthDyAlt = vec2(dFdy(earthUAlt), earthDy.y);
            bool earthUseAlt = max(abs(earthDxAlt.x), abs(earthDyAlt.x)) < max(abs(earthDx.x), abs(earthDy.x));
            vec4 sampledDiffuseColor = textureGrad(map, vec2(earthU, earthV),
              earthUseAlt ? earthDxAlt : earthDx, earthUseAlt ? earthDyAlt : earthDy);
            diffuseColor *= sampledDiffuseColor;
          #endif
        `).replace('#include <opaque_fragment>', `
          float earthCapAngle = acos(clamp(dot(normalize(vEarthRendered), uEarthFocus), -1.0, 1.0));
          float earthCapFade = uEarthWarpEnabled > 0.5 ? 1.0 - smoothstep(uEarthCapStart, uEarthCapEnd, earthCapAngle) : 1.0;
          if (earthCapFade <= 0.001) discard;
          diffuseColor.a *= earthCapFade;
          #include <opaque_fragment>
        `);
    };
    material.customProgramCacheKey = () => 'earth-half-angle-adaptive-v5';
  }

  function updateEarthBaseGeometry() {
    if (!earthMesh || !THREE) return;
    if (!earthFocus || earthZoom <= 1.0001) {
      earthMesh.geometry = earthLegacyGeometry;
      return;
    }
    if (!earthAdaptiveGeometry) {
      const sphere = new THREE.SphereGeometry(EARTH_RADIUS, 64, 48);
      earthAdaptiveGeometry = sphere.toNonIndexed();
      sphere.dispose();
      earthAdaptiveTemplate = earthAdaptiveGeometry.attributes.position.array.slice();
      earthAdaptiveGeometry.setAttribute('earthRendered', new THREE.BufferAttribute(new Float32Array(earthAdaptiveTemplate.length), 3));
      // Bounds must describe shader output, not its tiny geographic source cap.
      earthAdaptiveGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EARTH_RADIUS);
    }
    const key = earthZoom + ':' + earthFocus.lat + ':' + earthFocus.lon + ':' + (earthEffectiveK(earthZoom) > 1 ? 'w' : 'g');
    if (key !== earthAdaptiveKey) {
      earthAdaptiveKey = key;
      const basis = earthGeographicBasis(earthFocus.lat, earthFocus.lon);
      const position = earthAdaptiveGeometry.attributes.position;
      const rendered = earthAdaptiveGeometry.attributes.earthRendered;
      const normal = earthAdaptiveGeometry.attributes.normal;
      const uv = earthAdaptiveGeometry.attributes.uv;
      for (let i = 0; i < position.count; i++) {
        const x = earthAdaptiveTemplate[i*3] / EARTH_RADIUS;
        const y = earthAdaptiveTemplate[i*3+1] / EARTH_RADIUS;
        const z = earthAdaptiveTemplate[i*3+2] / EARTH_RADIUS;
        const r = earthSafeUnit({ x:basis.east.x*x+basis.north.x*y+basis.normal.x*z,
          y:basis.east.y*x+basis.north.y*y+basis.normal.y*z,
          z:basis.east.z*x+basis.north.z*y+basis.normal.z*z });
        const g = earthUnwarpLocal(r, earthZoom, basis.normal);
        position.setXYZ(i, g.x*EARTH_RADIUS, g.y*EARTH_RADIUS, g.z*EARTH_RADIUS);
        rendered.setXYZ(i, r.x*EARTH_RADIUS, r.y*EARTH_RADIUS, r.z*EARTH_RADIUS);
        normal.setXYZ(i, r.x, r.y, r.z);
        uv.setXY(i, Math.atan2(g.x, g.z)/(2*Math.PI)+0.25, Math.asin(Math.max(-1, Math.min(1, g.y)))/Math.PI+0.5);
      }
      // Duplicate triangle vertices allow independent longitude unwrapping;
      // a pole takes the midpoint longitude of its two nonpolar neighbours.
      for (let i = 0; i < position.count; i += 3) {
        const us = [uv.getX(i), uv.getX(i+1), uv.getX(i+2)];
        for (let j = 1; j < 3; j++) us[j] += Math.round(us[0]-us[j]);
        for (let j = 0; j < 3; j++) {
          if (Math.abs(uv.getY(i+j)-0.5) > 0.499999) us[j] = (us[(j+1)%3]+us[(j+2)%3])/2;
          uv.setX(i+j, us[j]);
        }
      }
      position.needsUpdate = rendered.needsUpdate = normal.needsUpdate = uv.needsUpdate = true;
    }
    earthMesh.geometry = earthAdaptiveGeometry;
  }

  function updateEarthWarpUniforms() {
    const material = earthMesh && earthMesh.material;
    const uniforms = material && material.userData && material.userData.earthWarpUniforms;
    if (!uniforms) return;
    const focus = earthFocus ? locationToUnit(earthFocus.lat, earthFocus.lon) : { x: 0, y: 0, z: 1 };
    uniforms.uEarthFocus.value = focus;
    uniforms.uEarthK.value = earthEffectiveK(earthZoom);
    uniforms.uEarthWarpEnabled.value = earthFocus && earthEffectiveK(earthZoom) > 1 ? 1 : 0;
    uniforms.uEarthAdaptive.value = earthMesh.geometry === earthAdaptiveGeometry ? 1 : 0;
    if (material.needsUpdate === false) material.needsUpdate = true;
  }

  function tableTilt(scale) {
    const s = Math.max(1, Number(scale) || 1);
    const k = Math.max(0, Math.min(1, (Math.log2(s) - Math.log2(EARTH_TABLE_TILT_LO)) /
      (Math.log2(EARTH_TABLE_TILT_HI) - Math.log2(EARTH_TABLE_TILT_LO))));
    return EARTH_TABLE_TILT_MAX * (k*k*(3-2*k));
  }
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
      if ((earthNorthUp || earthPoseQuat) && earthFocus) {
        // North Up / the top-down quaternion pose own the full pose,
        // including roll. Zoom easing and frame updates must not rebuild it
        // from yaw/pitch telemetry.
      } else if (earthZoom > 1.0001 && earthFocus) {
        // Keep the focused normal exact during zoom/anchor solves. In the
        // default (top-down) mode there is no tilt at all; the legacy table
        // tilt is represented by the map's curved warped surface and by the
        // north-up basis used for pan; changing this normal would move the
        // comfort anchor and make the world swim.
        const qYaw = qFromAxisAngle({x:0,y:1,z:0}, earthYaw || 0);
        const qPitch = qFromAxisAngle({x:1,y:0,z:0}, earthPitch || 0);
        let base = qMultiply(qYaw, qPitch);
        if (earthRoll) base = qMultiply(base, qFromAxisAngle({x:0,y:0,z:1}, earthRoll));
        const normal = qRotate(base, locationToUnit(earthFocus.lat, earthFocus.lon));
        const east = vNorm(vCross({x:0,y:1,z:0}, normal));
        earthQuat = debugFlags.topdown ? base : qMultiply(qFromAxisAngle(east, tableTilt(earthZoom)), base);
      } else {
        const qYaw = qFromAxisAngle({x:0,y:1,z:0}, earthYaw || 0);
        const qPitch = qFromAxisAngle({x:1,y:0,z:0}, earthPitch || 0);
        earthQuat = qMultiply(qYaw, qPitch);
        if (earthRoll) earthQuat = qMultiply(earthQuat, qFromAxisAngle({x:0,y:0,z:1}, earthRoll));
      }
      earthMesh.quaternion.set(earthQuat.x, earthQuat.y, earthQuat.z, earthQuat.w);
    } catch (e) {}
    // Zoomed + focused: re-pin the focus surface point to the comfort anchor
    // so drags pivot the globe around the viewed spot (map-rotate feel)
    // instead of swinging the viewed area on a multi-meter lever arm.
    updateEarthWarpUniforms();
    if (earthFocus && earthZoom > 1.0001) applyEarthZoom();
  }

  // Inverse of Ry(yaw)*Rx(pitch) applied to a world point, yielding
  // normalized fixed-frame local coordinates for zone matching.
  function earthLocalFromWorld(world) {
    const c = earthLiveCenter();
    const local = qRotate(qConjugate(earthQuat), { x: world.x-c.x, y: world.y-c.y, z: world.z-c.z });
    return vNorm(local);
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
  // Band actually streamed around a latitude. A Web Mercator tile spans
  // cos(lat) of an equatorial tile's ground, so at 80° the fixed 7×7 ring
  // covered ~1/6 of the view and the rest fell back to the blurry base globe.
  // Dropping the band by log2(1/cos lat) keeps tiles the same on-screen size
  // (and the ring the same coverage) at every latitude.
  function earthTileZoomAt(lat) {
    const phi = Math.max(-85.05112878, Math.min(85.05112878, Number(lat) || 0)) * Math.PI / 180;
    return Math.max(0, Math.min(17, Math.round(Math.log2(Math.max(1, earthZoom)) + 3.3 + Math.log2(Math.cos(phi)))));
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
  function earthWorldDirection(lat, lon) {
    let local = locationToUnit(lat, lon);
    if (earthFocus && earthZoom > 1.0001) local = earthWarpLocal(local, earthZoom, locationToUnit(earthFocus.lat, earthFocus.lon));
    return qRotate(earthQuat, local);
  }
  function earthRenderedDirection(lat, lon) {
    return earthFocus && earthZoom > 1.0001
      ? earthWarpLocal(locationToUnit(lat, lon), earthZoom, locationToUnit(earthFocus.lat, earthFocus.lon))
      : locationToUnit(lat, lon);
  }

  function earthLiveCenter() {
    if (earthGroup && earthGroup.position) {
      return { x: earthGroup.position.x, y: earthGroup.position.y, z: earthGroup.position.z };
    }
    return earthCenter;
  }

  // Hand a quaternion-owned pose (top-down drag/tracking, North Up) back to
  // yaw/pitch without a jump: decompose it, keep the twist in earthRoll and
  // let advanceEarthZoom ease that to zero.
  function releaseEarthPose() {
    if (!earthPoseQuat && !earthNorthUp) return;
    const e = earthEulerYXZ(earthQuat);
    earthYaw = e.yaw;
    earthPitch = e.pitch;
    earthRoll = e.roll;
    earthPoseQuat = false;
  }

  // Solve yaw/pitch so the rotated focus unit vector faces targetDir (unit,
  // world frame). Pitch candidates are clamped to the existing ±1.2 drag
  // clamp unless the caller passes a wider maxPitch; the one nearest the
  // current pitch wins. Degenerate polar foci keep the current pose (the
  // clamp makes exact polar centering impossible).
  function solveEarthFocusRotation(lat, lon, targetDir, maxPitch) {
    const v = locationToUnit(lat, lon);
    const t = targetDir;
    const bound = Math.max(0.5, Math.min(Math.PI, Number(maxPitch) || 1.2));
    const clampPitch = (p) => Math.max(-bound, Math.min(bound, p));
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
    const visibleRadius = earthVisibleRadius(S);
    try { earthGroup.scale.setScalar(visibleRadius / EARTH_RADIUS); } catch (e) {}
    if (earthPointerZoom && earthFocus && S > 1.0001) {
      const gesture = earthPointerZoom;
      const rayDir = earthSafeUnit(gesture.ray.direction);
      const anchor = { x:gesture.ray.origin.x + rayDir.x*gesture.distance,
        y:gesture.ray.origin.y + rayDir.y*gesture.distance, z:gesture.ray.origin.z + rayDir.z*gesture.distance };
      const dir = qRotate(earthQuat, earthWarpLocal(gesture.geo, S, locationToUnit(earthFocus.lat, earthFocus.lon)));
      earthGroup.position.set(anchor.x-dir.x*visibleRadius, anchor.y-dir.y*visibleRadius, anchor.z-dir.z*visibleRadius);
      earthZoomAnchor = anchor;
    } else if (earthGrabGeo && earthGrabAnchor && S > 1.0001) {
      const dir = qRotate(earthQuat, earthWarpLocal(earthGrabGeo, S, locationToUnit(earthFocus.lat, earthFocus.lon)));
      earthGroup.position.set(earthGrabAnchor.x-dir.x*visibleRadius, earthGrabAnchor.y-dir.y*visibleRadius, earthGrabAnchor.z-dir.z*visibleRadius);
    } else if (earthFocus && earthZoomAnchor && S > 1.0001) {
      const focusLocal = earthGrabGeo || (earthFocus ? locationToUnit(earthFocus.lat, earthFocus.lon) : null);
      const dir = focusLocal ? qRotate(earthQuat, earthFocus ? earthWarpLocal(focusLocal, earthZoom, locationToUnit(earthFocus.lat, earthFocus.lon)) : focusLocal) : null;
      const d = visibleRadius;
      earthGroup.position.set(
        earthZoomAnchor.x - dir.x * d,
        earthZoomAnchor.y - dir.y * d,
        earthZoomAnchor.z - dir.z * d
      );
    } else if (earthGrabGeo && earthGrabAnchor) {
      const renderedGrab = earthFocus ? earthWarpLocal(earthGrabGeo, earthZoom, locationToUnit(earthFocus.lat, earthFocus.lon)) : earthGrabGeo;
      const dir = qRotate(earthQuat, renderedGrab);
      earthGroup.position.set(
        earthGrabAnchor.x - dir.x * visibleRadius,
        earthGrabAnchor.y - dir.y * visibleRadius,
        earthGrabAnchor.z - dir.z * visibleRadius
      );
    } else {
      earthGroup.position.set(earthCenter.x, earthCenter.y, earthCenter.z);
    }
    earthZoomApplied = S;
    updateEarthBaseGeometry();
    updateEarthWarpUniforms();
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
    earthGrabGeo = null;
    earthGrabAnchor = null;
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
    earthFaceAnim = null;
    releaseEarthPose();
    const viewAxis = lockEarthZoomAnchor();
    earthFocus = { lat: Number(lat) || 0, lon: Number(lon) || 0 };
    earthNorthUp = false;
    earthPointerZoom = null;
    // Aim the focus's outward normal BACK along the view axis (toward the
    // head), not along it: with groupPos = anchor − focusDir·R·S this puts
    // the globe center on the far side of the anchor, so the viewer stays
    // outside looking at the near wall head-on. Aiming +viewAxis would
    // strand the center behind the head (inside the ball, map invisible).
    // Top-down mode also relaxes the pitch clamp so high-latitude foci
    // still face exactly.
    const solved = solveEarthFocusRotation(earthFocus.lat, earthFocus.lon,
      { x: -viewAxis.x, y: -viewAxis.y, z: -viewAxis.z },
      earthTopdownWillBeActive(toZoom) ? EARTH_TOPDOWN_MAX_PITCH : undefined);
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
    // Seed the quaternion from the solved pose before the first zoom frame;
    // this keeps the comfort anchor exact even when reduced-motion snaps.
    earthYaw = earthZoomAnim.toYaw;
    earthPitch = earthZoomAnim.toPitch;
    applyEarthRotation();
    if (reducedMotion) advanceEarthZoom(t0); // snaps: k forced to 1
    return toZoom;
  }

  // Continuous zoom (grip+stick / wheel / dock): exponential, toward the
  // facing point when no focus is set yet. Zooming back out to 1 releases
  // the focus so the globe returns to free spin at the docked position.
  function adjustEarthZoom(factor, pointerRay) {
    earthTouchInput();
    earthFaceAnim = null;
    earthFling = { yaw: 0, pitch: 0 };
    const prev = earthZoomTarget;
    const next = clampEarthZoom(prev * (Number(factor) || 1));
    if (next === prev) return earthZoomTarget;
    if (next > 1 && pointerRay && pointerRay.origin && pointerRay.direction) {
      const hit = hitTestEarth(pointerRay.origin, pointerRay.direction);
      if (hit.hit && hit.local) {
        const oldWorld = qRotate(earthQuat, hit.renderedLocal);
        earthFocus = unitToLatLon(hit.local);
        earthQuat = qMultiply(qFromUnitVectors(qRotate(earthQuat, hit.local), oldWorld), earthQuat);
        if (earthMesh) earthMesh.quaternion.set(earthQuat.x,earthQuat.y,earthQuat.z,earthQuat.w);
        earthPointerZoom = { geo: { ...hit.local }, distance: vLen(vSub(hit.point, pointerRay.origin)), ray: { origin: { ...pointerRay.origin }, direction: { ...pointerRay.direction } } };
        earthZoomAnchor = { ...hit.point };
        // The turn above is a pure quaternion edit: keep it authoritative.
        if (earthTopdownWillBeActive(next)) earthPoseQuat = true;
      }
    }
    if (next > 1 && !earthFocus) { earthFocus = earthFacingLatLon(); lockEarthZoomAnchor(); }
    earthZoomTarget = next;
    earthZoomAnim = null; // continuous input supersedes any tap animation
    if (next <= 1) {
      releaseEarthPose();
      earthFocus = null;
      earthZoomAnchor = null;
      earthPointerZoom = null;
      earthGrabGeo = null;
      earthGrabAnchor = null;
    }
    if (reducedMotion) advanceEarthZoom(0);
    return earthZoomTarget;
  }

  // Back to the full globe (dock GLOBE RESET button).
  function earthGeographicBasis(lat, lon) {
    const normal = locationToUnit(lat, lon);
    const phi = Number(lat) * Math.PI / 180;
    const theta = Number(lon) * Math.PI / 180;
    const cosPhi = Math.cos(phi);
    // At the poles longitude has no unique tangent. Choose +X east so the
    // result is deterministic and continuous for every repeated reset.
    const east = Math.abs(cosPhi) > 1e-8
      ? { x: Math.cos(theta), y: 0, z: -Math.sin(theta) }
      : { x: 1, y: 0, z: 0 };
    return { east, north: vNorm(vCross(normal, east)), normal };
  }

  // Pose that puts (lat, lon) on the view normal with its north tangent
  // pointing up on screen (legacy ?topdown=0 adds the table tilt).
  function earthUprightQuat(lat, lon, view) {
    let targetNormal = earthSafeUnit(view, { x:0, y:0, z:1 });
    const worldUp = { x:0, y:1, z:0 };
    let targetNorth = vSub(worldUp, vScale(targetNormal, vDot(worldUp, targetNormal)));
    if (vLen(targetNorth) < 1e-8) targetNorth = { x:0, y:0, z:1 };
    targetNorth = vNorm(targetNorth);
    const targetEast = vNorm(vCross(targetNorth, targetNormal));
    const tilt = debugFlags.topdown ? 0 : tableTilt(earthZoom);
    const tiltQ = qFromAxisAngle(targetEast, tilt);
    targetNormal = qRotate(tiltQ, targetNormal);
    targetNorth = qRotate(tiltQ, targetNorth);
    const source = earthGeographicBasis(lat, lon);
    const sourceQ = qFromBasis(source.east, source.north, source.normal);
    const targetQ = qFromBasis(targetEast, targetNorth, targetNormal);
    // Map the complete geographic basis, not the canonical basis. This keeps
    // the focused location on targetNormal and its north tangent north-up.
    return qMultiply(targetQ, qConjugate(sourceQ));
  }

  function resetEarthNorthUp() {
    if (!earthFocus || !earthZoomAnchor) return false;
    earthFaceAnim = null;
    earthQuat = earthUprightQuat(earthFocus.lat, earthFocus.lon,
      earthTopdownViewDir() || { x: 0, y: 0, z: -1 });
    earthNorthUp = true;
    earthZoomAnim = null;
    if (earthMesh) earthMesh.quaternion.set(earthQuat.x, earthQuat.y, earthQuat.z, earthQuat.w);
    applyEarthZoom();
    lastEarthLabelKey = '';
    return true;
  }

  // Location card RESET ROTATION: turn the globe so (lat, lon) ends centred on
  // the view, perpendicular and north-up. Zoomed, the pose and the focus
  // travel together (slerp of the pose, focus = whatever sits on the
  // interpolated view normal), so the spot glides to the centre instead of
  // snapping; the zoom level is untouched. At globe scale it is a yaw/pitch
  // turn (north up by construction).
  const EARTH_FACE_ANIM_MS = 650;
  function faceEarthLocation(lat, lon) {
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
    earthTouchInput();
    earthFling = { yaw: 0, pitch: 0 };
    earthPointerZoom = null;
    earthGrabGeo = null;
    earthGrabAnchor = null;
    const t0 = earthNowMs();
    if (earthFocus && earthZoomTarget > 1.0001 && earthZoomAnchor) {
      const view = earthTopdownViewDir() || { x: 0, y: 0, z: 1 };
      const toQ = earthUprightQuat(la, lo, view);
      earthZoomAnim = null;
      earthPoseQuat = true;
      earthNorthUp = false;
      earthFaceAnim = {
        t0, dur: EARTH_FACE_ANIM_MS, lat: la, lon: lo,
        fromQ: { ...earthQuat }, toQ,
        fromN: vNorm(qRotate(earthQuat, locationToUnit(earthFocus.lat, earthFocus.lon))),
        toN: vNorm(qRotate(toQ, locationToUnit(la, lo))),
      };
      if (reducedMotion) advanceEarthFace(t0 + EARTH_FACE_ANIM_MS);
      return true;
    }
    earthFaceAnim = null;
    const head = getHeadPosition();
    const c = earthLiveCenter();
    const dir = earthSafeUnit({ x: head.x - c.x, y: head.y - c.y, z: head.z - c.z }, { x: 0, y: 0, z: 1 });
    const solved = solveEarthFocusRotation(la, lo, dir, 1.2);
    let dYaw = solved.yaw - (earthYaw || 0);
    dYaw = ((dYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    earthZoomAnim = {
      t0, dur: EARTH_FACE_ANIM_MS,
      fromZoom: earthZoom, toZoom: earthZoomTarget,
      fromYaw: earthYaw || 0, toYaw: (earthYaw || 0) + dYaw,
      fromPitch: earthPitch || 0, toPitch: solved.pitch,
    };
    if (reducedMotion) advanceEarthZoom(t0 + EARTH_FACE_ANIM_MS);
    return true;
  }
  function advanceEarthFace(time) {
    const a = earthFaceAnim;
    if (!a) return false;
    const k = reducedMotion ? 1 : Math.max(0, Math.min(1, ((Number(time) || 0) - a.t0) / Math.max(1, a.dur)));
    const e = 1 - Math.pow(1 - k, 3); // cubic-out, like the zoom animation
    earthQuat = qSlerp(a.fromQ, a.toQ, e);
    const n = qRotate(qScaleAngle(qFromUnitVectors(a.fromN, a.toN), e), a.fromN);
    const f = k >= 1 ? { lat: a.lat, lon: a.lon } : unitToLatLon(qRotate(qConjugate(earthQuat), n));
    if (!earthFocus) earthFocus = { lat: f.lat, lon: f.lon };
    earthFocus.lat = f.lat;
    earthFocus.lon = f.lon;
    if (k >= 1) {
      earthQuat = { ...a.toQ };
      earthFaceAnim = null;
      earthNorthUp = true; // the result is exactly the NORTH UP pose
    }
    if (earthMesh) earthMesh.quaternion.set(earthQuat.x, earthQuat.y, earthQuat.z, earthQuat.w);
    applyEarthRotation(); // quaternion kept; re-pins the anchor
    lastEarthLabelKey = '';
    return true;
  }

  function resetEarthZoom() {
    earthFaceAnim = null;
    releaseEarthPose();
    earthFocus = null;
    earthZoomAnchor = null;
    earthNorthUp = false;
    earthGrabGeo = null;
    earthGrabAnchor = null;
    earthPointerZoom = null;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    earthZoomAnim = {
      t0, dur: EARTH_ZOOM_ANIM_MS,
      fromZoom: earthZoom, toZoom: 1,
      fromYaw: earthYaw || 0, toYaw: earthYaw || 0,
      fromPitch: earthPitch || 0, toPitch: earthPitch || 0,
    };
    earthZoomTarget = 1;
    // Focus is gone, so the warp frame is geographic again: rebuild pins +
    // heat immediately so the globe view never shows stale street-warped
    // cones against geographic canvas halos (also covered per-frame in
    // advanceEarthZoom for focus-kept zoom-outs).
    try { rebuildEarthPins(); } catch (e) {}
    try { rebuildEarthHeatSprites(); } catch (e) {}
    earthMapDirty = true;
    if (reducedMotion) advanceEarthZoom(t0);
  }

  // Instant reset (mode exit / teardown): re-entry always starts globe-view.
  function resetEarthZoomImmediate() {
    earthZoom = 1;
    earthZoomTarget = 1;
    earthZoomFrameTime = null;
    earthFocus = null;
    earthZoomAnchor = null;
    earthZoomAnim = null;
    earthFaceAnim = null;
    earthNorthUp = false;
    earthPoseQuat = false;
    earthRoll = 0;
    applyEarthZoom();
    try { rebuildEarthPins(); } catch (e) {}
    try { rebuildEarthHeatSprites(); } catch (e) {}
    earthMapDirty = true;
  }

// Per-frame zoom advance for both loops: run the focus animation, else
  // ease the continuous target. Zoom interpolation is logarithmic so every
  // doubling receives the same amount of motion time.
  function easeEarthZoom(from, to, progress) {
    const a = Math.log(Math.max(1, from));
    const b = Math.log(Math.max(1, to));
    return Math.exp(a + (b - a) * Math.max(0, Math.min(1, progress)));
  }

  // Returns true while a tap animation is active.
  function advanceEarthZoom(time) {
    const now = Number(time) || 0;
    // R6: clamp long frames (background tab, hitch) to 100 ms so a stall
    // recovers over a few eased frames instead of snapping or jumping.
    const rawDt = earthZoomFrameTime === null ? 0 : Math.max(0, now - earthZoomFrameTime);
    const dt = Math.min(rawDt, 100);
    earthZoomFrameTime = now;
    if (earthFaceAnim) advanceEarthFace(now);
    // Settle a released pose: the twist eases out, and back at globe scale
    // the pitch eases into the ±1.2 drag clamp (a polar view can leave it
    // past that).
    if (!earthPoseQuat && !earthNorthUp && !earthDragging) {
      const keep = reducedMotion ? 0 : Math.pow(0.85, dt / (1000 / 60));
      let settled = false;
      if (earthRoll) {
        earthRoll *= keep;
        if (Math.abs(earthRoll) < 1e-4) earthRoll = 0;
        settled = true;
      }
      if (!earthFocus && Math.abs(earthPitch || 0) > 1.2) {
        const lim = Math.sign(earthPitch) * 1.2;
        earthPitch = lim + (earthPitch - lim) * keep;
        if (Math.abs(earthPitch - lim) < 1e-4) earthPitch = lim;
        settled = true;
      }
      if (settled && !earthZoomAnim) applyEarthRotation();
    }
    if (earthZoomAnim) {
      const anim = earthZoomAnim;
      const k = reducedMotion ? 1 : Math.max(0, Math.min(1, ((Number(time) || 0) - anim.t0) / Math.max(1, anim.dur)));
      const e = 1 - Math.pow(1 - k, 3); // cubic-out
      earthZoom = easeEarthZoom(anim.fromZoom, anim.toZoom, e);
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
      // Tap-animation zoom-out landing back at globe scale: the pins + heat
      // sprites were built in street-warped rendered coordinates — rebuild
      // them geographic so cones agree with the canvas halos. (Continuous
      // zoom-out crosses the same gate below.)
      if (!earthZoomAnim && earthZoom <= 1.0001 && !_earthWarpReleased) {
        _earthWarpReleased = true;
        try { rebuildEarthPins(); } catch (e2) {}
        try { rebuildEarthHeatSprites(); } catch (e2) {}
        earthMapDirty = true;
      } else if (earthEffectiveK(earthZoom) > 1) {
        _earthWarpReleased = false;
      }
      return true;
    }
    if (earthZoom !== earthZoomTarget) {
      const next = reducedMotion
        ? earthZoomTarget
        : easeEarthZoom(earthZoom, earthZoomTarget, 1 - Math.exp(Math.log(0.82) * dt / (1000 / 60)));
      earthZoom = Math.abs(Math.log(Math.max(1, next)) - Math.log(Math.max(1, earthZoomTarget))) < 0.004
        ? earthZoomTarget : next;
      applyEarthZoom();
      // Zoom-out crossing back to globe scale releases the warp frame: pins
      // and heat sprites were built in rendered (warped) coordinates, so
      // rebuild them in geographic coordinates once the effective
      // magnification returns to 1. Without this, the canvas halos (always
      // geographic) and the 3D cones (stale warped) disagree after a
      // street→globe zoom-out. Guarded to run once per crossing (the rebuild
      // itself leaves k_eff at 1, so re-check the pre-step value).
      if (earthFocus && earthEffectiveK(earthZoom) <= 1 && !_earthWarpReleased) {
        _earthWarpReleased = true;
        try { rebuildEarthPins(); } catch (e) {}
        try { rebuildEarthHeatSprites(); } catch (e) {}
        earthMapDirty = true;
      } else if (earthEffectiveK(earthZoom) > 1) {
        _earthWarpReleased = false;
      }
    }
    // Top-down tracking: while active (and no animation or drag owns the
    // pose), turn the globe a fraction of the minimal rotation that puts the
    // focus normal on the head line, so residual tilt — from head motion or
    // pointer zoom — converges back to a perpendicular street view. Minimal
    // rotations keep the map bearing, so this stays calm at the poles where
    // a yaw/pitch solve would spin the map. Object motion only.
    if (earthTopdownActive() && !earthZoomAnim && !earthDragging && !earthFaceAnim) {
      const viewDir = earthTopdownViewDir();
      if (viewDir && earthFocus) {
        if (!earthNorthUp) earthPoseQuat = true;
        const cur = qRotate(earthQuat, locationToUnit(earthFocus.lat, earthFocus.lon));
        const full = qFromUnitVectors(cur, viewDir);
        if (Math.abs(full.w) < 1 - 1e-12) {
          earthQuat = qMultiply(qScaleAngle(full, reducedMotion ? 1 : 0.12), earthQuat);
          if (earthMesh) earthMesh.quaternion.set(earthQuat.x, earthQuat.y, earthQuat.z, earthQuat.w);
        }
        applyEarthRotation(); // also re-pins the focus to the anchor
      }
    }
    return false;
  }

  // Tap dispatch (Z1 UX): below the city band a zone tap zooms into it
  // (Snap pinch equivalent); at/above the band it keeps the legacy flow —
  // preview → accept → location feed. A clean tap on open globe zooms one
  // step toward the tapped point. Drag releases never reach here.
  function handleEarthTap(zoneIndex, hit) {
    earthTouchInput();
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
  const EARTH_TILE_CACHE_MAX = 140;     // LRU across zoom levels (count backstop)
  // R4 byte budget (decision: 128 MB limit): composite canvases are clamped to
  // 512² RGBA + mipmaps ≈ 1 MiB × 4/3 ≈ 1.33 MiB per unique texture. Fallback
  // slots share their ancestor's texture (refcounted, counted once).
  const EARTH_TILE_TEXTURE_BYTES = 512 * 512 * 4 * 4 / 3;
  const EARTH_TILE_TEXTURE_BUDGET = 128 * 1024 * 1024;
  let earthTileTextureBytes = 0;
  function earthTileEstimateBytes(texture) {
    try {
      const img = texture && (texture.image || texture.source);
      const w = Number(img && (img.width || img.videoWidth)) || 0;
      const h = Number(img && (img.height || img.videoHeight)) || 0;
      if (w > 0 && h > 0) return Math.ceil(w * h * 4 * 4 / 3);
    } catch (e) {}
    return EARTH_TILE_TEXTURE_BYTES;
  }
  const EARTH_TILE_FETCH_CONCURRENCY = 6;
  const EARTH_TILE_CROSSFADE_LO = 4;    // S band [4, 8]: hologram → tiles
  const EARTH_TILE_CROSSFADE_HI = 8;
  const EARTH_TILE_FAIL_LIMIT = 8;      // consecutive failures → offline mode
  const EARTH_TILE_PROBE_MS = 5000;     // degraded-mode re-arm cadence
  // A failed slot retries on its own back-off (1 s doubling to 16 s) instead
  // of staying blank until the view moves to another tile.
  const EARTH_TILE_RETRY_MS = 1000;
  const EARTH_TILE_RETRY_MAX_MS = 16000;
  let earthTileLastGeometryUpdate = -1;
  const OSM_ATTRIBUTION_TEXT = '© OPENSTREETMAP © CARTO';
  const OSM_ATTRIBUTION_TEXT_OSM_ONLY = '© OPENSTREETMAP';
  const ESRI_ATTRIBUTION_TEXT = '© ESRI · © OPENSTREETMAP';
  const OSM_ATTRIBUTION_OFFLINE = 'MAP OFFLINE — CITY VIEW';
  // Dynamic credit: OSM-only until /attribution names the provider actually
  // proxied (Esri default, keyed CARTO opt-in). Fetched once per earth
  // session; short HUD forms. The server's theme hint picks the tile grade.
  let earthAttributionText = OSM_ATTRIBUTION_TEXT_OSM_ONLY;
  let earthAttributionFetched = false;
  let earthTileTheme = 'light';
  function refreshEarthAttribution() {
    if (earthAttributionFetched || typeof fetch === 'undefined') return;
    earthAttributionFetched = true;
    try {
      fetch('/api/reels/map-tiles/attribution', { credentials: 'include' }).then((r) => {
        if (!r || !r.ok) return null;
        return r.json();
      }).then((p) => {
        if (!p || typeof p.attribution !== 'string') return;
        if (/esri/i.test(p.attribution)) earthAttributionText = ESRI_ATTRIBUTION_TEXT;
        else if (/carto/i.test(p.attribution)) earthAttributionText = OSM_ATTRIBUTION_TEXT;
        if (p.theme === 'dark' || p.theme === 'light') earthTileTheme = p.theme;
        else earthTileTheme = /carto/i.test(p.attribution) ? 'dark' : 'light';
        lastEarthLabelKey = ''; // repaint with the provider's credit
      }).catch(() => {});
    } catch (e) {}
  }

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

  // Return the exact parent texture sub-rectangle needed for a missing child.
  // UV state is data, not mutated on the shared ancestor material.
  function earthTileAncestor(childZ, childX, childY, parentZ) {
    const z = Math.max(0, Math.min(Number(childZ) || 0, Number(parentZ) || 0));
    const pz = Math.max(0, Math.min(Number(parentZ) || 0, 17));
    const q = Math.pow(2, Math.max(0, (Number(childZ) || 0) - pz));
    const x = Math.floor((Number(childX) || 0) / q);
    const y = Math.floor((Number(childY) || 0) / q);
    return {
      z: pz, x, y, key: earthTileKey(pz, x, y),
      offsetX: ((Number(childX) || 0) % q) / q,
      offsetY: ((Number(childY) || 0) % q) / q,
      extent: 1 / q,
    };
  }

  function earthGreatCircleKm(a, b) {
    const lat1 = Number(a.lat) * Math.PI / 180, lat2 = Number(b.lat) * Math.PI / 180;
    const dLat = lat2 - lat1, dLon = (Number(b.lon) - Number(a.lon)) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(Math.max(0, h)), Math.sqrt(Math.max(0, 1 - h)));
  }

  function earthScaleBar(scale, focus, maxPixels = 180) {
    // The billboard is 0.86 m wide over 640 texels. The ruler represents a
    // surface chord of exactly the same world length, centred at the focus
    // in geographic east/west (not a screen-projection or latitude estimate).
    const metersPerPixel = 0.86 / 640;
    const radius = earthVisibleRadius(scale);
    const k = earthEffectiveK(scale);
    const maxChord = Math.min(maxPixels * metersPerPixel, radius);
    const halfRendered = Math.asin(maxChord / (2 * radius));
    const halfGeo = 2 * Math.atan(Math.tan(halfRendered / 2) / k);
    const maxKm = 6371 * 2 * halfGeo;
    const power = Math.pow(10, Math.floor(Math.log10(maxKm)));
    const ratio = maxKm / power;
    const km = (ratio >= 5 ? 5 : ratio >= 2 ? 2 : 1) * power;
    const angle = km / 6371 / 2;
    const basis = earthGeographicBasis(focus.lat, focus.lon);
    const endpoint = (sign) => unitToLatLon({
      x: basis.normal.x * Math.cos(angle) + sign * basis.east.x * Math.sin(angle),
      y: basis.normal.y * Math.cos(angle) + sign * basis.east.y * Math.sin(angle),
      z: basis.normal.z * Math.cos(angle) + sign * basis.east.z * Math.sin(angle),
    });
    const renderedAngle = 2 * Math.atan(k * Math.tan(angle / 2));
    const chord = 2 * radius * Math.sin(renderedAngle);
    return { km, start: endpoint(-1), end: endpoint(1), chord, pixels: chord / metersPerPixel,
      caption: km < 1 ? Number((km * 1000).toPrecision(3)) + ' m' : Number(km.toPrecision(3)) + ' km' };
  }
  function drawEarthScaleBar(ctx, bar) {
    // R6: explicit hide contract — a missing or UNAVAILABLE bar draws nothing
    // (no stale ruler). Production always passes a valid bar when zoomed
    // (earthScaleBar endpoints sit near the focus); this guards direct
    // callers, tests, and future miss branches.
    if (!bar || !ctx || bar.caption === 'UNAVAILABLE' || !(bar.pixels > 0)) return;
    const left = 220 - bar.pixels / 2, right = 220 + bar.pixels / 2;
    ctx.strokeStyle = '#E8F6FF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, 94); ctx.lineTo(right, 94);
    ctx.moveTo(left, 89); ctx.lineTo(left, 99);
    ctx.moveTo(right, 89); ctx.lineTo(right, 99);
    ctx.stroke();
    ctx.fillStyle = '#E8F6FF';
    ctx.font = '700 15px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(bar.caption, 325, 94);
  }

  function earthScaleDistanceKm(scale, renderedSpan = 1) {
    const radius = earthVisibleRadius(scale);
    const span = Math.max(0, Number(renderedSpan) || 0);
    if (!(radius > 0) || span <= 0 || span >= 2 * radius) return 0;
    // A rendered chord is converted to its central angle, then inverse-warped
    // to geographic angle. Once angular, distance needs only Earth's km radius.
    const renderedAngle = 2 * Math.asin(Math.min(1, span / (2 * radius)));
    const sourceAngle = 2 * Math.atan2(Math.tan(renderedAngle * 0.5), earthEffectiveK(scale));
    return 6371 * sourceAngle;
  }

  function earthNiceScaleDistance(km) {
    const value = Math.max(0, Number(km) || 0);
    if (!value) return { distance: 0, label: 'UNAVAILABLE', unit: 'km' };
    const meters = value * 1000;
    const unitScale = meters < 1000 ? 1 : 1000;
    const raw = meters / unitScale;
    const exponent = Math.floor(Math.log10(Math.max(raw, 1e-9)));
    const base = raw / Math.pow(10, exponent);
    const nice = base <= 1 ? 1 : (base <= 2 ? 2 : (base <= 5 ? 5 : 10));
    const distance = nice * Math.pow(10, exponent);
    return { distance, label: String(distance) + ' ' + (unitScale === 1 ? 'm' : 'km'), unit: unitScale === 1 ? 'm' : 'km' };
  }

  // Bounded visible set around a lat/lon: (2·ring+1)² tiles centered on the
  // facing/focused point, sorted by ring distance (fetch priority order).
  // R4: x wraps at the dateline (mod 2^z) so Pacific crossings stay covered;
  // y clips (Mercator has no tiles past ±85.05° — poles use the base globe).
  function earthTileVisibleSet(z, lat, lon, ring) {
    const zz = Math.max(0, Math.min(17, Number(z) || 0));
    const n = 1 << zz;
    const r = Math.max(1, Math.min(6, Number(ring) || EARTH_TILE_RING));
    const c = earthTileXY(lat, lon, zz);
    const cx = Math.max(0, Math.min(n - 1, Math.floor(c.x)));
    const cy = Math.max(0, Math.min(n - 1, Math.floor(c.y)));
    const out = [];
    const seen = new Set();
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const y = cy + dy;
        if (y < 0 || y >= n) continue; // poles: no wrap, base globe shows through
        const x = ((cx + dx) % n + n) % n; // dateline wrap
        const key = earthTileKey(zz, x, y);
        if (seen.has(key)) continue; // low-z dedupe (n smaller than the window)
        seen.add(key);
        out.push({ key, z: zz, x, y, dist: Math.abs(dx) + Math.abs(dy) });
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
  // Step 6.1 client-side tile cache: decoded tile layer images keyed by URL.
  // In-memory Map is authoritative (synchronous adoption, works in XR where
  // CacheStorage may be unavailable); CacheStorage 'sx-map-tiles-v1' is a
  // best-effort persistent backstop for repeat visits across sessions.
  const EARTH_TILE_IMAGE_CACHE_MAX = 220;
  const earthTileImageCache = new Map(); // url -> HTMLImageElement (LRU, MRU at end)
  let earthTileCacheStorage = null; // 'pending' | object | false
  let earthTileCacheStats = { memoryHits: 0, storageHits: 0, misses: 0, stores: 0 };
  function earthTileCacheTouch(url, img) {
    try {
      if (earthTileImageCache.has(url)) earthTileImageCache.delete(url);
      earthTileImageCache.set(url, img);
      while (earthTileImageCache.size > EARTH_TILE_IMAGE_CACHE_MAX) {
        const oldest = earthTileImageCache.keys().next();
        if (oldest.done) break;
        earthTileImageCache.delete(oldest.value);
      }
    } catch (e) {}
  }
  function earthTileCacheGet(url) {
    try {
      if (earthTileImageCache.has(url)) {
        const img = earthTileImageCache.get(url);
        earthTileImageCache.delete(url);
        earthTileImageCache.set(url, img);
        earthTileCacheStats.memoryHits += 1;
        return img;
      }
    } catch (e) {}
    return null;
  }
  function earthTileCacheStore() { return (typeof caches !== 'undefined' && caches) || null; }
  function earthTileCacheStorageGet() {
    if (earthTileCacheStorage) return earthTileCacheStorage === false ? null : earthTileCacheStorage;
    const store = earthTileCacheStore();
    if (!store) { earthTileCacheStorage = false; return null; }
    try {
      const pending = store.open('sx-map-tiles-v1');
      earthTileCacheStorage = 'pending';
      Promise.resolve(pending).then(
        (cache) => { earthTileCacheStorage = cache || false; },
        () => { earthTileCacheStorage = false; });
    } catch (e) { earthTileCacheStorage = false; return null; }
    return null;
  }
  function earthTileCacheReadStorage(url, onHit) {
    const store = earthTileCacheStore();
    if (!store || typeof fetch === 'undefined') return false;
    const cache = earthTileCacheStorageGet();
    if (!cache || typeof cache.match !== 'function') return false;
    try {
      Promise.resolve(cache.match(url)).then((res) => {
        if (!res || typeof res.blob !== 'function') return;
        Promise.resolve(res.blob()).then((blob) => {
          if (!blob) return;
          const objUrl = (typeof URL !== 'undefined' && URL.createObjectURL)
            ? URL.createObjectURL(blob) : null;
          const finish = (img) => {
            try { if (objUrl && URL.revokeObjectURL) URL.revokeObjectURL(objUrl); } catch (e) {}
            if (img) {
              earthTileCacheTouch(url, img);
              earthTileCacheStats.storageHits += 1;
              onHit(img);
            }
          };
          if (typeof createImageBitmap === 'function' && !objUrl) {
            Promise.resolve(createImageBitmap(blob)).then((bmp) => finish(bmp), () => {});
            return;
          }
          loadEarthTileImageDirect(objUrl || url, finish, () => {
            try { if (objUrl && URL.revokeObjectURL) URL.revokeObjectURL(objUrl); } catch (e) {}
          });
        }, () => {});
      }, () => {});
      return true;
    } catch (e) { return false; }
  }
  function earthTileCacheWriteStorage(url) {
    const store = earthTileCacheStore();
    if (!store || typeof fetch === 'undefined') return;
    const cache = earthTileCacheStorage && earthTileCacheStorage !== 'pending' ? earthTileCacheStorage : null;
    const put = (store_) => {
      try {
        Promise.resolve(fetch(url, { credentials: 'include' })).then((res) => {
          if (!res || !res.ok) return;
          Promise.resolve(store_.put(url, res)).then(
            () => { earthTileCacheStats.stores += 1; }, () => {});
        }, () => {});
      } catch (e) {}
    };
    if (cache && typeof cache.put === 'function') { put(cache); return; }
    try {
      Promise.resolve(store.open('sx-map-tiles-v1')).then((opened) => {
        earthTileCacheStorage = opened || false;
        if (opened) put(opened);
      }, () => { earthTileCacheStorage = false; });
    } catch (e) {}
  }
  function loadEarthTileImageDirect(url, onLoad, onError) {
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
  function loadEarthTileImage(url, onLoad, onError) {
    const cached = earthTileCacheGet(url);
    if (cached) { try { onLoad(cached); } catch (e) {} return; }
    earthTileCacheStats.misses += 1;
    let settled = false;
    const ok = (img) => {
      if (settled) return;
      settled = true;
      earthTileCacheTouch(url, img);
      earthTileCacheWriteStorage(url);
      try { onLoad(img); } catch (e) {}
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { onError(err); } catch (e) {}
    };
    if (earthTileCacheReadStorage(url, ok)) {
      // Storage lookup is async; fall through to network so a cold storage
      // never blocks the visible set. The network win calls ok() first and
      // the late storage hit is dropped by the settled guard (LRU keeps it
      // only if it arrived first).
      loadEarthTileImageDirect(url, ok, fail);
      return;
    }
    loadEarthTileImageDirect(url, ok, fail);
  }

  function earthTileLayerUrl(layer, z, x, y) {
    return '/api/reels/map-tiles/' + layer + '/' + z + '/' + x + '/' + y + '.png';
  }

  // Fetch one tile slot's layers. The base layer is authoritative (its
  // failure is the tile's failure and feeds the offline degrade); a missing
  // labels layer is non-fatal — the slot renders label-free. R5: coarse
  // parent bands (wantLabels=false) skip the labels fetch entirely — their
  // glyphs are unreadable at that scale, and it halves their HTTP + GPU.
  function loadEarthTilePair(z, x, y, onLoad, onError, wantLabels) {
    let base = null;
    let labels;
    let failed = false;
    let done = false;
    const finish = () => {
      if (done) return;
      if (base === null || labels === undefined) return;
      if (failed) { done = true; onError(); return; }
      done = true; onLoad({ base, labels });
    };
    // Decide labels before the base fetch: a synchronous base success calls
    // finish() inline, which must already see the labels verdict.
    if (wantLabels === false || !earthTileLabelsAvailable) labels = null;
    loadEarthTileImage(earthTileLayerUrl('base', z, x, y),
      (img) => { base = img; finish(); }, () => { base = false; failed = true; finish(); });
    if (wantLabels !== false && earthTileLabelsAvailable) {
      loadEarthTileImage(earthTileLayerUrl('labels', z, x, y),
        (img) => { labels = img; finish(); }, () => {
          earthTileLabelsAvailable = false;
          labels = null;
          finish();
        });
    }
  }

  // Curved sphere patch for one tile, in earthMesh-local (geographic) frame.
  // Mercator y is non-linear in latitude, so each grid row samples its own
  // latitude — the raster rows then land on their true latitudes.
  function buildEarthTileGeometry(z, tx, ty, radius, uvRect) {
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
        let dir = locationToUnit(lat, lon);
        if (earthFocus && earthZoom > 1.0001) {
          dir = earthWarpLocal(dir, earthZoom, locationToUnit(earthFocus.lat, earthFocus.lon));
        }
        positions[p++] = dir.x * radius;
        positions[p++] = dir.y * radius;
        positions[p++] = dir.z * radius;
        const uu = i / segs;
        const vv = j / segs;
        uvs[u++] = uvRect ? uvRect.offsetX + uu * uvRect.extent : uu;
        uvs[u++] = uvRect ? 1 - (uvRect.offsetY + vv * uvRect.extent) : 1 - vv; // XYZ north stays texture top
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

  function releaseEarthTileTexture(entry) {
    const owner = entry && (entry.textureOwner || entry);
    if (!owner || !owner.texture) return;
    owner.textureRefs = Math.max(0, (owner.textureRefs || 1) - 1);
    if (owner.textureRefs === 0) {
      try { owner.texture.dispose(); } catch (e) {}
      try { if (owner.labelsTexture) owner.labelsTexture.dispose(); } catch (e2) {}
      earthTileTextureBytes = Math.max(0, earthTileTextureBytes - (owner.textureBytes || 0));
      owner.texture = null;
      owner.labelsTexture = null;
      owner.textureBytes = 0;
    }
  }
  function disposeEarthTile(entry) {
    if (!entry) return;
    try {
      if (entry.mesh && earthTileGroup) earthTileGroup.remove(entry.mesh);
      if (entry.material) entry.material.dispose();
      releaseEarthTileTexture(entry);
      if (entry.geometry) entry.geometry.dispose();
      entry.geometry = null;
      entry.state = 'retired';
      entry.mesh = null;
      entry.material = null;
    } catch (e) {}
  }

  // Shared per-tile uniform block (fallback + network tiles). uTileNight
  // engages the night-chart grade for light rasters (keyless OSM); keyed dark
  // CARTO sources keep the original tint chain.
  function earthTileSourceIsLight() {
    return earthTileTheme !== 'dark';
  }
  function makeEarthTileUniforms(labelsTexture, holo) {
    return {
      labelsMap: { value: labelsTexture || null },
      uTileTintLift: { value: EARTH_TILE_TINT_LIFT_VEC },
      uTileTintHue: { value: EARTH_TILE_TINT_HUE_VEC },
      uTileTintDepth: { value: EARTH_TILE_TINT_DEPTH },
      uTileTintStrength: { value: holo ? 1 : 0 },
      uTileHasLabels: { value: labelsTexture ? 1 : 0 },
      uTileLabelsAlpha: { value: holo ? EARTH_TILE_LABEL_ALPHA : 1 },
      uTileNight: { value: (holo && earthTileSourceIsLight()) ? 1 : 0 },
    };
  }

  function earthReadyAncestor(tile) {
    let best = null;
    for (const candidate of earthTiles.values()) {
      if (!candidate || candidate.state !== 'ready' || !candidate.texture) continue;
      const z = Number(candidate.z);
      if (!(z < tile.z) || (best && z <= best.z)) continue;
      const q = 1 << (tile.z - z);
      if (Math.floor(tile.x / q) === candidate.x && Math.floor(tile.y / q) === candidate.y) {
        best = candidate;
      }
    }
    return best;
  }

  function materializeEarthTileFallback(entry, tile, ancestor, radius) {
    if (!entry || !ancestor || !ancestor.texture || !earthTileGroup) return false;
    try {
      const subrect = earthTileAncestor(tile.z, tile.x, tile.y, ancestor.z);
      if (entry.geometry && entry.geometry.dispose) entry.geometry.dispose();
      entry.geometry = buildEarthTileGeometry(tile.z, tile.x, tile.y, radius, subrect);
      entry.texture = ancestor.texture;
      entry.labelsTexture = ancestor.labelsTexture || null;
      entry.textureOwner = ancestor;
      entry.textureBytes = 0; // shared with the ancestor (counted once)
      ancestor.textureRefs = (ancestor.textureRefs || 1) + 1;
      const holo = earthTileStyleMode() === 'holo';
      const uniforms = makeEarthTileUniforms(entry.labelsTexture, holo);
      entry.material = new THREE.MeshBasicMaterial({ map: entry.texture, transparent: true, opacity: earthTileFade(), depthWrite: false, side: THREE.FrontSide });
      installEarthTileShader(entry.material, uniforms);
      entry.mesh = new THREE.Mesh(entry.geometry, entry.material);
      entry.mesh.renderOrder = 1; // coarse fallback tile sits below fine child tiles
      entry.mesh.frustumCulled = false;
      entry.mesh.userData.lodLevel = (ancestor.lodLevel || 0) + 1;
      earthTileGroup.add(entry.mesh);
      entry.fallback = true;
      if (entry.state !== 'loading' && entry.state !== 'error') entry.state = 'fallback';
      return true;
    } catch (e) { return false; }
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
      if (entry.fallback && entry.mesh) {
        disposeEarthTile(entry);
        entry.geometry = null;
        entry.fallback = false;
      }
      if (entry.texture && entry.textureOwner === entry) releaseEarthTileTexture(entry);
      entry.texture = null;
      entry.labelsTexture = null;
      entry.textureOwner = null;
      entry.textureBytes = 0;
      if (!entry.geometry) {
        if (!(radius > 0)) radius = EARTH_RADIUS + EARTH_TILE_RADIUS_EPS * EARTH_RADIUS / earthVisibleRadius(earthZoom);
        entry.geometry = buildEarthTileGeometry(tile.z, tile.x, tile.y, radius);
      }
      const pair = img.base ? img : { base: img, labels: null };
      const composed = composeEarthTileCanvas(pair);
      const texture = applyEarthTileSampling(composed ? new THREE.CanvasTexture(composed) : new THREE.Texture(pair.base));
      try { if (THREE.SRGBColorSpace !== undefined) texture.colorSpace = THREE.SRGBColorSpace; } catch (e2) {}
      texture.needsUpdate = true;
      entry.texture = texture;
      entry.textureOwner = entry;
      entry.textureRefs = 1;
      entry.textureBytes = earthTileEstimateBytes(texture);
      // R5 dual-texture GPU path: labels ride a second texture, composited
      // untinted in the shader. Label fetch failure stays non-fatal
      // (base-only tinted tile, uTileHasLabels=0).
      entry.labelsTexture = null;
      if (pair.labels) {
        try {
          const labelsTex = applyEarthTileSampling(new THREE.Texture(pair.labels));
          try { if (THREE.SRGBColorSpace !== undefined) labelsTex.colorSpace = THREE.SRGBColorSpace; } catch (e3) {}
          labelsTex.needsUpdate = true;
          entry.labelsTexture = labelsTex;
          entry.textureBytes += earthTileEstimateBytes(labelsTex);
        } catch (e4) { entry.labelsTexture = null; }
      }
      earthTileTextureBytes += entry.textureBytes;
      const holoTile = earthTileStyleMode() === 'holo';
      const tileUniforms = makeEarthTileUniforms(entry.labelsTexture, holoTile);
      entry.material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: earthTileFade(),
        depthWrite: false,
        side: THREE.FrontSide,
      });
      installEarthTileShader(entry.material, tileUniforms);
      entry.mesh = new THREE.Mesh(entry.geometry, entry.material);
      entry.mesh.renderOrder = (entry.lodLevel && entry.lodLevel > 0) ? 1 : 2; // fine tiles above coarse parents, below UI
      entry.mesh.frustumCulled = false;
      earthTileGroup.add(entry.mesh);
      entry.mesh.userData.lodLevel = entry.lodLevel || 0;
      entry.state = 'ready';
      entry.fallback = false;
      entry.img = null;
      return true;
    } catch (e) {
      entry.state = 'error';
      entry.img = null;
      return false;
    }
  }

  function refreshEarthTileFallbacks() {
    if (!earthTileGroup) return;
    const radius = EARTH_RADIUS + EARTH_TILE_RADIUS_EPS * EARTH_RADIUS / earthVisibleRadius(earthZoom);
    for (const entry of earthTiles.values()) {
      if (entry.state === 'ready' || entry.state === 'retired' || entry.mesh || !Number.isFinite(entry.z)) continue;
      const ancestor = earthReadyAncestor(entry);
      if (ancestor) materializeEarthTileFallback(entry, entry, ancestor, radius);
    }
  }

  function earthTileHasReady() {
    for (const entry of earthTiles.values()) {
      if (entry && entry.state === 'ready') return true;
    }
    return false;
  }
  function earthTileRetryDue() {
    for (const entry of earthTiles.values()) {
      if (entry && entry.state === 'error' && !(entry.retryAt > earthTileClock)) return true;
    }
    return false;
  }

  function pumpEarthTileQueue() {
    if (!earthTileGroup) return;
    if (earthTilePausedUntil >= 0 && earthTileClock < earthTilePausedUntil) return;
    while (earthTileInFlight < EARTH_TILE_FETCH_CONCURRENCY && earthTileQueue.length > 0) {
      const job = earthTileQueue.shift();
      const entry = earthTiles.get(job.key);
      if (!entry || (entry.state !== 'queued' && entry.state !== 'fallback')) continue;
      // R4 budget-hold: slots evicted under byte pressure stay parked (parent
      // fallback covers them) until the band changes — never refetch-churn.
      if (entry.budgetHeld) continue;
      entry.state = 'loading';
      const generation = earthTileGeneration;
      earthTileInFlight += 1;
      // R5: labels only ride the fine band (job.labels); coarse parents are
      // base-only. Decision 12-at-once: 6 slots × up to 2 requests (pair).
      loadEarthTilePair(job.z, job.x, job.y, (img) => {
        earthTileInFlight = Math.max(0, earthTileInFlight - 1);
        const current = earthTiles.get(job.key);
        if (current !== entry || generation !== earthTileGeneration || entry.state === 'retired') {
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
          current.failCount = 0;
          earthTileAvailable = true;
          refreshEarthTileFallbacks();
        }
        pumpEarthTileQueue();
      }, () => {
        earthTileInFlight = Math.max(0, earthTileInFlight - 1);
        const current = earthTiles.get(job.key);
        if (current !== entry || generation !== earthTileGeneration || entry.state === 'retired') { pumpEarthTileQueue(); return; }
        current.state = 'error';
        current.failCount = (current.failCount || 0) + 1;
        current.retryAt = earthTileClock + Math.min(EARTH_TILE_RETRY_MAX_MS,
          EARTH_TILE_RETRY_MS * Math.pow(2, current.failCount - 1));
        refreshEarthTileFallbacks();
        earthTileFailures += 1;
        if (earthTileFailures >= EARTH_TILE_FAIL_LIMIT && earthTileHasReady()) {
          // Partial outage (rate limit, flaky upstream): the map already on
          // screen stays — tiles, warp and credit — and fetching pauses for
          // one probe interval before the holes retry. Tearing everything
          // down here is what made a working map flip to MAP OFFLINE.
          earthTilePausedUntil = earthTileClock + EARTH_TILE_PROBE_MS;
          earthTileQueue = [];
        } else if (earthTileFailures >= EARTH_TILE_FAIL_LIMIT) {
          // Nothing loaded at all (offline / flag-off): degrade to the
          // hologram (§7.4), then re-probe on a slow cadence instead of
          // latching forever.
          earthTileAvailable = false;
          earthTileQueue = [];
          earthTilePrefetch.clear();
          retireEarthTiles(() => true);
          earthTileZ = -1;
          earthTileCenterKey = '';
          earthTileProbeAt = earthTileClock + EARTH_TILE_PROBE_MS;
          lastEarthLabelKey = ''; // force the MAP OFFLINE label repaint
          refreshEarthLabel();
        }
        pumpEarthTileQueue();
      }, job.labels !== false);
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
    const geometryKey = earthZoom + ':' + (earthFocus ? earthFocus.lat + ':' + earthFocus.lon : 'globe') + ':' + (earthEffectiveK(earthZoom) > 1 ? 'w' : 'g');
    if (geometryKey !== earthTileGeometryKey && (now - earthTileLastGeometryUpdate >= 50 || earthTileLastGeometryUpdate < 0)) {
      earthTileLastGeometryUpdate = now;
      earthTileGeometryKey = geometryKey;
      const radius = EARTH_RADIUS + EARTH_TILE_RADIUS_EPS * EARTH_RADIUS / earthVisibleRadius(earthZoom);
      for (const entry of earthTiles.values()) {
        if (!Number.isFinite(entry.z)) continue;
        const rect = entry.fallback && entry.textureOwner
          ? earthTileAncestor(entry.z, entry.x, entry.y, entry.textureOwner.z) : null;
        const tileRadius = (entry.lodLevel && entry.lodLevel > 0) || entry.fallback ? radius - 0.0002 : radius;
        const geometry = buildEarthTileGeometry(entry.z, entry.x, entry.y, tileRadius, rect);
        if (entry.geometry) entry.geometry.dispose();
        entry.geometry = geometry;
        if (entry.mesh) entry.mesh.geometry = geometry;
      }
    }
    earthTileClock = Math.max(earthTileClock, now);
    if (earthTilePausedUntil >= 0 && earthTileClock >= earthTilePausedUntil) {
      // Pause over: retry the holes; two more misses re-pause.
      earthTilePausedUntil = -1;
      earthTileFailures = Math.min(earthTileFailures, EARTH_TILE_FAIL_LIMIT - 2);
      earthTileCenterKey = '';
    }
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
        // The base hologram stays opaque under the tiles: Web Mercator stops
        // at ±85.05°, so the polar caps (and slots still streaming or
        // retrying) show the hologram instead of empty space. Tiles blend
        // over it with their own fade opacity.
        earthMesh.material.transparent = fade > 0.001;
        earthMesh.material.opacity = 1;
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
        earthTileZ = -1;
        earthTileCenterKey = '';
      }
      return;
    }
    if (!earthTileAvailable) return;
    // Re-plan at most ~7 Hz.
    if (earthTileLastMaintain >= 0 && time - earthTileLastMaintain < 150) return;
    earthTileLastMaintain = time;
    const anchor = earthFocus || earthFacingLatLon();
    const z = earthTileZoomAt(anchor.lat);
    const center = earthTileXY(anchor.lat, anchor.lon, z);
    const n = 1 << z;
    const centerKey = earthTileKey(z,
      Math.max(0, Math.min(n - 1, Math.floor(center.x))),
      Math.max(0, Math.min(n - 1, Math.floor(center.y))));
    if (z === earthTileZ && centerKey === earthTileCenterKey && earthTiles.size > 0 && !earthTileRetryDue()) {
      maintainEarthTilePrefetch(z, center);
      return;
    }
    earthTileZ = z;
    earthTileCenterKey = centerKey;
    // R4 budget-hold release: a new band re-arms every parked slot.
    for (const entry of earthTiles.values()) {
      if (entry && entry.budgetHeld) { entry.budgetHeld = false; entry.heldBand = -1; }
    }

    // Keep the current band plus two coarse parent bands alive. A parent is
    // a real draped tile, so it remains visible while the fine child streams;
    // this avoids the old hologram hole during every band transition.
    // R5: only the fine band (lod 0) fetches labels; coarse parents are
    // base-only (glyphs unreadable there; halves their HTTP + GPU).
    const visible = [];
    const lodLevels = [];
    for (let lod = 0; lod < 3; lod++) {
      const levelZ = Math.max(0, z - lod * 2);
      const levelRing = lod === 0 ? EARTH_TILE_RING : 2;
      const levelSet = earthTileVisibleSet(levelZ, anchor.lat, anchor.lon, levelRing);
      levelSet.forEach((item) => { item.lodLevel = lod; item.wantLabels = lod === 0; visible.push(item); });
      lodLevels.push(levelZ);
    }
    earthTileLodLevels = lodLevels;
    const radius = EARTH_RADIUS + EARTH_TILE_RADIUS_EPS / Math.max(1, earthVisibleRadius(earthZoom) / EARTH_RADIUS);
    const wanted = new Set();
    earthTileQueue = [];
    for (const tile of visible) {
      wanted.add(tile.key);
      let entry = earthTiles.get(tile.key);
      if (!entry) {
        const pre = earthTilePrefetch.get(tile.key);
        if (pre && pre.state === 'ready' && pre.img) {
          // Idle-warmed child from the previous band: adopt the image.
          entry = { state: 'queued', geometry: null, mesh: null, material: null, texture: null, img: pre.img, lodLevel: tile.lodLevel || 0 };
          earthTiles.set(tile.key, entry);
          earthTilePrefetch.delete(tile.key);
        } else {
          try {
            entry = {
              state: 'queued', z: tile.z, x: tile.x, y: tile.y,
              geometry: buildEarthTileGeometry(tile.z, tile.x, tile.y, radius),
              mesh: null, material: null, texture: null, textureOwner: null,
              fallback: false,
              lodLevel: tile.lodLevel || 0,
            };
            earthTiles.set(tile.key, entry);
          } catch (e) {
            continue;
          }
        }
      }
      entry.z = tile.z; entry.x = tile.x; entry.y = tile.y;
      if (entry.state === 'error' && !(entry.retryAt > earthTileClock)) {
        // Back-off elapsed: re-queue (an ancestor fallback mesh, if any,
        // keeps covering the slot while it refetches).
        entry.state = entry.mesh ? 'fallback' : 'queued';
      }
      if (entry.state === 'ready') {
        entry.lodLevel = tile.lodLevel || 0;
        earthTilePrefetch.delete(tile.key); // prefetch/normal race leftover
      } else if (entry.state === 'queued' && !entry.mesh) {
        const ancestor = earthReadyAncestor(tile);
        if (ancestor) materializeEarthTileFallback(entry, tile, ancestor, radius);
      }
      entry.lastUse = time;
      entry.dist = tile.dist;
      if (entry.state === 'queued' || entry.state === 'fallback') {
        entry.lodLevel = tile.lodLevel || 0;
        if (entry.img) {
          // Warmed image: materialize now. On failure the entry is 'error'
          // (img cleared) and re-plans on the next band change, like every
          // other failed tile — pumping it would be a no-op.
          materializeEarthTile(entry, tile, radius);
        } else if (entry.budgetHeld && entry.heldBand === z) {
          // Parked under byte pressure: parent fallback (above) already
          // covers this slot, so skip the refetch until the band changes.
        } else {
          entry.budgetHeld = false;
          earthTileQueue.push({ z: tile.z, x: tile.x, y: tile.y, dist: tile.dist, key: tile.key, labels: tile.wantLabels !== false, lod: tile.lodLevel || 0 });
        }
      }
    }
    // Ancestors are created after children in the priority list. Revisit the
    // queued children now that every ready coarse tile is discoverable.
    for (const tile of visible) {
      const entry = earthTiles.get(tile.key);
      if (entry && entry.state === 'queued' && !entry.mesh && !entry.img) {
        const ancestor = earthReadyAncestor(tile);
        if (ancestor) materializeEarthTileFallback(entry, tile, ancestor, radius);
      }
    }
    // Evict everything outside the visible set (also drops stale zoom bands).
    retireEarthTiles((key) => !wanted.has(key));
    earthTileQueue.sort((a, b) => a.dist - b.dist || (b.lod - a.lod));
    pumpEarthTileQueue();
    // LRU with visual-importance tiebreak: stale first, then coarse/outlying
    // tiles — the zoomed center (fine, small dist) is always evicted last.
    const earthTileEvictOrder = (a, b) =>
      ((a[1].lastUse || 0) - (b[1].lastUse || 0)) ||
      ((b[1].lodLevel || 0) - (a[1].lodLevel || 0)) ||
      ((b[1].dist || 0) - (a[1].dist || 0));
    // Hard LRU cap across bands (safety net; the visible set already bounds us).
    if (earthTiles.size > EARTH_TILE_CACHE_MAX) {
      const entries = Array.from(earthTiles.entries()).sort(earthTileEvictOrder);
      while (earthTiles.size > EARTH_TILE_CACHE_MAX && entries.length > 0) {
        const [key, entry] = entries.shift();
        disposeEarthTile(entry);
        earthTiles.delete(key);
      }
    }
    // R4 byte budget: park LRU until unique GPU textures fit 128 MB. Parked
    // wanted slots keep their entry (fallback mesh where an ancestor is
    // ready, else the base globe) and skip refetch until the band changes —
    // no holes, no refetch churn. The counter only tracks owner textures;
    // shared fallback slots cost nothing extra.
    if (earthTileTextureBytes > EARTH_TILE_TEXTURE_BUDGET) {
      const entries = Array.from(earthTiles.entries()).sort(earthTileEvictOrder);
      while (earthTileTextureBytes > EARTH_TILE_TEXTURE_BUDGET && entries.length > 0) {
        const [key, entry] = entries.shift();
        if (!entry || !entry.texture) continue;
        if (wanted.has(key)) {
          entry.budgetHeld = true;
          entry.heldBand = z;
          if (entry.mesh && earthTileGroup) earthTileGroup.remove(entry.mesh);
          if (entry.material) entry.material.dispose();
          releaseEarthTileTexture(entry);
          entry.mesh = null;
          entry.material = null;
          entry.texture = null;
          entry.labelsTexture = null;
          entry.state = 'queued';
          entry.img = null;
          const parked = earthReadyAncestor(entry);
          if (parked) materializeEarthTileFallback(entry, entry, parked, radius);
        } else {
          disposeEarthTile(entry);
          earthTiles.delete(key);
        }
      }
      refreshEarthTileLoadRatio();
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
      if (earthTileInFlight >= EARTH_TILE_FETCH_CONCURRENCY) break;
      const entry = { z: job.z, x: job.x, y: job.y, state: 'loading', img: null };
      const generation = earthTileGeneration;
      earthTilePrefetch.set(key, entry);
      earthTileInFlight += 1;
      loadEarthTilePair(job.z, job.x, job.y, (img) => {
        earthTileInFlight = Math.max(0, earthTileInFlight - 1);
        const current = earthTilePrefetch.get(key);
        if (current === entry && generation === earthTileGeneration && current.state === 'loading') {
          current.state = 'ready';
          current.img = img;
          current.readyAt = earthTileClock;
        }
        pumpEarthTileQueue();
      }, () => {
        earthTileInFlight = Math.max(0, earthTileInFlight - 1);
        if (earthTilePrefetch.get(key) === entry && generation === earthTileGeneration) earthTilePrefetch.delete(key);
        pumpEarthTileQueue();
      });
    }
  }

  // ─── Globe motion policy ────────────────────────────────────────────────
  // The globe is a *showpiece when idle, a stable instrument when used*:
  //   • It drifts (3°/s) only at orbit scale with nothing to read or touch.
  //   • It STANDS STILL while: dragging, coasting from a fling, hovering or
  //     selecting a zone (the target must not slip from under the laser while
  //     its preview loads/plays), a preview is open, a zoom is animating or
  //     zoomed in, or for EARTH_SPIN_IDLE_MS after any input (drag, stick,
  //     wheel, tap, zoom) so the user's last pose is respected.
  //   • Drift eases in over EARTH_SPIN_RAMP_MS and out over ~0.25 s — it never
  //     starts or stops with a jolt.
  //   • A release while moving flings the globe: velocity (sampled over the
  //     last ~120 ms) decays with a 0.55 s time constant.
  const EARTH_SPIN_RATE = Math.PI / 60;   // rad/s, idle drift
  const EARTH_SPIN_IDLE_MS = 4500;
  const EARTH_SPIN_RAMP_MS = 2000;
  const EARTH_FLING_TAU_MS = 550;
  const EARTH_FLING_MIN = 0.03;           // rad/s below which a fling is dropped
  const EARTH_FLING_MAX = 4.5;            // rad/s cap
  let earthSpinRate = 0;                  // eased drift rate (rad/s)
  let earthFrameClock = 0;                // last frame timestamp (ms)
  let earthLastInputAt = -1e9;            // frame-clock stamp of the last input
  let earthFling = { yaw: 0, pitch: 0 };  // coasting velocity (rad/s)
  let earthDragTrail = [];                // [{t, yaw, pitch}] recent drag poses
  let earthStickLast = -1;                // last stick-rotate timestamp (ms)

  function earthTouchInput() {
    earthLastInputAt = earthFrameClock;
    // The last input also cancels any stale fling from a previous gesture.
  }
  function earthNowMs() {
    try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : earthFrameClock; }
    catch (e) { return earthFrameClock; }
  }
  // Why the globe is (not) allowed to drift right now. Exposed for tests/HUD.
  function earthSpinHoldReason() {
    if (reducedMotion) return 'reduced-motion';
    if (earthDragging) return 'dragging';
    if (earthZoomAnim) return 'zoom-animating';
    if (earthZoomTarget > 1.02 || earthZoom > 1.02) return 'zoomed';
    if (Math.abs(earthFling.yaw) > EARTH_FLING_MIN || Math.abs(earthFling.pitch) > EARTH_FLING_MIN) return 'coasting';
    if (earthHoveredIndex >= 0) return 'hovering-zone';
    if (earthSelectedIndex >= 0) return 'zone-selected';
    if (earthPreviewLocationIndex >= 0 || earthPreviewItems.length > 0) return 'preview-open';
    if (earthFrameClock - earthLastInputAt < EARTH_SPIN_IDLE_MS) return 'recent-input';
    return '';
  }

  function advanceEarthSpin(time) {
    if (reducedMotion) { earthSpinRate = 0; earthFling = { yaw: 0, pitch: 0 }; return 0; }
    earthFrameClock = Number.isFinite(Number(time)) ? Number(time) : earthFrameClock;
    if (earthLastFrameTime < 0) {
      earthLastFrameTime = time;
      return 0;
    }
    const dt = Math.max(0, Math.min(100, time - earthLastFrameTime));
    earthLastFrameTime = time;
    const sec = dt / 1000;
    // 1) Fling coast (orbit scale only — a zoomed map must never slide away).
    let delta = 0;
    const flinging = !earthDragging && (earthFling.yaw !== 0 || earthFling.pitch !== 0);
    if (flinging) {
      if (earthZoomTarget > 1.02 || earthZoomAnim) {
        earthFling = { yaw: 0, pitch: 0 };
      } else {
        const decay = Math.exp(-dt / EARTH_FLING_TAU_MS);
        earthFling = { yaw: earthFling.yaw * decay, pitch: earthFling.pitch * decay };
        if (Math.abs(earthFling.yaw) < EARTH_FLING_MIN && Math.abs(earthFling.pitch) < EARTH_FLING_MIN) {
          earthFling = { yaw: 0, pitch: 0 };
        } else {
          rotateEarth(earthFling.yaw * sec, earthFling.pitch * sec);
          delta += earthFling.yaw * sec;
        }
      }
    }
    // 2) Idle drift with eased start/stop.
    const hold = earthSpinHoldReason();
    if (hold) {
      earthSpinRate *= Math.exp(-dt / 250);
      if (earthSpinRate < 1e-5) earthSpinRate = 0;
    } else {
      earthSpinRate = Math.min(EARTH_SPIN_RATE, earthSpinRate + EARTH_SPIN_RATE * (dt / EARTH_SPIN_RAMP_MS));
    }
    if (earthSpinRate > 0 && !earthDragging) {
      const d = earthSpinRate * sec;
      rotateEarth(d, 0);
      delta += d;
    }
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
      // Soft round stars (radial sprite) with per-star tint, instead of square
      // pixels: reads as a night sky rather than dead pixels.
      const starColors = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        const t = Math.random();
        const warm = t > 0.88, bright = 0.55 + Math.random() * 0.45;
        starColors[i * 3] = (warm ? 1.0 : 0.62 + t * 0.2) * bright;
        starColors[i * 3 + 1] = (warm ? 0.86 : 0.80 + t * 0.15) * bright;
        starColors[i * 3 + 2] = 1.0 * bright;
      }
      starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
      let starSprite = null;
      try {
        if (typeof document !== 'undefined') {
          const sc = document.createElement('canvas');
          sc.width = 64; sc.height = 64;
          const sx = sc.getContext('2d');
          const sg = sx.createRadialGradient(32, 32, 0, 32, 32, 32);
          sg.addColorStop(0, 'rgba(255,255,255,1)');
          sg.addColorStop(0.25, 'rgba(255,255,255,0.55)');
          sg.addColorStop(1, 'rgba(255,255,255,0)');
          sx.fillStyle = sg;
          sx.fillRect(0, 0, 64, 64);
          starSprite = new THREE.CanvasTexture(sc);
        }
      } catch (e) { starSprite = null; }
      const starMat = new THREE.PointsMaterial({
        color: 0xffffff, size: starSprite ? 0.22 : 0.08, transparent: true, opacity: 0.9,
        vertexColors: true, depthWrite: false,
      });
      if (starSprite) starMat.map = starSprite;
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
      earthMapTexture = applyEarthTileSampling(new THREE.CanvasTexture(earthMapCanvas));
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

      // Legacy full-globe geometry is retained at S=1. Zoomed views switch to
      // inverse-mapped rendered-space tessellation in updateEarthBaseGeometry.
      const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 48, 32);
      const earthMat = new THREE.MeshBasicMaterial({
        map: earthMapTexture || null,
        color: earthMapTexture ? 0xffffff : 0x0d2a3f,
      });
      installEarthWarpShader(earthMat);
      earthLegacyGeometry = earthGeo;
      earthGeo.setAttribute('earthRendered', earthGeo.attributes.position.clone());
      earthMesh = new THREE.Mesh(earthGeo, earthMat);
      // R2: shader-deformed + group-scaled globe must never be frustum-culled
      // from stale CPU bounds. Single-object cost, always visible when earth shown.
      earthMesh.frustumCulled = false;
      earthGroup.add(earthMesh);
      // A low-cost additive shell supplies a stable atmospheric limb while
      // warped map tiles retain their visible curvature.
      // R5 Fresnel-rim spec (owner): view-dependent limb glow at 1.03×Rvis
      // (ratio preserved through group scale). BackSide + depthTest means only
      // limb fragments outside the globe silhouette survive — the far-side
      // shell depth-fails against the opaque base, so there is no washed-out
      // disk and no glow over label centers. renderOrder 4 draws after tiles
      // (2) and heat (3). No cap discard by design: atmosphere extends past
      // the map cap. Opacity breathes with table tilt (0.12→0.20).
      try {
        const atmosphereGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.03, 32, 20);
          const atmosphereMat = new THREE.MeshBasicMaterial({
          color: 0x39d7ff, transparent: true, opacity: 0.24,
          blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
          depthTest: true,
        });
        atmosphereMat.onBeforeCompile = (shader) => {
              shader.vertexShader = 'varying vec3 vEarthRimNormal; varying vec3 vEarthRimViewPosition;\n' +
            shader.vertexShader
              .replace('#include <begin_vertex>', '#include <begin_vertex>\n vEarthRimNormal = normalize(normalMatrix * normalize(transformed));')
              .replace('#include <project_vertex>', '#include <project_vertex>\n vEarthRimViewPosition = - mvPosition.xyz;');
          shader.fragmentShader = 'varying vec3 vEarthRimNormal; varying vec3 vEarthRimViewPosition;\n' +
            shader.fragmentShader.replace('#include <opaque_fragment>', `
              float earthRim = pow(1.0 - abs(dot(normalize(vEarthRimNormal), normalize(vEarthRimViewPosition))), 3.0);
              diffuseColor.rgb = mix(vec3(0.04, 0.30, 0.85), vec3(0.50, 0.96, 1.0), earthRim);
              diffuseColor.a *= earthRim;
              #include <opaque_fragment>
            `);
        };
        earthAtmosphereMesh = new THREE.Mesh(atmosphereGeo, atmosphereMat);
        earthAtmosphereMesh.renderOrder = 4;
        earthAtmosphereMesh.frustumCulled = false;
        earthMesh.add(earthAtmosphereMesh);
      } catch (e) { earthAtmosphereMesh = null; }

      earthPinsGroup = new THREE.Group();
      earthPinsGroup.frustumCulled = false;
      earthMesh.add(earthPinsGroup);
      rebuildEarthPins();

      // Z2 tile layer: child of the mesh so patches inherit the geographic
      // frame (same convention as pins/hit-test) plus the group's zoom scale.
      earthTileGroup = new THREE.Group();
      // NOTE: do NOT set renderOrder on this THREE.Group. Group.renderOrder is a
      // *group sort order* that outranks every child's own renderOrder, so a value
      // here drew the whole tile layer AFTER the scene-rooted HUD (label, preview
      // card, bezel, compass) and buried them under the map at any zoom with tiles.
      // Tile meshes carry their own renderOrder (1 coarse / 2 fine).
      earthTileGroup.frustumCulled = false;
      earthMesh.add(earthTileGroup);
      earthTileZ = -1;
      earthTileCenterKey = '';

      // Z3 heat overlay: additive sprites that stay visible over the tiles.
      earthHeatGroup = new THREE.Group();
      earthHeatGroup.visible = false;
      earthHeatGroup.frustumCulled = false;
      earthMesh.add(earthHeatGroup);
      rebuildEarthHeatSprites();

      // NOTE: no platform deck under the globe. An early port added a dark
      // truncated cone here, but in-headset it read as a panel slicing the
      // earth into a hemisphere, so it was removed per owner request. The
      // globe floats free against the starfield.

      if (!earthLabelCanvas && typeof document !== 'undefined') {
        try {
          earthLabelCanvas = document.createElement('canvas');
          earthLabelCanvas.width = EARTH_LABEL_LOGICAL_W * 2; // 2× the logical layout (crisp in-headset)
          earthLabelCanvas.height = EARTH_LABEL_LOGICAL_H * 2;
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
          depthTest: false,
          side: THREE.DoubleSide,
        });
        earthLabelMesh = new THREE.Mesh(new THREE.PlaneGeometry(EARTH_LABEL_HALF_W * 2, EARTH_LABEL_HALF_H * 2), labelMat);
        earthLabelMesh.renderOrder = 100;
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
          // 512×716 keeps the 0.5 × 0.7 m billboard texel-square (no stretch).
          earthPreviewCanvas.width = 512;
          earthPreviewCanvas.height = 716;
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
          depthTest: false,
          side: THREE.DoubleSide,
        });
        earthPreviewMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), pvMat);
        earthPreviewMesh.renderOrder = 100;
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

  // Readout block for the Earth Atlas dock (drawn by vr_ui_canvas).
  function earthDockStatus() {
    try {
      const zoomed = earthZoom > 1.02 || earthZoomTarget > 1.02;
      const tier = EARTH_TIERS[earthTierIndex(earthZoom)];
      const tileOffline = (!earthTileAvailable || earthTileFailures >= EARTH_TILE_FAIL_LIMIT) && zoomed;
      const streaming = zoomed && earthTileFade() > 0.02 && earthTileLoadRatio < 0.995;
      let mapStatus = 'ORBITAL';
      if (tileOffline) mapStatus = 'OFFLINE';
      else if (streaming) mapStatus = 'STREAMING ' + Math.round(earthTileLoadRatio * 100) + '%';
      else if (earthTileFade() > 0.02) mapStatus = 'LIVE TILES';
      const featured = earthLocations[earthHoveredIndex] || earthLocations[earthSelectedIndex] || null;
      let scaleCaption = '—';
      if (zoomed) {
        const bar = earthScaleBar(earthZoom, earthFocus || earthFacingLatLon());
        if (bar && bar.caption) scaleCaption = bar.caption;
      }
      return {
        tier: tier.name,
        tierColor: tier.color,
        zoomPct: earthZoomPercent(),
        scaleCaption,
        mapStatus,
        mapOffline: !!tileOffline,
        location: featured ? (featured.name || featured.slug) : (zoomed ? 'WORLD' : 'EARTH ACTIVITY'),
        northUp: !!earthNorthUp,
        canOpenFeed: !!featured,
      };
    } catch (e) { return {}; }
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
      const playlist = (callbacks.getPlaylist && callbacks.getPlaylist()) || [];
      const idx = callbacks.getCurrentIndex ? callbacks.getCurrentIndex() : 0;
      ui.renderControlsCanvas(controlsCtx, {
        source,
        itemState,
        packMode: isPackExperience(),
        packContext: getPackContext(),
        playlist,
        idx,
        item: playlist[idx] || null,
        comments: callbacks.getComments ? callbacks.getComments() : [],
        hoveredButton,
        pressedButton,
        isCurved,
        curvatureMode,
        lockToViewer,
        autoNext: getAutoNext(),
        sceneMode,
        earth: sceneMode === 'earth' ? earthDockStatus() : null,
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
      const earthPanel = earthHudPanelHit(ray.origin, ray.direction);
      if (earthPanel) {
        updateEarthHoverFromRay(ray.origin, ray.direction); // keeps the location + button highlight
        return { ray, hit: null, controlIndex, panelDesc, earthPanel };
      }
      const hit = hitTestEarth(ray.origin, ray.direction);
      updateEarthHoverFromRay(ray.origin, ray.direction);
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
        let carded = false;
        if (hovering < 0) {
          const card = earthHudPanelHit(origin, direction);
          if (card) {
            dist = card.distance;
            hovering = -2; // card hover (lit laser; button highlight is drawn on the card)
            carded = true;
          }
          raycaster.set(origin, direction);
        }
        if (hovering < 0 && !carded && earthMesh && earthGroup && earthGroup.visible !== false) {
          let compassed = false;
          if (earthCompassMesh && earthCompassMesh.visible) {
            try {
              const hits = raycaster.intersectObject(earthCompassMesh, false);
              if (hits.length > 0) {
                dist = hits[0].distance;
                hovering = -3; // compass badge hover (own highlight channel)
                compassed = true;
              }
            } catch (e) {}
          }
          if (!compassed) {
            const hit = hitTestEarth(origin, direction);
            if (hit.hit) {
              dist = hit.dist;
              hovering = hit.zoneIndex >= 0 ? -2 : -1; // -2 = globe hover (no dock button)
            }
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
    const isHover = hovering >= 0 || overScreen || hovering === -2 || hovering === -3;
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
        activeRayInputSource = preferred || null;
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
      // XR hover highlight + preview fetch follow the same controller ray
      // (the laser helper only reports globe-vs-dock for its visuals).
      // Change-guarded inside: holding still never refetches.
      updateEarthHoverFromRay(activeRayOrigin, activeRayDir);
      if (earthDragging && earthXrGrabActive && sceneMode === 'earth') {
        const grabHit = hitTestEarth(activeRayOrigin, activeRayDir);
        if (grabHit.hit && grabHit.local) updateEarthDrag(grabHit, earthDragSource);
      }
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
  function pulseInput(source, strength, ms) {
    const actuator = source && source.gamepad && source.gamepad.hapticActuators &&
      source.gamepad.hapticActuators[0];
    if (!actuator || typeof actuator.pulse !== 'function') return;
    try {
      const r = actuator.pulse(strength === undefined ? 0.45 : strength, ms === undefined ? 120 : ms);
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
      // Location card: buttons click on press; the card body swallows the
      // press so it never grabs the globe behind it.
      if (sceneMode === 'earth' && target && target.earthPanel) {
        previewPointer.control = true;
        if (target.earthPanel.region) executeEarthPanelAction(target.earthPanel.region);
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
          updateEarthDrag(target.hit, previewPointer.source);
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
            // it, otherwise playback toggles (static pack cards and image
            // posts' prev/next thirds route through the select handler first).
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
              if (!handled && (source.kind === 'static-card' || source.kind === 'image') && callbacks.onMainScreenSelect && screenHit.uv) {
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
        if (event.deltaY) {
          const ray = previewRayAt(event.clientX, event.clientY);
          adjustEarthZoom(Math.exp(-(event.deltaY || 0) * 0.0016), ray);
        }
        if (event.deltaX) { earthTouchInput(); earthFling = { yaw: 0, pitch: 0 }; rotateEarth((event.deltaX || 0) * 0.0025 / Math.max(1, Math.sqrt(earthZoom)), 0); }
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
    earthRoll = 0;
    earthPoseQuat = false;
    earthLastFrameTime = -1;
    earthSpinRate = 0;
    earthFling = { yaw: 0, pitch: 0 };
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
    // The street bezel ring and compass dial are scene-rooted too: only the
    // Earth dressing pass re-shows them, so every other mode must hide them.
    if (!isEarth) {
      if (earthBezelMesh) earthBezelMesh.visible = false;
      if (earthCompassMesh) earthCompassMesh.visible = false;
      earthHudSlide.label = null;
      earthHudSlide.preview = null;
      earthHudLastT = -1;
    }
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
  // R4: the tile set wraps at the dateline, so Pacific views emit a crossing
  // box (west > east); the ≥350° guard remains for truly global low-z sets
  // (the server degrades those to the full set anyway).
  function earthVisibleBbox() {
    const zoomParam = earthActivityRequestZoom();
    if (zoomParam === null) return null;
    const anchor = earthFocus || earthFacingLatLon();
    const lat = Math.max(-90, Math.min(90, Number(anchor && anchor.lat) || 0));
    const lon = Number(anchor && anchor.lon) || 0;
    const bandZ = earthTileZoomAt(lat);
    const visible = earthTileVisibleSet(bandZ, lat, lon, EARTH_TILE_RING);
    if (!visible.length) return null;
    const n = 1 << bandZ;
    let minX = n, maxX = -1, minY = n, maxY = -1;
    for (const t of visible) {
      if (t.x < minX) minX = t.x;
      if (t.x > maxX) maxX = t.x;
      if (t.y < minY) minY = t.y;
      if (t.y > maxY) maxY = t.y;
    }
    const west = minX / n * 360 - 180;
    const east = (maxX + 1) / n * 360 - 180;
    // R4 dateline wrap: when the set covers both x=0 and x=n-1 the tiles form
    // one continuous wrapped interval — emit a crossing box (west > east) so
    // activity fetch stays scoped instead of degrading to global. The server
    // treats west > east as lon >= west OR lon <= east. Check before the
    // global-span guard: a wrapped set trivially spans minX=0..maxX=n-1.
    if (maxX - minX > n / 2) {
      const highs = [], lows = [];
      for (const t of visible) (t.x >= n / 2 ? highs : lows).push(t.x);
      if (highs.length && lows.length) {
        const outWest = Math.min(...highs) / n * 360 - 180;
        const outEast = (Math.max(...lows) + 1) / n * 360 - 180;
        const north = earthMercatorYToLat(minY / n);
        const south = earthMercatorYToLat((maxY + 1) / n);
        const round4 = (v) => Math.round(Number(v) * 10000) / 10000;
        return { west: round4(outWest), south: round4(south), east: round4(outEast), north: round4(north) };
      }
    }
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

  // Single choke point for hover detection on every input path (desktop
  // mouse ray, XR controller lasers): ray-cast the globe, publish the
  // hovered zone index, and let setEarthHoveredIndex drive the label
  // highlight + preview fetch (change-guarded, so per-frame calls are
  // cheap). Returns the zone index or -1. Previously only the desktop
  // path resolved zones — the XR laser collapsed everything to "globe",
  // so hover highlight + previews never fired on Quest.
  // Step 6.3: the compass badge is hoverable too — a laser over the badge
  // reports 'compass' so the preview button highlight path can surface it.
  // Ray → floating earth panels (reel card, WORLD › location panel):
  // { panel: 'card'|'label', region, distance } for the nearest one hit
  // (region '' off the buttons), else null. Panels sit in front of the
  // globe, so they take the pointer first.
  function earthHudPanelHit(origin, direction) {
    if (!raycaster || !origin || !direction) return null;
    let best = null;
    try {
      raycaster.set(origin, direction);
      if (earthPreviewMesh && earthPreviewMesh.visible) {
        const hits = raycaster.intersectObject(earthPreviewMesh, false);
        if (hits.length) {
          const ui = getUICanvas();
          const uv = hits[0].uv;
          let region = '';
          if (uv && ui && typeof ui.resolveEarthPreviewHit === 'function') {
            region = ui.resolveEarthPreviewHit(uv.x * ui.EARTH_PREVIEW_W, (1 - uv.y) * ui.EARTH_PREVIEW_H) || '';
          }
          best = { panel: 'card', region, distance: hits[0].distance };
        }
      }
      if (earthLabelMesh && earthLabelMesh.visible !== false) {
        const hits = raycaster.intersectObject(earthLabelMesh, false);
        if (hits.length && (!best || hits[0].distance < best.distance)) {
          const uv = hits[0].uv;
          let region = '';
          if (uv) {
            const x = uv.x * EARTH_LABEL_LOGICAL_W, y = (1 - uv.y) * EARTH_LABEL_LOGICAL_H;
            const b = EARTH_LABEL_RESET_RECT;
            if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) region = 'face';
          }
          best = { panel: 'label', region, distance: hits[0].distance };
        }
      }
    } catch (e) { return null; }
    return best;
  }
  function setEarthPreviewHoverRegion(region) {
    const next = region || '';
    if (next === earthPreviewHoverRegion) return;
    earthPreviewHoverRegion = next;
    lastEarthPreviewUpdate = -1e9; // repaint the hover highlight now
  }
  function setEarthLabelHoverRegion(region) {
    const next = region || '';
    if (next === earthLabelHoverRegion) return;
    earthLabelHoverRegion = next;
    lastEarthLabelKey = ''; // repaint the hover highlight now
  }
  function setEarthPanelHover(panelHit) {
    setEarthPreviewHoverRegion(panelHit && panelHit.panel === 'card' ? panelHit.region : '');
    setEarthLabelHoverRegion(panelHit && panelHit.panel === 'label' ? panelHit.region : '');
  }
  // What RESET ROTATION turns to: the location the panel is showing
  // (hovered, else selected), else the current zoomed focus, else — the
  // EARTH ACTIVITY globe — the whole globe stood upright.
  function earthResetTarget() {
    const idx = earthHoveredIndex >= 0 ? earthHoveredIndex : earthSelectedIndex;
    const row = (idx >= 0 && idx < earthLocations.length) ? earthLocations[idx] : null;
    if (row && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon))) {
      return { kind: 'location', lat: Number(row.lat), lon: Number(row.lon), name: row.name || '' };
    }
    if (earthFocus && earthZoomTarget > 1.0001) return { kind: 'focus', lat: earthFocus.lat, lon: earthFocus.lon, name: '' };
    return { kind: 'globe' };
  }
  // EARTH ACTIVITY reset: north up, equator level, no twist. Yaw is kept so
  // the side of the planet facing the viewer stays the same.
  function resetEarthGlobeUpright() {
    earthFaceAnim = null;
    releaseEarthPose();
    earthTouchInput();
    earthFling = { yaw: 0, pitch: 0 };
    const t0 = earthNowMs();
    earthZoomAnim = {
      t0, dur: EARTH_FACE_ANIM_MS,
      fromZoom: earthZoom, toZoom: earthZoomTarget,
      fromYaw: earthYaw || 0, toYaw: earthYaw || 0,
      fromPitch: earthPitch || 0, toPitch: 0,
    };
    if (reducedMotion) advanceEarthZoom(t0 + EARTH_FACE_ANIM_MS);
    return true;
  }
  // Panel buttons: 'face' (location panel) → RESET ROTATION; 'feed' (reel
  // card) → OPEN FEED, same routing as the dock (clusters drill in first).
  function executeEarthPanelAction(action) {
    if (sceneMode !== 'earth') return false;
    if (action === 'face') {
      const target = earthResetTarget();
      if (!target) return false;
      if (target.kind === 'globe') resetEarthGlobeUpright();
      else if (!faceEarthLocation(target.lat, target.lon)) return false;
      showNotification('RESET ROTATION');
      return true;
    }
    if (action === 'feed') {
      const idx = earthPreviewLocationIndex;
      const row = (idx >= 0 && idx < earthLocations.length) ? earthLocations[idx] : null;
      if (!row) return false;
      if (row.kind === 'cluster' && Number(row.location_count) > 1) handleEarthTap(idx, null);
      else selectEarthLocation(idx);
      return true;
    }
    return false;
  }

  function updateEarthHoverFromRay(origin, direction) {
    if (sceneMode !== 'earth' || !origin || !direction) return -1;
    // Pointing at a panel keeps its location: the ray leaving the zone to
    // reach a button must not close the card or blank the WORLD › title. A
    // sweep that crossed bare globe on the way restores the zone it just
    // left (short grace).
    const panelHit = earthHudPanelHit(origin, direction);
    setEarthPanelHover(panelHit);
    if (panelHit) {
      if (earthHoveredIndex < 0 && earthRecentHover.index >= 0 &&
          earthRecentHover.index < earthLocations.length &&
          earthNowMs() - earthRecentHover.at < EARTH_PANEL_HOVER_GRACE_MS) {
        setEarthHoveredIndex(earthRecentHover.index);
      }
      return panelHit.panel === 'card' ? 'preview' : 'label';
    }
    if (earthCompassMesh && earthCompassMesh.visible) {
      try {
        const c = earthCompassMesh.position;
        const r = Number(earthCompassMesh.userData.worldRadius) || 0.16;
        const ox = origin.x - c.x, oy = origin.y - c.y, oz = origin.z - c.z;
        const dx = direction.x, dy = direction.y, dz = direction.z;
        const a = dx * dx + dy * dy + dz * dz;
        if (a > 1e-12) {
          const t = Math.max(0, -(ox * dx + oy * dy + oz * dz) / a);
          const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
          if (Math.sqrt(px * px + py * py + pz * pz) <= r && t < 10) return 'compass';
        }
      } catch (e) {}
    }
    let hit = null;
    try {
      hit = hitTestEarth(origin, direction);
    } catch (e) {
      return -1;
    }
    const idx = hit && hit.hit ? hit.zoneIndex : -1;
    setEarthHoveredIndex(idx);
    return idx;
  }

  function setEarthHoveredIndex(index) {
    index = Number(index);
    if (index >= 0) earthRecentHover = { index, at: earthNowMs() };
    const changed = index !== earthHoveredIndex;
    earthHoveredIndex = index;
    earthPreviewLocationIndex = index;
    if (changed) {
      earthPreviewHoverSince = index >= 0 ? earthNowMs() : -1;
      earthPreviewVideoFailed = '';
      if (earthPreviewVideo) disposeEarthPreviewVideo();
      // Light haptic tick as the laser lands on a zone (XR only).
      if (index >= 0 && sceneMode === 'earth' && xrSession) pulseInput(activeRayInputSource, 0.18, 35);
    }
    if (index < 0) {
      if (earthPreviewAbortController) {
        try { earthPreviewAbortController.abort(); } catch (e) {}
        earthPreviewAbortController = null;
      }
      earthPreviewStatus = 'idle';
      earthPreviewItems = [];
      resetEarthPreviewYaw(null);
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
            earthPreviewIndex = 0;
            earthPreviewCycleAt = -1;
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

  function beginEarthDrag(source, hit) {
    if (!hit) return false;
    const hitObj = hit.hit ? hit : (hit.x !== undefined ? { hit: true, local: hit } : null);
    if (!hitObj || !hitObj.hit) return false;
    earthDragging = true;
    earthFaceAnim = null; // a grab takes the globe from the RESET ROTATION turn
    earthDragSource = source || 'pointer';
    earthFling = { yaw: 0, pitch: 0 }; // a new grab catches a coasting globe
    earthDragTrail = [];
    earthTouchInput();
    const initialVec = hitObj.local || (hitObj.x !== undefined ? hitObj : (hitObj.point || null));
    earthDragLastDir = initialVec ? { ...initialVec } : null;
    earthDragStartDir = initialVec ? { ...initialVec } : null;
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
    earthPressZone = (hitObj && hitObj.zoneIndex >= 0) ? hitObj.zoneIndex : -1;
    earthTopdownGrab = null;
    if (hitObj.local && earthTopdownActive() && earthZoom > 1.0001) {
      // Zoomed top-down: the world turns under the fixed viewing spot, so the
      // grab is tracked as a geographic reference only (no group translation).
      earthTopdownGrab = { geo: { ...hitObj.local }, point: hitObj.point ? { ...hitObj.point } : null };
      earthPointerZoom = null;
      earthGrabGeo = null;
      earthGrabAnchor = null;
    } else if (hitObj.local) {
      earthGrabGeo = { ...hitObj.local };
      earthPointerZoom = null;
      earthGrabAnchor = hitObj.point ? { ...hitObj.point } : null;
    }
    return true;
  }

  // Turn the world so geographic point `grab` shows where `cursor` shows now:
  // earthQuat ← earthQuat·R with R = rot(grab→cursor), and the focus (the
  // point at the anchor) moves by R⁻¹, so its world direction — and the
  // comfort anchor — stay exactly put. One minimal rotation per step: no
  // lat/lon bookkeeping, so the pole is just another point (no clamp, no
  // spin) and the map bearing carries through.
  function earthTopdownTurn(grab, cursor) {
    if (!earthFocus) return false;
    earthFaceAnim = null;
    const R = qFromUnitVectors(grab, cursor);
    const focus = qRotate(qConjugate(R), locationToUnit(earthFocus.lat, earthFocus.lon));
    const ll = unitToLatLon(focus);
    earthFocus.lat = ll.lat;
    earthFocus.lon = ll.lon;
    earthQuat = qMultiply(earthQuat, R);
    earthPoseQuat = true;
    earthNorthUp = false;
    earthZoomAnim = null; // the gesture owns the pose now (cancels any tap anim)
    if (earthMesh) earthMesh.quaternion.set(earthQuat.x, earthQuat.y, earthQuat.z, earthQuat.w);
    applyEarthRotation(); // re-pins the anchor
    return true;
  }

  // Grab step (closed loop, exactly like the full-globe grab): whatever
  // geographic point is now under the ray, the world turns so the pressed
  // point shows there instead. Both axes are free — no axis lock — so the
  // world turns the way the hand drags it. Returns true when consumed.
  function updateEarthTopdownPan(local) {
    if (!earthFocus || !earthTopdownGrab) return false;
    const grab = earthSafeUnit(earthTopdownGrab.geo);
    const cursor = earthSafeUnit(local);
    if (vDot(grab, cursor) > 1 - 1e-15) return true;
    return earthTopdownTurn(grab, cursor) || true;
  }

  // Stick / programmatic nudge: move the content by (cx, cy) screen units of
  // `arc` radians of the local rendered surface. The viewer-facing right/up
  // axes are mapped onto the focus's east/north tangents, so "right" is right
  // on screen whatever the map bearing is.
  function earthTopdownNudge(cx, cy, arc) {
    if (!earthFocus || !earthZoomAnchor) return false;
    const head = getHeadPosition();
    const f = vNorm({ x: earthZoomAnchor.x - head.x, y: earthZoomAnchor.y - head.y, z: earthZoomAnchor.z - head.z });
    let right = vCross(f, { x: 0, y: 1, z: 0 });
    if (vLen(right) < 1e-6) right = { x: 1, y: 0, z: 0 };
    right = vNorm(right);
    const up = vNorm(vCross(right, f));
    const m = { x: right.x * cx + up.x * cy, y: right.y * cx + up.y * cy, z: right.z * cx + up.z * cy };
    // Content moves along m: the point `ang` behind the focus (against m,
    // on the surface) is brought to the anchor.
    const F = locationToUnit(earthFocus.lat, earthFocus.lon);
    const mLocal = qRotate(qConjugate(earthQuat), m);
    const t = vSub(mLocal, vScale(F, vDot(mLocal, F)));
    const ang = Math.hypot(cx, cy) * arc;
    if (!(ang > 0) || vLen(t) < 1e-12) return false;
    const tn = vNorm(t);
    const behind = earthSafeUnit({
      x: F.x * Math.cos(ang) - tn.x * Math.sin(ang),
      y: F.y * Math.cos(ang) - tn.y * Math.sin(ang),
      z: F.z * Math.cos(ang) - tn.z * Math.sin(ang),
    });
    return earthTopdownTurn(behind, F);
  }

  function updateEarthDrag(direction, source) {
    if (!earthDragging || !direction) return;
    // R3: ignore hand-switch mid-drag. A second controller's move/release
    // must not hijack the active grab (source recorded in beginEarthDrag).
    if (source && earthDragSource && source !== earthDragSource) return;
    if (earthTopdownGrab && earthFocus && earthZoom > 1.0001) {
      const tl = (direction.local && direction.local.x !== undefined) ? direction.local
        : (direction.x !== undefined ? direction : null);
      if (!tl) return;
      const n = vNorm(tl);
      if (!earthDragEngaged) {
        // Engage as soon as the pointer leaves the tap tolerance: measured in
        // world metres when the hit carries a surface point, else as a chord
        // scaled by the local magnification (the same hand motion spans far
        // less ground the deeper you are zoomed).
        const g = earthTopdownGrab;
        const away = (direction.point && g.point)
          ? vLen(vSub(direction.point, g.point)) > 0.03
          : vLen(vSub(n, vNorm(g.geo))) * Math.max(1, earthEffectiveK(earthZoom)) > EARTH_TAP_CHORD;
        if (away) {
          earthDragMoved = earthDragEngaged = true;
          earthTopdownGrab.geo = n; // re-anchor here: engaging never jumps the world
          earthZoomAnim = null;
          earthTouchInput();
        }
        return;
      }
      earthTouchInput();
      updateEarthTopdownPan(n);
      return;
    }
    if (direction.hit && direction.point && earthFocus && earthZoom > 1.0001 && earthGrabGeo) {
      const hit = direction;
      if (vLen(vSub(hit.point, earthGrabAnchor)) > 0.002) {
        earthDragMoved = earthDragEngaged = true;
        earthZoomAnim = null;
        earthGrabAnchor = { ...hit.point };
        applyEarthZoom();
      }
      return;
    }
    const dirVec = (direction.local && direction.local.x !== undefined) ? direction.local
                 : (direction.x !== undefined ? direction
                 : (direction.point && direction.point.x !== undefined ? direction.point : null));
    if (!dirVec) return;
    const len = Math.sqrt(
      (dirVec.x || 0) * (dirVec.x || 0) +
      (dirVec.y || 0) * (dirVec.y || 0) +
      (dirVec.z || 0) * (dirVec.z || 0)
    ) || 1;
    const normalized = { x: (dirVec.x || 0) / len, y: (dirVec.y || 0) / len, z: (dirVec.z || 0) / len };
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
      const globeGrab = !(earthFocus && earthZoom > 1.0001);
      if (!earthDragEngaged) {
        if (globeGrab) {
          // Orbit scale: a drag begins the instant the pointer leaves the tap
          // tolerance (no 280 ms hold). The grab point is re-anchored HERE, so
          // engaging never jumps the globe by the dead-zone distance.
          if (chord > EARTH_TAP_CHORD) {
            earthDragEngaged = true;
            earthGrabGeo = { ...normalized };
            earthDragTrail = [];
          }
        } else {
          let heldLong = false;
          try {
            heldLong = (typeof performance !== 'undefined' && performance.now)
              ? (performance.now() - earthPressTime) >= EARTH_DRAG_HOLD_MS
              : false;
          } catch (e) {}
          if (heldLong || chord > EARTH_DRAG_CHORD) earthDragEngaged = true;
        }
      }
      if (earthDragEngaged) {
        earthTouchInput();
        // Single-axis lock decided once per drag from cumulative travel.
        if (!earthDragAxis) {
          const ax = Math.abs(earthDragCumX);
          const ay = Math.abs(earthDragCumY);
          if (ax > EARTH_AXIS_LOCK || ay > EARTH_AXIS_LOCK) {
            earthDragAxis = ax >= ay ? 'yaw' : 'pitch';
          }
        }
        // v2 grab-pan: keep the pressed geographic point under the current
        // ray at every zoomed level. The quaternion delta is derived from
        // rendered surface directions, so warp and roll are both respected.
        if (earthFocus && earthZoom > 1.0001 && earthGrabGeo) {
          const focusLocal = locationToUnit(earthFocus.lat, earthFocus.lon);
          const oldRendered = earthWarpLocal(earthGrabGeo, earthZoom, focusLocal);
          const cursorRendered = earthWarpLocal(normalized, earthZoom, focusLocal);
          const oldWorld = qRotate(earthQuat, oldRendered);
          const cursorWorld = qRotate(earthQuat, cursorRendered);
          // R3: near-antipodal deltas carry no stable rotation axis —
          // reject instead of 180°-jumping via an arbitrary orthogonal axis.
          const panDot = vDot(vNorm(oldWorld), vNorm(cursorWorld));
          if (panDot < -1 + 1e-6) {
            earthDragLastDir = normalized;
            return;
          }
          earthQuat = qMultiply(qFromUnitVectors(oldWorld, cursorWorld), earthQuat);
          earthNorthUp = false;
          if (earthMesh) earthMesh.quaternion.set(earthQuat.x, earthQuat.y, earthQuat.z, earthQuat.w);
          applyEarthZoom();
        } else if (globeGrab && earthGrabGeo) {
          // TRUE GRAB at orbit scale: solve yaw/pitch so the geographic point
          // that was grabbed sits exactly under the pointer ray's hit. North
          // stays up (no roll); pitch is clamped at ±1.2 like the sticks.
          const ll = unitToLatLon(earthGrabGeo);
          const cursorWorld = vNorm(qRotate(earthQuat, normalized));
          const solved = solveEarthFocusRotation(ll.lat, ll.lon, cursorWorld, 1.2);
          if (solved && Number.isFinite(solved.yaw) && Number.isFinite(solved.pitch)) {
            earthYaw = solved.yaw;
            earthPitch = solved.pitch;
            applyEarthRotation();
            earthDragTrail.push({ t: earthNowMs(), yaw: earthYaw, pitch: earthPitch });
            if (earthDragTrail.length > 12) earthDragTrail.shift();
          }
        } else if (earthDragAxis === 'pitch') {
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
    // R3: a different hand's release must not end the active drag.
    if (source && earthDragSource && source !== earthDragSource) return false;
    if (hit && hit.hit) updateEarthDrag(hit.point ? hit : hit.local, source);
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
    // Fling: velocity over the last ~120 ms of pose samples, only if the
    // pointer was still moving at release (a deliberate stop does not coast).
    earthFling = { yaw: 0, pitch: 0 };
    try {
      const now = earthNowMs();
      const recent = earthDragTrail.filter((p) => now - p.t <= 120);
      if (earthDragMoved && earthDragEngaged && recent.length >= 2 && now - recent[recent.length - 1].t <= 60 &&
          !(earthFocus && earthZoom > 1.0001)) {
        const a = recent[0], b = recent[recent.length - 1];
        const span = Math.max(16, b.t - a.t) / 1000;
        let dYaw = b.yaw - a.yaw;
        dYaw = ((dYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const clampV = (v) => Math.max(-EARTH_FLING_MAX, Math.min(EARTH_FLING_MAX, v));
        const vy = clampV(dYaw / span), vp = clampV((b.pitch - a.pitch) / span);
        if (Math.hypot(vy, vp) > EARTH_FLING_MIN * 4) earthFling = { yaw: vy, pitch: vp };
      }
    } catch (e) { earthFling = { yaw: 0, pitch: 0 }; }
    earthDragTrail = [];
    earthTouchInput();
    earthDragging = false;
    earthDragSource = null;
    earthDragLastDir = null;
    earthDragStartDir = null;
    earthDragEngaged = false;
    earthDragCumX = 0;
    earthDragCumY = 0;
    earthDragAxis = null;
    earthPressZone = -1;
    earthTopdownGrab = null; // next drag re-grabs
    if (earthGrabGeo && earthGrabAnchor && earthFocus) {
      const center = earthLiveCenter();
      const dir = qRotate(earthQuat, locationToUnit(earthFocus.lat,earthFocus.lon));
      const radius = earthVisibleRadius(earthZoom);
      earthZoomAnchor = { x:center.x+dir.x*radius,y:center.y+dir.y*radius,z:center.z+dir.z*radius };
    }
    earthGrabGeo = null;
    earthGrabAnchor = null;
    // The quaternion is authoritative after a drag. Do not reconstruct or
    // reset it here: doing so caused a one-frame jump and discarded roll.
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
      quaternion: { ...earthQuat },
      northUp: earthNorthUp,
      dragging: earthDragging,
      zoom: earthZoom,
      zoomTarget: earthZoomTarget,
      tileZoom: earthTileZoom(),
      focus: earthFocus ? { ...earthFocus } : null,
      anchor: earthZoomAnchor ? { ...earthZoomAnchor } : null,
      animating: !!earthZoomAnim,
      tileLodLevels: earthTileLodLevels.slice(),
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
          adjustEarthZoom(Math.exp(-thumbY * 0.045), activeRayOrigin && activeRayDir
            ? { origin: activeRayOrigin, direction: activeRayDir } : null);
          continue;
        }
        if (Math.abs(thumbX) > 0.12 || Math.abs(thumbY) > 0.12) {
          // Frame-rate independent, dead-zone-remapped, eased stick rotation:
          // both axes at once, gentle near centre, slower the deeper you zoom.
          const shape = (v) => {
            const m = (Math.abs(v) - 0.12) / 0.88;
            return m <= 0 ? 0 : Math.sign(v) * Math.pow(Math.min(1, m), 1.6);
          };
          const nowT = earthNowMs();
          const sdt = earthStickLast > 0 ? Math.max(0.004, Math.min(0.1, (nowT - earthStickLast) / 1000)) : 1 / 72;
          earthStickLast = nowT;
          const slow = 1 / Math.max(1, Math.sqrt(Math.max(1, earthZoom)));
          earthTouchInput();
          earthFling = { yaw: 0, pitch: 0 };
          if (earthFocus && earthZoom > 1.0001 && earthTopdownActive()) {
            // Zoomed: turn the world under the fixed viewing spot. Speed is a
            // constant ~0.9 m/s of surface at full deflection whatever the zoom
            // (arc = distance / (magnification × visible radius)).
            const arc = 0.9 * sdt / (Math.max(1, earthEffectiveK(earthZoom)) * earthVisibleRadius(earthZoom));
            earthTopdownNudge(shape(thumbX), shape(thumbY), arc);
          } else {
            rotateEarth(shape(thumbX) * 1.7 * sdt * slow, -shape(thumbY) * 1.2 * sdt * slow);
          }
        } else {
          earthStickLast = -1;
        }
      }
      // A / X (face button 1): the Quest "confirm". On a hovered zone it opens
      // that location's feed straight away (no need to zoom to the city band
      // first); on empty space it steps the map back out one level.
      let faceDown = false, faceSource = null;
      for (const source of sources) {
        const gp = source && source.gamepad;
        if (gp && gp.buttons && gp.buttons.length > 4 && gp.buttons[4].pressed) { faceDown = true; faceSource = source; }
      }
      if (faceDown && !prevBtnState.rightA) {
        earthTouchInput();
        if (earthHoveredIndex >= 0 && earthHoveredIndex < earthLocations.length) {
          selectEarthLocation(earthHoveredIndex);
        } else {
          adjustEarthZoom(1 / EARTH_ZOOM_STEP);
        }
        pulseInput(faceSource);
      }
      prevBtnState.rightA = faceDown;
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

  // XR trigger on the globe = GRAB (same drag machine as the mouse): hold the
  // trigger and sweep the controller to turn the planet under the laser; a
  // clean press-release is still a tap (zoom / select), dispatched by
  // endEarthDrag. Dock buttons and the compass keep their own click path.
  let earthXrGrabActive = false; // WebXR order: selectstart → select → selectend
  function earthCompassUnderRay(origin, direction) {
    try {
      if (!earthCompassMesh || !earthCompassMesh.visible || !raycaster) return false;
      raycaster.set(origin, direction);
      return raycaster.intersectObject(earthCompassMesh, false).length > 0;
    } catch (e) { return false; }
  }
  function onVRSelectStart(ev) {
    if (sceneMode === 'earth' && earthMesh && activeRayOrigin && activeRayDir && hoveredButton < 0 &&
        !earthCompassUnderRay(activeRayOrigin, activeRayDir) &&
        !earthHudPanelHit(activeRayOrigin, activeRayDir)) {
      const hit = hitTestEarth(activeRayOrigin, activeRayDir);
      if (hit.hit) {
        const hand = (ev && ev.data && ev.data.handedness) || activeRayHandedness || 'xr';
        if (beginEarthDrag(hand, hit)) earthXrGrabActive = true;
      }
    }
    pressedButton = hoveredButton;
    // Begin a trigger-drag scroll when pressing on the panel list/scrollbar.
    if (commentsPanelVisible && cPanelHover &&
        (cPanelHover === 'list' || cPanelHover === 'scrollbar')) {
      executeCommentAction(cPanelHover);
      cPanelDragMoved = false;
    }
    emitPreviewState();
  }

  function onVRSelectEnd(ev) {
    if (earthXrGrabActive) {
      earthXrGrabActive = false;
      let hit = null;
      try { if (activeRayOrigin && activeRayDir) hit = hitTestEarth(activeRayOrigin, activeRayDir); } catch (e) {}
      const hand = (ev && ev.data && ev.data.handedness) || activeRayHandedness || 'xr';
      if (earthDragging) {
        const acted = endEarthDrag(hand, hit && hit.hit ? hit : null);
        if (acted) pulseInput(ev && ev.data);
      }
    }
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

      if (sceneMode === 'earth' && earthMesh && earthXrGrabActive) {
        // The trigger gesture was owned by the grab machine (tap or drag) and
        // already dispatched — never double-fire zoom/select.
        handled = true;
      } else if (sceneMode === 'earth' && earthMesh) {
        // Floating panels first (reel card, location panel): they sit in
        // front of the globe.
        const card = earthHudPanelHit(rayOrigin, rayDir);
        if (card) {
          if (card.region && executeEarthPanelAction(card.region)) pulseInput(ev.data);
          handled = true;
        }
        raycaster.set(rayOrigin, rayDir);
        // Step 6.3: compass badge click → true-north pose (400 ms slerp is
        // inside resetEarthNorthUp's instant pose; the eased feel comes from
        // the zoom-frame smoothing, not a second animation machine).
        if (!handled && earthCompassMesh && earthCompassMesh.visible) {
          try {
            const hits = raycaster.intersectObject(earthCompassMesh, false);
            if (hits.length > 0) {
              if (resetEarthNorthUp()) {
                showNotification('NORTH UP');
                pulseInput(ev.data);
                handled = true;
              }
            }
          } catch (e) {}
        }
        if (!handled) {
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
              } else if (visualSource.kind === 'image' && callbacks.onMainScreenSelect && hits[0].uv
                && (function () {
                  // Left/right third of an image post steps its images.
                  try {
                    return !!callbacks.onMainScreenSelect({ u: hits[0].uv.x, v: 1 - hits[0].uv.y });
                  } catch (e) { return false; }
                })()) {
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
    if (earthLegacyGeometry) earthLegacyGeometry.dispose();
    if (earthAdaptiveGeometry) earthAdaptiveGeometry.dispose();
    earthLegacyGeometry = earthAdaptiveGeometry = earthAdaptiveTemplate = null;
    earthAdaptiveKey = '';
    earthMesh = null;
    earthPinsGroup = null;
    earthPreviewMesh = null;
    disposeEarthPreviewVideo();
    earthPreviewVideoFailed = '';
    earthPreviewHoverSince = -1;
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
    earthBaseCanvas = null;
    earthBaseCtx = null;
    earthBaseBuildToken++;
    earthHeatPaintedAt = -1e9;
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
    earthBezelMesh = null;
    earthCompassMesh = null;
    earthCompassCanvas = null;
    earthCompassCtx = null;
    earthCompassTexture = null;
    earthCompassKey = '';
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
    earthTopdownGrab = null;
    earthPoseQuat = false;
    earthRoll = 0;
    earthFaceAnim = null;
    earthPreviewHoverRegion = '';
    earthLabelHoverRegion = '';
    earthRecentHover = { index: -1, at: -1e9 };
    earthGrabGeo = earthGrabAnchor = earthPointerZoom = null;
    earthZoomAnim = null;
    earthZoomApplied = -1;
    resetEarthPreviewYaw(null);
    // Z2 tile teardown: dispose every patch + texture; the layer rebuilds
    // from scratch on the next earth entry.
    try { retireEarthTiles(() => true); } catch (e) {}
    earthTilePrefetch.clear();
    earthTileQueue = [];
    earthTileGeneration += 1;
    earthTileGroup = null;
    earthTileZ = -1;
    earthTileCenterKey = '';
    earthTileLastMaintain = -1;
    earthTileBaseFade = -1;
    earthTileClock = -1;
    earthTileProbeAt = -1;
    earthTilePausedUntil = -1;
    earthTileLoadRatio = 1;
    earthTileFailures = 0;
    earthTileAvailable = true;
    earthTileLabelsAvailable = true;
    earthAttributionText = OSM_ATTRIBUTION_TEXT_OSM_ONLY;
    earthAttributionFetched = false;
    earthTileTheme = 'light';
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
      case 'earth_north_up':
        if (sceneMode === 'earth') resetEarthNorthUp();
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
      earthHeatRamp,
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
        for (const k of ['lock', 'overlay', 'guide', 'glow', 'dockfreeze', 'glowprobe', 'domoverlay', 'vrtex', 'xrminimal', 'xrfull', 'earthmap', 'topdown', 'horizonhud']) {
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
            labelTitle: earthLabelTitle,
            labelDetail: earthLabelDetail,
            labelScale: earthLabelMesh ? earthLabelMesh.scale.x : null,
            labelVisible: !!(earthLabelMesh && earthLabelMesh.visible),
            labelRenderOrder: earthLabelMesh ? earthLabelMesh.renderOrder : null,
            hasPreview: !!earthPreviewMesh,
            previewVisible: !!(earthPreviewMesh && earthPreviewMesh.visible),
            previewWorldPos: earthPreviewMesh ? {
              x: earthPreviewMesh.position.x, y: earthPreviewMesh.position.y, z: earthPreviewMesh.position.z,
            } : null,
            previewScale: earthPreviewMesh ? earthPreviewMesh.scale.x : null,
            previewRenderOrder: earthPreviewMesh ? earthPreviewMesh.renderOrder : null,
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
      updateEarthHoverFromRay,
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
      earthTileZoomAt,
      unitToLatLon,
      rotateEarthDir,
      earthGeographicBasis,
      solveEarthFocusRotation,
      earthFacingLatLon,
      applyEarthZoom,
      advanceEarthZoom,
      zoomEarthTo,
      adjustEarthZoom,
      resetEarthZoom,
      resetEarthNorthUp,
      earthTopdownNudge,
      earthEulerYXZ,
      faceEarthLocation,
      executeEarthPanelAction,
      earthHudPanelHit,
      earthResetTarget,
      earthLabelHoverRegion() { return earthLabelHoverRegion; },
      earthLabelMeshForTest() { return earthLabelMesh; },
      earthPreviewHoverRegion() { return earthPreviewHoverRegion; },
      earthFaceAnimating() { return !!earthFaceAnim; },
      earthNowMs,
      earthPreviewMeshForTest() { return earthPreviewMesh; },
      earthPolarRowFilter,
      resetEarthZoomImmediate,
      handleEarthTap,
      // Earth tile layer seams (Z2).
      earthTileXY,
      earthTileKey,
      earthMercatorYFrac,
      earthMercatorYToLat,
      earthTileVisibleSet,
      earthTileAncestor,
      earthGreatCircleKm,
      earthNiceScaleDistance,
      earthWarpCapFade,
      earthRenderedDirection,
      earthTileFade,
      buildEarthTileGeometry,
      updateEarthTiles,
      pumpEarthTileQueue,
      setEarthTileImageLoader(fn) {
        earthTileImageLoader = (typeof fn === 'function') ? fn : null;
      },
      // Z3 seams: band-tracked activity fetch + heat overlay.
      earthTopdownActive,
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
      earthTileEntries() { return Array.from(earthTiles.values()); },
      earthTileGeometrySnapshot() {
        return Array.from(earthTiles.values()).filter((entry) => entry.geometry).map((entry) => ({
          z: entry.z, x: entry.x, y: entry.y, positions: Array.from(entry.geometry.attributes.position.array),
        }));
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
          pausedUntil: earthTilePausedUntil,
          errored: Array.from(earthTiles.values()).filter((e) => e.state === 'error').length,
          loadRatio: earthTileLoadRatio,
        };
      },
      // R4 byte budget seam: unique GPU texture bytes + budget.
      earthTileMemoryStats() {
        return {
          bytes: earthTileTextureBytes,
          budget: EARTH_TILE_TEXTURE_BUDGET,
          perTexture: EARTH_TILE_TEXTURE_BYTES,
        };
      },
      getEarthLabelDetail() { return earthLabelDetail; },
      getEarthLabelTitle() { return earthLabelTitle; },
      earthZoomPercent,
      easeEarthZoom,
      earthVisibleRadius,
      earthWarpK,
      earthEffectiveK,
      earthWarpTilesLive,
      earthWarpLocal,
      earthUnwarpLocal,
      earthWarpCapFade,
      earthScaleDistanceKm,
      earthScaleBar,
      earthBaseGeometry() { return earthMesh && earthMesh.geometry; },
      drawEarthScaleBar,
      tableTilt,
      resetEarthNorthUp,
      composeEarthTileCanvas,
      refreshEarthAttribution,
      earthAttributionText() { return earthAttributionText; },
      setEarthTileCanvasFactory(fn) { earthTileCanvasFactory = typeof fn === 'function' ? fn : null; },
      applyEarthTileSampling,
      earthTileLayerUrl,
      earthTileStyleMode,
      setEarthTileImageLoader(fn) { earthTileImageLoader = typeof fn === 'function' ? fn : null; },
      earthTileCacheStats() { return { ...earthTileCacheStats, size: earthTileImageCache.size }; },
      earthTileCacheClear() {
        earthTileImageCache.clear();
        earthTileCacheStats = { memoryHits: 0, storageHits: 0, misses: 0, stores: 0 };
      },
      stepEarthPreviewYaw,
      resetEarthPreviewYaw,
      earthPreviewYawState() {
        return { offset: earthPreviewYawOffset, velocity: earthPreviewYawVelocity, anchor: earthPreviewYawAnchor };
      },
      __loadTileImageForTest(url, onLoad, onError) { loadEarthTileImage(url, onLoad, onError); },
      __advanceEarthZoomForTest(time) { return advanceEarthZoom(time); },
      earthPinPosition(index) {
        try {
          const kids = (earthPinsGroup && earthPinsGroup.children) || [];
          const p = kids[Number(index) || 0];
          if (!p || !p.position) return null;
          return { x: p.position.x, y: p.position.y, z: p.position.z };
        } catch (e) { return null; }
      },
      earthTierIndex,
      earthMapBearing,
      setPreviewLook(yaw, pitch) { previewYaw = Number(yaw) || 0; previewPitch = Number(pitch) || 0; applyPreviewCamera(); },
      earthPreviewVideoState() { return { url: earthPreviewVideoUrl, failed: earthPreviewVideoFailed, hoverSince: earthPreviewHoverSince, now: earthNowMs(), index: earthPreviewIndex, hasMesh: !!earthPreviewMesh, lastUpdate: lastEarthPreviewUpdate }; },
      earthGazeClamp,
      earthSeparatePanel,
      earthAvoidKeepOuts,
      earthHudKeepOuts,
      earthViewAngles,
      earthRectOverlapsPanel,
      earthViewHalfFov,
      earthSpinHoldReason,
      earthTouchInput,
      earthFlingState() { return { yaw: earthFling.yaw, pitch: earthFling.pitch, spinRate: earthSpinRate }; },
      earthViewBasis,
      earthDockStatus,
      earthPreviewPosterImages,
      earthTileSourceIsLight,
      EARTH_TIERS,
      earthBezelState() {
        return {
          visible: !!(earthBezelMesh && earthBezelMesh.visible && earthCompassMesh && earthCompassMesh.visible),
          radius: earthBezelRadius(),
          northUp: !!earthNorthUp,
        };
      },
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
        earthZoom = earthZoomTarget;
        earthZoomAnim = null;
        earthZoomFrameTime = null;
        earthNorthUp = false;
        earthPoseQuat = false;
        earthRoll = 0;
        earthFaceAnim = null;
        earthFocus = focus ? { lat: Number(focus.lat) || 0, lon: Number(focus.lon) || 0 } : null;
        if (!earthFocus) earthZoomAnchor = null;
        else if (!earthZoomAnchor) earthZoomAnchor = { x: 0, y: 1.3, z: -1.15 };
        applyEarthRotation();
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
        earthPoseQuat = false;
        earthRoll = 0;
        earthYaw = Number(yaw) || 0;
        earthPitch = Math.max(-1.2, Math.min(1.2, Number(pitch) || 0));
        if (center) earthCenter = { x: center.x, y: center.y, z: center.z };
        earthLastFrameTime = -1;
        earthSpinRate = 0;
        earthFling = { yaw: 0, pitch: 0 };
        earthLastInputAt = -1e9;
        applyEarthRotation();
      },
      getEarthState,
      getScene() { return scene; },
      getCamera() { return camera; },
      getLabelMesh() { return earthLabelMesh; },
      getPreviewMesh() { return earthPreviewMesh; },
    },
  };
})();
