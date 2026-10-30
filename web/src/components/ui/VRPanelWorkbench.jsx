import { useEffect, useMemo, useRef, useState } from 'react';
// Side-effect import: the UMD module assigns window.VRUICanvas, and Vite
// re-runs it on every save, so panel edits show up without a reload.
import '../../../../ui/assets/vr_ui_canvas.js';
import '../../../../ui/assets/vr_shell_canvas.js';
import '../../../../ui/assets/vr_shell.js';
import controllerPng from '../../../../ui/assets/quest_controller.png';
import { Segmented, ToggleRow } from './controls.jsx';

// Captured now: ReelsPlayer later re-injects its own copy onto window.
const UI = typeof window !== 'undefined' ? window.VRUICanvas : null;
const SC = typeof window !== 'undefined' ? window.VRShellCanvas : null;
const VS = typeof window !== 'undefined' ? window.VRShell : null;
if (typeof window !== 'undefined' && !window.QUEST_CONTROLLER_B64) {
  window.QUEST_CONTROLLER_B64 = controllerPng;
}

const DURATION = 42;
const PANEL_KEYS = ['COMMENTS', 'OVERLAY', 'GUIDE', 'DOCK', 'EARTH DOCK', 'EARTH CARD', 'EARTH LABEL', 'SHELL NAV', 'SHELL MAIN', 'SHELL KEYBOARD'];
const SHELL_KEYS = { 'SHELL NAV': 1, 'SHELL MAIN': 1, 'SHELL KEYBOARD': 1 };
const SIZES = UI ? {
  COMMENTS: { w: UI.CPANEL_W, h: UI.CPANEL_H },
  OVERLAY: { w: UI.OVERLAY_W, h: UI.OVERLAY_H },
  GUIDE: { w: UI.GUIDE_W, h: UI.GUIDE_H },
  'EARTH CARD': { w: UI.EARTH_PREVIEW_W, h: UI.EARTH_PREVIEW_H },
  'EARTH LABEL': { w: UI.EARTH_LABEL_W, h: UI.EARTH_LABEL_H },
  ...(SC ? {
    'SHELL NAV': { w: SC.NAV_W, h: SC.NAV_H },
    'SHELL MAIN': { w: SC.MAIN_W, h: SC.MAIN_H },
    'SHELL KEYBOARD': { w: SC.KB_W, h: SC.KB_H },
  } : {}),
} : {};
const IDLE_HOVER = {
  DOCK: -1, 'EARTH DOCK': -1, COMMENTS: '', OVERLAY: null, 'EARTH CARD': '', 'EARTH LABEL': '',
  'SHELL NAV': '', 'SHELL MAIN': '', 'SHELL KEYBOARD': '',
};
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
// Globe zoom stops for the breadcrumb: render scale, zoom share, scale bar.
const EARTH_ZOOMS = {
  GLOBE: { scale: 1, pct: 0, bar: null },
  REGION: { scale: 8, pct: 35, bar: { pixels: 140, caption: '500 KM' } },
  CITY: { scale: 60, pct: 72, bar: { pixels: 120, caption: '5 KM' } },
  STREET: { scale: 400, pct: 100, bar: { pixels: 90, caption: '200 M' } },
};
// Engine EARTH_TIERS: the dock's tier tile name and colour by render scale.
const EARTH_TIERS = [
  { name: 'ORBIT', max: 3, color: '#39D7FF' },
  { name: 'REGION', max: 24, color: '#4FE3C1' },
  { name: 'CITY', max: 200, color: '#FFC857' },
  { name: 'STREET', max: Infinity, color: '#FF8A5B' },
];
// Mirrors the engine's earthDockStatus() for the Earth zoom / place / offline
// controls; zoomed views stream at 60%, like the Earth label's streaming bar.
function earthDockStatus(mock) {
  const z = EARTH_ZOOMS[mock.earthZoom];
  const zoomed = z.scale > 1;
  const tier = EARTH_TIERS.find((t) => z.scale < t.max);
  const offline = zoomed && mock.earthOffline;
  return {
    tier: tier.name,
    tierColor: tier.color,
    zoomPct: z.pct,
    scaleCaption: z.bar ? z.bar.caption : '—',
    mapStatus: offline ? 'OFFLINE' : (zoomed ? 'STREAMING 60%' : 'ORBITAL'),
    mapOffline: offline,
    location: mock.earthPlace ? 'HANOI' : (zoomed ? 'WORLD' : 'EARTH ACTIVITY'),
    northUp: true,
    canOpenFeed: !!mock.earthPlace,
  };
}
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

