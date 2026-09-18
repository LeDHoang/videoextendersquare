/**
 * ECHO WebXR VR Module for Reels — v8.0 (Pure Three.js Engine with Path A Curvature)
 *
 * Fully overhauled using Three.js (r186) scene graph, THREE.OrbitControls,
 * and decoupled 2D In-VR UI Canvas (window.VRUICanvas).
 */
window.WebXRVR = window.WebXRVR || (function () {
  'use strict';

  const VR_VERSION = 'v8.1-20260919-entry-drag-hologram';
  console.log('[WebXRVR] Module loaded:', VR_VERSION);

  // ─── Constants & Configuration ──────────────────────────────────────
  const VR_TEX_CAP = 2048;
  const EARTH_RADIUS = 0.676;
  const EARTH_MAP_W = 2048;
  const EARTH_MAP_H = 1024;
  const EARTH_PIN_CAP = 64;
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
  let screenScale = 1.0;
  let controlsVisible = true;

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
  let cPanelHover = '';
  let cPanelHighlightId = null;
  let commentsPanelVisible = false;

  // Telemetry & Render Stats
  const renderStats = {
    earthDrawCalls: 0,
    reelDrawCalls: 0,
    starDrawCalls: 0,
    videoUploads: 0,
    earthPreviewUploads: 0,
  };
  let lastPreviewEmitTime = 0;

  // Video upload gating (avoids re-uploading identical frames every tick)
  let lastVisualKind = '';
  let lastVisualVersion = '';
  let lastVisualElement = null;
  let lastVideoTime = -1;

  // Three.js Core Instances
  let THREE = (typeof window !== 'undefined' && window.THREE) || null;
  let renderer = null;
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
  let laserLine = null;
  let laserPositions = null;
  let reticleMesh = null;
  let reticleTexture = null;
  // Last mouse-driven hover ray in preview (persistent head-ray endpoint).
  let previewHoverRay = null;
  let scratchMat4 = null;
  let scratchVec2 = null;
  let scratchVec3 = null;
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

  // 2D Canvases & Textures
  let vrProxyCanvas = null;
  let vrProxyCtx = null;
  let videoTexture = null;
  let controlsCanvas = null;
  let controlsCtx = null;
  let controlsTexture = null;
  let commentsCanvas = null;
  let commentsCtx = null;
  let commentsTexture = null;
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

  // ─── Below-screen console dock layout ───────────────────────────────
  // Upstream-faithful: the dock hangs below the screen bottom edge and
  // faces the viewer with locked roll, so the curved screen (DOME edges
  // reach z≈-1.6) can never occlude it. Pure math in computeDockPose so
  // the Node harness can assert the clearances without GL.
  const DOCK_W = 1.6;
  const DOCK_H = 0.6;
  const DOCK_GAP = 0.08;
  const DOCK_Z = -1.9;
  const SCREEN_CENTER_Y = 1.6;
  // Earth-station console: floats before + below the globe (front surface
  // z≈-0.62, bottom y≈0.44) so it is reachable, fully visible, and carries
  // the ride back to reels. Station chosen with the viewer tilt applied:
  // the tilted top edge still clears the sphere (see dock test).
  const EARTH_DOCK_POS = { x: 0, y: 0.20, z: -0.85 };

  function computeDockPose(headPos, mode) {
    const m = mode || sceneMode;
    const pos = (m === 'earth')
      ? { x: EARTH_DOCK_POS.x, y: EARTH_DOCK_POS.y, z: EARTH_DOCK_POS.z }
      : { x: 0, y: SCREEN_CENTER_Y - SCREEN_HALF_H - DOCK_GAP - DOCK_H / 2, z: DOCK_Z };
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

  function layoutControlsDock() {
    if (!controlsMesh) return;
    const pose = computeDockPose(getHeadPosition());
    controlsMesh.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
    controlsMesh.rotation.order = 'YXZ';
    controlsMesh.rotation.set(pose.pitch, pose.yaw, 0);
    // Side comments panel keeps its station but faces the viewer too.
    if (commentsMesh) faceViewerLevel(commentsMesh, getHeadPosition());
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

  function earthZoneAngularRadius(location) {
    const heat = Math.max(0, Math.min(1, Number(location && location.heat) || 0));
    return 0.11 + heat * 0.12;
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

  function refreshEarthLabel() {
    if (!earthLabelCtx || !earthLabelTexture) return;
    const hovered = (earthHoveredIndex >= 0 && earthHoveredIndex < earthLocations.length)
      ? earthLocations[earthHoveredIndex]
      : null;
    const selected = (!hovered && earthSelectedIndex >= 0 && earthSelectedIndex < earthLocations.length)
      ? earthLocations[earthSelectedIndex]
      : null;
    const featured = hovered || selected;
    const key = earthLocations.length + '|' + (featured ? featured.slug : '');
    if (key === lastEarthLabelKey) return;
    lastEarthLabelKey = key;
    try {
      const ctx = earthLabelCtx;
      const title = featured && featured.name ? featured.name : 'EARTH ACTIVITY';
      let detail;
      if (featured) {
        const heat = Math.round(earthHeatOf(featured) * 100);
        detail = heat + '% HEAT · ' + (Number(featured.active_reel_count) || 0) + ' ACTIVE';
      } else if (earthLocations.length === 0) {
        detail = 'NO RECENT ACTIVITY';
      } else {
        detail = earthLocations.length + (earthLocations.length === 1 ? ' ZONE' : ' ZONES');
      }
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
  function updateEarthDressing(time) {
    if (!earthGroup || earthGroup.visible === false) return;
    try {
      const head = getHeadPosition();
      // Deck rim keeps identity orientation (upstream flat platform).
      if (earthLabelMesh) earthLabelMesh.lookAt(head.x, head.y, head.z);
      if (earthPreviewMesh && earthPreviewMesh.visible) {
        earthPreviewMesh.lookAt(head.x, head.y, head.z);
      }
    } catch (e) {}
    if (!reducedMotion && earthPinsGroup) {
      try {
        const kids = earthPinsGroup.children;
        for (let i = 0; i < kids.length; i++) {
          const p = kids[i];
          const base = p.userData.baseScale || 1;
          const s = base * (1 + 0.22 * Math.sin(time * 0.003 + (p.userData.pulsePhase || 0)));
          p.scale.setScalar(Math.max(0.05, s));
        }
      } catch (e) {}
    }
    refreshEarthTexture();
    refreshEarthLabel();
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
    const hitDist = raySphereHit(rayOrigin, rayDir, earthCenter, EARTH_RADIUS * 1.08);
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
  }

  // Inverse of Ry(yaw)*Rx(pitch) applied to a world point, yielding
  // normalized fixed-frame local coordinates for zone matching.
  function earthLocalFromWorld(world) {
    const ox = world.x - earthCenter.x;
    const oy = world.y - earthCenter.y;
    const oz = world.z - earthCenter.z;
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

  function advanceEarthSpin(time) {
    if (reducedMotion || earthDragging) return 0;
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
      const opts = { canvas, alpha: true, antialias: true, powerPreference: 'high-performance' };
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
      videoTexture = new THREE.CanvasTexture(vrProxyCanvas);
      try { if (THREE.SRGBColorSpace !== undefined) videoTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    }
    if (!screenMesh) {
      const screenGeo = createScreenGeometry(curvatureMode);
      const screenMat = new THREE.MeshBasicMaterial({
        map: videoTexture,
        side: THREE.DoubleSide,
      });
      screenMesh = new THREE.Mesh(screenGeo, screenMat);
      screenMesh.position.set(0, 1.6, -2.2);
      scene.add(screenMesh);
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
          glowAlphaTexture = new THREE.CanvasTexture(glowAlphaCanvas);
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
        glowProbeCtx = glowProbeCanvas.getContext('2d');
      } catch (e) {
        glowProbeCanvas = null;
        glowProbeCtx = null;
      }
    }
    if (!ambilightMesh) {
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
      ambilightMesh.position.set(0, 1.6, -2.26);
      scene.add(ambilightMesh);
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
      controlsTexture = new THREE.CanvasTexture(controlsCanvas);
      try { if (THREE.SRGBColorSpace !== undefined) controlsTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    }
    if (!controlsMesh && controlsTexture) {
      const ctrlGeo = new THREE.PlaneGeometry(1.6, 0.6);
      const ctrlMat = new THREE.MeshBasicMaterial({
        map: controlsTexture,
        transparent: true,
        side: THREE.DoubleSide,
      });
      controlsMesh = new THREE.Mesh(ctrlGeo, ctrlMat);
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
      commentsTexture = new THREE.CanvasTexture(commentsCanvas);
      try { if (THREE.SRGBColorSpace !== undefined) commentsTexture.colorSpace = THREE.SRGBColorSpace; } catch (e) {}
    }
    if (!commentsMesh && commentsTexture) {
      const cpGeo = new THREE.PlaneGeometry(1.05, 1.28);
      const cpMat = new THREE.MeshBasicMaterial({
        map: commentsTexture,
        transparent: true,
        side: THREE.DoubleSide,
      });
      commentsMesh = new THREE.Mesh(cpGeo, cpMat);
      commentsMesh.position.set(1.55, 1.6, -2.0);
      commentsMesh.rotation.y = -0.4;
      commentsMesh.visible = false;
      scene.add(commentsMesh);
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
          reticleTexture = new THREE.CanvasTexture(rc);
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
      earthMapTexture = new THREE.CanvasTexture(earthMapCanvas);
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
        earthLabelTexture = new THREE.CanvasTexture(earthLabelCanvas);
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
        earthLabelMesh.position.set(0, EARTH_RADIUS + 0.28, 0);
        earthGroup.add(earthLabelMesh);
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
        earthPreviewTexture = new THREE.CanvasTexture(earthPreviewCanvas);
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
        earthPreviewMesh.position.set(0.94, 0.17, 0);
        earthPreviewMesh.visible = false;
        earthGroup.add(earthPreviewMesh);
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

  function visualSourceSignature(source) {
    return String(source.kind || '') + '|' + String(source.version || '');
  }

  function shouldUploadVisual(source) {
    if (!source || !source.element) return false;
    const sig = visualSourceSignature(source);
    const visualChanged = source.kind !== lastVisualKind ||
      sig !== lastVisualVersion ||
      source.element !== lastVisualElement;
    if (visualChanged) return true;
    if (source.kind === 'video') {
      if (hasNewVideoFrame) return true;
      if (Number(source.currentTime) !== Number(lastVideoTime)) return true;
      return false;
    }
    // Static cards / images only re-upload when something changed.
    return false;
  }

  function uploadVideoFrame(force) {
    const source = getVisualSource();
    if (!vrProxyCtx || !source.element) return false;
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
        try {
          vrProxyCtx.drawImage(source.element, 0, 0, VR_TEX_CAP, VR_TEX_CAP);
        } catch (drawErr) {
          return false;
        }
      } else {
        return false;
      }
      if (videoTexture) videoTexture.needsUpdate = true;
      lastUploadedSource = source.element;
      lastVisualKind = source.kind;
      lastVisualVersion = visualSourceSignature(source);
      lastVisualElement = source.element;
      if (source.kind === 'video') lastVideoTime = Number(source.currentTime) || 0;
      hasNewVideoFrame = false;
      pendingClearedFor = '';
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

  function updateUiTextures() {
    const ui = getUICanvas();
    if (!ui) return;
    const source = getVisualSource();
    let itemState = {};
    if (callbacks.getCurrentItemState) {
      try { itemState = callbacks.getCurrentItemState() || {}; } catch (e) {}
    }

    if (controlsCtx) {
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
        sceneMode,
        notificationText,
        notificationUntil,
        callbacks,
      });
      if (controlsTexture) controlsTexture.needsUpdate = true;
    }

    if (commentsCtx && commentsPanelVisible) {
      ui.renderCommentsPanelCanvas(commentsCtx, {
        comments: callbacks.getComments ? callbacks.getComments() : [],
        cPanelTab,
        cPanelScrollY,
        cPanelHover,
        cPanelHighlightId,
        user: callbacks.getCurrentUser ? callbacks.getCurrentUser() : null,
        currentTime: source.currentTime,
      });
      if (commentsTexture) commentsTexture.needsUpdate = true;
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
      cameraMode: previewCameraMode,
      sceneMode,
      stereo: stereoMode,
      reducedMotion,
      curvatureMode: getCurvatureMode(),
      lockToViewer,
      controlsVisible,
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
      if (source && source.ready === false) {
        clearPendingTexture();
      } else {
        uploadVideoFrame();
      }
      updateGlowColor(time, 120);
      applyGlowColor();
      renderStats.earthDrawCalls = 0;
      renderStats.reelDrawCalls = 1;
    } else if (sceneMode === 'earth') {
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
    if (sceneMode === 'earth' && controlIndex < 0) {
      const hit = hitTestEarth(ray.origin, ray.direction);
      setEarthHoveredIndex(hit.hit ? hit.zoneIndex : -1);
      return { ray, hit, controlIndex };
    }
    return { ray, hit: null, controlIndex };
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
          }
        }
        if (hovering < 0 && screenMesh && screenMesh.visible !== false) {
          const hits = raycaster.intersectObject(screenMesh, false);
          if (hits.length > 0) {
            dist = hits[0].distance;
            overScreen = true;
          }
        }
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
      reticleMesh.position.set(
        origin.x + direction.x * dist,
        origin.y + direction.y * dist,
        origin.z + direction.z * dist
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

  // XR per-frame: first tracked controller drives the shared laser and
  // dock hover highlight (upstream processInput, single active ray).
  function updateControllerLasers() {
    if (!renderer || !raycaster || !THREE || vrControllers.length === 0) return;
    try {
      if (!scratchMat4) scratchMat4 = new THREE.Matrix4();
      if (!scratchVec) scratchVec = new THREE.Vector3();
      if (!scratchVec2) scratchVec2 = new THREE.Vector3();
      for (let i = 0; i < vrControllers.length; i++) {
        const controller = vrControllers[i];
        if (!controller) continue;
        scratchMat4.identity().extractRotation(controller.matrixWorld);
        scratchVec.setFromMatrixPosition(controller.matrixWorld);
        scratchVec2.set(0, 0, -1).applyMatrix4(scratchMat4).normalize();
        const hovered = updateLaserPointer(scratchVec, scratchVec2);
        hoveredButton = hovered >= 0 ? hovered : -1;
        break; // single shared laser: first controller wins
      }
    } catch (e) {}
  }

  function toggleControlsVisibility() {
    controlsVisible = !controlsVisible;
    if (controlsMesh) controlsMesh.visible = controlsVisible;
    vrLastUiUploadT = -1;
    emitPreviewState();
    return controlsVisible;
  }

  function installPreviewListeners() {
    if (!previewCanvas || previewListeners) return;
    if (typeof previewCanvas.addEventListener !== 'function') return;
    const onPointerDown = function (event) {
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
      if (sceneMode === 'earth' && target && target.hit) {
        beginEarthDrag(source, target.hit);
        previewPointer.earth = true;
      }
    };
    const onPointerMove = function (event) {
      const target = updatePreviewHover(event.clientX, event.clientY);
      if (!previewPointer || previewPointer.id !== event.pointerId) return;
      const dx = event.clientX - previewPointer.x;
      const dy = event.clientY - previewPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) previewPointer.moved = true;
      previewPointer.x = event.clientX;
      previewPointer.y = event.clientY;
      if (previewPointer.control) return;
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
    };
    const finishPointer = function (event) {
      if (!previewPointer || previewPointer.id !== event.pointerId) return;
      const target = updatePreviewHover(event.clientX, event.clientY);
      if (sceneMode === 'earth' && previewPointer.earth) {
        endEarthDrag(previewPointer.source, target && target.hit);
      } else if (!previewPointer.control && !previewPointer.moved && target) {
        if (target.hit && target.hit.hit) {
          if (callbacks.onTogglePlay) { try { callbacks.onTogglePlay(); } catch (e) {} }
        } else if (target.controlIndex < 0 && raycaster && screenMesh && screenMesh.visible !== false) {
          // Tap on the video screen toggles playback (static pack cards
          // route through the pack select handler first).
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
            if (source.kind === 'static-card' && callbacks.onMainScreenSelect && screenHit.uv) {
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
      pressedButton = -1;
      vrLastUiUploadT = -1;
      try { if (previewCanvas.releasePointerCapture) previewCanvas.releasePointerCapture(event.pointerId); } catch (e) {}
      previewPointer = null;
    };
    const onWheel = function (event) {
      if (event.preventDefault) { try { event.preventDefault(); } catch (e) {} }
      if (sceneMode === 'earth') {
        rotateEarth((event.deltaX || 0) * 0.0025, (event.deltaY || 0) * 0.65 * 0.002);
        return;
      }
      if (previewCameraMode === 'orbit') {
        previewOrbitDistance = Math.max(1.2, Math.min(12, previewOrbitDistance + (event.deltaY || 0) * 0.006));
        applyPreviewCamera();
      }
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
    if (ambilightMesh) {
      if (ambilightMesh.geometry) ambilightMesh.geometry.dispose();
      ambilightMesh.geometry = createScreenGeometry(curvatureMode, 2.4 * 1.34, 2.4 * 1.34, 24, 24) ||
        new THREE.PlaneGeometry(3.2, 3.2);
    }
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
    if (screenMesh) screenMesh.visible = !isEarth;
    if (ambilightMesh) ambilightMesh.visible = !isEarth;
    if (controlsMesh) controlsMesh.visible = controlsVisible;
    if (commentsMesh) commentsMesh.visible = (!isEarth && commentsPanelVisible);
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
  }

  async function loadEarthActivity() {
    if (earthActivityAbort) {
      try { earthActivityAbort.abort(); } catch (e) {}
    }
    const generation = ++earthActivityGeneration;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    earthActivityAbort = controller;
    try {
      const fetchFn = typeof fetch !== 'undefined' ? fetch : null;
      if (!fetchFn) return;
      const response = await fetchFn('/api/reels/locations/activity?window_days=7&limit=128', {
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
      selectEarthLocation(selected);
      return true;
    }
    return false;
  }

  function getEarthState() {
    return {
      center: { ...earthCenter },
      yaw: earthYaw,
      pitch: earthPitch,
      dragging: earthDragging,
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
    emitPreviewState();
  }

  function onVRSelectEnd() {
    pressedButton = -1;
    emitPreviewState();
  }

  function onVRSelect(ev) {
    const controller = ev.target;
    let handled = false;
    if (raycaster && controller && scene) {
      const tempMatrix = new THREE.Matrix4();
      tempMatrix.identity().extractRotation(controller.matrixWorld);
      const rayOrigin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
      const rayDir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
      raycaster.set(rayOrigin, rayDir);

      if (sceneMode === 'earth' && earthMesh) {
        const hit = hitTestEarth(rayOrigin, rayDir);
        if (hit.hit && hit.zoneIndex >= 0) {
          selectEarthLocation(hit.zoneIndex);
          handled = true;
        }
      } else if (controlsMesh && controlsMesh.visible) {
        const hits = raycaster.intersectObject(controlsMesh);
        if (hits.length > 0 && hits[0].uv) {
          const index = controlIndexFromUV(hits[0].uv);
          if (index >= 0) {
            executeControlButton(index);
            handled = true;
          }
        }
      }
    }

    if (!handled && ev.data && ev.data.handedness) {
      if (ev.data.handedness === 'right') {
        if (callbacks.onNext) callbacks.onNext();
      } else if (ev.data.handedness === 'left') {
        if (callbacks.onPrev) callbacks.onPrev();
      }
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

  async function enterVR(options = {}) {
    if (xrSession) return xrSession;
    // A desktop preview owns the singleton renderer/loop; tear it down so
    // the immersive session starts from a clean slate (upstream parity).
    if (previewRunning) {
      try { stopPreview(); } catch (e) {}
    }
    const xr = (options && options.xr) || getXR();
    if (!xr) {
      return notifyVRError('webxr-unavailable', 'navigator.xr is absent (needs HTTPS or localhost)');
    }

    ensureThree();
    if (!THREE) {
      return notifyVRError('three-missing', 'three.min.js did not load');
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

    let session = null;
    const sessionOpts = {
      optionalFeatures: ['local-floor', 'local', 'bounded-floor', 'hand-tracking'],
    };

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

    xrSession = session;

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

      renderer.setAnimationLoop((time, frame) => {
        applySceneVisibility();
        if (sceneMode === 'reels') {
          const source = getVisualSource();
          if (source && source.ready === false) {
            clearPendingTexture();
          } else {
            uploadVideoFrame();
          }
          updateGlowColor(time, 800);
          applyGlowColor();
        } else {
          advanceEarthSpin(time);
          updateEarthDressing(time);
        }
        updateUiTextures();
        layoutControlsDock();
        updateControllerLasers();
        renderer.render(scene, camera);
      });
    }

    session.addEventListener('end', () => {
      xrSession = null;
      if (renderer) renderer.setAnimationLoop(null);
      stopVideoFrameTracking();
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('sx-vr-active');
        if (document.body) document.body.classList.remove('sx-vr-active');
      }
      if (callbacks.onExitVR) callbacks.onExitVR();
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
                    m.map !== commentsTexture && m.map !== earthPreviewTexture) {
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
    if (controlsTexture) { try { controlsTexture.dispose(); } catch (e) {} controlsTexture = null; }
    if (commentsTexture) { try { commentsTexture.dispose(); } catch (e) {} commentsTexture = null; }
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

  // Screen mesh defaults in createScreenGeometry(): 2.4 × 2.4 m.
  const SCREEN_HALF_W = 1.2;
  const SCREEN_HALF_H = 1.2;

  function visualPointFromHit(hitLocal) {
    if (!hitLocal) return null;
    return {
      u: Math.max(0, Math.min(1, (hitLocal.x / (SCREEN_HALF_W * 2)) + 0.5)),
      v: Math.max(0, Math.min(1, 0.5 - (hitLocal.y / (SCREEN_HALF_H * 2)))),
    };
  }

  function executeControlButton(index) {
    const ui = getUICanvas();
    const btns = ui ? ui.CTRL_BUTTONS : [];
    if (index < 0 || index >= btns.length) return;
    const action = btns[index].action;
    pressedButton = index;
    switch (action) {
      case 'prev': callbacks.onPrev && callbacks.onPrev(); break;
      case 'next': callbacks.onNext && callbacks.onNext(); break;
      case 'play': callbacks.onTogglePlay && callbacks.onTogglePlay(); break;
      case 'rew':  callbacks.onSeek && callbacks.onSeek(-5); break;
      case 'fwd':  callbacks.onSeek && callbacks.onSeek(5); break;
      case 'mode': callbacks.onToggleMode && callbacks.onToggleMode(); break;
      case 'curve': setCurvatureMode((curvatureMode + 1) % 3); break;
      case 'lock': lockToViewer = !lockToViewer; break;
      case 'mute':
        if (callbacks.onToggleMute) callbacks.onToggleMute();
        else if (videoElement) videoElement.muted = !videoElement.muted;
        break;
      case 'comments':
        commentsPanelVisible = !commentsPanelVisible;
        if (commentsMesh) commentsMesh.visible = commentsPanelVisible;
        break;
      case 'earth':
        if (isPackExperience() && callbacks.onTogglePackQueue) callbacks.onTogglePackQueue();
        else setSceneMode(sceneMode === 'earth' ? 'reels' : 'earth');
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

  // ─── Public Module API ──────────────────────────────────────────────
  return {
    init(video, cbs) {
      videoElement = video;
      callbacks = cbs || {};
      lockToViewer = !isPackExperience();
      console.log('[WebXRVR] Initialised', VR_VERSION);
    },

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
      const source = getVisualSource();
      if (source && source.ready === false) {
        clearPendingTexture();
      }
      if (videoTexture) videoTexture.needsUpdate = true;
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
            screenMesh.material.map = videoTexture;
          } else {
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
          if (controlsMesh) info.controls = { visible: controlsMesh.visible };
          if (commentsMesh) info.comments = { visible: commentsMesh.visible };
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
          info.earthMap = {
            hasTexture: !!(earthMesh && earthMesh.material && earthMesh.material.map),
            base: earthBaseSource,
            baseTried: !!earthBaseTried,
            mapOffset: earthMapTexture ? earthMapTexture.offset.x : null,
            pinCount: earthPinsGroup ? earthPinsGroup.children.length : 0,
            hasLabel: !!earthLabelMesh,
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
          .filter((button) => ui.isControlVisible(button.action, source, itemState, isPackExperience()))
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
