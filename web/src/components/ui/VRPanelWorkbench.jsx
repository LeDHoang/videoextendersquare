import { useEffect, useMemo, useRef, useState } from 'react';
// Side-effect import: the UMD module assigns window.VRUICanvas, and Vite
// re-runs it on every save, so panel edits show up without a reload.
import '../../../../ui/assets/vr_ui_canvas.js';
import controllerPng from '../../../../ui/assets/quest_controller.png';
import { Segmented, ToggleRow } from './controls.jsx';

// Captured now: ReelsPlayer later re-injects its own copy onto window.
const UI = typeof window !== 'undefined' ? window.VRUICanvas : null;
if (typeof window !== 'undefined' && !window.QUEST_CONTROLLER_B64) {
  window.QUEST_CONTROLLER_B64 = controllerPng;
}

const DURATION = 42;
const PANEL_KEYS = ['COMMENTS', 'OVERLAY', 'GUIDE', 'DOCK', 'EARTH CARD', 'EARTH LABEL'];
const SIZES = UI ? {
  COMMENTS: { w: UI.CPANEL_W, h: UI.CPANEL_H },
  OVERLAY: { w: UI.OVERLAY_W, h: UI.OVERLAY_H },
  GUIDE: { w: UI.GUIDE_W, h: UI.GUIDE_H },
  'EARTH CARD': { w: UI.EARTH_PREVIEW_W, h: UI.EARTH_PREVIEW_H },
  'EARTH LABEL': { w: UI.EARTH_LABEL_W, h: UI.EARTH_LABEL_H },
} : {};
const IDLE_HOVER = { DOCK: -1, COMMENTS: '', OVERLAY: null, 'EARTH CARD': '', 'EARTH LABEL': '' };
const KINDS = { VIDEO: 'video', IMAGE: 'image', 'STATIC CARD': 'static-card' };
const CURVES = { DOME: 1, 'SQ CURVE': 2, FLAT: 0 };
const CURVE_ORDER = ['DOME', 'SQ CURVE', 'FLAT'];
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const PLAYLIST = [
  {
    title: 'Neon rain over the Shibuya crossing at midnight',
    caption: 'Shot handheld from the Starbucks window as the lights changed. Full 3D in the headset.',
    creator: { username: 'echo_archive', display_name: 'echo_archive' },
    created_at: daysAgo(64),
    tags: ['tokyo', 'night', 'rain'],
    location: { city: 'Tokyo', country: 'Japan' },
    duration_ms: 15000,
    likes: 1840,
    views: 42200,
  },
  {
    title: 'Ha Long Bay sunrise',
    creator: { username: 'nam', display_name: 'Nam Tran' },
    created_at: daysAgo(3),
    tags: ['vietnam'],
    location: { city: 'Ha Long', country: 'Vietnam' },
    duration_ms: 42000,
    likes: 312,
    views: 5100,
  },
  {
    title: 'Reykjavik northern lights, full sky',
    caption: 'Aurora over the harbour.',
    creator: { username: 'lina', display_name: 'lina' },
    created_at: daysAgo(400),
    location: { display_name: 'Reykjavik' },
    media_type: 'image',
    likes: 98000,
    views: 1250000,
  },
];
const EARTH_STATUS = {
  tier: 'CITY',
  tierColor: '#3b82f6',
  zoomPct: 240,
  scaleCaption: '5 KM',
  mapStatus: 'LIVE TILES',
  mapOffline: false,
  location: 'HANOI',
  northUp: true,
  canOpenFeed: true,
};
// Globe zoom stops for the breadcrumb: render scale, zoom share, scale bar.
const EARTH_ZOOMS = {
  GLOBE: { scale: 1, pct: 0, bar: null },
  REGION: { scale: 8, pct: 35, bar: { pixels: 140, caption: '500 KM' } },
  CITY: { scale: 60, pct: 72, bar: { pixels: 120, caption: '5 KM' } },
  STREET: { scale: 400, pct: 100, bar: { pixels: 90, caption: '200 M' } },
};
const EARTH_LOCATION = { name: 'Hanoi', slug: 'hanoi', heat: 0.72, active_reel_count: 18 };
const COMMENT_TEMPLATES = [
  ['mika_tokyo', '#ff3b1f', 'The lantern reflections here are unreal'],
  ['dev ray', '#3b82f6', 'Is this shot on a 360 rig or stitched from a phone? The parallax on the left side is wild.'],
  ['lina', '#22c55e', 'Saving this one for the weekend trip planning, thank you!'],
  ['oskar_b', '#f2c744', 'Audio drops out for a second around the bridge'],
  ['quest_owner_2026', '#a855f7', 'Watching this in the headset with the dome curve is the best way to see it'],
  ['nam', '#ef4444', 'Hà Nội mùa thu đẹp quá'],
];

