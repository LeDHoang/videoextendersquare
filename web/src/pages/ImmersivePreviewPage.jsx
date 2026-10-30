import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import ReelsPlayer from '../components/ui/ReelsPlayer.jsx';
import { Button, Segmented, ToggleRow } from '../components/ui/controls.jsx';
import { AccentBlock, Hero, Mono, SpecRow } from '../components/ui/primitives.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';

const VRPanelWorkbench = lazy(() => import('../components/ui/VRPanelWorkbench.jsx'));

const DEFAULT_STATE = {
  running: false,
  cameraMode: 'headset',
  curvatureMode: 'dome',
  stereo: false,
  reducedMotion: false,
  sceneMode: 'reels',
  shell: null,
  renderStats: { earthDrawCalls: 0, reelDrawCalls: 0, videoUploads: 0 },
};

// Vertical FOV (three.js PerspectiveCamera.fov is vertical). Quest values from
// Meta's device comparison: Quest 3S 90° V, Quest 3 96° V. A 16:9 window still
// shows more width than the headset does.
const FOV_PRESETS = { 'DESKTOP 70°': 70, 'QUEST 3S 90°': 90, 'QUEST 3 96°': 96 };

// [tuning key, label, min, max, step]. Ranges cover the engine clamps.
const TUNING_SLIDERS = [
  ['screenScale', 'SCREEN SIZE (M)', 1, 10, 0.05],
  ['screenDistance', 'SCREEN DISTANCE (M)', 1.2, 6, 0.01],
  ['screenHeight', 'ANCHOR HEIGHT (M)', 0.8, 2.4, 0.01],
  ['dockWidth', 'DOCK WIDTH (× SCREEN)', 0.4, 1.2, 0.01],
  ['dockGap', 'DOCK GAP (M)', 0, 0.4, 0.005],
  ['panelSideGap', 'PANEL SIDE GAP (M)', 0, 1, 0.005],
  ['panelFwdOffset', 'PANEL FORWARD (M)', -0.6, 0.3, 0.01],
  ['commentsScale', 'COMMENTS SIZE (× SCREEN)', 0.2, 0.8, 0.002],
  ['guideScale', 'GUIDE SIZE (× SCREEN)', 0.2, 0.8, 0.002],
];

// The shipped source lines in ui/assets/webxr_vr.js for the current tuning.
function formatTuningConstants(t) {
  const n = (v) => Number(Number(v).toFixed(4));
  return [
    `const DEFAULT_POS = { x: 0, y: ${n(t.screenHeight)}, z: -${n(t.screenDistance)} };`,
    `const DEFAULT_SCALE = ${n(t.screenScale)};`,
    `const PANEL_SIDE_GAP = ${n(t.panelSideGap)};`,
    `const PANEL_FWD_OFFSET = ${n(t.panelFwdOffset)};`,
    `const CPANEL_SCALE_FACTOR = ${n(t.commentsScale)};`,
    `const GUIDE_SCALE_FACTOR = ${n(t.guideScale)};`,
    `const DOCK_GAP = ${n(t.dockGap)};`,
    `dockWidth: ${n(t.dockWidth)}, // in defaultLayoutTuning()`,
  ].join('\n');
}

function formatCurvatureMode(mode) {
  if (typeof mode === 'number') {
    mode = mode === 1 ? 'dome' : (mode === 2 ? 'sq_curve' : 'flat');
  }
  return String(mode || 'dome').replace('_', ' ').toUpperCase();
}

function isCurvatureActive(mode, target) {
  if (typeof mode === 'number') {
    mode = mode === 1 ? 'dome' : (mode === 2 ? 'sq_curve' : 'flat');
  }
  return (mode || 'dome') === target;
}

// VR shell pages to review on the flat preview without a headset.
const SHELL_PAGES = [
  ['EXPLORE', () => '/explore'],
  ['PROFILE', (user) => '/profile/' + encodeURIComponent(user?.username || 'echo_archive')],
  ['MESSAGES', () => '/messages'],
  ['WALLET', () => '/wallet'],
];

