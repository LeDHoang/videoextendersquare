import { useEffect, useState } from 'react';
import ReelsPlayer from '../components/ui/ReelsPlayer.jsx';
import { Button, ToggleRow } from '../components/ui/controls.jsx';
import { AccentBlock, Hero, Mono, SpecRow } from '../components/ui/primitives.jsx';

const DEFAULT_STATE = {
  running: false,
  cameraMode: 'headset',
  curvatureMode: 'dome',
  stereo: false,
  reducedMotion: false,
  sceneMode: 'reels',
  renderStats: { earthDrawCalls: 0, reelDrawCalls: 0, videoUploads: 0 },
};

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

export default function ImmersivePreviewPage() {
  const [renderer, setRenderer] = useState(null);
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
        <div className="sx-control-group">
          <Button disabled={!renderer} onClick={() => invoke('resetPreview')}>RESET VIEW</Button>
          <Button disabled={!renderer} onClick={() => invoke('requestPreviewFullscreen')}>FULLSCREEN</Button>
        </div>
      </div>

      <ReelsPlayer
        params={{ codec: 'h264', sort: 'for_you' }}
        previewMode
        previewOptions={{ cameraMode: 'headset', sceneMode: 'reels', showControls: true }}
        onPreviewReady={(api) => {
          setRenderer(api);
          syncState(api);
        }}
      />

      <SpecRow
        cells={[
          ['EARTH DRAWS', previewState.renderStats?.earthDrawCalls ?? 0, 'ZERO WHILE REELS MODE IS ACTIVE'],
          ['REEL DRAWS', previewState.renderStats?.reelDrawCalls ?? 0, 'SHARED SCENE CORE'],
          ['VIDEO UPLOADS', previewState.renderStats?.videoUploads ?? 0, 'PAUSED WHILE EARTH IS OPEN'],
        ]}
      />
      <Mono>DRAG TO LOOK OR ORBIT · DRAG THE EARTH TO ROTATE · CLICK A HEAT MARKER TO LOAD ITS RECENT TRENDING REELS</Mono>
    </div>
  );
}