function makeComments(count) {
  return Array.from({ length: count }, (_, i) => {
    const [author, color, text] = COMMENT_TEMPLATES[i % COMMENT_TEMPLATES.length];
    return {
      id: `c${i + 1}`,
      author_name: author,
      avatar_color: color,
      text,
      // Every third comment is general (no timestamp); the rest pop up on the screen.
      timestamp: i % 3 === 2 ? null : (1 + i * 3.5) % DURATION,
      likes: (i * 7) % 12,
      liked_by_me: i === 1,
    };
  });
}

let posterCache = null;
function getPosters() {
  if (!posterCache) {
    posterCache = ['#ff3b1f', '#3b82f6', '#22c55e'].map((color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 270;
      canvas.height = 480;
      const g = canvas.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, color);
      grad.addColorStop(1, '#050608');
      g.fillStyle = grad;
      g.fillRect(0, 0, canvas.width, canvas.height);
      return canvas;
    });
  }
  return posterCache;
}

function filterByTab(comments, tab) {
  if (tab === 'general') return comments.filter((c) => c.timestamp === null);
  return comments;
}

function mockSource(mock, s) {
  return { paused: !mock.playing, muted: mock.muted, currentTime: s.time, duration: DURATION, kind: KINDS[mock.kind] };
}

function dockOptions(mock, s) {
  return {
    source: mockSource(mock, s),
    itemState: { available: true, liked: s.liked, saved: s.saved, following: s.following },
    sceneMode: mock.dock === 'EARTH' ? 'earth' : 'reels',
    packMode: mock.dock === 'PACK',
  };
}

// Current reel + follow state for the comments panel creator block.
function commentsItem(s) {
  return { item: PLAYLIST[s.idx], itemState: { available: true, following: s.following } };
}

// The dock canvas shrinks to fit its live controls, as in the engine.
function panelSize(key, mock) {
  return key === 'DOCK' ? UI.controlsCanvasSize(dockOptions(mock, { time: 0 })) : SIZES[key];
}

