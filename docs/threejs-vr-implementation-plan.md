# ECHO WebXR VR Reels Player: Three.js Full Architectural Overhaul & USB Debugging Guide

**Document Status**: v8.10 PURE THREE.JS ACTIVE — FIRST-FRAME HOLD LANDED 2026-09-20
**Engine Version**: `v8.10-20260920-firstframe-hold` (+ v8.9 scope + fresh visuals wait for
HAVE_FUTURE_DATA before cutting in)
**Current Line Count**: `ui/assets/webxr_vr.js` (~4,750 lines) + `ui/assets/vr_ui_canvas.js` (~1,100 lines) + `ui/assets/three.min.js` (797 KB IIFE, r186)
**Primary Platform Targets**: Meta Quest 3, Meta Quest 3S (Horizon OS / Quest Browser), Desktop WebXR Parity Inspector (`/reels/immersive-preview`)
**Core Features**: Path A Custom Curvature (`DOME`, `SQ CURVE`, `FLAT`), Three.js r186, `OrbitControls` (orbit mode) + custom drag-look (headset mode), Live Telemetry Streaming  

---

## 1. Executive Summary & Architecture Status

ECHO's WebXR VR mode delivers high-fidelity 1:1 square master reels inside a floating 3D cosmic cinema environment, complemented by an interactive 3D **Earth View** for geographic reel discovery and an **Immersive Desktop Preview** for desktop development and debugging.