function shellTab(section) {
  if (!section || section === 'handoff') return '';
  if (section === 'profile') return 'PROFILE';
  if (section === 'messages' || section === 'thread' || section === 'share') return 'MESSAGES';
  if (section === 'wallet' || section === 'rewards') return 'WALLET';
  return 'EXPLORE';
}

export default function ImmersivePreviewPage() {
  const { user } = useAuth();
  const [renderer, setRenderer] = useState(null);
  const [view, setView] = useState('3D SCENE');
  const [hiFi, setHiFi] = useState(true);
  const [fov, setFov] = useState('DESKTOP 70°');
  const [tuning, setTuning] = useState(null);
  const [copied, setCopied] = useState(false);
  // ReelsPlayer keeps the onPreviewReady from its first render, and every
  // remount (hi-fi toggle, view switch) restarts the engine at the shipped
  // layout, so the live choices are re-applied from refs.
  const fovRef = useRef(fov);
  const tuningRef = useRef(null);
  const [previewState, setPreviewState] = useState(() => ({
    ...DEFAULT_STATE,
    reducedMotion: typeof window !== 'undefined'
      ? !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      : false,
  }));

  useEffect(() => {
    const update = (event) => setPreviewState((current) => ({
      ...current,
      ...(event.detail || {}),
    }));
    window.addEventListener('echo:webxr-preview-state', update);
    return () => window.removeEventListener('echo:webxr-preview-state', update);
  }, []);

  useEffect(() => {
    if (!renderer?.getPreviewState) return undefined;
    const timer = window.setInterval(() => setPreviewState(renderer.getPreviewState()), 500);
    return () => window.clearInterval(timer);
  }, [renderer]);

  const syncState = (api = renderer) => {
    if (api?.getPreviewState) setPreviewState(api.getPreviewState());
  };

  const invoke = (method, ...args) => {
    if (!renderer?.[method]) return;
    Promise.resolve(renderer[method](...args)).finally(() => syncState());
  };

  const switchView = (next) => {
    if (next !== '3D SCENE') setRenderer(null);
    setView(next);
  };

  const changeFov = (label) => {
    fovRef.current = label;
    setFov(label);
    renderer?.setPreviewFov?.(FOV_PRESETS[label]);
  };

  const changeTuning = (patch) => {
    if (!renderer?.setLayoutTuning) return;
    const next = renderer.setLayoutTuning(patch);
    tuningRef.current = next;
    setTuning(next);
  };

  const resetTuning = () => {
    if (!renderer?.resetLayoutTuning) return;
    tuningRef.current = null;
    setTuning(renderer.resetLayoutTuning());
  };

  const copyTuning = () => {
    if (!tuning) return;
    navigator.clipboard?.writeText(formatTuningConstants(tuning)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };

  return (
    <div className="sx-immersive-preview-page">
      <Hero
        title="IMMERSIVE REELS PREVIEW"
        kicker="CREATOR TOOL · SHARED WEBXR SCENE · DESKTOP INSPECTION"
      >
        <div className="sx-stats-pill">
          <span>SCENE: <strong>{(previewState.sceneMode || 'reels').toUpperCase()}</strong></span>
          <span>CURVE: <strong>{formatCurvatureMode(previewState.curvatureMode)}</strong></span>
          <span>CAMERA: <strong>{(previewState.cameraMode || 'headset').toUpperCase()}</strong></span>
          <span>VIEW: <strong>{previewState.stereo ? 'STEREO' : 'MONO'}</strong></span>
          <span>SHELL: <strong>{(previewState.shell || 'closed').toUpperCase()}</strong></span>
          <span>STATUS: <strong>{previewState.running ? 'LIVE' : 'LOADING'}</strong></span>
        </div>
      </Hero>

      <AccentBlock
        title="PREVIEW SCOPE"
        lines={[
          'This view uses the same scene geometry, shaders, live reel, panels, Earth data, and callbacks as the Quest WebXR session.',
          'It is a scene/layout parity tool. It does not emulate Quest optics, tracking quality, thermal limits, or headset frame-time performance.',
        ]}
      />

      <div className="sx-immersive-preview-toolbar" aria-label="Preview view">
        <Segmented
          ariaLabel="Preview view"
          options={['3D SCENE', 'FLAT PANELS']}
          value={view}
          onChange={switchView}
        />
      </div>

      {view === 'FLAT PANELS' ? (
        <Suspense fallback={<Mono>LOADING PANEL WORKBENCH…</Mono>}>
          <VRPanelWorkbench />
        </Suspense>
      ) : null}

      {view === '3D SCENE' ? (
        <>
          <div className="sx-immersive-preview-toolbar" aria-label="Immersive preview controls">
            <div className="sx-control-group">
              <Button
                primary={previewState.sceneMode === 'reels'}
                disabled={!renderer}
                onClick={() => invoke('setSceneMode', 'reels')}
              >
                REELS
              </Button>
              <Button
                primary={previewState.sceneMode === 'earth'}
                disabled={!renderer}
                onClick={() => invoke('setSceneMode', 'earth')}
              >
                EARTH ACTIVITY
              </Button>
            </div>
            <div className="sx-control-group" role="group" aria-label="Curvature Mode">
              <Button
                primary={isCurvatureActive(previewState.curvatureMode, 'dome')}
                disabled={!renderer}
                onClick={() => invoke('setCurvatureMode', 'dome')}
              >
                DOME
              </Button>
              <Button
                primary={isCurvatureActive(previewState.curvatureMode, 'sq_curve')}
                disabled={!renderer}
                onClick={() => invoke('setCurvatureMode', 'sq_curve')}
              >
                SQ CURVE
              </Button>
              <Button
                primary={isCurvatureActive(previewState.curvatureMode, 'flat')}
                disabled={!renderer}
                onClick={() => invoke('setCurvatureMode', 'flat')}
              >
                FLAT
              </Button>
            </div>
            <div className="sx-control-group">
              <Button
                primary={previewState.cameraMode === 'headset'}
                disabled={!renderer}
                onClick={() => invoke('setPreviewCameraMode', 'headset')}
              >
                HEADSET POV
              </Button>
              <Button
                primary={previewState.cameraMode === 'orbit'}
                disabled={!renderer}
                onClick={() => invoke('setPreviewCameraMode', 'orbit')}
              >
                ORBIT INSPECT
              </Button>
            </div>
            <div className="sx-control-group" role="group" aria-label="VR shell pages">
              {SHELL_PAGES.map(([label, path]) => (
                <Button
                  key={label}
                  primary={shellTab(previewState.shell) === label}
                  disabled={!renderer?.shell}
                  onClick={() => { renderer.shell.open(path(user)); syncState(); }}
                >
                  {label}
                </Button>
              ))}
              <Button disabled={!previewState.shell} onClick={() => { renderer.shell.close(); syncState(); }}>CLOSE SHELL</Button>
            </div>
            <div className="sx-control-group">
              <Button disabled={!renderer?.shell} onClick={() => { renderer.shell.share(); syncState(); }}>SHARE REEL</Button>
              {/* Sample reel-reward reply so the wallet's progress line can be reviewed. */}
              <Button
                disabled={!renderer?.shell}
                onClick={() => { renderer.shell.noteReward({ progress: 7, remaining: 3 }); renderer.shell.open('/wallet'); syncState(); }}
              >
                REWARD PROGRESS
              </Button>
            </div>
            <ToggleRow
              label="SIDE-BY-SIDE STEREO"
              checked={previewState.stereo}
              onChange={(enabled) => invoke('setPreviewStereo', enabled)}
            />
            <ToggleRow
              label="REDUCED MOTION"
              checked={previewState.reducedMotion}
              onChange={(enabled) => invoke('setReducedMotion', enabled)}
            />
            <ToggleRow
              label="HI-FI PREVIEW"
              help="Desktop only: MSAA + mipmapped panels. Restarts the preview. The headset keeps its own sampling."
              checked={hiFi}
              onChange={(enabled) => {
                setRenderer(null);
                setHiFi(enabled);
              }}
            />
            <Segmented
              ariaLabel="Preview field of view"
              options={Object.keys(FOV_PRESETS)}
              value={fov}
              disabled={!renderer}
              onChange={changeFov}
            />
            <div className="sx-control-group">
              <Button disabled={!renderer} onClick={() => invoke('resetPreview')}>RESET VIEW</Button>
              <Button disabled={!renderer} onClick={() => invoke('requestPreviewFullscreen')}>FULLSCREEN</Button>
            </div>
          </div>

          {/* WebGL antialias is fixed per canvas, so hi-fi changes remount the player. */}
          <ReelsPlayer
            key={hiFi ? 'hifi' : 'legacy'}
            params={{ codec: 'h264', sort: 'for_you' }}
            previewMode
            previewOptions={{ cameraMode: 'headset', sceneMode: 'reels', showControls: true, hiFi }}
            onPreviewReady={(api) => {
              api.setPreviewFov?.(FOV_PRESETS[fovRef.current]);
              if (tuningRef.current) api.setLayoutTuning?.(tuningRef.current);
              setTuning(api.getLayoutTuning?.() || null);
              setRenderer(api);
              syncState(api);
            }}
          />

          {tuning ? (
            <section className="sx-immersive-tuning" aria-label="Layout tuning">
              <div className="sx-immersive-tuning-sliders">
                {TUNING_SLIDERS.map(([key, label, min, max, step]) => (
                  <label key={key} className="sx-immersive-tuning-row">
                    <span>{label}</span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={tuning[key]}
                      onChange={(event) => changeTuning({ [key]: Number(event.target.value) })}
                    />
                    <output>{Number(tuning[key]).toFixed(3)}</output>
                  </label>
                ))}
              </div>
              <div className="sx-immersive-tuning-out">
                <pre>{formatTuningConstants(tuning)}</pre>
                <div className="sx-control-group">
                  <Button onClick={copyTuning}>{copied ? 'COPIED' : 'COPY CONSTANTS'}</Button>
                  <Button onClick={resetTuning}>RESET LAYOUT</Button>
                </div>
                <Mono>PREVIEW ONLY · PASTE INTO UI/ASSETS/WEBXR_VR.JS TO SHIP · THE HEADSET USES THE SHIPPED VALUES</Mono>
              </div>
            </section>
          ) : null}

          <SpecRow
            cells={[
              ['EARTH DRAWS', previewState.renderStats?.earthDrawCalls ?? 0, 'ZERO WHILE REELS MODE IS ACTIVE'],
              ['REEL DRAWS', previewState.renderStats?.reelDrawCalls ?? 0, 'SHARED SCENE CORE'],
              ['VIDEO UPLOADS', previewState.renderStats?.videoUploads ?? 0, 'PAUSED WHILE EARTH IS OPEN'],
            ]}
          />
          <Mono>DRAG TO LOOK OR ORBIT · DRAG THE EARTH TO ROTATE (SHIFT-DRAG TO LOOK) · CLICK A HEAT MARKER TO LOAD ITS RECENT TRENDING REELS</Mono>
          <Mono>SHELL: DRAG OR WHEEL THE MAIN PANEL TO SCROLL (FLICK TO FLING) · CLICK TO OPEN · ADD ?vrshell=0 TO THE URL TO DISABLE THE SHELL</Mono>
        </>
      ) : null}
    </div>
  );
}