// Mock API for the VR shell: same reply shapes as the server, served instantly.
const SHELL_ME = { id: 'me', username: 'you', display_name: 'You' };
const SHELL_PEOPLE = [
  { id: 'u1', username: 'mika_tokyo', display_name: 'Mika' },
  { id: 'u2', username: 'nam', display_name: 'Nam Tran' },
  { id: 'u3', username: 'lina', display_name: 'lina' },
  { id: 'u4', username: 'oskar_b', display_name: 'Oskar B' },
  { id: 'u5', username: 'dev_ray', display_name: 'dev ray' },
  { id: 'u6', username: 'quest_owner_2026', display_name: 'Quest owner' },
  { id: 'u7', username: 'echo_archive', display_name: 'echo_archive' },
];
const SHELL_REELS = Array.from({ length: 23 }, (_, i) => ({
  ...PLAYLIST[i % PLAYLIST.length],
  id: `r${i + 1}`,
  poster_url: `mock:${i % 3}`,
  comments_count: (i * 5) % 7,
  liked_by_me: i % 4 === 0,
  stereo_layout: i % 5 === 1 ? 'sbs' : undefined,
}));
const SHELL_PACKS = [
  ['TOKYO AFTER DARK', 7], ['RAINY SEASON', 5], ['NORTHERN LIGHTS', 4], ['HA LONG MORNINGS', 6], ['ROOFTOPS', 3],
].map(([title, n], i) => ({ id: `p${i + 1}`, title, status: 'published', reel_count: n, cover_url: `mock:${i % 3}` }));
const SHELL_LINES = [
  'did you see the aurora reel?', 'yes!! the dome curve makes it', 'sending you the Tokyo pack',
  'thanks, watching now', 'the rain one is unreal in 3D', 'right? shot it handheld', 'weekend trip?',
];
const SHELL_PAGES = {
  EXPLORE: '/explore',
  SEARCH: '/explore?q=tokyo',
  TAG: '/explore/tag/night',
  LOCATION: '/explore/location/tokyo',
  PROFILE: '/profile/mika_tokyo',
  PACK: '/packs/p1',
  MESSAGES: '/messages',
  CHAT: '/messages/c1',
  CREDITS: '/wallet',
  SHARE: 'share',
  HANDOFF: '/upload',
  CLOSED: '',
};
const SECTION_PAGE = {
  explore: 'EXPLORE', search: 'SEARCH', tag: 'TAG', location: 'LOCATION', profile: 'PROFILE', pack: 'PACK',
  messages: 'MESSAGES', thread: 'CHAT', wallet: 'CREDITS', share: 'SHARE', handoff: 'HANDOFF',
};

function shellConversations(box) {
  const people = box === 'requests' ? SHELL_PEOPLE.slice(5) : SHELL_PEOPLE;
  return people.map((p, i) => ({
    id: `c${i + 1}`,
    participant: p,
    can_message: true,
    is_request: box === 'requests',
    unread_count: i < 2 ? 2 - i : 0,
    last_message: i === 2
      ? { kind: 'reel', post: SHELL_REELS[2], sender_id: 'me' }
      : { kind: 'text', text: SHELL_LINES[i % SHELL_LINES.length], sender_id: i % 2 ? 'me' : p.id },
  }));
}