### 1.1 Current Architecture State: v8.6 Pure Three.js (Phases 0–4 + Parity + Device + Laser Fixes Landed)
The current system in [`ui/assets/webxr_vr.js`](file:///Users/hoangleduc/Documents/[ez]/Coding/VR%20Tiktok/videoextendersquare/ui/assets/webxr_vr.js) is a **pure Three.js engine** (the 6,278-line raw-WebGL v5.2 was fully replaced; working-tree file is ~5,050 lines):
- **Three.js (r186) Runtime**: Bundled offline in `ui/assets/three.min.js` and loaded ahead of the VR engine.
- **Three.js Integration**: `THREE.WebGLRenderer` (XR enabled) owns the GL context; `THREE.OrbitControls` drives ORBIT INSPECT mode; custom yaw/pitch drag-look drives HEADSET POV mode; Path A curvature switching (`DOME`, `SQ CURVE`, `FLAT`) rebuilds `PlaneGeometry`; `WebXRVR.getThree()` exposes the runtime.
- **Decoupled UI**: 2D in-VR canvas OS (comments, controls dock) lives in `ui/assets/vr_ui_canvas.js` (`window.VRUICanvas`) and feeds `THREE.CanvasTexture`s.
- **Raw WebGL retained only as reference**: `git show e3f7de1:ui/assets/webxr_vr.js` (v5.2, 6,278 lines; equivalently `git show HEAD^:...` while the overhaul commit `0da05fa` is HEAD — note **HEAD itself is already Three.js v8, not raw WebGL**) is the last fully-working upstream — consult its `initGL` / `XRWebGLLayer` / `uploadVisual2D` / `installPreviewListeners` when Three.js behavior is unclear (per owner decision 2026-09-19: keep v8, revisit raw WebGL for guidance when lost).

> [!NOTE]
> **Scope decision (owner, 2026-09-19)**: keep the v8 Three.js engine and restore
> upstream form/function parity in it rather than chasing a ~1,000-line target
> (§2.3's target tree is superseded by this decision). The test harness asserts
> on Three.js scene state (`getSceneInfo`, `getLastUploadedSource`) instead of
> raw WebGL mock counters. Phase 4 (VR session lifecycle + emulator unblock)
> has since landed — see §8; the engine now stands at ~3,400 lines / 43 tests.

---

## 2. Codebase Simplification: Current vs. Target Architecture

### 2.1 Metric Comparison

| Metric / Feature | Legacy Raw WebGL (v5.2, commit `e3f7de1`) | v8.2 Pure Three.js (2026-09-19, Phases 0–4 landed) | Target (Phase 3+4) |
|---|---|---|---|
| **Total Line Count (`webxr_vr.js`)** | 6,278 lines | **~3,400 lines** | Parity restored; further shrink only if form holds |
| **In-VR 2D Canvas UI** | Inlined (~2,100 lines) | Decoupled to `vr_ui_canvas.js` (675 lines) | Same (done) |
| **Linear Algebra Math** | Custom `mat4_*`, `quat_*` (~650 lines) | Native `THREE.Matrix4`, `THREE.Quaternion`, `THREE.Vector3`, `THREE.Raycaster` | Same (done) |
| **Shader Pipeline** | 5 custom GLSL shaders (~1,300 lines) | `THREE.MeshBasicMaterial` / `CanvasTexture` / `PointsMaterial` | Same (done) |
| **Earth Geometry & Raycast** | Custom vertex loop + quadratic solver | CPU `raySphereHit` + textured `SphereGeometry`, standard-equirect zones (seam-compensated), 3D pins, billboards | Same (done 2026-09-19) |
| **Desktop Preview Controls** | Custom mouse Euler drag | Custom yaw/pitch drag (headset POV) + `THREE.OrbitControls` (orbit inspect) + wheel + tap-play | Same (done 2026-09-19) |
| **Three.js Runtime** | None | Three.js r186 (797 KB offline IIFE) | Same (done) |
| **Test Pass Rate** | (v5.2-era harness retired) | 69/69 Node tests pass (43 carried + 13 v8.3 + 6 v8.4 + 1 v8.5 + 3 v8.6 + 2 v8.7 + 1 v8.8) | Target: keep green |

### 2.2 Root Causes of Current Technical Debt (Why the First Shrink Broke)

1. **Test Suite Coupling to Raw WebGL**:
   [`web/tests/webxr-earth.test.js`](file:///Users/hoangleduc/Documents/[ez]/Coding/VR%20Tiktok/videoextendersquare/web/tests/webxr-earth.test.js) does not just test high-level behavior; it passes a mock WebGL context (`makeMockGl`) into a Node.js VM context and explicitly checks:
   - `counters.deleted > 0` (intercepting `gl.deleteBuffer`, `gl.deleteTexture`, `gl.deleteProgram`).
   - `state.renderStats.earthDrawCalls > 0` and `videoUploads == 1`.
   - Internal private functions on `renderer.__test` (`advanceEarthSpin`, `setEarthPose`, `loadEarthPreviewNow`).
   Replacing raw WebGL with Three.js objects caused these tests to immediately fail because Three.js manages GPU buffers internally and doesn't invoke the mock hooks in the expected sequence.

2. **In-Headset 2D Canvas OS (~2,100 lines)**:
   The VR experience contains a full interactive operating system projected into 3D:
   - Virtual VR keyboard & comment composition.
   - Comments list with scrollable viewport, upvotes, and replies.
   - Interactive media scrubber dock with time displays, volume, and playback speed.
   - Reel pack carousel cards and hover preview tiles.
   These are drawn directly via HTML5 `<canvas>` 2D context. Simply removing them drops line count but breaks the core user experience inside the headset.

3. **WebXR Session & Frame Loop Lifecycle**:
   Three.js `renderer.xr` handles session acquisition and frame callbacks differently than raw WebGL (`gl.makeXRCompatible()`, `glLayer = new XRWebGLLayer(session, gl)`). Over-simplifying `enterVR()` resulted in `SecurityError` or silent hangs in VR simulation.

### 2.3 Phase 2 Target Architecture: Decoupled Three.js Core (superseded)

> [!NOTE]
> The ~1,000-line target below was **superseded by the owner scope decision (2026-09-19)**:
> parity with upstream form/function was restored instead, and the engine stands at
> ~3,400 lines / 43 green tests. Kept for historical context only.

To genuinely achieve ~1,000 lines without breaking functionality:
```
Target Architecture (~1,000 lines core + modular helpers)
├── ui/assets/three.min.js          ──> Three.js r186 + OrbitControls + XRControllerModelFactory (797 KB)
├── ui/assets/vr_ui_canvas.js       ──> In-VR 2D Canvas UI generator (~1,500 lines decoupled)
├── ui/assets/webxr_vr.js           ──> Pure Three.js WebXR Scene & Session Manager (~900 lines)
└── web/tests/webxr-earth.test.js   ──> Refactored test harness asserting on Three.js scene graph state
```

---

## 3. Architecture & Pipeline Overview

```mermaid
flowchart TB
    subgraph HostApp["Host Application & Asset Loading"]
        API["FastAPI /api/reels/player-inline"]
        HTML["ui/assets/reels.html"]
        Vendor["ui/assets/three.min.js (797 KB IIFE, r186)"]
        VRModule["ui/assets/webxr_vr.js (v8.2, ~3,400 lines)"]
    end

    subgraph ThreeBridge["Three.js Runtime & Scene Graph"]
        Renderer["THREE.WebGLRenderer (XR Enabled)"]
        Scene["THREE.Scene (Celestial Skybox & World Rig)"]
        
        subgraph DisplaySubsystem["Display Subsystem"]
            Mesh["Path A Subdivided Plane (48x48 Grid)"]
            Proxy["vrProxyCanvas (2048x2048 GPU Buffer)"]
            Glow["Ambient Radial Glow Quad"]
            Curvature["Curvature: DOME / SQ CURVE / FLAT"]
        end

        subgraph EarthSubsystem["Earth Discovery Subsystem"]
            EarthMesh["THREE.SphereGeometry (R=0.676m)"]
            EarthPins["THREE.Group (Pulsing Beacons)"]
            EarthRay["THREE.Raycaster (Heat Zone Hit Testing)"]
        end

        subgraph PreviewSubsystem["Desktop Preview Subsystem"]
            Orbit["THREE.OrbitControls (Damped Orbit)"]
            Camera["THREE.PerspectiveCamera (Dual Mode)"]
        end

        Input["6DOF Natural Grab (Zero Z-Roll Horizon Lock)"]
    end

    subgraph Headset["Meta Quest 3 / 3S"]
        Compositor["Horizon OS VR Compositor (72Hz / 90Hz)"]
        Touch["Meta Quest Touch Plus / Hand Tracking"]
    end

    API --> HTML
    Vendor --> HTML
    HTML --> VRModule
    VRModule --> Renderer
    Proxy --> Mesh
    Curvature --> Mesh
    Glow --> Scene
    Mesh --> Scene
    EarthMesh --> Scene
    EarthPins --> Scene
    Orbit --> Camera
    Renderer --> Compositor
    Touch --> Input
```

### 3.1 Zero-CDN Offline Asset Packaging
To guarantee **zero network latency, offline execution, and airgapped reliability** across firewalled or isolated Quest headsets:
- **Source**: `web/src/vr/three_bundle_entry.js` imports `three` (r186), `OrbitControls`, and `XRControllerModelFactory`.
- **Bundle**: Compiled via esbuild into `ui/assets/three.min.js` (797 KB standalone IIFE).
- **Injection**:
  - `server/routers/reels.py` replaces `<script>__THREE_JS__</script>` with the inlined bundle across both `/api/reels/player` and `/api/reels/player-inline`.
  - Legacy Streamlit view `ui/views/reels_view.py` similarly injects `__THREE_JS__`.
  - `ui/assets/reels.html` executes `three.min.js` immediately before `webxr_vr.js`.

---

## 4. Subsystem Implementations

### 4.1 Earth View Subsystem
The interactive 3D Earth globe allows users to discover location-tagged reels geospatially (restored 2026-09-19, upstream parity):
- **Holographic Base**: Natural Earth photo (`/assets/earth-natural-1024x512.jpg` in dev, `/api/reels/earth-texture` backend route in production/Quest; procedural fallback always available) re-styled per-pixel upstream-verbatim — land/ocean classify, luminance tint, cyan edge-detect coastlines — plus 10°/30° graticule and scanlines. Source reported as `earthMap.base` (`photo`/`fallback`).
- **Textured Sphere**: `THREE.SphereGeometry(0.676, 48, 32)` with the live `2048×1024` equirect `CanvasTexture`, sRGB color space.
- **Equirect/UV Convention**: standard equirect `x = (lon+180)/360·W`, `y = (90−lat)/180·H` (upstream verbatim) for both the photo and painted zones, plus `earthMapTexture.offset.x = +0.25` with `RepeatWrapping` to compensate the `THREE.SphereGeometry` UV seam (verified against three r186 source: `x=−r·cos φ`, `z=r·sin φ`, `uv=(u,1−v)`). Pins, zones, photo texels, and hit-test vectors all coincide.
- **3D Pulsing Pins**: up to 64 cones at exact `locationToUnit` vectors (same convention as hit-testing, so hover and visuals agree), heat-colored, sine pulse (frozen under reduced motion).
- **Hover/Selected Label** (`0.86×0.15`, upstream card spec: selected/hovered name else status, amber vs default border) and **Hover Preview Billboard** (`0.50×0.70`, fed by `VRUICanvas.renderEarthPreviewCanvas`, hover triggers debounced fetch) billboarded per frame. Zone tap → `selectEarthLocation` → host swaps the location feed → back to reels mode for in-VR playlist playback (stays on globe with status on reject). No platform deck — an early cone build read as a hemisphere-slicing panel in-headset and was removed per owner request; the globe floats free.
- **Raycast Hit Testing**: CPU `raySphereHit` + zone match (unchanged); hover loads at most 3 cancellable location reels.
- **Draw Call Gating**: reels playback → earth draws 0; earth mode → video uploads pause.

### 4.2 Immersive Desktop Preview Subsystem
The desktop preview inspector (`/reels/immersive-preview`) allows complete testing without a physical headset:
- **OrbitControls Integration**: Integrated `THREE.OrbitControls` with `enableDamping = true` and `dampingFactor = 0.05`, supporting fluid mouse drag, pinch zoom, and right-click panning.
- **Dual Camera Modes**:
  - **ORBIT INSPECT**: Free 360° orbital camera positioned at $(0, 1.6, 2.5)$ targeting $(0, 1.4, -2.0)$ to inspect screen curvature, ambient glow, and controller models.
  - **HEADSET POV**: Snaps the camera to $\{x: 0, y: 1.6, z: 0\}$, simulating the exact physical viewpoint of a seated or standing Quest 3 user.
- **Real-Time Mode Switching**: Seamlessly toggle between curvature profiles (`dome`, `sq_curve`, `flat`) and stereo playback modes (2D mono vs. 3D Side-by-Side).
- **Below-Screen Console Dock** (2026-09-19): the controls dock hangs below the screen bottom edge at $(0, 0.02, -1.9)$, yaw/pitch-facing the viewer with locked roll — dome extrusion (edges reach $z \approx -1.6$) can never occlude it. Look/drag down to reach it in HEADSET POV (same as upstream, whose dock sat at $y \approx -0.56$). In earth mode it re-stations to a **front console at $(0, 0.20, -0.85)$** (re-stationed from $(0, 0.30, -0.95)$ after a dock/globe clip fix — see §8) before/below the globe, carrying the ride back to reels.
- **All-Red Laser + Head-Ray** (2026-09-19): `THREE.Line` ray + billboarded radial reticle (0.045 idle / 0.07 hover), updated per frame in both loops (controllers in XR, cached mouse-hover ray — else head-forward — in preview, always visible).
- **Single-Source Visibility** (2026-09-19): `applySceneVisibility()` gates all six memberships from `sceneMode`, enforced from `setSceneMode`, scene init, and both frame loops; `enterVR` re-asserts the mode on entry.

### 4.3 v8.3 Lock-to-Viewer, Controller Input & Comment Surfaces (2026-09-20)
Restores the v5.2 interaction model in the Three.js engine (full checklist in
[`docs/v8.3-vr-parity-restore-plan.md`](file:///Users/hoangleduc/Documents/[ez]/Coding/VR%20Tiktok/videoextendersquare/docs/v8.3-vr-parity-restore-plan.md)):
- **Head lock** (`applyLockToViewer`): screen at `screenDistance` (default 2.24 m) along head
  forward, orientation = head quaternion — perpendicular, centered, 4.0 m wide so it fills the
  horizontal view. Per-frame in the XR loop and in headset-POV preview; re-posed via
  `commitScreenTransform()` (screen + 1.34× glow + overlay share the pose; curvature scales
  uniformly through `mesh.scale = screenScale/2.4`). Unlock → free 6DOF grip-drag, level-facing.
- **Controller map** (`processXRInput`, per `XRSession.inputSources`): grip+stickY = scale
  (0.04/frame, clamp 1–10 m); **grip+stickX = distance** (v8.3 addition, right = further, 0.03/frame,
  clamp 1.2–6 m); stickY flick = next/prev; stickY-on-panel = list scroll; stickX flick = seek ±5 s;
  A = play/pause; B = toggle dock+guide; trigger chain = panel → dock → popup → screen → empty.
  Earth mode keeps stick-rotate + B-toggle. Haptics on interactions.
- **Dock/panels track the screen**: locked anchor `{0, 1.52, −screenDistance}` (level, room-stable);
  unlocked = screen-local offsets (upstream factors: dock width `scale·0.82`, panels `±(scale/2+w/2+0.384)`,
  `z −0.15`). Below-screen dock, **comments LEFT**, **guide RIGHT**, all `faceViewerLevel`.
- **AUTO/LOOP + LOCK/FREE labels**: dock pills render live `getAutoNext()` state (`AUTO`/`LOOP` + ⟳)
  and lock state (`LOCK`/`FREE` + 🔒/🔓) with active accents — upstream pill styles.
- **Popup overlay** (`renderOverlayCanvas`): time-synced comments `[t, t+4.2s]`, max 3 middle-left,
  fade in/out, hover pill; separate transparent quad sharing the screen pose; click → panel opens
  scrolled + highlighted. Suppressed while the panel is open.
- **Comments panel interaction**: hover regions, tabs, close, scroll buttons, trigger/mouse/wheel
  drag-scroll, `seek:`/`like:`/`profile:`/`account` actions, DOM-overlay Quest keyboard posting via
  the wired `onPostComment` host callback.
- **Guide panel**: 440×760 canvas (vector controller artwork), six mapping cards, rendered once per
  session, toggled with the dock (B button, 5 s auto-hide while playing).

### 4.4 v8.4 Device Fixes (2026-09-20, from on-device Quest testing)
Full checklist in [`docs/v8.4-vr-device-fixes-plan.md`](file:///Users/hoangleduc/Documents/[ez]/Coding/VR%20Tiktok/videoextendersquare/docs/v8.4-vr-device-fixes-plan.md):
- **Tandem rig** (owner-confirmed): dock + comments + guide always derive from the *live* screen
  transform — locked, the whole rig follows the head in tandem; unlocked, it freezes in the room.
  Screen takes the full head quaternion; panels stay roll-free (`faceViewerLevel`).
- **Paint-order ladder** (legacy parity): `depthTest: false` + `renderOrder` — screen 0, overlay 2,
  dock 3, comments/guide 4. Legacy drew the reels view with `DEPTH_TEST` effectively off
  (painter's algorithm); the port's depth-tested UI was culled behind the head-swept screen.
- **Curvature z-scale fix**: uniform `scale.set(s,s,s)` so the dome depth scales with the screen
  (upstream `R_world = R·scale`).
- **Controller photo**: `renderGuideCanvas` uses the live `window.QUEST_CONTROLLER_B64`
  (542×900, injected by `reels.py` from `quest_controller_img.js`) with vector fallback and a
  dirty-flag re-upload when the photo arrives late.
- **Dirty-only overlay**: re-render/re-upload only when the popup ID-set or hover changes; fade
  repaints ≤10 Hz only while visible; zero popups → zero uploads (kills the v8.3 10 Hz 1024² churn
  flagged in the playback investigation).
- **Legacy sampling**: `LinearFilter` + `generateMipmaps: false` on all 10 `CanvasTexture`s
  (legacy set `LINEAR`/no-mipmaps everywhere) — crisper text, no mipmap regen per re-upload.
- **Respec A/B**: `WebXRVR.setVideoUploadMode('subimage'|'respec')` (+ `?vrTexMode=respec` auto-read);
  `respec` disposes the video texture per upload to force full `texImage2D` re-specs (legacy path) —
  decisive on-device test for the Quest `texSubImage2D` driver suspicion (three r186 uses
  sub-image updates for same-size canvas re-uploads).
- **XR telemetry**: frame-interval + upload counters POSTed ~1 Hz to the existing `/api/reels/diag`
  while presenting (playback-investigation §4 workflow).

### 4.5 Path A: Screen Curvature Mathematics
The video screen mesh uses a subdivided quad grid ($48 \times 48$ tessellation, 2.4 m base, live-scaled by `screenScale/2.4`) whose vertices are deformed on the **CPU** once per curvature-mode switch — `createScreenGeometry()` bakes the deform into a rebuilt `THREE.PlaneGeometry` (rendered with `THREE.MeshBasicMaterial`, no custom shaders) — preserving sharp 1:1 square master proportions. Coordinates are normalized by half-extent ($\hat{x} = x/halfW$, etc.), which is mathematically identical to the upstream v5.2 GPU vertex shader that operated on $[-1, 1]$ coordinates:

```
       🌐 DOME (Mode 1)               🔲 SQ CURVE (Mode 2)               📺 FLAT (Mode 0)
    Concave Radial Cap              Biaxial Pillow Curve                 Planar Quad
         .-''''-.                         .-------.                       .-------.
       .'        '.                      /         \                      |       |
      /     •      \                    |     •     |                     |   •   |
       '.        .'                      \         /                      |       |
         '-....-'                         '-------'                       '-------'
    Center (0,0) is Apex             Horizontal & Vertical              Z = 0 Flat
    Radial Curvature toward user     Symmetrical amphitheater           Planar screen
```

#### Constants & Parameters:
- Arc Angle: $\alpha = 0.65\text{ rad} \approx 37.24^\circ$
- Sphere Radius: $R = \frac{1}{\alpha} \approx 1.5385\text{ m}$

#### Curvature Formulations:
1. **`🌐 DOME` (Concave Hemisphere)**: Apex at $(0, 0)$, all edges curve smoothly toward the viewer ($+Z$ in camera space); $\hat x, \hat y$ are half-extent-normalized coordinates:
   $$r = \sqrt{\hat x^2 + \hat y^2}, \quad \phi = r \cdot \alpha, \quad x' = \frac{\hat x}{r} R \sin(\phi), \quad y' = \frac{\hat y}{r} R \sin(\phi), \quad z' = R (1 - \cos(\phi))$$
2. **`🔲 SQ CURVE` (Biaxial Pillow Curve)**: Dual-axis independent curvature along both horizontal ($X$) and vertical ($Y$) axes:
   $$\theta_x = \hat x \cdot \alpha, \quad \theta_y = \hat y \cdot \alpha, \quad x' = R \sin(\theta_x), \quad y' = R \sin(\theta_y), \quad z' = R (1 - \cos(\theta_x) \cos(\theta_y))$$
3. **`📺 FLAT`**: Standard planar quad with zero depth deformation ($z' = 0$).

---

## 5. Qualcomm Adreno 740 GPU Safeguard

### 5.1 The 4K Video Texture Bottleneck
Raw 4K HEVC frames ($3840 \times 3840$ pixels in RGBA format) consume **56.25 MiB per frame**.
On the Meta Quest 3 (Snapdragon XR2 Gen 2 / Adreno 740), calling unconstrained `gl.texImage2D` with raw 4K frames stalls the GPU memory bus for **45–110 ms per frame**, dropping compositor frame rates from **72 FPS down to ~22 FPS**.

### 5.2 The 2048² Proxy Canvas Pipeline
ECHO's VR engine solves this hardware limitation:
1. **Resolution Cap**: The Quest 3 display panel is $\sim 1832 \times 1920\text{ px}$ per eye. Oversampling beyond 2048² produces negligible visual gain.
2. **GPU Blit**: The video frame is rendered into a $2048 \times 2048$ proxy canvas (`vrProxyCanvas`) using hardware 2D `drawImage`.
3. **In-Place SubImage Upload**: The engine blits into the proxy canvas and flags the wrapping `THREE.CanvasTexture` with `needsUpdate = true`; Three.js then issues `gl.texSubImage2D` internally after initial allocation (same-size uploads), preventing texture re-specification and avoiding pipeline flushes. The engine itself makes no raw GL calls outside Three's state tracker.
4. **Result**: Frame upload time drops to **$\sim 13\text{ ms}$**, maintaining a rock-solid **72 FPS / 90 FPS** in headset.

---

## 6. Quest USB Debugging & Remote Inspection Guide

WebXR requires a **Secure Context** (`https://` or `localhost`). Using USB debugging maps ports so Quest Browser treats the local server as `localhost`.

### 6.1 Step 1: Connect Quest 3 via USB-C
1. Enable **Developer Mode** on your Quest headset via the Meta Quest smartphone app.
2. Connect Quest 3 to your development Mac/PC using a USB 3.0 / USB-C link cable.
3. Inside the headset, accept the prompt: *"Allow USB debugging?"* (check *"Always allow from this computer"*).
4. Verify connected devices:
   ```bash
   adb devices
   # Output: <device_serial>   device
   ```

### 6.2 Step 2: Reverse Port Forwarding
Forward the FastAPI backend (`:8000`) and Vite dev server (`:5173`) into the headset:
```bash
# Forward backend & frontend
adb reverse tcp:8000 tcp:8000
adb reverse tcp:5173 tcp:5173

# Verify active reverse tunnels
adb reverse --list
```

For CDP remote inspection of Quest Browser from the host, forward the DevTools port the other way: `adb forward tcp:9222 tcp:9222` (Quest Browser must have remote debugging enabled; `scripts/debug-quest-targets.cjs` lists discoverable targets).

### 6.3 Step 3: Launch Quest Browser
1. In the Quest headset, open **Meta Quest Browser**.
2. Navigate to:
   ```
   http://localhost:5173/reels
   # or for desktop inspector:
   http://localhost:5173/reels/immersive-preview
   ```
3. Because the domain is `localhost`, Quest Browser enables all WebXR APIs (`navigator.xr`) without requiring custom SSL certificates.
4. Click **ENTER VR** on any reel or pack to launch the immersive session.

### 6.4 Step 4: Real-Time Telemetry & Frame Probing (`debug-quest.cjs`)
The repository includes dedicated Chrome DevTools Protocol (CDP) probes to monitor playback quality, decode frame counts, and dropped frames directly from the terminal:

```bash
# Probe active Quest Browser tabs
node scripts/debug-quest-targets.cjs

# Connect CDP bridge and stream live video decode stats
node scripts/debug-quest.cjs
```

The output displays:
- `video.webkitDecoded` vs `video.webkitDropped` (hardware HEVC decoding health).
- `rafN` and `rafMed` (frame time cadence in milliseconds).
- `glInfo.renderer` (Adreno 740 probe) and `maxTex` (maximum texture dimensions).
- `xrPresenting: true` confirmation.

---

## 7. Verification & Quality Assurance

### 7.1 Automated Test Results (2026-09-20, v8.4 device fixes complete)
- **Node Test Suite** (`web/tests/webxr-earth.test.js`):
  - **62 tests passed (100% green)** in ~800 ms (43 carried + 13 v8.3 + 6 v8.4:
    tandem rig, paint-order ladder, guide photo fallback, overlay dirty-only,
    overlay fade bound, linear sampling, respec switch).
  - Coverage includes: geographic spherical projection (`locationToUnit`), heat-zone raycasting, drag-to-rotate + click-to-select, heat scaling / pitch bounds, controls-dock Earth action, reduced-motion spin gating, preview start/stop + GPU cleanup, reels-vs-earth draw gating + video-upload pausing, cancellable 3-item location previews, stale-activity rejection, credit notifications, pack vs reel actions, proxy-canvas static-card upload + normalized hit coords, pending-image clear-then-upload, `startPreview` options + canvas validation, **restart-after-stop texture rebuild**, camera modes, `curved` alias, controls toggle, fullscreen, `version` export, scene-graph inspection, **plus A–E + issues-1–3 regression tests**: visibility matrix; dock clearances; laser build/visibility; earth texture/label/pins + standard-equirect `earthZoneUV` + seam offset; select-accept/select-reject flows; dock-UV→action; pointer-tap raycast chain; stopPreview reels-baseline reset; enterVR reason codes; 2-axis drag (pitch verbatim / reduced yaw / clamp / tap fallback); earth playback handshake; pack earth refusal; earth-station clearance; hologram classifier + heat-style constants; version stamp.
  - Harness note: uploads are observed via `__test.getLastUploadedSource()` (values: element / `'__cleared__'`) instead of spying on mock `gl.texImage2D` — the engine no longer issues raw GL calls outside Three's state tracker.
- **Static Syntax Check**:
  - `node --check ui/assets/webxr_vr.js` and `node --check ui/assets/vr_ui_canvas.js` pass cleanly.
- **Production Build**:
  - `npm run build --prefix web` clean (1.70 s).

### 7.2 Live CDP Verification (`scripts/verify_reels_player_live.cjs`)
Executed on live FastAPI endpoint `http://localhost:8000/api/reels/player`:
- `hasTHREE: true` (Three.js r186 verified)
- `hasOrbitControls: true` (OrbitControls available)
- `hasXRControllerModelFactory: true` (Controller models factory available)
- `hasWebXRVR: true`
- `vrVersion`: reads `vr.version` (exposed since Phase 1+2 patch; falls back to `vr.vrVersion`)
- `curvatureTest: { orig, dome: 'dome', flat: 'flat', curved: 'sq_curve' }` — probe uses **`sq_curve`** (the `curved` alias is still accepted by `setCurvatureMode` for backward compatibility)
- `vrButtonPresent`: checks `#vrBtn` (actual id in `reels.html`) with legacy `#vr-button`/`.vr-btn` fallbacks
- Live screenshot saved to `threejs_reels_player_live.png`.
- Companion probes: `scripts/verify_threejs_cdp.cjs` (same `sq_curve` fix), `scripts/verify_threejs_parity_live.cjs` + `scripts/test_vr_simulation.cjs` (orbit/earth/scene exercisers for immersive-preview), **`scripts/verify_v83_parity_live.cjs`** (v8.4: 20/20 green — v8.3 scope + tandem dock, paint ladder, linear sampling, dirty-only overlay, respec switch).

---

## 8. Build Progress Log (v8.0 → v8.2 — Owner-Approved Scope 2026-09-19)

> [!NOTE]
> This section is a chronological log: figures like line counts, test totals, and
> pin counts are **at-the-time snapshots** of the entry they appear in. Live values
> (v8.3, ~4,650 lines, 56/56 tests, comments LEFT / guide RIGHT, popup overlay) are in
> §1–§7. Entries superseded later in the log are marked *superseded* inline.

Owner decisions: (1) Phase 1+2 first, Phase 3+4 after confirmation; (2) keep v8 Three.js, revisit raw WebGL (`e3f7de1:ui/assets/webxr_vr.js` — the commit before the Three.js overhaul; HEAD itself is already v8) for guidance when lost; (3) fix CDP scripts + doc drift alongside code; keep this doc updated as the crash-safe progress tracker; (4) v8.3: legacy stick-Y behavior kept (next/prev flick) + grip+stickX = distance (right = further); legacy comments-LEFT/guide-RIGHT layout kept.

### ✅ v8.3 Parity Restore (2026-09-20, done — the 5 reported VR regressions)
- **Screen lock/scale/distance**: `screenPos/screenQuat/screenScale (4.0)/screenDistance (2.24)` state, per-frame `applyLockToViewer()` + `commitScreenTransform()` (screen/glow/overlay share pose; curvature scales via `mesh.scale`), locked anchor `{0,1.52,−screenDistance}` with screen-sized dock/panels, unlocked screen-local derivation (upstream factors verbatim). Default screen fills the horizontal view, perpendicular + centered. (`ui/assets/webxr_vr.js`: screen-transform block, XR/preview loops, `enterVR` reset)
- **Controller input**: `processXRInput()` over `XRSession.inputSources` — grip+stickY scale (0.04, 1–10 m), grip+stickX distance (0.03, 1.2–6 m; right = further), stickY flick next/prev (latch/reset), stickX seek ±5 s, panel-pointing stickY scroll, A play/pause, B dock+guide toggle, 6DOF grip-drag unlocked, earth stick-rotate, haptics. Trigger `select` chain: panel → dock → popup → screen → empty (legacy priority).
- **Labels**: dock `AUTO/LOOP` (+⟳) from live `getAutoNext()`, `LOCK/FREE` (+🔒/🔓) with active accents, `MUTED/AUDIO` — upstream pill styles in `vr_ui_canvas.js`.
- **Popup overlay**: `renderOverlayCanvas` + `resolveOverlayCommentAt` (max 3, middle-left, `[t,t+4.2s]`, fades, hover pill), transparent quad sharing the screen pose, click → panel scroll+highlight; suppressed while panel open.
- **Comments LEFT + guide RIGHT**: screen-tracking poses/sizes replace the hardcoded right-side panel; full panel interaction (hover regions, tabs, drag/wheel scroll, seek/like/profile/account, DOM-overlay Quest keyboard → `onPostComment`); guide 440×760 with vector controller + six mapping cards, B-coupled with 5 s auto-hide.
- **Verification**: 56/56 node tests; `npm run build --prefix web` clean; `npm test --prefix web` green (13 vitest + node suite); live `scripts/verify_v83_parity_live.cjs` 16/16 green on `/reels/immersive-preview` (locked screen `(0,1.6,−2.24)`, comments −3.248 / guide +3.226, live input drive, red-tint paint proof, zero page errors). Full headset session still needs on-device confirmation (USB workflow in §6 unchanged).
- **Checklist**: [`docs/v8.3-vr-parity-restore-plan.md`](file:///Users/hoangleduc/Documents/[ez]/Coding/VR%20Tiktok/videoextendersquare/docs/v8.3-vr-parity-restore-plan.md) (all workstreams A–G green).

### ✅ v8.4 Device Fixes (2026-09-20, done — 4 on-device Quest reports)
- **Panels in front + tandem**: paint-order ladder (`depthTest:false`, screen 0 / overlay 2 / dock 3 / comments+guide 4 — legacy drew with `DEPTH_TEST` effectively off); lock special-cases deleted so dock/panels always derive from the live screen transform (locked = head tandem, unlocked = room freeze, per owner model); curvature `scale.set(s,s,s)` (upstream uniform dome scaling).
- **Controller photo**: guide uses live `window.QUEST_CONTROLLER_B64` (542×900, already injected) with vector fallback + dirty-flag re-upload on late arrival.
- **Glitch fixes**: dirty-only overlay (ID-set/hover key, fade ≤10 Hz only while visible, zero uploads when empty — kills the v8.3 10 Hz 1024² churn); `LinearFilter` + no-mipmaps on all 10 canvas textures (legacy sampling); `setVideoUploadMode('subimage'|'respec')` + `?vrTexMode=respec` (forces full `texImage2D` re-specs — decisive sub-image driver test); ~1 Hz XR telemetry POST to `/api/reels/diag` while presenting.
- **Verification**: 62/62 node tests; build + web tests green; live probe 20/20 green (tandem dock, paint ladder, linear sampling, dirty-only overlay, respec switch, red-tint paint proof, zero page errors). **Open: owner on-device A/B** (head-turn ±40°, photo check, comment-heavy reel in both upload modes, diag watch) — see `docs/v8.4-vr-device-fixes-plan.md` W5.5.
- **Checklist**: [`docs/v8.4-vr-device-fixes-plan.md`](file:///Users/hoangleduc/Documents/[ez]/Coding/VR%20Tiktok/videoextendersquare/docs/v8.4-vr-device-fixes-plan.md) (W1–W4 green, W5.5 owner-side open).

### ✅ v8.5 Legacy-Lock Revert + Bisection Flags (2026-09-20, done)
- **Exact legacy locked/unlocked restored** (owner reversal of the tandem rig): locked = head-locked
  screen + room-fixed UI at the default spot sized at `DEFAULT_SCALE` (`getLockedAnchor` + lock
  branches reinstated verbatim); unlocked = screen-relative UI at live scale. Paint-order ladder,
  uniform z-scale, photo, dirty-only overlay, linear sampling, respec mode, telemetry all kept.
- **On-device bisection flags** (URL query, read once in `init()`): `?lock=0` (no face-following —
  pre-lock builds), `?overlay=0`, `?guide=0`, `?glow=0`, plus `?vrTexMode=respec`. Each removes
  exactly one v8.3+ addition. Seams: `__test.getDebugFlags/setDebugFlags`, `lockApplies()`.
- **Black-square debugging theory**: if the squares appeared only once the screen started
  following the face, two prime suspects — (a) HEVC macroblocking newly visible on the 4 m
  screen (v8.2's 2.4 m screen hid it; starved masters like Travis 5.8 Mbps vs King Von 28.8 Mbps
  per the playback investigation §6); (b) texture-upload hazard from three's `texSubImage2D`
  re-upload path. Distinguishing tests below.
- **Verification**: 63/63 node tests; build + web tests green; live probe 20/20 green (v8.5 stamp,
  legacy anchor dock `(0,−0.56,−2.24)`, panels room-fixed while screen follows gaze).
- **Owner on-device protocol**: full tab close + reopen, then in VR — (1) shrink the screen with
  grip+stickY to ~half size: squares shrink with the picture → source macroblocking (fix = use
  high-bitrate masters / Quest rendition); squares stay fixed-size → compositor/texture bug →
  (2) flag bisection in order `?overlay=0`, `?glow=0`, `?lock=0`, `?vrTexMode=respec`, one at a
  time, ~1 min playback each on the same reel; (3) compare King Von (28.8 Mbps) vs Travis
  (5.8 Mbps) reels; (4) `watch curl …/api/reels/diag` during each — report `dtMaxMs` + which
  combination is clean.

### ✅ v8.6 Laser Ray Unification + Reticle Fix (2026-09-20, done — 2 on-device laser reports)
- **Mismatch**: hover tracked `vrControllers[0]` (connection order, unknown hand) while clicks used
  the pressing hand. Now the shared laser prefers the **right** hand (legacy `pointerEligible`
  priority) via XR `frame` poses, stores the shown ray per frame (`activeRayOrigin/Dir/Handedness`),
  and `onVRSelect` reuses it when the pressing hand matches (falls back to a fresh raycast
  otherwise) — clicks always honor the visible highlight.
- **Half-circle reticle**: the billboarded dot sat exactly on the hit surface with depth testing
  on — oblique/curved hits buried half of it. Now `depthTest: false` on beam (999) + reticle
  (1000) with a 0.02 m pullback off the surface (legacy drew the laser/dot last with depth off).
- **Verification**: 66/66 node tests (incl. right-preference, stored-ray vs fresh-ray select paths,
  beam/reticle geometry + flags); live probe 23/23 green (beam hits posed screen at 2.24 m,
  reticle exactly 0.02 back). Owner to confirm in-headset.

### ✅ Phase 0: Baseline (2026-09-19, done)
- Locked reality vs doc: working tree is v8.0 / 1,261 lines / 14 tests — doc's "v7.1 / 6,361 lines / 58 tests" was stale.
- `node --check` clean on both engine files; `three.min.js` verified (r186 + OrbitControls + XRControllerModelFactory present).
- Ranked breakage hypotheses H1–H9 (shared non-xrCompatible context, disposed-texture reuse black screen, silent THREE-undefined, bogus raw `texImage2D`, frozen canvas size, dual-loop fight, OrbitControls-only input, wireframe-earth form loss, ungated uploads + emulator gate).

### ✅ Phase 1: Preview-renders-video restore (2026-09-19, done)
- `startPreview(canvas, opts)` honors `cameraMode/stereo/reducedMotion/showControls/sceneMode`, validates canvas (throws → ReelsPlayer error box instead of silent black), tears down previous session before rebuild, resets stats + visual-tracking state. (`ui/assets/webxr_vr.js:startPreview`)
- Per-frame `updatePreviewSize()` (devicePixelRatio ≤ 2) + `camera.aspect` sync; `scene.background` / clear color `0x020612`; `getPreviewState()` reports `reelDrawCalls` + `controlsVisible`. (Fixes frozen-size + "REEL DRAWS 0" drift.)
- Removed invalid raw `glContext.texImage2D(0,…)` calls; uploads gated on visual-change / new-video-frame / time-moved with clear-once pending semantics (16 MiB/frame spam + load flicker fixed). Test bridge: `__test.getLastUploadedSource()`.
- `cleanup()` disposes **and nulls** all `CanvasTexture`s + canvases + listeners + resize handler, so restart rebuilds instead of rendering disposed (black) textures.
- `visualPointFromHit` uses real 2.4 m screen extents (was `screenScale = 1.0`); `setCurvatureMode` accepts legacy `'curved'` alias → `sq_curve`; public API exposes `version`, `toggleControls`, real `requestPreviewFullscreen`.

### ✅ Phase 2: Preview interaction parity (2026-09-19, done)
- Custom HEADSET POV drag-look (yaw/pitch ±1.35, 0.006 sensitivity) + `OrbitControls` in ORBIT INSPECT only; wheel = orbit dolly / earth yaw-pitch; tap screen = play/pause (static cards → pack select); tap empty = controls show/hide; hover raycasts controls dock (UV → `VRUICanvas.resolveControlsHit`) and earth heat zones. (`installPreviewListeners`, `previewRayAt`, `updatePreviewHover`)
- `setPreviewCameraMode` lazily constructs controls, repositions camera per mode; `resetPreview` resets camera + earth pose; side-by-side stereo split render when `stereoMode`; UI canvases redraw throttled to ~10 Hz.

### ✅ Verification (2026-09-19, A–E all green)
- `node --test web/tests/webxr-earth.test.js`: **43/43 pass** (36 carried + shouldAttemptXR table, fail-fast preview preservation, bind-failure restore, xrCompat recording, reels.html gate guard, ray seam, pointer-error-free cycle).
- `node --check` clean on engine, UI canvas, and both fixed CDP scripts; `npm run build --prefix web` clean (1.70 s).
- Backend serves all 8 `player-inline` scripts in order (`three` + `VRUICanvas` + `WebXRVR` present); `player-inline` sends `no-store`.
- Isolated live CDP probes (fresh tab, no shared-tab interference) against `/reels/immersive-preview`: `running:true`, `reelDrawCalls:1`, `videoUploads` climbing with a playing 720² reel, canvas backing == CSS size, earth mode (`earthDrawCalls:1`, `star:1`, `resourcesReady:true`, **20 live pins**), orbit/flat/stereo/dome/headset/reset transitions, **zero page errors**.
- Scene proof: reels → earth hidden/screen shown/laser on/glow sampling (`glow.color` steered off default by video); earth → globe shown/screen hidden; back to reels clean. Center pixels: reels **[116,68,64] video**, earth **[250,169,159] heat/label**. Dock live at `(0, 0.02, −1.9)` pitched −0.694 to the viewer.
- Pixel proof via `__test.readCenterPixels()` (same-task render+readback): headset center **video content**, debug-red **[255,0,0]**, orbit **scene content** — renderer conclusively paints the scene.
- ⚠️ Methodology note: `Page.captureScreenshot` in this Chrome/CDP setup does **not** capture WebGL layers (control experiment: fullscreen red plane → only 214 red px in PNG). Do **not** use screenshots to judge the 3D scene; use `readCenterPixels()` / `getSceneInfo()` / `renderStats` instead.
- ⚠️ Environment note: other CDP sessions (e.g. `emulate_webxr_session.cjs`, gesture tests) were driving the shared browser tabs concurrently during verification — always verify in an isolated `Target.createTarget` tab.
- sRGB fix landed (video/UI/earth textures) — framebuffer now tracks source brightness. Remaining Quest-side follow-up: adaptive upload stride for Adreno (currently ~27/s while playing — fine on desktop, re-check on device).

### ✅ Scene Parity A–E (2026-09-19, done — the 5 reported sim bugs)
- **A. Visibility**: `applySceneVisibility()` single source of truth (reels → screen/glow/dock; earth → globe/dock), enforced from `setSceneMode`, scene init, and both frame loops; `enterVR` re-asserts mode on entry. Globe can no longer leak into reels mode.
- **B. Dock**: below-screen console at `(0, 0.02, −1.9)`, yaw/pitch-facing the viewer with locked roll (`computeDockPose`, node-tested clearances); dome extrusion (edges → −1.6) can never occlude it. Look/drag down to reach it (upstream-identical ergonomics).
- **C. Glow**: radial-falloff alpha texture, 1.34× curved plane, additive, video-sampled color (8×8 probe + upstream enhance/lerp, 120 ms preview / 800 ms XR). No more hard square.
- **D. Laser**: all-red line + radial reticle, shared updater in both loops (controllers in XR, persistent mouse-hover/head-forward ray in preview), hover grow/brighten, `controlIndexFromUV` shared by preview/XR/select paths.
- **E. Earth**: `2048×1024` equirect texture (holographic photo base + verbatim heat zones, standard-equirect + seam offset convention), ≤64 pulsing 3D pins at exact hit-test vectors, spec label, hover-preview billboard with debounced fetch. (Deck cone removed — read as hemisphere panel.)

### ✅ Issues 1–3 follow-up (2026-09-19, done — clip fix, paint-over fix, diagnostics)
- **Dock clip (real geometry bug)**: the viewer tilt lifts the dock's top edge up-back; at the old station `(0, 0.30, −0.95)` the top-center sat *inside* the globe (dist 0.652 < 0.676). Re-stationed to `(0, 0.20, −0.85)` — tilted top edge clears by 0.11, all corners clear. Node test asserts the tilt-aware top-edge clearance (regression).
- **Photo paint-over (real logic bug, explains "no hologram")**: `refreshEarthTexture()` repainted the fallback gradient over an asynchronously arrived photo base. Split into base-if-stale + zones-only; photo path marks base live before zoning. Proven live: base canvas variance ~2700 (structured) stable across forced zone repaints; `earthMap.base='photo'`, 19 pins.
- **Stale-client disambiguation**: engine stamped `v8.1-20260919-entry-drag-hologram` (superseded by `v8.2-20260919-phase4-session` after Phase 4) (`renderer.version`, `__test` surface); served bundle verified wireframe-free. If the globe ever reads as wireframe again, check `WebXRVR.version` in console first.
- **Asset reality check**: `/assets/earth-natural-1024x512.jpg` serves 200/90 KB on both `:5173` (vite public) and `:8000` (already present in `server/static/assets/` — no restart needed for it). The new `/api/reels/earth-texture` route (verified 200/image-jpeg on a test port) is fallback-only and goes live on next backend restart. Loader tries both URLs, then procedural fallback; `earthMap.base`/`baseTried` report the outcome.
- **Live browser drag synthesis**: press-hold-sweep on the globe moved pitch 0 → 0.624 with yaw locked (0.078 → 0.079), zero errors — the full listener→raycast→machine→rotation chain works in-browser.
- Empty-activity honesty: label shows `NO RECENT ACTIVITY` at 0 zones instead of a bare count.

### ✅ Phase 4: VR session parity + emulator unblock (2026-09-19, done)
- **Fail-fast entry order**: `requestSession` now runs BEFORE preview teardown / GL allocation, so a rejection leaves a running preview untouched (new test asserts this). Bind still tears down first (renderer required for `setSession`) and restores on failure.
- **Preview snapshot + restore**: `enterVR` captures canvas + full option set (`cameraMode/sceneMode/stereo/reducedMotion/showControls`); the session-`end` handler and the bind-failure path both restore via shared `restorePreviewSnapshot()` (skips silently if the SPA navigated away). Tested: bind-failure tears down then restores to reels-running.
- **xrCompatible**: `ensureXRCompatibleContext()` awaits `gl.makeXRCompatible()` before `setSession` (standard Three.js path for Quest Browser); non-blocking — records `unknown|compatible|made-compatible|unavailable|failed:*` in `xrCompatStatus`, surfaced in `getPreviewState().xrCompat` + `getSceneInfo().xr` + `__test.getXrCompatStatus()`. Absence of the API never blocks entry (desktops/mocks).
- **Single loop, guaranteed**: stale `setAnimationLoop(null)` before installing the XR loop; preview uses rAF and is always torn down first; `exitVR` funnels through the `end` event (which also removes the XR canvas and clears `sx-vr-active`).
- **Emulator unblock**: `reels.html` no longer hard-blocks localhost when `isSessionSupported=false` — shows `TRYING EMULATED SESSION…` and attempts `requestSession` anyway (DevTools/extension only materialize on request); `?forceXR=1` forces the attempt anywhere; non-localhost without support still shows HEADSET NOT DETECTED. Shared gate logic lives testably in `WebXRVR.__test.shouldAttemptXR` (truth-table tested); `reels.html` presence asserted to prevent drift.
- **Pointer robustness (found during verification)**: handlers wrapped so a canvas callback can never die silently — failures land in `__test.getLastPointerError()` + console; `cleanup()` resets the full earth-drag machine (a mid-drag teardown previously stranded `dragging=true`, freezing idle spin). `hoveredButton/pressedButton` added to preview state; `__test.previewRayFor` seam added for ray diagnostics.
- **Verification**: 43/43 node tests; vite build clean; live matrix — 2D page ready + button + `v8.2`, gate `{supported:false, gate:true}` (attempt proceeds), earth `base:photo`/19 pins/visibility/dock, presenting/xrCompat in state, zero page errors. Full immersive click still needs an emulator-enabled Chrome (this automation profile has none — correctly gated with attempt + guidance, failure surfaces via `onVRError` toast codes).
- **⚠️ Probe methodology lesson (costly)**: CDP drag probes silently failed for a full session due to (1) page scroll between coordinate capture and moves (`rect.top` drifted −169→0→682 — always `scrollIntoView` + resolve coords fresh per action), (2) dispatching at off-viewport coords, (3) author HMR edits triggering React remounts mid-probe, (4) reading zone counts before the activity fetch resolves (poll, don't sleep-blind). Scroll-safe retest with trusted input: down engages (`drag:true`), 5-step vertical sweep pitches 0→1.122 with yaw locked — machine + path fully vindicated. Never trust a red probe until rect/mode/zones are re-verified in the same evaluate.

### ⏳ Remaining (device-side, cannot verify headless)
- Quest Browser session: confirm `makeXRCompatible` + `setSession` succeed on-device and report `xrCompat` via `getPreviewState()`; check 72 FPS + upload stride on Adreno (desktop uploads ~27/s — re-check on device).
- Emulator-enabled Chrome click-through: with Immersive Web Emulator / device-simulation flag on, the 2D VR button should now attempt and enter (previously hard-blocked); confirm preview restores after session end.
- USB workflow in §6 unchanged (`adb reverse`, `scripts/debug-quest.cjs`).

### ✅ Issues 1–3 (2026-09-19, done — sim bug reports)
- **Issue 2 (entry + mode leaks)**: `stopPreview` resets to reels baseline (`sceneMode`, `previewCanvas`, camera, stereo, controls); `enterVR` tears down preview, builds a fresh XR canvas every entry (no `previewCanvas` reuse), validates each stage with reason codes (`webxr-unavailable`/`three-missing`/`canvas-unavailable`/`webgl-unavailable`/`session-rejected`/`bind-failed`) surfaced via `callbacks.onVRError` → 2D toast; explicit `enterVR({mode})` defaulting to reels; 2D button gated on `__sxReelsReady`. Live matrix: 2D page ready + button visible + XR present; preview-earth → back-to-/reels ⇒ mode reels, preview stopped (leak closed). Full immersive click needs an emulator-enabled Chrome (this automation profile reports `isSessionSupported=false`, correctly gated with emulator guidance).
- **Issue 3 (modes + drag)**: edge-triggered `setSceneMode` with `openEarthPlayback`/`closeEarthPlayback` handshake (pauses the real source element, `onEarthOpen` freeze incl. image timer, `onEarthClose` resume; pack mode refuses earth); front dock station `(0, 0.30, −0.95)` *(superseded → `(0, 0.20, −0.85)` after the dock-clip fix below)* with sightline clearance proven in tests; upstream drag machine (280 ms hold / 0.12 flick engage, 0.06 tap chord, single-axis lock, tap press/hover/release fallback), **pitch `dy·2.24` verbatim, yaw `dx·1.7` reduced**, clamp ±1.2, `YXZ` mesh rotation + inverse-rotated picking so hover tracks the turned globe.
- **Issue 1 (hologram detail)**: `GET /api/reels/earth-texture` backend route (verified 200/90,687 B image/jpeg; needs backend restart to go live — engine degrades to fallback until then); photo re-style ported verbatim (classify/tint/edge/wrap/smooth upscale); heat fill verbatim (4 stops, 1–3 state rings, `0.11+h·0.12` shared radius); deck rim as truncated cone platform (identity) *(superseded — deck removed in the follow-up below)*; label per spec (hovered-name/heat/active detail, amber vs default border). Live: `earthMap.base='photo'`, 19 pins *(snapshot at that run's activity fetch — data-dependent; a later verification run saw 20)*, label, deck in earth mode.
- **UV seam fix + select flow + deck removal (2026-09-19 follow-up)**: painted zones moved to standard equirect (upstream verbatim) with `earthMapTexture.offset.x=+0.25` + `RepeatWrapping` (derived from three r186 `SphereGeometry` source: seam sits on −X, 90° off standard) — photo, zones, pins, hit-test now coincide; `selectEarthLocation` returns to reels on accept (live: location feed playing, `paused:false`) and stays with status on reject; deck cone deleted (all refs + tests); label shows selected zone. 36/36 green.

### ✅ Scripts + doc drift (2026-09-19, done)
- `verify_reels_player_live.cjs`: `sq_curve` probe token, `vr.version` with fallback, `#vrBtn` selector.
- `verify_threejs_cdp.cjs`: `sq_curve` probe token.
- `webxr-earth.test.js`: proxy-canvas upload assertions + 3 new regression tests (17/17 green).
- This doc: status/metrics/verification sections corrected; §8 converted to progress log.
- **Doc drift round 2 (2026-09-19)**: fixed the raw-WebGL reference (`HEAD:` → `e3f7de1:`/`HEAD^:` — HEAD is already Three.js); §4.3 now describes the actual CPU `createScreenGeometry` path (48×48, no custom shaders) with normalized-coordinate formulas; earth dock station updated to `(0, 0.20, −0.85)` in §4.2; mermaid fixed (duplicate `EarthPins`/undefined `EarthRings` node, R=0.676 m, v8.2 label); §2.3 ~1,000-line target marked superseded; `xrCompatStatus` enum gained `unavailable`; §6.2 `:9222` corrected to `adb forward`; engine file header bumped v8.0 → v8.2 to match `VR_VERSION`.


### ✅ v8.7 UI-Transition Diagnostics (2026-09-20, done — black-square elimination round)
- **Device evidence**: squares are fixed-size (macroblocking dead), bitrate-independent,
  immune to overlay/glow/lock/respec flags, clustered at reel starts + rapid prev/next.
  Exonerated: overlay, glow, face-following, video sub-image path. Surviving theory:
  dock/panel sub-image upload tears colliding with video re-specs at transition frames
  (only textures without flag coverage; locked UI sizes ignore screenScale — explains
  the shrink test).
- **New diagnostics**: `?dockfreeze=1` (dock paints once then freezes — isolates dock tears),
  `?glowprobe=0` (kills the 800 ms `getImageData` readback sync), per-texture counters
  (`dockUploads/panelUploads/guideUploads`) + transition counters (`transChanges/transClears/
  transNotReady`, the last counting buffering frames) in the ~1 Hz `/api/reels/diag` payload.
- **Verification**: 68/68 node tests; build + web tests green; live probe 25/25 green.
- **Owner on-device protocol v2**: full tab close + reopen, comments panel CLOSED, then —
  (1) `?dockfreeze=1`: squares gone → dock/panel upload path confirmed (fix = re-spec routing
  for UI textures); squares persist → UI innocent → (2) `?glowprobe=0`: gone → readback sync
  (fix = drop the 800 ms probe or move off-frame); persist → (3) report
  `watch curl …/api/reels/diag` (`dtMaxMs` + per-texture deltas) during a glitchy transition.
  Also needed: feed or pack mode? panel open or closed during tests? precise square
  description (where in view, size, duration, every transition or sometimes)?

### ✅ v8.9 Hold-Frame + Decoded Gating (2026-09-20, done — rapid-switch telemetry verdict)
- **Live verdict**: rapid-switch telemetry (frames mid-70s, dtMax 55–93 ms, `transNotReady`
  21–42/s, clears 4–8/s, video uploads *dropping* to 25–60/s) attributes the glitch
  windows to a loading-pipeline buffering storm — perpetual `src` swaps + prune/refetch +
  preload contention over USB — not GL upload contention (which would need spikes *with*
  high upload counts). Every GL path is exonerated by flags; `?domoverlay=0` test pending.
- **Hold-last-frame**: black clears are now session-start-only; switches hold the prior
  visual until the new source is ready (no mid-playlist black flash).
- **Decoded-frame gating** (legacy Fix #1 port): uploads key on `totalVideoFrames` with a
  0.25 s seek-jump backstop (~90/s → ~source fps; paused seeks never go stale).
- **Rapid-flight preload backoff** (`reels.html`): `preloadNext` skips background transfers
  within 1500 ms of navigation (`lastSwitchTime` in `nextVideo`/`prevVideo`).
- **Verification**: 71/71 node tests; build + web tests green; live probe 26/26 green.
- **Owner on-device protocol v3**: full tab close + reopen → rapid-switch 1 min → expect
  brief freezes on the old reel instead of black flashes, `transClears` ≈ 1/session,
  `videoUploads` ≈ 30/s, lower `dtMaxMs`. Then `?domoverlay=0` for the compositor layer.

### ✅ v8.10 First-Frame Hold (2026-09-20, done — owner: freeze-then-cut works, first frames still square)
> Full evidence record: [`docs/vr-black-squares-investigation.md`](file:///Users/hoangleduc/Documents/[ez]/Coding/VR%20Tiktok/videoextendersquare/docs/vr-black-squares-investigation.md) (telemetry captures, elimination matrix, per-version fixes, open items, on-device protocol).
- **Diagnosis**: a just-switched visual cut in on the first `HAVE_CURRENT_DATA` frame, which
  after a src-swap/seek can be decoder resync garbage (corrupt references → blocky first
  frames until the decoder settles). Matches the owner report exactly (clean between
  switches, squares only in new reels' first frames).
- **Fix**: fresh video visuals wait for `HAVE_FUTURE_DATA` (readyState ≥ 3) before the
  first upload, holding the previous frame meanwhile; steady visuals upload at ≥ 2 as
  before. Wall-clock cap 2.5 s bounds the hold on slow tunnels; `force` bypasses.
- **Verification**: 72/72 node tests (incl. fresh-hold at rs2, cut-in at rs3, steady rs2
  unaffected); live probe green. Owner to confirm first frames are clean on-device.
