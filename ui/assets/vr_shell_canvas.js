/**
 * ECHO VR Shell Canvas — pure 2D renderers and hit resolvers for the in-VR
 * shell (nav bar + main panel). No THREE, no DOM beyond the ctx it is handed,
 * so it loads in a bare VM for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VRShellCanvas = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const MAIN_W = 2048;
  const MAIN_H = 1152;
  const NAV_W = 1536;
  const NAV_H = 160;

  // Fallbacks mirror VRUICanvas.TOKENS; the live tokens win when that module is loaded.
  const FALLBACK = {
    hex: { bg: '#08090a', surface: '#101214', surface2: '#16191c', surface3: '#1d2126', rule: '#24282d',
      ruleStrong: '#3a4047', ink: '#f2f3f5', ink2: '#a4abb3', ink3: '#8e959e', inkMuted: '#646b74', accent: '#ff3b1f',
      accentHi: '#ff5c42', onAccent: '#0a0a0a' },
    font: { display: "'Archivo Black', Archivo, sans-serif", sans: 'Archivo, ui-sans-serif, system-ui, sans-serif',
      mono: "'JetBrains Mono', ui-monospace, Menlo, monospace" },
  };
  function tokens() {
    const ui = typeof window !== 'undefined' && window.VRUICanvas;
    return (ui && ui.TOKENS) || FALLBACK;
  }

  // Nav bar tabs, left to right, after the ECHO mark. 'reels' and 'earth'
  // close the shell into that scene, the rest open sections. icon: a
  // VRUICanvas dock icon.
  const NAV_ITEMS = [
    { id: 'reels', label: 'REELS', icon: 'reels' },
    { id: 'earth', label: 'EARTH', icon: 'location' },
    { id: 'explore', label: 'EXPLORE', icon: 'compass' },
    { id: 'messages', label: 'MESSAGES', icon: 'message' },
    { id: 'wallet', label: 'CREDITS', icon: 'credits' },
    { id: 'profile', label: 'PROFILE', icon: 'profile' },
  ];
  const NAV_PAD = 16;
  const NAV_GAP = 12;
  const NAV_BRAND_W = 216;
  function navRects() {
    const w = (NAV_W - NAV_BRAND_W - NAV_PAD - NAV_GAP * (NAV_ITEMS.length - 1)) / NAV_ITEMS.length;
    return NAV_ITEMS.map((item, i) => ({
      id: item.id, label: item.label, icon: item.icon,
      x: NAV_BRAND_W + i * (w + NAV_GAP), y: NAV_PAD, w, h: NAV_H - NAV_PAD * 2,
    }));
  }

  // Main panel chrome (canvas px).
  const HEADER_H = 120;
  const CLOSE_BTN = { x: MAIN_W - 120 - 32, y: 20, w: 120, h: 80 };
  const HANDOFF_BTNS = [
    { action: 'handoff-confirm', label: 'EXIT VR & OPEN', x: MAIN_W / 2 - 520, y: 760, w: 500, h: 120 },
    { action: 'handoff-cancel', label: 'STAY IN VR', x: MAIN_W / 2 + 20, y: 760, w: 500, h: 120 },
  ];

  // Explore-style sections: a tool row (search bar or chips) above a scrolling tile grid.
  const GRID_SECTIONS = { explore: 1, search: 1, tag: 1, location: 1, profile: 1, pack: 1 };
  const GRID_COLS = 4;
  const GRID_ROWS = 2;
  const GRID_TOP = 280;
  const GRID_GAP = 24;
  const CARD_H = 400;
  const TILE_GAP = 8;
  const TILE_C = 10;
  const SEARCH_BAR = { x: 48, y: 148, w: MAIN_W - 216, h: 104 };
  const CHIP_W = 290;
  const CHIP_MAX = 6;
  const SCROLL_BTNS = [
    { arg: -1, label: '▲', x: MAIN_W - 144, y: GRID_TOP, w: 96, h: CARD_H },
    { arg: 1, label: '▼', x: MAIN_W - 144, y: GRID_TOP + CARD_H + GRID_GAP, w: 96, h: CARD_H },
  ];

  // Inbox and share sheet: one conversation per row beside the scroll column.
  const LIST_ROWS = 6;
  const LIST_GAP = 12;
  const LIST_ROW_H = (CARD_H * 2 + GRID_GAP - LIST_GAP * (LIST_ROWS - 1)) / LIST_ROWS;
  const BOX_TABS = [{ arg: 'inbox', label: 'INBOX' }, { arg: 'requests', label: 'REQUESTS' }];
  const BOX_TAB_W = 400;

  function listRowRect(slot) {
    return { x: 48, y: GRID_TOP + slot * (LIST_ROW_H + LIST_GAP), w: MAIN_W - 48 - 168, h: LIST_ROW_H };
  }

  function boxTabRect(i) {
    return { x: 48 + i * (BOX_TAB_W + 16), y: SEARCH_BAR.y, w: BOX_TAB_W, h: SEARCH_BAR.h };
  }

  // Thread: bubbles, quick replies, then the compose bar with SEND.
  const THREAD_ROWS = 6;
  const THREAD_ROW_H = 84;
  const THREAD_GAP = 12;
  const QUICK_REPLIES = ['👍', 'Nice!', 'Haha 😂', 'Love this', 'Thanks!'];
  const QUICK_Y = GRID_TOP + THREAD_ROWS * (THREAD_ROW_H + THREAD_GAP) + 8;
  const QUICK_W = 290;
  const SEND_W = 280;
  const COMPOSE_BAR = { x: 48, y: QUICK_Y + 84 + 24, w: SEARCH_BAR.w - SEND_W - 16, h: 104 };
  const SEND_BTN = { x: COMPOSE_BAR.x + COMPOSE_BAR.w + 16, y: COMPOSE_BAR.y, w: SEND_W, h: COMPOSE_BAR.h };
  const THREAD_SCROLL_H = (THREAD_ROWS * (THREAD_ROW_H + THREAD_GAP) - THREAD_GAP - GRID_GAP) / 2;
  const THREAD_SCROLL = [
    { arg: -1, label: '▲', x: MAIN_W - 144, y: GRID_TOP, w: 96, h: THREAD_SCROLL_H },
    { arg: 1, label: '▼', x: MAIN_W - 144, y: GRID_TOP + THREAD_SCROLL_H + GRID_GAP, w: 96, h: THREAD_SCROLL_H },
  ];

  function threadRowRect(slot) {
    return { x: 48, y: GRID_TOP + slot * (THREAD_ROW_H + THREAD_GAP), w: MAIN_W - 48 - 168, h: THREAD_ROW_H };
  }

  function quickRect(i) {
    return { x: 48 + i * (QUICK_W + 16), y: QUICK_Y, w: QUICK_W, h: 84 };
  }

  // Profile: a hero column (avatar, bio, tags, counts, follow) beside the
  // highlighted packs strip over a 3-column tile grid.
  const PROFILE_COL = { x: 48, y: 148, w: 520 };
  const PROFILE_X = 600;
  const PROFILE_COLS = 3;
  const TAG_W = (PROFILE_COL.w - 24) / 3;
  const HL_SIZE = 136;
  const HL_GAP = 16;
  const HL_MAX = 8;
  const HL_COVER_Y = 192;
  const HL_BOTTOM = 376;

  // Tile area of a grid route: below the tool row, or right of the profile
  // column (under the highlights strip when the profile has any).
  function gridLayout(route) {
    const bottom = GRID_TOP + CARD_H * 2 + GRID_GAP;
    const right = MAIN_W - 168;
    if (route && route.section === 'profile') {
      const y = (route.highlights || []).length ? HL_BOTTOM + 16 : PROFILE_COL.y;
      return { x: PROFILE_X, y, w: right - PROFILE_X, h: bottom - y, cols: PROFILE_COLS, rows: GRID_ROWS };
    }
    return { x: 48, y: GRID_TOP, w: right - 48, h: bottom - GRID_TOP, cols: GRID_COLS, rows: GRID_ROWS };
  }

  function tileRect(L, slot) {
    const w = (L.w - TILE_GAP * (L.cols - 1)) / L.cols;
    const h = (L.h - TILE_GAP * (L.rows - 1)) / L.rows;
    return { x: L.x + (slot % L.cols) * (w + TILE_GAP), y: L.y + Math.floor(slot / L.cols) * (h + TILE_GAP), w, h };
  }

  // Scroll column beside a grid: the up and down halves of its height.
  function gridScrollBtns(L) {
    const h = (L.h - GRID_GAP) / 2;
    return [
      { arg: -1, label: '▲', x: MAIN_W - 144, y: L.y, w: 96, h },
      { arg: 1, label: '▼', x: MAIN_W - 144, y: L.y + h + GRID_GAP, w: 96, h },
    ];
  }

  // Hero column, bottom up: follow button, 2×2 counts, top tags; the bio gets the rest.
  function profileLayout(route) {
    const det = (route && route.detail) || {};
    const c = PROFILE_COL;
    let bottom = GRID_TOP + CARD_H * 2 + GRID_GAP;
    const follow = det.is_me ? null : { x: c.x, y: bottom - 96, w: c.w, h: 96 };
    if (follow) bottom = follow.y - 16;
    const cellW = (c.w - 8) / 2;
    const statsY = bottom - 88 * 2 - 8;
    const stats = [0, 1, 2, 3].map((k) => ({ x: c.x + (k % 2) * (cellW + 8), y: statsY + Math.floor(k / 2) * 96, w: cellW, h: 88 }));
    const tags = (det.top_tags || []).slice(0, 3).map((tag, k) => ({ x: c.x + k * (TAG_W + 12), y: statsY - 80, w: TAG_W, h: 56, tag }));
    return { follow, stats, tags, bioTop: c.y + 184, bioBottom: (tags.length ? tags[0].y : statsY) - 24 };
  }

  function tagPath(tag) {
    return '/explore/tag/' + encodeURIComponent(tag.slug || tag.name || '');
  }

  // Highlighted pack covers; the rect takes in the title under the cover.
  function highlightRects(route) {
    return (route.highlights || []).slice(0, HL_MAX).map((pack, k) => ({
      x: PROFILE_X + k * (HL_SIZE + HL_GAP), y: HL_COVER_Y, w: HL_SIZE, h: HL_SIZE + 40, pack,
      path: '/packs/' + encodeURIComponent(pack.id),
    }));
  }

  // First cover member's poster or image, else the pack's own cover.
  function packCover(pack) {
    const first = ((pack && pack.cover_items) || []).map((e) => (e && e.post) || e)[0];
    return thumbUrl(first) || (pack && pack.cover_url) || '';
  }

  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function joinedLabel(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d.getTime()) ? 'JOINED ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '';
  }

  // Tile overlays use mono caps; its 0.6em advance gives pill widths from
  // character counts, so one rect serves both drawing and hit testing.
  const PILL_H = 48;
  const PILL_FONT = 24;
  function monoW(text, size) {
    return Array.from(text).length * size * 0.6;
  }
  function clipChars(text, maxW, size) {
    const chars = Array.from(text);
    const n = Math.floor(maxW / (size * 0.6));
    return chars.length <= n ? text : chars.slice(0, Math.max(1, n - 1)).join('') + '…';
  }

  // URL key of a reel's place, as the 2D explore tile builds it.
  function locationKey(loc) {
    const slug = (v) => String(v || '').toLowerCase().replace(/[^\w]+|_+/g, '-').replace(/^-+|-+$/g, '');
    const city = slug(loc && loc.city);
    if (!city) return '';
    const country = slug(loc.country);
    return city + (country ? '--' + country : '');
  }

  // IMAGE / IMAGES · n for image reels, 3D for stereo ones; videos get no badge.
  function kindLabel(item) {
    const parts = [];
    if (item.media_type === 'image') {
      const n = (item.images || []).length || 1;
      parts.push(n > 1 ? 'IMAGES · ' + n : 'IMAGE');
    }
    if (item.stereo_layout === 'sbs' || item.stereo_layout === 'tb') parts.push('3D');
    return parts.join(' · ');
  }

  // Overlay pills of a tile (2D ExploreTile): creator, then place, top-left; kind badge top-right.
  function tilePills(r, item) {
    const out = {};
    const kind = kindLabel(item);
    let right = r.x + r.w - 12;
    if (kind) {
      const w = monoW(kind, 22) + 28;
      out.kind = { x: right - w, y: r.y + 12, w, h: 40, text: kind };
      right = out.kind.x - 8;
    }
    let y = r.y + 12;
    const user = (item.creator && item.creator.username) || item.author_name;
    if (user) {
      const text = clipChars('@' + user, right - r.x - 12 - 72, PILL_FONT);
      out.creator = { x: r.x + 12, y, w: 72 + monoW(text, PILL_FONT), h: PILL_H, text, user };
      y += PILL_H + 8;
      right = r.x + r.w - 12;
    }
    const loc = item.location || {};
    const key = locationKey(loc);
    if (key) {
      const text = clipChars([loc.city, loc.country].filter(Boolean).join(', '), right - r.x - 12 - 64, PILL_FONT);
      out.loc = { x: r.x + 12, y, w: 64 + monoW(text, PILL_FONT), h: PILL_H, text, key };
    }
    return out;
  }

  // Creator and place pills open their pages; the rest of the tile plays.
  function tileHit(r, item, i, x, y) {
    const p = tilePills(r, item);
    if (p.creator && inRect(p.creator, x, y)) {
      return { action: 'chip', arg: '/profile/' + encodeURIComponent(p.creator.user), hover: 'creator:' + i };
    }
    if (p.loc && inRect(p.loc, x, y)) return { action: 'chip', arg: '/explore/location/' + p.loc.key, hover: 'loc:' + i };
    return { action: 'play', arg: i };
  }

  function chipRect(i) {
    return { x: 48 + i * (CHIP_W + 16), y: SEARCH_BAR.y, w: CHIP_W, h: SEARCH_BAR.h };
  }

  // Detail action buttons, right-aligned in the tool row (profile: under its
  // hero column). Empty until the detail loads.
  const DETAIL_BTN_W = 260;
  function detailButtons(route) {
    const det = route && route.detail;
    if (!det) return [];
    const k = (n) => fmtCount(n);
    if (route.section === 'profile') {
      const f = profileLayout(route).follow;
      return f ? [Object.assign({ action: 'follow', label: det.is_following ? 'FOLLOWING' : 'FOLLOW', primary: !det.is_following }, f)] : [];
    }
    let btns = [];
    if (route.section === 'thread' && det.can_accept) {
      const busy = !!(route.pending && route.pending.decide);
      btns = [
        { action: 'accept', label: 'ACCEPT', primary: true, disabled: busy },
        { action: 'decline', label: 'DECLINE', disabled: busy || !det.can_decline },
      ];
    } else if (route.section === 'wallet') {
      btns = [{ action: 'buy', label: 'BUY CREDITS', primary: true }];
    } else if (route.section === 'pack') {
      btns = [
        { action: 'play', arg: 0, label: '▶ PLAY ALL', primary: true, disabled: !(route.items || []).length },
        { action: 'pack-like', label: (det.liked_by_me ? '♥ ' : '♡ ') + k(det.likes), active: !!det.liked_by_me },
        { action: 'pack-save', label: (det.saved_by_me ? '★ ' : '☆ ') + k(det.saves), active: !!det.saved_by_me },
      ];
    }
    const right = SEARCH_BAR.x + SEARCH_BAR.w;
    return btns.map((b, i) => Object.assign(b, {
      x: right - (btns.length - i) * (DETAIL_BTN_W + 16) + 16, y: SEARCH_BAR.y, w: DETAIL_BTN_W, h: SEARCH_BAR.h,
    }));
  }

  function fmtCount(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(v);
  }

  // Poster for videos, the image itself for image reels; '' draws the initials fallback.
  function thumbUrl(item) {
    if (!item) return '';
    return item.poster_url || (item.media_type === 'image' ? (item.preview_url || item.url) : '') || '';
  }

  const SECTION_TITLES = {
    explore: 'EXPLORE', search: 'SEARCH', tag: 'TAG', location: 'LOCATION', profile: 'PROFILE',
    pack: 'PACK', messages: 'MESSAGES', thread: 'CHAT', share: 'SHARE', wallet: 'CREDITS', rewards: 'REWARDS',
  };
  // Header icon per section (VRUICanvas dock icons).
  const SECTION_ICONS = {
    explore: 'compass', search: 'compass', tag: 'compass', location: 'location', profile: 'profile', pack: 'reels',
    messages: 'message', thread: 'message', share: 'share', wallet: 'credits', rewards: 'credits',
  };

  // Comments/guide panel shades: header band, row, hovered row.
  const BAND = '#0d0e0f';
  const ROW = '#121315';
  const ROW_HOVER = '#1c1d1f';

  function inRect(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  function uiKit() {
    return typeof window !== 'undefined' && window.VRUICanvas;
  }

  // Chamfered outline (the dock tile shape); a plain rect when VRUICanvas is absent.
  function shape(ctx, r, c) {
    const ui = uiKit();
    if (ui && ui.chamferPath) ui.chamferPath(ctx, r.x, r.y, r.w, r.h, c);
    else { ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); }
  }

  function tile(ctx, r, c, fill, stroke, lineWidth) {
    shape(ctx, r, c);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth || 2; ctx.stroke(); }
  }

  function icon(ctx, name, cx, cy, size, ink, core) {
    const ui = uiKit();
    const T = tokens().hex;
    if (ui && ui.drawIcon) ui.drawIcon(ctx, name, cx, cy, size, ink, T.accent, core);
    else { ctx.fillStyle = T.accent; ctx.fillRect(cx - 8, cy - 8, 16, 16); }
  }

  // Dock-style button: chamfered tile, accent rule when lit, mono caps label.
  // opts: primary, active, hover, disabled, quiet (darker tile, dimmer label), size, font, weight.
  function drawButton(ctx, r, label, opts) {
    const t = tokens();
    const T = t.hex;
    const o = opts || {};
    const lit = !o.disabled && (o.hover || o.active);
    let fill = lit ? T.surface3 : (o.quiet ? ROW : T.surface2);
    let stroke = lit ? T.accent : T.rule;
    if (o.primary) {
      fill = o.hover ? (T.accentHi || T.accent) : T.accent;
      stroke = o.hover ? T.ink : T.accent;
    }
    ctx.globalAlpha = o.disabled ? 0.4 : 1;
    tile(ctx, r, 12, fill, stroke, 2);
    if (o.active && !o.primary) {
      ctx.fillStyle = T.accent;
      ctx.fillRect(r.x + r.w / 2 - 28, r.y + r.h - 10, 56, 4);
    }
    ctx.fillStyle = o.primary ? T.onAccent : (o.quiet && !lit ? T.ink2 : T.ink);
    ctx.font = (o.weight || 700) + ' ' + (o.size || 32) + 'px ' + (o.font || t.font.mono);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 2);
    ctx.globalAlpha = 1;
  }

  // Status pill, right edge at `right`: 'fill' (accent), 'accent' (accent outline) or muted outline.
  function drawPill(ctx, right, cy, label, style) {
    const t = tokens();
    const T = t.hex;
    ctx.font = '700 28px ' + t.font.mono;
    const w = ctx.measureText(label).width + 48;
    const fill = style === 'fill';
    tile(ctx, { x: right - w, y: cy - 28, w, h: 56 }, 8, fill ? T.accent : T.bg, fill || style === 'accent' ? T.accent : T.ruleStrong, 2);
    ctx.fillStyle = fill ? T.onAccent : (style === 'accent' ? T.accent : T.ink2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, right - w / 2, cy + 2);
  }

  // Mono route pill centred on cx.
  function pathPill(ctx, cx, cy, path) {
    const t = tokens();
    const T = t.hex;
    ctx.font = '600 30px ' + t.font.mono;
    const w = ctx.measureText(path).width + 64;
    tile(ctx, { x: cx - w / 2, y: cy - 32, w, h: 64 }, 10, T.bg, T.rule, 2);
    ctx.fillStyle = T.ink2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(path, cx, cy + 2);
  }

  // Loading/empty/error line: accent square marker and mono caps, as in the comments panel.
  function drawStatus(ctx, text, y) {
    const t = tokens();
    const label = String(text).toUpperCase();
    ctx.font = '700 40px ' + t.font.mono;
    const x = MAIN_W / 2 - (ctx.measureText(label).width + 40) / 2;
    ctx.fillStyle = t.hex.accent;
    ctx.fillRect(x, y - 10, 20, 20);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 40, y + 2);
  }

  // Text field: dark well, accent rule and caret while focused, mono caps placeholder.
  // Long text shows its end, where typing happens.
  function drawField(ctx, r, text, placeholder, focused, hover, lead) {
    const t = tokens();
    const T = t.hex;
    tile(ctx, r, 12, T.bg, focused ? T.accent : (hover ? T.ink2 : T.ruleStrong), focused ? 3 : 2);
    const x = r.x + (lead || 32);
    const maxW = r.x + r.w - 40 - x;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (text || focused) {
      ctx.font = '40px ' + t.font.sans;
      let shown = String(text || '');
      while (shown.length > 1 && ctx.measureText(shown).width > maxW - 24) shown = shown.slice(1);
      ctx.fillStyle = T.ink;
      ctx.fillText(shown, x, r.y + r.h / 2 + 2);
      if (focused) {
        ctx.fillStyle = T.accent;
        ctx.fillRect(x + ctx.measureText(shown).width + 6, r.y + r.h / 2 - 24, 4, 48);
      }
    } else {
      ctx.font = '600 30px ' + t.font.mono;
      ctx.fillStyle = T.inkMuted;
      ctx.fillText(truncate(ctx, String(placeholder).toUpperCase(), maxW), x, r.y + r.h / 2 + 2);
    }
  }

  // state: VRShell getRenderState(); hover: nav item id or ''.
  // Drawn as a strip of the reels dock: glass surface, vermilion rule,
  // chamfered icon tiles with mono captions (VRUICanvas renderControlsCanvas).
  // Closed, the bar hangs flush under the dock, so it drops its top rule and
  // the dock's bottom edge is the seam.
  function renderNavBar(ctx, state, hover) {
    const t = tokens();
    const T = t.hex;
    const ui = typeof window !== 'undefined' && window.VRUICanvas;
    const s = state || {};
    ctx.clearRect(0, 0, NAV_W, NAV_H);
    ctx.fillStyle = T.surface;
    ctx.fillRect(0, 0, NAV_W, NAV_H);
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (s.open) ctx.rect(1.5, 1.5, NAV_W - 3, NAV_H - 3);
    else {
      ctx.moveTo(1.5, 0);
      ctx.lineTo(1.5, NAV_H - 1.5);
      ctx.lineTo(NAV_W - 1.5, NAV_H - 1.5);
      ctx.lineTo(NAV_W - 1.5, 0);
    }
    ctx.stroke();
    if (ui && ui.drawIcon) ui.drawIcon(ctx, 'logo', 60, NAV_H / 2, 52, T.ink, T.accent, T.surface);
    ctx.fillStyle = T.ink;
    ctx.font = '900 30px ' + (t.font.brand || t.font.display);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('ECHO', 98, NAV_H / 2 + 1);
    navRects().forEach((r) => {
      const scene = s.scene === 'earth' ? 'earth' : 'reels';
      const active = r.id === 'reels' || r.id === 'earth' ? !s.open && scene === r.id : s.open && s.tab === r.id;
      const off = r.id === 'earth' && s.earthOff;
      const lit = !off && (active || hover === r.id);
      if (ui && ui.chamferPath) ui.chamferPath(ctx, r.x, r.y, r.w, r.h, 12);
      else { ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); }
      ctx.fillStyle = lit ? T.surface3 : T.surface2;
      ctx.fill();
      ctx.strokeStyle = lit ? T.accent : T.rule;
      ctx.lineWidth = 2;
      ctx.stroke();
      const ink = lit ? T.ink : (off ? T.inkMuted : T.ink2);
      if (ui && ui.drawIcon) ui.drawIcon(ctx, r.icon, r.x + r.w / 2, r.y + 44, 44, ink, T.accent, lit ? T.surface3 : T.surface2);
      ctx.fillStyle = ink;
      ctx.font = 'bold 18px ' + t.font.mono;
      ctx.textAlign = 'center';
      ctx.fillText(r.label, r.x + r.w / 2, r.y + r.h - 22);
      if (active) {
        ctx.fillStyle = T.accent;
        ctx.fillRect(r.x + r.w / 2 - 24, r.y + r.h - 6, 48, 4);
      }
      if (r.id === 'messages' && s.unread > 0) drawBadge(ctx, r.x + r.w - 30, r.y + 30, s.unread);
    });
  }

  function drawBadge(ctx, cx, cy, n) {
    const t = tokens();
    ctx.fillStyle = t.hex.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = t.hex.onAccent;
    ctx.font = '26px ' + t.font.display;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n > 99 ? '99+' : String(n), cx, cy + 1);
  }

  function resolveNavHit(x, y) {
    const r = navRects().find((rect) => inRect(rect, x, y));
    return r ? { action: 'nav', arg: r.id } : null;
  }

  // Header band: accent top rule, icon tile, mono title / subtitle, close tile.
  function renderHeader(ctx, title, subtitle, hover, iconName) {
    const t = tokens();
    const T = t.hex;
    const cy = HEADER_H / 2 + 3;
    ctx.fillStyle = BAND;
    ctx.fillRect(0, 0, MAIN_W, HEADER_H);
    ctx.fillStyle = T.accent;
    ctx.fillRect(0, 0, MAIN_W, 6);
    ctx.fillStyle = T.rule;
    ctx.fillRect(0, HEADER_H - 2, MAIN_W, 2);
    tile(ctx, { x: 40, y: cy - 38, w: 76, h: 76 }, 10, T.surface2, T.rule, 2);
    icon(ctx, iconName || 'logo', 78, cy, 48, T.ink, T.surface2);
    ctx.fillStyle = T.ink;
    ctx.font = '700 44px ' + t.font.mono;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 148, cy);
    if (subtitle) {
      const x = 148 + ctx.measureText(title).width + 28;
      ctx.font = '600 34px ' + t.font.mono;
      ctx.fillStyle = T.inkMuted;
      ctx.fillText('/', x, cy);
      ctx.fillStyle = T.ink2;
      ctx.fillText(truncate(ctx, subtitle, CLOSE_BTN.x - x - 96), x + 44, cy);
    }
    const lit = hover === 'close';
    tile(ctx, CLOSE_BTN, 12, lit ? T.surface3 : T.surface2, lit ? T.accent : T.ruleStrong, 2);
    ctx.fillStyle = lit ? T.ink : T.accent;
    ctx.font = '700 40px ' + t.font.mono;
    ctx.textAlign = 'center';
    ctx.fillText('✕', CLOSE_BTN.x + CLOSE_BTN.w / 2, CLOSE_BTN.y + CLOSE_BTN.h / 2 + 2);
  }

  // Centred card around the handoff copy; the buttons sit on its lower edge.
  const HANDOFF_CARD = { x: MAIN_W / 2 - 600, y: 200, w: 1200, h: 740 };

  function renderHandoffCard(ctx, handoff, hover) {
    const t = tokens();
    const T = t.hex;
    const c = HANDOFF_CARD;
    tile(ctx, c, 24, ROW, T.ruleStrong, 2);
    ctx.fillStyle = T.accent;
    ctx.fillRect(c.x + 24, c.y, c.w - 48, 6);
    tile(ctx, { x: MAIN_W / 2 - 60, y: 260, w: 120, h: 120 }, 16, T.surface2, T.accent, 2);
    icon(ctx, 'exit', MAIN_W / 2, 320, 68, T.ink, T.surface2);
    centerText(ctx, handoff.title || 'FINISH ON 2D', 460, '64px ' + t.font.display, T.ink);
    ctx.font = '40px ' + t.font.sans;
    centerText(ctx, truncate(ctx, handoff.message || 'This page needs the 2D site.', c.w - 120), 540, ctx.font, T.ink2);
    if (handoff.path) pathPill(ctx, MAIN_W / 2, 636, handoff.path);
    HANDOFF_BTNS.forEach((b) => drawButton(ctx, b, b.label, {
      primary: b.action === 'handoff-confirm', hover: hover === b.action, size: 36,
    }));
  }

  function truncate(ctx, text, maxW) {
    let s = String(text || '');
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  function centerText(ctx, text, y, font, color) {
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, MAIN_W / 2, y);
  }

  // Search field with a magnifier glyph; shows the live query while typing.
  function renderSearchBar(ctx, route, field, hover) {
    const T = tokens().hex;
    const f = field || {};
    const r = SEARCH_BAR;
    const text = f.focused ? f.text : (route.section === 'search' ? route.arg : '');
    drawField(ctx, r, text, 'Search reels, tags, places', !!f.focused, hover === 'search-focus', 100);
    const cx = r.x + 50;
    const cy = r.y + r.h / 2;
    ctx.strokeStyle = f.focused ? T.accent : T.ink2;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx - 4, cy - 4, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 7, cy + 7);
    ctx.lineTo(cx + 19, cy + 19);
    ctx.stroke();
  }

  function renderChips(ctx, related, hover) {
    const t = tokens();
    (related || []).slice(0, CHIP_MAX).forEach((c, i) => {
      ctx.font = '600 30px ' + t.font.mono;
      drawButton(ctx, chipRect(i), truncate(ctx, c.label, CHIP_W - 40), { hover: hover === 'chip:' + c.path, size: 30, weight: 600 });
    });
  }

  // Value-over-caption columns from x, split by thin rules; stops before maxX.
  function drawStats(ctx, x, cy, stats, maxX) {
    const t = tokens();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < stats.length; i++) {
      ctx.font = '700 38px ' + t.font.mono;
      const vw = ctx.measureText(stats[i][0]).width;
      ctx.font = '600 22px ' + t.font.mono;
      const w = Math.max(vw, ctx.measureText(stats[i][1]).width);
      if (x + w > maxX) break;
      if (i) {
        ctx.fillStyle = t.hex.rule;
        ctx.fillRect(x - 28, cy - 30, 2, 60);
      }
      ctx.fillStyle = t.hex.ink3;
      ctx.fillText(stats[i][1], x, cy + 24);
      ctx.font = '700 38px ' + t.font.mono;
      ctx.fillStyle = t.hex.ink;
      ctx.fillText(stats[i][0], x, cy - 12);
      x += w + 56;
    }
  }

  // Pack: creator chip and counts, buttons on the right.
  function renderDetailRow(ctx, route, hover) {
    const t = tokens();
    const det = route.detail;
    if (!det) return;
    const btns = detailButtons(route);
    const textRight = btns.length ? btns[0].x - 32 : SEARCH_BAR.x + SEARCH_BAR.w;
    let x = SEARCH_BAR.x;
    const cy = SEARCH_BAR.y + SEARCH_BAR.h / 2;
    const chip = (route.related || [])[0];
    if (chip) {
      ctx.font = '600 30px ' + t.font.mono;
      drawButton(ctx, chipRect(0), truncate(ctx, chip.label, CHIP_W - 40), { hover: hover === 'chip:' + chip.path, size: 30, weight: 600 });
      x += CHIP_W + 48;
    }
    drawStats(ctx, x, cy, [[fmtCount(det.playable_count != null ? det.playable_count : (route.items || []).length), 'REELS'],
      [fmtCount(det.views), 'VIEWS']], textRight);
    btns.forEach((b) => drawButton(ctx, b, b.label, {
      primary: b.primary, active: b.active, disabled: b.disabled,
      hover: !b.disabled && hover === (b.arg === undefined ? b.action : b.action + ':' + b.arg),
    }));
  }

  // Greedy word wrap to maxLines; a cut last line ends in an ellipsis.
  function wrapLines(ctx, text, maxW, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length && maxLines > 0; i++) {
      const test = cur ? cur + ' ' + words[i] : words[i];
      if (!cur || ctx.measureText(test).width <= maxW) { cur = test; continue; }
      if (lines.length === maxLines - 1) return lines.concat(truncate(ctx, cur + ' ' + words.slice(i).join(' '), maxW));
      lines.push(cur);
      cur = words[i];
    }
    if (cur && maxLines > 0) lines.push(truncate(ctx, cur, maxW));
    return lines;
  }

  // 2D profile page in the panel: hero column (avatar, names, bio, tags,
  // counts, follow) and the highlighted packs strip above the tile grid.
  function renderProfile(ctx, route, hover, getImage) {
    const t = tokens();
    const T = t.hex;
    const det = route.detail;
    if (!det) return;
    const c = PROFILE_COL;
    const L = profileLayout(route);
    const av = { x: c.x, y: c.y, w: 144, h: 144 };
    drawAvatar(ctx, av.x + 72, av.y + 72, 72, det);
    const img = det.avatar_url && getImage ? getImage(det.avatar_url) : null;
    if (img) {
      ctx.save();
      shape(ctx, av, 18);
      ctx.clip();
      drawThumb(ctx, av, img, det);
      ctx.restore();
      tile(ctx, av, 18, null, det.avatar_color || T.accent, 3);
    }
    const nx = av.x + av.w + 28;
    const nw = c.x + c.w - nx;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = T.ink;
    ctx.font = '44px ' + t.font.display;
    ctx.fillText(truncate(ctx, det.display_name || det.username || '', nw), nx, c.y + 40);
    ctx.fillStyle = T.ink3;
    ctx.font = '600 26px ' + t.font.mono;
    ctx.fillText(truncate(ctx, '@' + (det.username || ''), nw), nx, c.y + 86);
    const joined = joinedLabel(det.created_at);
    if (joined) {
      ctx.fillStyle = T.inkMuted;
      ctx.font = '600 22px ' + t.font.mono;
      ctx.fillText(joined, nx, c.y + 124);
    }
    const lineH = 42;
    let y = L.bioTop;
    ctx.font = '30px ' + t.font.sans;
    ctx.fillStyle = T.ink2;
    wrapLines(ctx, det.bio, c.w, Math.floor((L.bioBottom - y - (det.website ? 48 : 0)) / lineH)).forEach((line) => {
      ctx.fillText(line, c.x, y + lineH / 2);
      y += lineH;
    });
    if (det.website) {
      ctx.fillStyle = T.accent;
      ctx.font = '600 24px ' + t.font.mono;
      ctx.fillText(truncate(ctx, String(det.website).replace(/^https?:\/\//, ''), c.w), c.x, y + 24);
    }
    L.tags.forEach((r) => {
      ctx.font = '600 24px ' + t.font.mono;
      drawButton(ctx, r, truncate(ctx, '#' + (r.tag.name || r.tag.slug), r.w - 24), {
        hover: hover === 'chip:' + tagPath(r.tag), size: 24, weight: 600,
      });
    });
    [[det.follower_count, 'FOLLOWERS'], [det.following_count, 'FOLLOWING'], [det.like_count, 'LIKES', true],
      [det.post_count, 'POSTS']].forEach(([n, label, accent], k) => {
      const r = L.stats[k];
      tile(ctx, r, 10, ROW, T.rule, 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = accent ? T.accent : T.ink;
      ctx.font = '700 40px ' + t.font.mono;
      ctx.fillText(fmtCount(n), r.x + 24, r.y + 34);
      ctx.fillStyle = T.ink3;
      ctx.font = '600 20px ' + t.font.mono;
      ctx.fillText(label, r.x + 24, r.y + 68);
    });
    detailButtons(route).forEach((b) => drawButton(ctx, b, b.label, { primary: b.primary, hover: hover === b.action, size: 36 }));
    const hl = highlightRects(route);
    if (!hl.length) return;
    ctx.textAlign = 'left';
    ctx.fillStyle = T.ink3;
    ctx.font = '700 24px ' + t.font.mono;
    ctx.fillText('HIGHLIGHTED PACKS', PROFILE_X, c.y + 18);
    hl.forEach((r) => {
      const lit = hover === 'chip:' + r.path;
      const cover = { x: r.x, y: r.y, w: r.w, h: HL_SIZE };
      const url = packCover(r.pack);
      ctx.save();
      shape(ctx, cover, TILE_C);
      ctx.clip();
      drawThumb(ctx, cover, url && getImage ? getImage(url) : null, { title: r.pack.title });
      ctx.restore();
      tile(ctx, cover, TILE_C, null, lit ? T.accent : T.rule, lit ? 4 : 2);
      if (r.pack.reel_count) {
        const n = String(r.pack.reel_count);
        const bw = monoW(n, 20) + 20;
        tile(ctx, { x: cover.x + cover.w - 8 - bw, y: cover.y + 8, w: bw, h: 32 }, 6, T.accent);
        ctx.fillStyle = T.onAccent;
        ctx.font = '800 20px ' + t.font.mono;
        ctx.textAlign = 'center';
        ctx.fillText(n, cover.x + cover.w - 8 - bw / 2, cover.y + 25);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = lit ? T.ink : T.ink2;
      ctx.font = '600 24px ' + t.font.sans;
      ctx.fillText(truncate(ctx, r.pack.title || 'Untitled', r.w), r.x, r.y + HL_SIZE + 22);
    });
  }

  function drawThumb(ctx, r, img, item) {
    const t = tokens();
    ctx.fillStyle = t.hex.surface3;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const iw = img && (img.naturalWidth || img.width);
    const ih = img && (img.naturalHeight || img.height);
    if (iw && ih) {
      // Cover-fit crop.
      const scale = Math.max(r.w / iw, r.h / ih);
      const sw = r.w / scale;
      const sh = r.h / scale;
      try { ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, r.x, r.y, r.w, r.h); return; } catch (e) {}
    }
    const initials = String((item && (item.title || item.author_name)) || '?').trim().slice(0, 2).toUpperCase();
    ctx.fillStyle = t.hex.inkMuted;
    ctx.font = Math.round(Math.min(96, r.h * 0.4)) + 'px ' + t.font.display;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, r.x + r.w / 2, r.y + r.h / 2);
  }

  // Up/down chevron stroke.
  function chevron(ctx, cx, cy, dir, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy - 9 * dir);
    ctx.lineTo(cx, cy + 9 * dir);
    ctx.lineTo(cx + 18, cy - 9 * dir);
    ctx.stroke();
    ctx.restore();
  }

  // Scroll column: arrow tiles at the outer ends of the two hit rects, a rule track with a thumb between.
  function renderScrollRail(ctx, route, btns, maxScroll, hover) {
    const T = tokens().hex;
    const scroll = route.scroll || 0;
    const up = btns[0];
    const down = btns[1];
    const trackX = up.x + up.w / 2 - 3;
    const trackY = up.y + up.w + 20;
    const trackH = down.y + down.h - down.w - 20 - trackY;
    ctx.fillStyle = T.rule;
    ctx.fillRect(trackX, trackY, 6, trackH);
    if (maxScroll > 0) {
      const len = Math.max(48, trackH / (maxScroll + 1));
      ctx.fillStyle = T.accent;
      ctx.fillRect(trackX, trackY + (trackH - len) * Math.min(1, scroll / maxScroll), 6, len);
    }
    btns.forEach((b) => {
      const disabled = b.arg < 0 ? !scroll : scroll >= maxScroll;
      const lit = !disabled && hover === 'scroll:' + b.arg;
      const r = { x: b.x, y: b.arg < 0 ? b.y : b.y + b.h - b.w, w: b.w, h: b.w };
      ctx.globalAlpha = disabled ? 0.35 : 1;
      tile(ctx, r, 12, lit ? T.surface3 : T.surface2, lit ? T.accent : T.rule, 2);
      chevron(ctx, r.x + r.w / 2, r.y + r.h / 2, b.arg < 0 ? -1 : 1, lit ? T.accent : T.ink);
      ctx.globalAlpha = 1;
    });
  }

  // Open eye: the views glyph (no dock icon for it).
  function drawEye(ctx, cx, cy, size, ink) {
    const hw = size / 2;
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - hw, cy);
    ctx.quadraticCurveTo(cx, cy - size * 0.62, cx + hw, cy);
    ctx.quadraticCurveTo(cx, cy + size * 0.62, cx - hw, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 2D ExploreTile in the panel: full-bleed thumb, creator and place pills
  // top-left, kind badge top-right, title and like/view/comment counts at the foot.
  function renderTile(ctx, r, item, i, hover, getImage) {
    const t = tokens();
    const T = t.hex;
    const lit = hover === 'play:' + i;
    const url = thumbUrl(item);
    ctx.save();
    shape(ctx, r, TILE_C);
    ctx.clip();
    drawThumb(ctx, r, url && getImage ? getImage(url) : null, item);
    ctx.restore();
    const pill = (q, on) => tile(ctx, q, 8, 'rgba(8,9,10,0.86)', on ? T.accent : T.ruleStrong, 2);
    const p = tilePills(r, item);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (p.kind) {
      pill(p.kind, false);
      ctx.fillStyle = T.ink;
      ctx.font = '700 22px ' + t.font.mono;
      ctx.fillText(p.kind.text, p.kind.x + 14, p.kind.y + p.kind.h / 2 + 1);
    }
    if (p.creator) {
      const c = p.creator;
      const on = hover === 'creator:' + i;
      const who = item.creator || {};
      const cx = c.x + 28;
      const cy = c.y + c.h / 2;
      pill(c, on);
      ctx.fillStyle = who.avatar_color || T.accent;
      ctx.beginPath();
      ctx.arc(cx, cy, 17, 0, Math.PI * 2);
      ctx.fill();
      const img = who.avatar_url && getImage ? getImage(who.avatar_url) : null;
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, 17, 0, Math.PI * 2);
        ctx.clip();
        drawThumb(ctx, { x: cx - 17, y: cy - 17, w: 34, h: 34 }, img, item);
        ctx.restore();
      } else {
        ctx.fillStyle = T.onAccent;
        ctx.font = '800 18px ' + t.font.mono;
        ctx.textAlign = 'center';
        ctx.fillText(c.user.charAt(0).toUpperCase(), cx, cy + 1);
        ctx.textAlign = 'left';
      }
      ctx.fillStyle = on ? T.accent : T.ink;
      ctx.font = '800 ' + PILL_FONT + 'px ' + t.font.mono;
      ctx.fillText(c.text, c.x + 56, cy + 1);
    }
    if (p.loc) {
      const on = hover === 'loc:' + i;
      pill(p.loc, on);
      icon(ctx, 'location', p.loc.x + 24, p.loc.y + p.loc.h / 2, 28, on ? T.accent : T.ink);
      ctx.fillStyle = on ? T.accent : T.ink;
      ctx.font = '700 ' + PILL_FONT + 'px ' + t.font.mono;
      ctx.fillText(p.loc.text, p.loc.x + 48, p.loc.y + p.loc.h / 2 + 1);
    }
    // Foot: counts pill, the title box above it.
    const comments = item.comments_count != null ? item.comments_count : (item.comments || []).length;
    const stats = [['like', fmtCount(item.likes), item.liked_by_me], ['eye', fmtCount(item.views)]];
    if (comments > 0) stats.push(['comment', fmtCount(comments)]);
    const sw = stats.reduce((w, s) => w + 36 + monoW(s[1], 22) + 16, 12);
    const sr = { x: r.x + 12, y: r.y + r.h - 56, w: sw, h: 44 };
    pill(sr, false);
    ctx.font = '700 22px ' + t.font.mono;
    let x = sr.x + 12;
    stats.forEach(([name, n, on]) => {
      const ink = on ? T.accent : T.ink;
      if (name === 'eye') drawEye(ctx, x + 14, sr.y + 22, 26, ink);
      else icon(ctx, name, x + 14, sr.y + 22, 28, ink);
      ctx.fillStyle = ink;
      ctx.fillText(n, x + 36, sr.y + 23);
      x += 36 + monoW(n, 22) + 16;
    });
    if (item.title) {
      ctx.font = '700 26px ' + t.font.sans;
      const lines = wrapLines(ctx, item.title, r.w - 48, 2);
      const tw = lines.reduce((w, l) => Math.max(w, ctx.measureText(l).width), 0);
      const tb = { x: r.x + 12, y: sr.y - 8 - (lines.length * 32 + 16), w: Math.min(r.w - 24, tw + 24), h: lines.length * 32 + 16 };
      tile(ctx, tb, 8, 'rgba(18,19,21,0.88)');
      ctx.fillStyle = T.ink;
      lines.forEach((line, k) => ctx.fillText(line, tb.x + 12, tb.y + 8 + 16 + k * 32));
    }
    tile(ctx, r, TILE_C, null, lit ? T.accent : T.rule, lit ? 4 : 2);
  }

  // Tile grid of a grid route, with its scroll rail.
  function renderGrid(ctx, route, hover, getImage) {
    const items = route.items || [];
    const L = gridLayout(route);
    const statusY = L.y + L.h / 2;
    if (route.status === 'loading') { drawStatus(ctx, 'Loading…', statusY); return; }
    if (route.status === 'error') { drawStatus(ctx, "Couldn't load this page", statusY); return; }
    if (!items.length) { drawStatus(ctx, 'Nothing here yet', statusY); return; }
    const first = (route.scroll || 0) * L.cols;
    for (let slot = 0; slot < L.cols * L.rows; slot++) {
      const item = items[first + slot];
      if (!item) break;
      renderTile(ctx, tileRect(L, slot), item, first + slot, hover, getImage);
    }
    renderScrollRail(ctx, route, gridScrollBtns(L), Math.max(0, Math.ceil(items.length / L.cols) - L.rows), hover);
  }

  // Square avatar tile: up to two initials in the user's colour.
  function drawAvatar(ctx, cx, cy, half, user) {
    const t = tokens();
    const u = user || {};
    const color = u.avatar_color || t.hex.accent;
    tile(ctx, { x: cx - half, y: cy - half, w: half * 2, h: half * 2 }, Math.round(half / 4), t.hex.surface2, color, 3);
    const words = String(u.display_name || u.username || '?').trim().split(/\s+/);
    ctx.fillStyle = color;
    ctx.font = '700 ' + Math.round(half * 0.8) + 'px ' + t.font.mono;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(words.slice(0, 2).map((w) => Array.from(w)[0] || '').join('').toUpperCase() || '?', cx, cy + 2);
  }

  // One-line summary of a message for the inbox row.
  function messagePreview(m, participant) {
    if (!m) return 'No messages yet';
    let body = m.text || '';
    if (m.deleted || m.kind === 'deleted') body = 'Message deleted';
    else if (m.kind === 'reel') body = '▶ ' + ((m.post && m.post.title) || 'Shared a reel');
    else if (m.kind === 'pack') body = '▦ ' + ((m.pack && m.pack.title) || 'Shared a pack');
    else if (m.kind === 'gif') body = 'GIF';
    return (participant && m.sender_id !== participant.id ? 'You: ' : '') + body;
  }

  // Avatar-colour edge, square avatar, name and @handle over a preview line, status pill on the right.
  function renderConversationRow(ctx, r, conv, sub, pill, hover) {
    const t = tokens();
    const T = t.hex;
    const p = conv.participant || {};
    tile(ctx, r, 12, hover ? ROW_HOVER : ROW, hover ? T.accent : T.ruleStrong, hover ? 3 : 2);
    ctx.fillStyle = p.avatar_color || T.accent;
    ctx.fillRect(r.x, r.y + 14, 6, r.h - 28);
    const cy = r.y + r.h / 2;
    drawAvatar(ctx, r.x + 80, cy, 40, p);
    const x = r.x + 152;
    const textW = r.w - 152 - 360;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = T.ink;
    ctx.font = '600 38px ' + t.font.sans;
    const name = truncate(ctx, p.display_name || p.username || '?', textW * 0.6);
    ctx.fillText(name, x, cy - 22);
    if (p.username) {
      const nx = x + ctx.measureText(name).width + 20;
      ctx.fillStyle = T.ink3;
      ctx.font = '600 28px ' + t.font.mono;
      ctx.fillText(truncate(ctx, '@' + p.username, x + textW - nx), nx, cy - 20);
    }
    ctx.fillStyle = T.ink2;
    ctx.font = '30px ' + t.font.mono;
    ctx.fillText(truncate(ctx, sub, textW), x, cy + 26);
    if (pill) drawPill(ctx, r.x + r.w - 32, cy, pill.label, pill.style);
  }

  function renderStatus(ctx, route, empty) {
    let text = '';
    if (route.status === 'loading') text = 'Loading…';
    else if (route.status === 'error') text = "Couldn't load this page";
    else if (!(route.items || []).length) text = empty;
    if (text) drawStatus(ctx, text, 620);
    return !!text;
  }

  // Inbox (route.box tabs) and the share sheet: scrolling conversation lists.
  function renderConversationList(ctx, state, hover) {
    const t = tokens();
    const T = t.hex;
    const route = state.route;
    const sharing = route.section === 'share';
    if (sharing) {
      const cy = SEARCH_BAR.y + SEARCH_BAR.h / 2;
      tile(ctx, { x: SEARCH_BAR.x, y: cy - 40, w: 80, h: 80 }, 10, T.surface2, T.accent, 2);
      icon(ctx, 'share', SEARCH_BAR.x + 40, cy, 48, T.ink, T.surface2);
      ctx.fillStyle = T.ink;
      ctx.font = '600 40px ' + t.font.sans;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const what = route.share && route.share.kind === 'pack' ? 'pack' : 'reel';
      ctx.fillText(truncate(ctx, 'Send this ' + what + ' to a chat', SEARCH_BAR.w - 112), SEARCH_BAR.x + 112, cy);
    } else {
      const counts = state.unreadBox || {};
      BOX_TABS.forEach((b, i) => {
        const r = boxTabRect(i);
        drawButton(ctx, r, b.label, { active: (route.box || 'inbox') === b.arg, hover: hover === 'box:' + b.arg });
        if (counts[b.arg]) drawPill(ctx, r.x + r.w - 20, r.y + r.h / 2, counts[b.arg] > 99 ? '99+' : String(counts[b.arg]), 'fill');
      });
    }
    if (renderStatus(ctx, route, sharing ? 'No chats to share to yet' : (route.box === 'requests' ? 'No message requests' : 'No messages yet'))) return;
    const items = route.items || [];
    const first = route.scroll || 0;
    for (let slot = 0; slot < LIST_ROWS; slot++) {
      const conv = items[first + slot];
      if (!conv) break;
      const r = listRowRect(slot);
      let pill = null;
      if (sharing) {
        const sent = (route.sent || {})[conv.id];
        pill = { sending: { label: 'SENDING…' }, sent: { label: 'SENT ✓', style: 'accent' },
          failed: { label: 'RETRY', style: 'accent' } }[sent] || { label: 'SEND', style: 'fill' };
      } else if (conv.unread_count) {
        pill = { label: conv.unread_count + ' NEW', style: 'fill' };
      } else if (conv.is_request) {
        pill = { label: 'REQUEST' };
      }
      const key = sharing ? 'share-to:' + (first + slot) : 'chip:/messages/' + conv.id;
      renderConversationRow(ctx, r, conv, messagePreview(conv.last_message, conv.participant), pill, hover === key);
    }
    renderScrollRail(ctx, route, SCROLL_BTNS, Math.max(0, items.length - LIST_ROWS), hover);
  }

  function bubbleText(m) {
    if (m.deleted || m.kind === 'deleted') return 'Message deleted';
    if (m.kind === 'reel') return '▶ ' + ((m.post && m.post.title) || 'Shared reel');
    if (m.kind === 'pack') return '▦ ' + ((m.pack && m.pack.title) || 'Shared pack');
    if (m.kind === 'gif') return 'GIF';
    return String(m.text || '') + (m.failed ? '  ⚠ not sent' : '');
  }

  function renderThread(ctx, state, hover) {
    const t = tokens();
    const T = t.hex;
    const route = state.route;
    const det = route.detail;
    const f = state.field || {};
    if (det) {
      const p = det.participant || {};
      const cy = SEARCH_BAR.y + SEARCH_BAR.h / 2;
      drawAvatar(ctx, SEARCH_BAR.x + 48, cy, 48, p);
      const x = SEARCH_BAR.x + 128;
      const note = det.is_request ? 'wants to message you' : (det.state === 'pending' ? 'request sent' : '');
      ctx.fillStyle = T.ink;
      ctx.font = '600 40px ' + t.font.sans;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(ctx, p.display_name || p.username || '', 640), x, cy - 18);
      ctx.fillStyle = note ? T.accent : T.ink3;
      ctx.font = '600 26px ' + t.font.mono;
      ctx.fillText(truncate(ctx, note ? note.toUpperCase() : '@' + (p.username || ''), 640), x, cy + 26);
      detailButtons(route).forEach((b) => drawButton(ctx, b, b.label, {
        primary: b.primary, disabled: b.disabled, hover: !b.disabled && hover === b.action,
      }));
    }
    if (!renderStatus(ctx, route, 'No messages yet. Say hi!')) {
      const items = route.items || [];
      const first = route.scroll || 0;
      for (let slot = 0; slot < THREAD_ROWS; slot++) {
        const m = items[first + slot];
        if (!m) break;
        const row = threadRowRect(slot);
        ctx.font = '36px ' + t.font.sans;
        const text = truncate(ctx, bubbleText(m), 1240);
        const w = Math.min(row.w, ctx.measureText(text).width + 64);
        const x = m.mine ? row.x + row.w - w : row.x;
        ctx.globalAlpha = m.pending ? 0.6 : 1;
        tile(ctx, { x, y: row.y, w, h: row.h }, 12, m.mine ? T.accent : T.surface2, m.mine ? null : T.rule, 2);
        ctx.fillStyle = m.mine ? T.onAccent : (m.deleted ? T.inkMuted : T.ink);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + 32, row.y + row.h / 2 + 2);
        ctx.globalAlpha = 1;
      }
      renderScrollRail(ctx, route, THREAD_SCROLL, Math.max(0, items.length - THREAD_ROWS), hover);
    }
    const canMessage = !!(det && det.can_message);
    if (canMessage) {
      QUICK_REPLIES.forEach((q, i) => drawButton(ctx, quickRect(i), q, {
        hover: hover === 'quick-reply:' + q, size: 32, font: t.font.sans, weight: 600,
      }));
    }
    const typing = f.focused && f.id === 'compose';
    let placeholder = 'Message ' + (route.label || '');
    if (det && !canMessage) placeholder = det.state === 'pending' ? 'Waiting for them to accept' : "You can't reply in this chat";
    drawField(ctx, COMPOSE_BAR, typing ? f.text : (route.draft || ''), placeholder, typing, canMessage && hover === 'compose-focus');
    drawButton(ctx, SEND_BTN, 'SEND', {
      primary: canMessage && !!(typing ? f.text : route.draft), disabled: !canMessage,
      hover: canMessage && hover === 'compose-send', size: 36,
    });
  }

  // '+1,000' / '-35'; reserve moves show as (reserved ±n) when available is unchanged.
  function ledgerDelta(e) {
    const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US');
    const a = Number(e.delta_available) || 0;
    const r = Number(e.delta_reserved) || 0;
    if (!a && r) return { text: '(reserved ' + sign(r) + ')', gain: false };
    return { text: sign(a), gain: a > 0 };
  }

  function ledgerLabel(e) {
    return String(e.source || e.type || 'entry').replace(/_/g, ' ').toUpperCase();
  }

  // Caption over value in a dark tile (wallet tool row).
  function statTile(ctx, r, caption, value, valueFont, valueColor) {
    const t = tokens();
    tile(ctx, r, 12, ROW, t.hex.rule, 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = t.hex.ink3;
    ctx.font = '600 22px ' + t.font.mono;
    ctx.fillText(caption, r.x + 24, r.y + 26);
    ctx.fillStyle = valueColor || t.hex.ink;
    ctx.font = valueFont || '700 38px ' + t.font.mono;
    ctx.fillText(truncate(ctx, value, r.w - 48), r.x + 24, r.y + 68);
  }

  // Wallet: balance, stat and reward-progress tiles in the tool row, BUY on the right, ledger rows below.
  function renderWallet(ctx, state, hover) {
    const t = tokens();
    const T = t.hex;
    const route = state.route;
    const w = route.detail;
    const y = SEARCH_BAR.y;
    const h = SEARCH_BAR.h;
    if (w) {
      const bal = { x: 48, y, w: 480, h };
      const balance = (Number(w.available_credits) || 0).toLocaleString('en-US');
      statTile(ctx, bal, 'AVAILABLE', balance, '52px ' + t.font.display, T.accent);
      ctx.strokeStyle = T.accent;
      shape(ctx, bal, 12);
      ctx.stroke();
      ctx.font = '52px ' + t.font.display;
      const bx = bal.x + 24 + Math.min(ctx.measureText(balance).width, bal.w - 48) + 20;
      ctx.fillStyle = T.ink2;
      ctx.font = '700 26px ' + t.font.mono;
      if (bx + ctx.measureText('CREDITS').width < bal.x + bal.w - 20) ctx.fillText('CREDITS', bx, y + 74);
      statTile(ctx, { x: 544, y, w: 200, h }, 'RESERVED', fmtCount(w.reserved_credits));
      statTile(ctx, { x: 760, y, w: 200, h }, 'EARNED', fmtCount(w.lifetime_earned));
      statTile(ctx, { x: 976, y, w: 200, h }, 'SPENT', fmtCount(w.lifetime_spent));
      const r = state.rewards;
      if (r) {
        const p = { x: 1192, y, w: 412, h };
        tile(ctx, p, 12, ROW, T.rule, 2);
        ctx.textAlign = 'left';
        ctx.fillStyle = T.ink3;
        ctx.font = '600 22px ' + t.font.mono;
        ctx.fillText(truncate(ctx, 'REELS · ' + (r.capped ? 'DAILY CAP REACHED' : r.progress + '/10 TO NEXT CREDIT'), p.w - 48), p.x + 24, y + 26);
        const segW = (p.w - 48 - 9 * 6) / 10;
        for (let i = 0; i < 10; i++) {
          ctx.fillStyle = r.capped || i < r.progress ? T.accent : T.surface3;
          ctx.fillRect(p.x + 24 + i * (segW + 6), y + 56, segW, 24);
        }
      }
    }
    detailButtons(route).forEach((b) => drawButton(ctx, b, b.label, { primary: b.primary, hover: hover === b.action }));
    if (renderStatus(ctx, route, 'No credit activity yet')) return;
    const items = route.items || [];
    const first = route.scroll || 0;
    for (let slot = 0; slot < LIST_ROWS; slot++) {
      const e = items[first + slot];
      if (!e) break;
      const r = listRowRect(slot);
      const delta = ledgerDelta(e);
      const cy = r.y + r.h / 2;
      tile(ctx, r, 12, ROW, T.ruleStrong, 2);
      ctx.fillStyle = delta.gain ? T.accent : T.ruleStrong;
      ctx.fillRect(r.x, r.y + 14, 6, r.h - 28);
      tile(ctx, { x: r.x + 36, y: cy - 36, w: 72, h: 72 }, 10, T.surface2, T.rule, 2);
      icon(ctx, 'credits', r.x + 72, cy, 44, delta.gain ? T.ink : T.ink2, T.surface2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = T.ink;
      ctx.font = '600 36px ' + t.font.sans;
      ctx.fillText(truncate(ctx, ledgerLabel(e), r.w - 720), r.x + 136, cy - 20);
      ctx.fillStyle = T.ink3;
      ctx.font = '28px ' + t.font.mono;
      ctx.fillText(String(e.created_at || '').slice(0, 10), r.x + 136, cy + 24);
      ctx.textAlign = 'right';
      ctx.fillStyle = delta.gain ? T.accent : T.ink;
      ctx.font = '700 44px ' + t.font.mono;
      ctx.fillText(delta.text, r.x + r.w - 32, cy - 14);
      ctx.fillStyle = T.inkMuted;
      ctx.font = '600 24px ' + t.font.mono;
      ctx.fillText('BALANCE ' + (Number(e.balance_available) || 0).toLocaleString('en-US'), r.x + r.w - 32, cy + 30);
    }
    renderScrollRail(ctx, route, SCROLL_BTNS, Math.max(0, items.length - LIST_ROWS), hover);
  }

  // Sections without a body yet show their icon, a status line and the route.
  function renderSectionBody(ctx, state) {
    const T = tokens().hex;
    const route = state.route || {};
    const cx = MAIN_W / 2;
    const cy = MAIN_H / 2 - 120;
    tile(ctx, { x: cx - 60, y: cy - 60, w: 120, h: 120 }, 16, T.surface2, T.accent, 2);
    icon(ctx, SECTION_ICONS[route.section] || 'logo', cx, cy, 68, T.ink, T.surface2);
    drawStatus(ctx, 'Coming to VR soon', MAIN_H / 2 + 20);
    if (route.path) pathPill(ctx, cx, MAIN_H / 2 + 116, route.path);
  }

  // getImage(url) → a loaded image or null (the host owns loading and caching).
  function renderMainPanel(ctx, state, hover, getImage) {
    const t = tokens();
    const s = state || {};
    ctx.clearRect(0, 0, MAIN_W, MAIN_H);
    ctx.fillStyle = 'rgba(13,14,15,0.97)';
    ctx.fillRect(0, 0, MAIN_W, MAIN_H);
    ctx.strokeStyle = t.hex.ruleStrong;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, MAIN_W - 3, MAIN_H - 3);
    if (s.handoff) {
      renderHeader(ctx, 'OPEN IN 2D', '', hover, 'exit');
      renderHandoffCard(ctx, s.handoff, hover);
      return;
    }
    const route = s.route || {};
    const section = route.section;
    renderHeader(ctx, SECTION_TITLES[section] || 'ECHO', route.label || route.arg || '', hover, SECTION_ICONS[section]);
    if (section === 'messages' || section === 'share') { renderConversationList(ctx, s, hover); return; }
    if (section === 'thread') { renderThread(ctx, s, hover); return; }
    if (section === 'wallet') { renderWallet(ctx, s, hover); return; }
    if (!GRID_SECTIONS[section]) { renderSectionBody(ctx, s); return; }
    if (section === 'explore' || section === 'search') renderSearchBar(ctx, route, s.field, hover);
    else if (section === 'profile') renderProfile(ctx, route, hover, getImage);
    else if (section === 'pack') renderDetailRow(ctx, route, hover);
    else renderChips(ctx, route.related, hover);
    renderGrid(ctx, route, hover, getImage);
  }

  function resolveMainHit(state, x, y) {
    if (inRect(CLOSE_BTN, x, y)) return { action: 'close' };
    if (state && state.handoff) {
      const b = HANDOFF_BTNS.find((r) => inRect(r, x, y));
      return b ? { action: b.action } : null;
    }
    const route = state && state.route;
    if (route && (route.section === 'messages' || route.section === 'share')) return resolveListHit(route, x, y);
    if (route && route.section === 'thread') return resolveThreadHit(route, x, y);
    if (route && route.section === 'wallet') {
      if (detailButtons(route).some((b) => inRect(b, x, y))) return { action: 'buy' };
      const sb = SCROLL_BTNS.find((r) => inRect(r, x, y));
      return sb ? { action: 'scroll', arg: sb.arg } : null;
    }
    if (!route || !GRID_SECTIONS[route.section]) return null;
    if (route.section === 'explore' || route.section === 'search') {
      if (inRect(SEARCH_BAR, x, y)) return { action: 'search-focus' };
    } else if (route.section === 'profile' || route.section === 'pack') {
      const b = detailButtons(route).find((r) => inRect(r, x, y));
      if (b) return b.disabled ? null : (b.arg === undefined ? { action: b.action } : { action: b.action, arg: b.arg });
      const chip = route.section === 'pack' && (route.related || [])[0];
      if (chip && inRect(chipRect(0), x, y)) return { action: 'chip', arg: chip.path };
      if (route.section === 'profile') {
        const tag = profileLayout(route).tags.find((r) => inRect(r, x, y));
        if (tag) return { action: 'chip', arg: tagPath(tag.tag) };
        const hl = highlightRects(route).find((r) => inRect(r, x, y));
        if (hl) return { action: 'chip', arg: hl.path };
      }
    } else {
      const related = (route.related || []).slice(0, CHIP_MAX);
      const i = related.findIndex((c, k) => inRect(chipRect(k), x, y));
      if (i >= 0) return { action: 'chip', arg: related[i].path };
    }
    const L = gridLayout(route);
    const sb = gridScrollBtns(L).find((r) => inRect(r, x, y));
    if (sb) return { action: 'scroll', arg: sb.arg };
    const items = route.items || [];
    for (let slot = 0; slot < L.cols * L.rows; slot++) {
      const r = tileRect(L, slot);
      if (!inRect(r, x, y)) continue;
      const i = (route.scroll || 0) * L.cols + slot;
      return i < items.length ? tileHit(r, items[i], i, x, y) : null;
    }
    return null;
  }

  function resolveListHit(route, x, y) {
    if (route.section === 'messages') {
      const tab = BOX_TABS.find((b, i) => inRect(boxTabRect(i), x, y));
      if (tab) return { action: 'box', arg: tab.arg };
    }
    const sb = SCROLL_BTNS.find((r) => inRect(r, x, y));
    if (sb) return { action: 'scroll', arg: sb.arg };
    const items = route.items || [];
    for (let slot = 0; slot < LIST_ROWS; slot++) {
      if (!inRect(listRowRect(slot), x, y)) continue;
      const i = (route.scroll || 0) + slot;
      if (i >= items.length) return null;
      return route.section === 'share' ? { action: 'share-to', arg: i } : { action: 'chip', arg: '/messages/' + items[i].id };
    }
    return null;
  }

  function resolveThreadHit(route, x, y) {
    const det = route.detail;
    const b = detailButtons(route).find((r) => inRect(r, x, y));
    if (b) return b.disabled ? null : { action: b.action };
    const sb = THREAD_SCROLL.find((r) => inRect(r, x, y));
    if (sb) return { action: 'scroll', arg: sb.arg };
    if (!det || !det.can_message) return null;
    const q = QUICK_REPLIES.findIndex((label, i) => inRect(quickRect(i), x, y));
    if (q >= 0) return { action: 'quick-reply', arg: QUICK_REPLIES[q] };
    if (inRect(COMPOSE_BAR, x, y)) return { action: 'compose-focus' };
    if (inRect(SEND_BTN, x, y)) return { action: 'compose-send' };
    return null;
  }

  // Laser keyboard (own panel, shown while a field is focused). A strip on top
  // echoes the field, since the keyboard sits over the main panel's field.
  const KB_W = 1280;
  const KB_H = 576;
  const KB_STRIP = 96;
  const KB_GAP = 12;
  const KB_KEY_W = (KB_W - KB_GAP * 11) / 10;
  const KB_KEY_H = (KB_H - KB_STRIP - KB_GAP * 5) / 4;
  const KB_BG = 'rgba(13,14,15,0.97)';
  const KB_LABELS = { backspace: '⌫', space: 'SPACE', enter: 'ENTER', close: 'HIDE', shift: '⇧' };
  const KB_LAYOUTS = {
    alpha: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
    symbols: ['1234567890', '@#$%&-+()', '!?,.\'":'],
    emoji: ['😀😂😍🥰😎🤔😮😢😡👍', '👏🙏🔥💯🎉💜👀🙌😅', '🤩😴🤯🥳💀🌍✨'],
  };

  // Keys for the field's layout; letters show upper case while shift is on.
  function keyboardRects(field) {
    const f = field || {};
    const layout = KB_LAYOUTS[f.layout] ? f.layout : 'alpha';
    const rows = KB_LAYOUTS[layout].map((r) => Array.from(r));
    const out = [];
    const unit = KB_KEY_W + KB_GAP;
    const rowY = (r) => KB_STRIP + KB_GAP + r * (KB_KEY_H + KB_GAP);
    const key = (id, label, x, row, w) => out.push({ id, label, x, y: rowY(row), w, h: KB_KEY_H });
    rows[0].forEach((c, i) => key(c, c, KB_GAP + i * unit, 0, KB_KEY_W));
    rows[1].forEach((c, i) => key(c, c, KB_GAP + unit / 2 + i * unit, 1, KB_KEY_W));
    key('shift', KB_LABELS.shift, KB_GAP, 2, 1.5 * unit - KB_GAP);
    rows[2].forEach((c, i) => key(c, c, KB_GAP + 1.5 * unit + i * unit, 2, KB_KEY_W));
    const bsX = KB_GAP + 1.5 * unit + rows[2].length * unit;
    key('backspace', KB_LABELS.backspace, bsX, 2, KB_W - KB_GAP - bsX);
    const symbolsKey = layout === 'symbols' ? ['layout:alpha', 'ABC'] : ['layout:symbols', '?123'];
    const emojiKey = layout === 'emoji' ? ['layout:alpha', 'ABC'] : ['layout:emoji', '☺'];
    let x = KB_GAP;
    [['close', KB_LABELS.close, 1.5], [symbolsKey[0], symbolsKey[1], 1.5], [emojiKey[0], emojiKey[1], 1.5],
      ['space', KB_LABELS.space, 3.5]].forEach(([id, label, u]) => { key(id, label, x, 3, u * unit - KB_GAP); x += u * unit; });
    key('enter', KB_LABELS.enter, x, 3, KB_W - KB_GAP - x);
    if (layout === 'alpha') out.forEach((k) => { if (k.id.length === 1) k.label = f.shift ? k.id.toUpperCase() : k.id; });
    return out;
  }

  // Dock-style keys: letters in sans, function keys quieter in mono caps, ENTER in accent.
  function renderKeyboard(ctx, hover, field) {
    const t = tokens();
    const shift = !!(field && field.shift);
    const emoji = !!(field && field.layout === 'emoji');
    ctx.clearRect(0, 0, KB_W, KB_H);
    ctx.fillStyle = KB_BG;
    ctx.fillRect(0, 0, KB_W, KB_H);
    ctx.strokeStyle = t.hex.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, KB_W - 2, KB_H - 2);
    renderKeyboardField(ctx, field);
    keyboardRects(field).forEach((k) => {
      const fn = k.id in KB_LABELS || k.id.indexOf('layout:') === 0;
      let size = emoji ? 44 : 48;
      if (fn) size = Array.from(k.label).length > 1 ? 28 : 40;
      drawButton(ctx, k, k.label, {
        primary: k.id === 'enter', active: k.id === 'shift' && shift, quiet: fn,
        hover: hover === 'key:' + k.id, size, font: fn ? t.font.mono : t.font.sans, weight: fn ? 700 : 600,
      });
    });
  }

  // Repaints just the strip, inside the border and above the keys: all a
  // keystroke changes on a keyboard renderKeyboard already drew.
  function renderKeyboardField(ctx, field) {
    const h = KB_STRIP + KB_GAP / 2 - 2;
    ctx.clearRect(2, 2, KB_W - 4, h);
    ctx.fillStyle = KB_BG;
    ctx.fillRect(2, 2, KB_W - 4, h);
    drawField(ctx, { x: KB_GAP, y: KB_GAP, w: KB_W - KB_GAP * 2, h: KB_STRIP - KB_GAP },
      field && field.text, '', true, false, 28);
  }

  function resolveKeyboardHit(x, y, field) {
    const k = keyboardRects(field).find((r) => inRect(r, x, y));
    return k ? { action: 'key', arg: k.id } : null;
  }

  // Hover key for a hit, matching the hover argument the renderers take.
  // A hit may name its own (tile pills share the 'chip' action).
  function hoverKey(hit) {
    if (!hit) return '';
    if (hit.hover) return hit.hover;
    if (hit.action === 'nav') return hit.arg;
    return hit.arg === undefined ? hit.action : hit.action + ':' + hit.arg;
  }

  return {
    MAIN_W,
    MAIN_H,
    NAV_W,
    NAV_H,
    NAV_ITEMS,
    navRects,
    renderNavBar,
    resolveNavHit,
    GRID_COLS,
    GRID_ROWS,
    KB_W,
    KB_H,
    renderMainPanel,
    resolveMainHit,
    gridLayout,
    tileRect,
    detailButtons,
    thumbUrl,
    keyboardRects,
    renderKeyboard,
    renderKeyboardField,
    LIST_ROWS,
    listRowRect,
    threadRowRect,
    quickRect,
    COMPOSE_BAR,
    SEND_BTN,
    QUICK_REPLIES,
    resolveKeyboardHit,
    hoverKey,
  };
});