function drawPanel(key, ctx, mock, comments, s, now) {
  if (key === 'DOCK') {
    UI.renderControlsCanvas(ctx, {
      ...dockOptions(mock, s),
      packContext: mock.dock === 'PACK' ? { title: 'TOKYO AFTER DARK', queueOpen: false } : null,
      playlist: PLAYLIST,
      idx: s.idx,
      item: PLAYLIST[s.idx],
      comments,
      hoveredButton: s.hover.DOCK,
      pressedButton: s.pressed,
      isCurved: mock.curve !== 'FLAT',
      curvatureMode: CURVES[mock.curve],
      lockToViewer: mock.lock,
      autoNext: mock.autoNext,
      earth: mock.dock === 'EARTH' ? EARTH_STATUS : null,
      stereo: mock.stereo.toLowerCase(),
    });
  } else if (key === 'COMMENTS') {
    UI.renderCommentsPanelCanvas(ctx, {
      comments,
      cPanelTab: s.tab,
      cPanelScrollY: s.scroll,
      cPanelHover: s.hover.COMMENTS,
      cPanelHighlightId: s.highlight,
      user: null,
      currentTime: s.time,
      ...commentsItem(s),
    });
  } else if (key === 'OVERLAY') {
    s.overlayRegions = UI.renderOverlayCanvas(ctx, {
      comments,
      currentTime: s.time,
      overlayHoverId: s.hover.OVERLAY,
    }) || [];
  } else if (key === 'GUIDE') {
    UI.renderGuideCanvas(ctx);
  } else if (key === 'EARTH LABEL') {
    const z = EARTH_ZOOMS[mock.earthZoom];
    const zoomed = z.scale > 1;
    const featured = mock.earthPlace;
    const title = featured ? (zoomed ? `WORLD › Hanoi · ${z.pct}%` : 'Hanoi') : (zoomed ? `WORLD · ${z.pct}%` : 'EARTH ACTIVITY');
    const hint = featured ? (z.scale >= 24 ? 'TRIGGER  ▸  OPEN FEED' : 'TRIGGER  ▸  ZOOM IN') : (zoomed ? '' : 'DRAG TO ROTATE  ·  TRIGGER TO ZOOM');
    UI.renderEarthLabelCanvas(ctx, {
      title,
      detail: mock.earthOffline ? 'MAP OFFLINE · TILES PAUSED' : (featured ? '72% HEAT · 18 ACTIVE' : '24 ZONES'),
      zoomed,
      zoomPct: z.pct,
      featured,
      offline: mock.earthOffline,
      scaleBar: z.bar,
      scale: z.scale,
      streaming: zoomed ? 0.6 : -1,
      hint,
      resetEnabled: zoomed || featured,
      resetHot: s.hover['EARTH LABEL'] === 'face',
    });
  } else if (key === 'EARTH CARD') {
    const ready = mock.card === 'READY';
    ctx.clearRect(0, 0, SIZES[key].w, SIZES[key].h);
    UI.renderEarthPreviewCanvas(ctx, {
      location: EARTH_LOCATION,
      earthPreviewStatus: mock.card === 'EMPTY' ? 'idle' : mock.card.toLowerCase(),
      earthPreviewItems: mock.card === 'EMPTY' ? [] : PLAYLIST,
      earthPreviewIndex: Math.floor(now / 4000) % PLAYLIST.length,
      earthPreviewPosters: ready ? getPosters() : [],
      earthPreviewHover: s.hover['EARTH CARD'],
      reducedMotion: false,
      time: now,
    });
  }
}