function shellRequest(path, query) {
  let m;
  if (path === '/api/reels') return { videos: query.author ? SHELL_REELS.slice(0, 9) : SHELL_REELS };
  if (path.startsWith('/api/reels/tags/')) {
    return { videos: SHELL_REELS.slice(3), related_tags: [{ slug: 'rain', name: '#rain' }, { slug: 'tokyo', name: '#tokyo' }] };
  }
  if (path.startsWith('/api/reels/locations/')) {
    return { videos: SHELL_REELS.slice(5), location: { name: 'Tokyo' }, related_locations: [{ slug: 'osaka', name: 'Osaka' }] };
  }
  if (/^\/api\/users\/[^/]+\/packs$/.test(path)) return { items: SHELL_PACKS };
  if ((m = /^\/api\/users\/(.+)$/.exec(path))) {
    const p = SHELL_PEOPLE.find((x) => x.username === decodeURIComponent(m[1])) || SHELL_PEOPLE[0];
    return {
      user: {
        ...p, avatar_color: '#ff3b1f', created_at: daysAgo(420), website: 'https://mika.example/tokyo',
        bio: 'Night walks through Tokyo in stereo 3D. Rain, neon and quiet backstreets, shot handheld on a 360 rig.',
        top_tags: [{ name: 'tokyo', slug: 'tokyo' }, { name: 'night', slug: 'night' }, { name: 'rain', slug: 'rain' }],
        post_count: 9, follower_count: 12400, following_count: 310, like_count: 86300, is_following: false,
      },
    };
  }
  if (path.startsWith('/api/packs/')) {
    return {
      pack: {
        id: 'p1', title: 'TOKYO AFTER DARK', creator: SHELL_PEOPLE[6], views: 48200, likes: 912, saves: 140,
        liked_by_me: false, saved_by_me: true, items: SHELL_REELS.slice(0, 7).map((post) => ({ available: true, post })),
      },
    };
  }
  if (path === '/api/messages/unread-count') return { unread_count: 3, inbox: 3, requests: 1 };
  if (path === '/api/messages/conversations') return { conversations: shellConversations(query.box) };
  if ((m = /^\/api\/messages\/conversations\/([^/]+)\/messages$/.exec(path))) {
    const conv = shellConversations('inbox').find((c) => c.id === m[1]) || shellConversations('inbox')[0];
    return {
      conversation: conv,
      messages: SHELL_LINES.map((text, i) => ({
        id: `m${i + 1}`, kind: i === 2 ? 'pack' : 'text', text, pack: i === 2 ? { title: 'TOKYO AFTER DARK' } : undefined,
        sender_id: i % 2 ? conv.participant.id : 'me', created_at: daysAgo((SHELL_LINES.length - i) / 24),
      })),
    };
  }
  if (path === '/api/billing/wallet') {
    return { available_credits: 1240, reserved_credits: 60, lifetime_earned: 3200, lifetime_spent: 1960 };
  }
  if (path === '/api/billing/transactions') {
    const sources = ['reel_reward', 'video_generation', 'credit_purchase', 'reel_reward', 'image_generation', 'refund'];
    let balance = 1240;
    return {
      transactions: Array.from({ length: 14 }, (_, i) => {
        const delta = [5, -40, 500, 5, -12, 40][i % 6];
        const row = { id: `t${i}`, source: sources[i % 6], delta_available: delta, delta_reserved: 0, balance_available: balance, created_at: daysAgo(i * 0.7) };
        balance -= delta;
        return row;
      }),
    };
  }
  return {};
}

