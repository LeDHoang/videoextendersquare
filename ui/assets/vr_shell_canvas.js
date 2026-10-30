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
      ruleStrong: '#3a4047', ink: '#f2f3f5', ink2: '#a4abb3', inkMuted: '#646b74', accent: '#ff3b1f',
      onAccent: '#0a0a0a' },
    font: { display: "'Archivo Black', Archivo, sans-serif", sans: 'Archivo, ui-sans-serif, system-ui, sans-serif',
      mono: "'JetBrains Mono', ui-monospace, Menlo, monospace" },
  };
  function tokens() {
    const ui = typeof window !== 'undefined' && window.VRUICanvas;
    return (ui && ui.TOKENS) || FALLBACK;
  }

  // Nav bar tabs, left to right. 'back' and 'reels' are shell actions, the rest open sections.
  const NAV_ITEMS = [
    { id: 'back', label: '‹ BACK' },
    { id: 'reels', label: 'REELS' },
    { id: 'explore', label: 'EXPLORE' },
    { id: 'messages', label: 'MESSAGES' },
    { id: 'wallet', label: 'CREDITS' },
    { id: 'profile', label: 'PROFILE' },
  ];
  const NAV_PAD = 16;
  function navRects() {
    const w = (NAV_W - NAV_PAD * (NAV_ITEMS.length + 1)) / NAV_ITEMS.length;
    return NAV_ITEMS.map((item, i) => ({
      id: item.id, label: item.label, x: NAV_PAD + i * (w + NAV_PAD), y: NAV_PAD, w, h: NAV_H - NAV_PAD * 2,
    }));
  }

  // Main panel chrome (canvas px).
  const HEADER_H = 120;
  const CLOSE_BTN = { x: MAIN_W - 120 - 32, y: 20, w: 120, h: 80 };
  const HANDOFF_BTNS = [
    { action: 'handoff-confirm', label: 'EXIT VR & OPEN', x: MAIN_W / 2 - 520, y: 760, w: 500, h: 120 },
    { action: 'handoff-cancel', label: 'STAY IN VR', x: MAIN_W / 2 + 20, y: 760, w: 500, h: 120 },
  ];

  // Explore-style sections: a tool row (search bar or chips) above a scrolling card grid.
  const GRID_SECTIONS = { explore: 1, search: 1, tag: 1, location: 1, profile: 1, pack: 1 };
  const GRID_COLS = 5;
  const GRID_ROWS = 2;
  const GRID_TOP = 280;
  const GRID_GAP = 24;
  const CARD_H = 400;
  const CARD_W = (MAIN_W - 48 - 168 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
  const SEARCH_BAR = { x: 48, y: 148, w: MAIN_W - 216, h: 104 };
  const CHIP_W = 290;
  const CHIP_MAX = 6;
  const SCROLL_BTNS = [
    { arg: -1, label: '▲', x: MAIN_W - 144, y: GRID_TOP, w: 96, h: CARD_H },
    { arg: 1, label: '▼', x: MAIN_W - 144, y: GRID_TOP + CARD_H + GRID_GAP, w: 96, h: CARD_H },
  ];

  function cardRect(slot) {
    const col = slot % GRID_COLS;
    const row = Math.floor(slot / GRID_COLS);
    return { x: 48 + col * (CARD_W + GRID_GAP), y: GRID_TOP + row * (CARD_H + GRID_GAP), w: CARD_W, h: CARD_H };
  }

  function chipRect(i) {
    return { x: 48 + i * (CHIP_W + 16), y: SEARCH_BAR.y, w: CHIP_W, h: SEARCH_BAR.h };
  }

  // Profile/pack action buttons, right-aligned in the tool row. Empty until the detail loads.
  const DETAIL_BTN_W = 260;
  function detailButtons(route) {
    const det = route && route.detail;
    if (!det) return [];
    const k = (n) => fmtCount(n);
    let btns = [];
    if (route.section === 'profile' && !det.is_me) {
      btns = [{ action: 'follow', label: det.is_following ? 'FOLLOWING' : 'FOLLOW', primary: !det.is_following }];
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
    pack: 'PACK', messages: 'MESSAGES', thread: 'CHAT', wallet: 'CREDITS', rewards: 'REWARDS',
  };

  function inRect(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  function drawButton(ctx, r, label, opts) {
    const t = tokens();
    const o = opts || {};
    ctx.fillStyle = o.primary ? t.hex.accent : (o.active ? t.hex.surface3 : t.hex.surface2);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (o.hover) {
      ctx.strokeStyle = t.hex.ink;
      ctx.lineWidth = 4;
      ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
    }
    if (o.active && !o.primary) {
      ctx.fillStyle = t.hex.accent;
      ctx.fillRect(r.x, r.y + r.h - 8, r.w, 8);
    }
    ctx.fillStyle = o.primary ? t.hex.onAccent : (o.disabled ? t.hex.inkMuted : t.hex.ink);
    ctx.font = (o.size || 40) + 'px ' + t.font.display;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 2);
  }

  // state: VRShell getRenderState(); hover: nav item id or ''.
  function renderNavBar(ctx, state, hover) {
    const t = tokens();
    const s = state || {};
    ctx.clearRect(0, 0, NAV_W, NAV_H);
    ctx.fillStyle = t.hex.bg;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(0, 0, NAV_W, NAV_H);
    ctx.globalAlpha = 1;
    navRects().forEach((r) => {
      const active = r.id === 'reels' ? !s.open : s.open && s.tab === r.id;
      const disabled = r.id === 'back' && !s.open;
      drawButton(ctx, r, r.label, { active, hover: hover === r.id && !disabled, disabled, size: 38 });
    });
  }

  function resolveNavHit(x, y) {
    const r = navRects().find((rect) => inRect(rect, x, y));
    return r ? { action: 'nav', arg: r.id } : null;
  }

  function renderHeader(ctx, title, subtitle, hover) {
    const t = tokens();
    ctx.fillStyle = t.hex.surface;
    ctx.fillRect(0, 0, MAIN_W, HEADER_H);
    ctx.fillStyle = t.hex.accent;
    ctx.fillRect(0, HEADER_H - 6, MAIN_W, 6);
    ctx.fillStyle = t.hex.ink;
    ctx.font = '64px ' + t.font.display;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 48, HEADER_H / 2);
    if (subtitle) {
      const titleW = ctx.measureText(title).width;
      ctx.fillStyle = t.hex.ink2;
      ctx.font = '36px ' + t.font.mono;
      ctx.fillText(subtitle, 48 + titleW + 32, HEADER_H / 2 + 4);
    }
    drawButton(ctx, CLOSE_BTN, '✕', { hover: hover === 'close', size: 48 });
  }

  function renderHandoffCard(ctx, handoff, hover) {
    const t = tokens();
    ctx.fillStyle = t.hex.ink;
    ctx.font = '80px ' + t.font.display;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(handoff.title || 'FINISH ON 2D', MAIN_W / 2, 360);
    ctx.fillStyle = t.hex.ink2;
    ctx.font = '44px ' + t.font.sans;
    ctx.fillText(handoff.message || 'This page needs the 2D site.', MAIN_W / 2, 480);
    ctx.fillStyle = t.hex.inkMuted;
    ctx.font = '36px ' + t.font.mono;
    ctx.fillText(handoff.path || '', MAIN_W / 2, 560);
    HANDOFF_BTNS.forEach((b) => drawButton(ctx, b, b.label, {
      primary: b.action === 'handoff-confirm', hover: hover === b.action, size: 44,
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

  function renderSearchBar(ctx, route, field, hover) {
    const t = tokens();
    const f = field || {};
    const r = SEARCH_BAR;
    ctx.fillStyle = t.hex.surface2;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = f.focused ? t.hex.accent : (hover === 'search-focus' ? t.hex.ink : t.hex.rule);
    ctx.lineWidth = 4;
    ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
    const query = f.focused ? f.text + '|' : (route.section === 'search' ? route.arg : '');
    ctx.fillStyle = query ? t.hex.ink : t.hex.inkMuted;
    ctx.font = '44px ' + t.font.sans;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, query || '⌕  Search reels, tags, places', r.w - 64), r.x + 32, r.y + r.h / 2);
  }

  function renderChips(ctx, related, hover) {
    (related || []).slice(0, CHIP_MAX).forEach((c, i) => {
      drawButton(ctx, chipRect(i), truncate(ctx, c.label, CHIP_W - 40), { hover: hover === 'chip:' + c.path, size: 32 });
    });
  }

  // Profile: avatar initials, name and counts. Pack: creator chip and counts. Buttons on the right.
  function renderDetailRow(ctx, route, hover) {
    const t = tokens();
    const det = route.detail;
    if (!det) return;
    const btns = detailButtons(route);
    const textRight = btns.length ? btns[0].x - 32 : SEARCH_BAR.x + SEARCH_BAR.w;
    let x = SEARCH_BAR.x;
    const cy = SEARCH_BAR.y + SEARCH_BAR.h / 2;
    let stats;
    if (route.section === 'profile') {
      ctx.fillStyle = det.avatar_color || t.hex.accent;
      ctx.beginPath();
      ctx.arc(x + 52, cy, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = t.hex.onAccent;
      ctx.font = '48px ' + t.font.display;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(det.display_name || det.username || '?').slice(0, 1).toUpperCase(), x + 52, cy + 2);
      x += 136;
      ctx.fillStyle = t.hex.ink;
      ctx.font = '44px ' + t.font.sans;
      ctx.textAlign = 'left';
      ctx.fillText(truncate(ctx, det.display_name || det.username, 520), x, cy);
      x += Math.min(520, ctx.measureText(det.display_name || det.username || '').width) + 40;
      stats = fmtCount(det.post_count) + ' POSTS  ·  ' + fmtCount(det.follower_count) + ' FOLLOWERS  ·  '
        + fmtCount(det.following_count) + ' FOLLOWING';
    } else {
      const chip = (route.related || [])[0];
      if (chip) {
        drawButton(ctx, chipRect(0), truncate(ctx, chip.label, CHIP_W - 40), { hover: hover === 'chip:' + chip.path, size: 32 });
        x += CHIP_W + 40;
      }
      stats = fmtCount(det.playable_count != null ? det.playable_count : (route.items || []).length) + ' REELS  ·  '
        + fmtCount(det.views) + ' VIEWS';
    }
    ctx.fillStyle = t.hex.ink2;
    ctx.font = '32px ' + t.font.mono;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, stats, Math.max(0, textRight - x)), x, cy + 2);
    btns.forEach((b) => drawButton(ctx, b, b.label, {
      primary: b.primary, active: b.active, disabled: b.disabled, size: 36,
      hover: !b.disabled && hover === (b.arg === undefined ? b.action : b.action + ':' + b.arg),
    }));
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
    ctx.font = '96px ' + t.font.display;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, r.x + r.w / 2, r.y + r.h / 2);
  }

  function renderGrid(ctx, route, hover, getImage) {
    const t = tokens();
    const items = route.items || [];
    if (route.status === 'loading') { centerText(ctx, 'Loading…', 680, '52px ' + t.font.sans, t.hex.ink2); return; }
    if (route.status === 'error') { centerText(ctx, "Couldn't load this page", 680, '52px ' + t.font.sans, t.hex.ink2); return; }
    if (!items.length) { centerText(ctx, 'Nothing here yet', 680, '52px ' + t.font.sans, t.hex.ink2); return; }
    const first = (route.scroll || 0) * GRID_COLS;
    for (let slot = 0; slot < GRID_COLS * GRID_ROWS; slot++) {
      const i = first + slot;
      const item = items[i];
      if (!item) break;
      const r = cardRect(slot);
      const url = thumbUrl(item);
      drawThumb(ctx, { x: r.x, y: r.y, w: r.w, h: 290 }, url && getImage ? getImage(url) : null, item);
      if (item.media_type === 'video') {
        ctx.fillStyle = t.hex.ink;
        ctx.font = '40px ' + t.font.sans;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('▶', r.x + 16, r.y + 14);
      }
      ctx.fillStyle = t.hex.surface;
      ctx.fillRect(r.x, r.y + 290, r.w, r.h - 290);
      ctx.fillStyle = t.hex.ink;
      ctx.font = '34px ' + t.font.sans;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(ctx, item.title || 'Untitled', r.w - 32), r.x + 16, r.y + 330);
      ctx.fillStyle = t.hex.ink2;
      ctx.font = '28px ' + t.font.mono;
      ctx.fillText(truncate(ctx, item.author_name ? '@' + item.author_name : '', r.w - 32), r.x + 16, r.y + 372);
      if (hover === 'play:' + i) {
        ctx.strokeStyle = t.hex.accent;
        ctx.lineWidth = 8;
        ctx.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
      }
    }
    const maxScroll = Math.max(0, Math.ceil(items.length / GRID_COLS) - GRID_ROWS);
    SCROLL_BTNS.forEach((b) => {
      const disabled = b.arg < 0 ? !route.scroll : (route.scroll || 0) >= maxScroll;
      drawButton(ctx, b, b.label, { hover: !disabled && hover === 'scroll:' + b.arg, disabled, size: 48 });
    });
  }

  // Sections without a body yet show a labelled placeholder.
  function renderSectionBody(ctx, state) {
    const t = tokens();
    ctx.fillStyle = t.hex.ink2;
    ctx.font = '52px ' + t.font.sans;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Coming to VR soon', MAIN_W / 2, MAIN_H / 2);
    ctx.fillStyle = t.hex.inkMuted;
    ctx.font = '36px ' + t.font.mono;
    ctx.fillText((state.route && state.route.path) || '', MAIN_W / 2, MAIN_H / 2 + 80);
  }

  // getImage(url) → a loaded image or null (the host owns loading and caching).
  function renderMainPanel(ctx, state, hover, getImage) {
    const t = tokens();
    const s = state || {};
    ctx.clearRect(0, 0, MAIN_W, MAIN_H);
    ctx.fillStyle = t.hex.bg;
    ctx.globalAlpha = 0.96;
    ctx.fillRect(0, 0, MAIN_W, MAIN_H);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = t.hex.ruleStrong;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, MAIN_W - 4, MAIN_H - 4);
    if (s.handoff) {
      renderHeader(ctx, 'OPEN IN 2D', '', hover);
      renderHandoffCard(ctx, s.handoff, hover);
      return;
    }
    const route = s.route || {};
    const section = route.section;
    renderHeader(ctx, SECTION_TITLES[section] || 'ECHO', route.label || route.arg || '', hover);
    if (!GRID_SECTIONS[section]) { renderSectionBody(ctx, s); return; }
    if (section === 'explore' || section === 'search') renderSearchBar(ctx, route, s.field, hover);
    else if (section === 'profile' || section === 'pack') renderDetailRow(ctx, route, hover);
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
    if (!route || !GRID_SECTIONS[route.section]) return null;
    if (route.section === 'explore' || route.section === 'search') {
      if (inRect(SEARCH_BAR, x, y)) return { action: 'search-focus' };
    } else if (route.section === 'profile' || route.section === 'pack') {
      const b = detailButtons(route).find((r) => inRect(r, x, y));
      if (b) return b.disabled ? null : (b.arg === undefined ? { action: b.action } : { action: b.action, arg: b.arg });
      const chip = route.section === 'pack' && (route.related || [])[0];
      if (chip && inRect(chipRect(0), x, y)) return { action: 'chip', arg: chip.path };
    } else {
      const related = (route.related || []).slice(0, CHIP_MAX);
      const i = related.findIndex((c, k) => inRect(chipRect(k), x, y));
      if (i >= 0) return { action: 'chip', arg: related[i].path };
    }
    const sb = SCROLL_BTNS.find((r) => inRect(r, x, y));
    if (sb) return { action: 'scroll', arg: sb.arg };
    const items = route.items || [];
    for (let slot = 0; slot < GRID_COLS * GRID_ROWS; slot++) {
      if (!inRect(cardRect(slot), x, y)) continue;
      const i = (route.scroll || 0) * GRID_COLS + slot;
      return i < items.length ? { action: 'play', arg: i } : null;
    }
    return null;
  }

  // Laser keyboard (own panel, shown while a field is focused).
  const KB_W = 1280;
  const KB_H = 480;
  const KB_GAP = 12;
  const KB_KEY_W = (KB_W - KB_GAP * 11) / 10;
  const KB_KEY_H = (KB_H - KB_GAP * 5) / 4;
  const KB_LABELS = { backspace: '⌫', space: 'SPACE', enter: 'ENTER', close: 'HIDE' };

  function keyboardRects() {
    const out = [];
    const unit = KB_KEY_W + KB_GAP;
    const rowY = (r) => KB_GAP + r * (KB_KEY_H + KB_GAP);
    const letters = (row, chars, x0) => chars.split('').forEach((c, i) => {
      out.push({ id: c, label: c.toUpperCase(), x: x0 + i * unit, y: rowY(row), w: KB_KEY_W, h: KB_KEY_H });
    });
    letters(0, 'qwertyuiop', KB_GAP);
    letters(1, 'asdfghjkl', KB_GAP + unit / 2);
    letters(2, 'zxcvbnm', KB_GAP + unit / 2);
    const bsX = KB_GAP + unit / 2 + 7 * unit;
    out.push({ id: 'backspace', x: bsX, y: rowY(2), w: KB_W - KB_GAP - bsX, h: KB_KEY_H });
    out.push({ id: 'close', x: KB_GAP, y: rowY(3), w: 2 * unit - KB_GAP, h: KB_KEY_H });
    out.push({ id: 'space', x: KB_GAP + 2 * unit, y: rowY(3), w: 6 * unit - KB_GAP, h: KB_KEY_H });
    out.push({ id: 'enter', x: KB_GAP + 8 * unit, y: rowY(3), w: KB_W - KB_GAP * 2 - 8 * unit, h: KB_KEY_H });
    out.forEach((k) => { if (!k.label) k.label = KB_LABELS[k.id]; });
    return out;
  }

  function renderKeyboard(ctx, hover) {
    const t = tokens();
    ctx.clearRect(0, 0, KB_W, KB_H);
    ctx.fillStyle = t.hex.bg;
    ctx.globalAlpha = 0.94;
    ctx.fillRect(0, 0, KB_W, KB_H);
    ctx.globalAlpha = 1;
    keyboardRects().forEach((k) => drawButton(ctx, k, k.label, {
      primary: k.id === 'enter', hover: hover === 'key:' + k.id, size: k.id.length > 1 ? 36 : 48,
    }));
  }

  function resolveKeyboardHit(x, y) {
    const k = keyboardRects().find((r) => inRect(r, x, y));
    return k ? { action: 'key', arg: k.id } : null;
  }

  // Hover key for a hit, matching the hover argument the renderers take.
  function hoverKey(hit) {
    if (!hit) return '';
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
    cardRect,
    detailButtons,
    thumbUrl,
    keyboardRects,
    renderKeyboard,
    resolveKeyboardHit,
    hoverKey,
  };
});