// Flat, pixel-exact view of the in-headset canvas panels with mock reel
// state. Draws with the same vr_ui_canvas.js renderers and hit tests the
// engine uploads as textures, so what you tune here is what the Quest shows.
export default function VRPanelWorkbench() {
  const [mock, setMock] = useState({
    panel: 'ALL',
    dock: 'REELS',
    kind: 'VIDEO',
    playing: false,
    muted: true,
    curve: 'DOME',
    stereo: 'MONO',
    lock: true,
    autoNext: true,
    comments: '6',
    card: 'READY',
    res: '2× CRISP',
    zoom: '75%',
    earthZoom: 'CITY',
    earthPlace: true,
    earthOffline: false,
  });
  const [lastAction, setLastAction] = useState('—');
  const comments = useMemo(() => makeComments(Number(mock.comments)), [mock.comments]);
  const live = useRef({ mock, comments });
  live.current = { mock, comments };
  const interact = useRef({
    time: 3,
    idx: 0,
    hover: { ...IDLE_HOVER },
    pressed: -1,
    tab: 'all',
    following: false,
    liked: false,
    saved: false,
    scroll: 0,
    highlight: null,
    overlayRegions: [],
  });
  const canvases = useRef({});
  const stageRef = useRef(null);

  const set = (key) => (value) => setMock((m) => ({ ...m, [key]: value }));

  const scrollComments = (delta) => {
    const s = interact.current;
    const listH = UI.CP_LIST_BOTTOM - UI.CP_LIST_TOP;
    const contentH = filterByTab(live.current.comments, s.tab).length * (UI.CP_ITEM_H + UI.CP_ITEM_GAP);
    s.scroll = Math.max(0, Math.min(Math.max(0, contentH - listH), s.scroll + delta));
  };

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let lastError = '';
    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      const { mock: m, comments: list } = live.current;
      const s = interact.current;
      if (m.playing) s.time = (s.time + (now - last) / 1000) % DURATION;
      last = now;
      for (const [key, canvas] of Object.entries(canvases.current)) {
        const ctx = canvas.getContext('2d');
        const k = canvas.width / panelSize(key, m).w;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        try {
          drawPanel(key, ctx, m, list, s, now);
        } catch (error) {
          const message = `${key}: ${error?.stack || error}`;
          if (message !== lastError) console.error('[VR workbench]', message);
          lastError = message;
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Native listener: React's wheel handler is passive and cannot stop the page scroll.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event) => {
      if (event.target.dataset?.panel !== 'COMMENTS') return;
      event.preventDefault();
      scrollComments(event.deltaY);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!UI) return null;

  const toNative = (event, key) => {
    const el = event.currentTarget;
    const size = panelSize(key, live.current.mock);
    return [
      event.nativeEvent.offsetX * (size.w / el.clientWidth),
      event.nativeEvent.offsetY * (size.h / el.clientHeight),
    ];
  };

  const hitTest = (key, x, y) => {
    const s = interact.current;
    const { mock: m, comments: list } = live.current;
    if (key === 'DOCK') return UI.resolveControlsHit(x, y, dockOptions(m, s));
    if (key === 'COMMENTS') return UI.resolveCommentsPanelRegion(x, y, { comments: list, cPanelTab: s.tab, cPanelScrollY: s.scroll, ...commentsItem(s) });
    if (key === 'OVERLAY') return UI.resolveOverlayCommentAt(x, y, s.overlayRegions);
    if (key === 'EARTH CARD') return UI.resolveEarthPreviewHit(x, y);
    if (key === 'EARTH LABEL') return UI.resolveEarthLabelHit(x, y);
    return null;
  };

  const clampTime = (t) => Math.max(0, Math.min(DURATION, t));

  const act = (key, hit, x) => {
    const s = interact.current;
    if (key === 'DOCK') {
      const btn = UI.CTRL_BUTTONS[hit];
      if (!btn) return;
      const a = btn.action;
      if (a === 'play') setMock((m) => ({ ...m, playing: !m.playing }));
      else if (a === 'mute') setMock((m) => ({ ...m, muted: !m.muted }));
      else if (a === 'lock') setMock((m) => ({ ...m, lock: !m.lock }));
      else if (a === 'mode') setMock((m) => ({ ...m, autoNext: !m.autoNext }));
      else if (a === 'curve') setMock((m) => ({ ...m, curve: CURVE_ORDER[(CURVE_ORDER.indexOf(m.curve) + 1) % CURVE_ORDER.length] }));
      else if (a === 'earth') setMock((m) => ({ ...m, dock: m.dock === 'EARTH' ? 'REELS' : 'EARTH' }));
      else if (a === 'prev' || a === 'next') {
        s.idx = (s.idx + (a === 'next' ? 1 : PLAYLIST.length - 1)) % PLAYLIST.length;
        s.time = 0;
      } else if (a === 'rew' || a === 'fwd') s.time = clampTime(s.time + (a === 'fwd' ? 5 : -5));
      else if (a === 'seek') s.time = clampTime(((x - btn.x) / btn.w) * DURATION);
      else if (a === 'like') s.liked = !s.liked;
      else if (a === 'save_reel' || a === 'collect') s.saved = !s.saved;
      else if (a === 'follow') s.following = !s.following;
      setLastAction(`DOCK › ${a}`);
    } else if (key === 'COMMENTS' && hit) {
      if (hit.startsWith('tab:')) {
        s.tab = hit.slice(4);
        s.scroll = 0;
      } else if (hit === 'follow') {
        s.following = !s.following;
      } else if (hit === 'scrollup' || hit === 'scrolldown') {
        scrollComments((hit === 'scrollup' ? -1 : 1) * (UI.CP_ITEM_H + UI.CP_ITEM_GAP));
      } else if (hit.startsWith('seek:')) {
        const c = live.current.comments.find((item) => item.id === hit.slice(5));
        if (c) {
          s.time = c.timestamp;
          s.highlight = c.id;
        }
      }
      setLastAction(`COMMENTS › ${hit}`);
    } else if (key === 'OVERLAY' && hit) {
      setLastAction(`OVERLAY › ${hit}`);
    } else if (key === 'EARTH CARD' && hit) {
      setLastAction(`EARTH CARD › ${hit}`);
    } else if (key === 'EARTH LABEL' && hit) {
      setLastAction(`EARTH LABEL › ${hit}`);
    }
  };

  const pointerProps = (key) => ({
    onPointerMove: (event) => {
      const [x, y] = toNative(event, key);
      interact.current.hover[key] = hitTest(key, x, y) ?? IDLE_HOVER[key];
    },
    onPointerLeave: () => {
      interact.current.hover[key] = IDLE_HOVER[key];
      interact.current.pressed = -1;
    },
    onPointerDown: (event) => {
      if (key === 'DOCK') interact.current.pressed = hitTest(key, ...toNative(event, key));
    },
    onPointerUp: () => { interact.current.pressed = -1; },
    onClick: (event) => {
      const [x, y] = toNative(event, key);
      act(key, hitTest(key, x, y), x);
    },
  });

  const res = mock.res.startsWith('2') ? 2 : 1;
  const zoom = parseInt(mock.zoom, 10) / 100;
  const shown = mock.panel === 'ALL' ? PANEL_KEYS : [mock.panel];

  return (
    <div className="sx-vr-workbench">
      <div className="sx-immersive-preview-toolbar" aria-label="Panel workbench controls">
        <Segmented ariaLabel="Panel" options={['ALL', ...PANEL_KEYS]} value={mock.panel} onChange={set('panel')} />
        <Segmented ariaLabel="Render resolution" options={['1× TEXTURE', '2× CRISP']} value={mock.res} onChange={set('res')} />
        <Segmented ariaLabel="Zoom" options={['50%', '75%', '100%', '150%']} value={mock.zoom} onChange={set('zoom')} />
      </div>
      <div className="sx-immersive-preview-toolbar" aria-label="Mock reel state">
        <Segmented ariaLabel="Dock variant" options={['REELS', 'PACK', 'EARTH']} value={mock.dock} onChange={set('dock')} />
        <Segmented ariaLabel="Source kind" options={Object.keys(KINDS)} value={mock.kind} onChange={set('kind')} />
        <Segmented ariaLabel="Curvature" options={CURVE_ORDER} value={mock.curve} onChange={set('curve')} />
        <Segmented ariaLabel="Stereo" options={['MONO', 'SBS', 'TB']} value={mock.stereo} onChange={set('stereo')} />
        <Segmented ariaLabel="Comment count" options={['0', '3', '6', '12']} value={mock.comments} onChange={set('comments')} />
        <Segmented ariaLabel="Earth card" options={['READY', 'LOADING', 'ERROR', 'EMPTY']} value={mock.card} onChange={set('card')} />
        <Segmented ariaLabel="Earth zoom" options={Object.keys(EARTH_ZOOMS)} value={mock.earthZoom} onChange={set('earthZoom')} />
        <ToggleRow label="EARTH PLACE" checked={mock.earthPlace} onChange={set('earthPlace')} />
        <ToggleRow label="MAP OFFLINE" checked={mock.earthOffline} onChange={set('earthOffline')} />
        <ToggleRow label="PLAYING" checked={mock.playing} onChange={set('playing')} />
        <ToggleRow label="MUTED" checked={mock.muted} onChange={set('muted')} />
        <ToggleRow label="LOCKED" checked={mock.lock} onChange={set('lock')} />
        <ToggleRow label="AUTO NEXT" checked={mock.autoNext} onChange={set('autoNext')} />
      </div>
      <div className="sx-vr-workbench-readout">LAST ACTION: <strong>{lastAction}</strong></div>
      <div className="sx-vr-workbench-stage" ref={stageRef}>
        {shown.map((key) => [key, panelSize(key, mock)]).map(([key, size]) => (
          <figure key={key} className="sx-vr-workbench-panel">
            <canvas
              ref={(el) => {
                if (el) canvases.current[key] = el;
                else delete canvases.current[key];
              }}
              data-panel={key}
              className={`sx-vr-workbench-canvas${key === 'OVERLAY' ? ' sx-vr-workbench-canvas--overlay' : ''}`}
              width={size.w * res}
              height={size.h * res}
              style={{ width: size.w * zoom, height: size.h * zoom }}
              {...pointerProps(key)}
            />
            <figcaption>{key} · {size.w}×{size.h} PX</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