function shellSend(method, path, body) {
  if (path === '/api/messages/share-content') return { succeeded: 1 };
  if (/\/messages$/.test(path) && body && body.text) {
    return { message: { id: body.client_id, kind: 'text', text: body.text, sender_id: 'me', created_at: new Date().toISOString() } };
  }
  return {};
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

// EARTH DOCK is the dock as Earth mode shows it, whatever the dock variant.
const isDock = (key) => key === 'DOCK' || key === 'EARTH DOCK';
const dockMock = (key, mock) => (key === 'EARTH DOCK' ? { ...mock, dock: 'EARTH' } : mock);

// The dock canvas shrinks to fit its live controls, as in the engine.
function panelSize(key, mock) {
  return isDock(key) ? UI.controlsCanvasSize(dockOptions(dockMock(key, mock), { time: 0 })) : SIZES[key];
}

function drawPanel(key, ctx, mock, comments, s, now) {
  if (SHELL_KEYS[key]) {
    const state = s.shell.getRenderState();
    if (key === 'SHELL NAV') SC.renderNavBar(ctx, state, s.hover[key]);
    else if (key === 'SHELL MAIN') SC.renderMainPanel(ctx, state, s.hover[key], (url) => getPosters()[Number(String(url).slice(5)) || 0]);
    else SC.renderKeyboard(ctx, s.hover[key], state.field);
  } else if (isDock(key)) {
    mock = dockMock(key, mock);
    UI.renderControlsCanvas(ctx, {
      ...dockOptions(mock, s),
      packContext: mock.dock === 'PACK' ? { title: 'TOKYO AFTER DARK', queueOpen: false } : null,
      playlist: PLAYLIST,
      idx: s.idx,
      item: PLAYLIST[s.idx],
      comments,
      hoveredButton: s.hover[key],
      pressedButton: s.pressedKey === key ? s.pressed : -1,
      isCurved: mock.curve !== 'FLAT',
      curvatureMode: CURVES[mock.curve],
      lockToViewer: mock.lock,
      autoNext: mock.autoNext,
      earth: mock.dock === 'EARTH' ? earthDockStatus(mock) : null,
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
  const [shellPage, setShellPage] = useState('CLOSED');
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
    shell: null,
  });
  if (!interact.current.shell && VS) {
    interact.current.shell = VS.create({
      getUser: () => SHELL_ME,
      request: (path, query) => Promise.resolve(shellRequest(path, query || {})),
      send: (method, path, body) => Promise.resolve(shellSend(method, path, body)),
      exitAndNavigate: (path) => setLastAction(`SHELL › exit VR › ${path}`),
      playFeed: ({ startIndex }) => setLastAction(`SHELL › play reel ${startIndex + 1}`),
      // REELS / EARTH nav tabs drive the mock dock, as they drive sceneMode in VR.
      getScene: () => (live.current.mock.dock === 'EARTH' ? 'earth' : 'reels'),
      setScene: (mode) => setMock((m) => (m.dock === 'PACK' ? m : { ...m, dock: mode === 'earth' ? 'EARTH' : 'REELS' })),
      earthAvailable: () => live.current.mock.dock !== 'PACK',
    });
    interact.current.shell.refreshUnread();
  }
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

  useEffect(() => {
    const shell = interact.current.shell;
    if (!shell) return undefined;
    return shell.onDirty(() => setShellPage(SECTION_PAGE[shell.section()] || 'CLOSED'));
  }, []);

  // Native listener: React's wheel handler is passive and cannot stop the page scroll.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event) => {
      const panel = event.target.dataset?.panel;
      if (panel === 'SHELL MAIN') {
        event.preventDefault();
        interact.current.shell.scroll(event.deltaY > 0 ? 1 : -1);
        return;
      }
      if (panel !== 'COMMENTS') return;
      event.preventDefault();
      scrollComments(event.deltaY);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!UI || !SC || !VS) return null;

  const openShellPage = (page) => {
    const shell = interact.current.shell;
    if (page === 'CLOSED') shell.close();
    else if (page === 'SHARE') shell.share({ kind: 'reel', target_id: 'r1', title: PLAYLIST[0].title });
    else shell.open(SHELL_PAGES[page]);
    setShellPage(page);
  };

  const toggleKeyboard = (on) => {
    const shell = interact.current.shell;
    if (on && !shell.isOpen()) openShellPage('SEARCH');
    shell.focusField(on, shell.section() === 'thread' ? 'compose' : 'search');
    setLastAction(`SHELL › keyboard ${on ? 'on' : 'off'}`);
  };

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
    if (key === 'SHELL NAV') return SC.resolveNavHit(x, y);
    if (key === 'SHELL MAIN') return SC.resolveMainHit(s.shell.getRenderState(), x, y);
    if (key === 'SHELL KEYBOARD') return SC.resolveKeyboardHit(x, y, s.shell.getRenderState().field);
    if (isDock(key)) return UI.resolveControlsHit(x, y, dockOptions(dockMock(key, m), s));
    if (key === 'COMMENTS') return UI.resolveCommentsPanelRegion(x, y, { comments: list, cPanelTab: s.tab, cPanelScrollY: s.scroll, ...commentsItem(s) });
    if (key === 'OVERLAY') return UI.resolveOverlayCommentAt(x, y, s.overlayRegions);
    if (key === 'EARTH CARD') return UI.resolveEarthPreviewHit(x, y);
    if (key === 'EARTH LABEL') return UI.resolveEarthLabelHit(x, y);
    return null;
  };

  const clampTime = (t) => Math.max(0, Math.min(DURATION, t));

  const act = (key, hit, x) => {
    const s = interact.current;
    if (SHELL_KEYS[key]) {
      if (!hit) return;
      const handled = s.shell.handleHit(hit);
      setLastAction(`SHELL › ${hit.action}${hit.arg != null && hit.arg !== '' ? ` ${hit.arg}` : ''}${handled ? '' : ' (ignored)'}`);
    } else if (isDock(key)) {
      const btn = UI.CTRL_BUTTONS[hit];
      if (!btn) return;
      const a = btn.action;
      if (a === 'play') setMock((m) => ({ ...m, playing: !m.playing }));
      else if (a === 'mute') setMock((m) => ({ ...m, muted: !m.muted }));
      else if (a === 'lock') setMock((m) => ({ ...m, lock: !m.lock }));
      else if (a === 'mode') setMock((m) => ({ ...m, autoNext: !m.autoNext }));
      else if (a === 'curve') setMock((m) => ({ ...m, curve: CURVE_ORDER[(CURVE_ORDER.indexOf(m.curve) + 1) % CURVE_ORDER.length] }));
      else if (a === 'prev' || a === 'next') {
        s.idx = (s.idx + (a === 'next' ? 1 : PLAYLIST.length - 1)) % PLAYLIST.length;
        s.time = 0;
      } else if (a === 'rew' || a === 'fwd') s.time = clampTime(s.time + (a === 'fwd' ? 5 : -5));
      else if (a === 'seek') s.time = clampTime(((x - btn.x) / btn.w) * DURATION);
      else if (a === 'like') s.liked = !s.liked;
      else if (a === 'save_reel' || a === 'collect') s.saved = !s.saved;
      else if (a === 'follow') s.following = !s.following;
      setLastAction(`${key} › ${a}`);
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
      const hit = hitTest(key, x, y);
      interact.current.hover[key] = SHELL_KEYS[key] ? SC.hoverKey(hit) : (hit ?? IDLE_HOVER[key]);
    },
    onPointerLeave: () => {
      interact.current.hover[key] = IDLE_HOVER[key];
      interact.current.pressed = -1;
    },
    onPointerDown: (event) => {
      if (isDock(key)) {
        interact.current.pressed = hitTest(key, ...toNative(event, key));
        interact.current.pressedKey = key;
      }
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
      <div className="sx-immersive-preview-toolbar" aria-label="Mock VR shell state">
        <Segmented ariaLabel="Shell page" options={Object.keys(SHELL_PAGES)} value={shellPage} onChange={openShellPage} />
        <ToggleRow
          label="KEYBOARD"
          checked={!!interact.current.shell.getRenderState().field.focused}
          onChange={toggleKeyboard}
        />
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
