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

  // Nav bar tabs, left to right, after the ECHO mark. 'back' and 'reels' are
  // shell actions, the rest open sections. icon: a VRUICanvas dock icon.
  const NAV_ITEMS = [
    { id: 'back', label: 'BACK', icon: 'back' },
    { id: 'reels', label: 'REELS', icon: 'reels' },
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
    } else if (route.section === 'thread' && det.can_accept) {
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
  // Drawn as a strip of the reels dock: glass surface, vermilion rule,
  // chamfered icon tiles with mono captions (VRUICanvas renderControlsCanvas).
  function renderNavBar(ctx, state, hover) {
    const t = tokens();
    const T = t.hex;
    const ui = typeof window !== 'undefined' && window.VRUICanvas;
    const s = state || {};
    ctx.clearRect(0, 0, NAV_W, NAV_H);
    ctx.fillStyle = T.surface;
    ctx.fillRect(0, 0, NAV_W, NAV_H);
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, NAV_W - 2, NAV_H - 2);
    if (ui && ui.drawIcon) ui.drawIcon(ctx, 'logo', 60, NAV_H / 2, 52, T.ink, T.accent, T.surface);
    ctx.fillStyle = T.ink;
    ctx.font = '900 30px ' + (t.font.brand || t.font.display);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('ECHO', 98, NAV_H / 2 + 1);
    navRects().forEach((r) => {
      const active = r.id === 'reels' ? !s.open : s.open && s.tab === r.id;
      const disabled = r.id === 'back' && !s.open;
      const lit = active || (hover === r.id && !disabled);
      if (ui && ui.chamferPath) ui.chamferPath(ctx, r.x, r.y, r.w, r.h, 12);
      else { ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); }
      ctx.globalAlpha = disabled ? 0.35 : 1;
      ctx.fillStyle = lit ? T.surface3 : T.surface2;
      ctx.fill();
      ctx.strokeStyle = lit ? T.accent : T.rule;
      ctx.lineWidth = 2;
      ctx.stroke();
      const ink = lit ? T.ink : T.ink2;
      if (ui && ui.drawIcon) ui.drawIcon(ctx, r.icon, r.x + r.w / 2, r.y + 44, 44, ink, T.accent, lit ? T.surface3 : T.surface2);
      ctx.fillStyle = ink;
      ctx.font = 'bold 18px ' + t.font.mono;
      ctx.textAlign = 'center';
      ctx.fillText(r.label, r.x + r.w / 2, r.y + r.h - 22);
      if (active) {
        ctx.fillStyle = T.accent;
        ctx.fillRect(r.x + r.w / 2 - 24, r.y + r.h - 6, 48, 4);
      }
      ctx.globalAlpha = 1;
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

  function drawAvatar(ctx, cx, cy, radius, user) {
    const t = tokens();
    const u = user || {};
    ctx.fillStyle = u.avatar_color || t.hex.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = t.hex.onAccent;
    ctx.font = Math.round(radius * 0.95) + 'px ' + t.font.display;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(u.display_name || u.username || '?').slice(0, 1).toUpperCase(), cx, cy + 2);
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

  // Avatar, name, a second line and an optional right-hand label.
  function renderConversationRow(ctx, r, conv, sub, right, hover) {
    const t = tokens();
    const p = conv.participant || {};
    ctx.fillStyle = hover ? t.hex.surface3 : t.hex.surface;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    drawAvatar(ctx, r.x + 24 + 44, r.y + r.h / 2, 44, p);
    const x = r.x + 144;
    const textW = r.w - 144 - 300;
    ctx.fillStyle = t.hex.ink;
    ctx.font = '40px ' + t.font.sans;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, (p.display_name || p.username || '?') + '  @' + (p.username || ''), textW), x, r.y + r.h * 0.34);
    ctx.fillStyle = t.hex.ink2;
    ctx.font = '30px ' + t.font.mono;
    ctx.fillText(truncate(ctx, sub, textW), x, r.y + r.h * 0.7);
    if (right) {
      ctx.fillStyle = right.accent ? t.hex.accent : t.hex.ink2;
      ctx.font = '34px ' + t.font.display;
      ctx.textAlign = 'right';
      ctx.fillText(right.label, r.x + r.w - 32, r.y + r.h / 2);
    }
    if (hover) {
      ctx.strokeStyle = t.hex.accent;
      ctx.lineWidth = 6;
      ctx.strokeRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    }
  }

  function renderStatus(ctx, route, empty) {
    const t = tokens();
    let text = '';
    if (route.status === 'loading') text = 'Loading…';
    else if (route.status === 'error') text = "Couldn't load this page";
    else if (!(route.items || []).length) text = empty;
    if (text) centerText(ctx, text, 620, '52px ' + t.font.sans, t.hex.ink2);
    return !!text;
  }

  function renderScrollButtons(ctx, route, btns, maxScroll, hover) {
    btns.forEach((b) => {
      const disabled = b.arg < 0 ? !route.scroll : (route.scroll || 0) >= maxScroll;
      drawButton(ctx, b, b.label, { hover: !disabled && hover === 'scroll:' + b.arg, disabled, size: 48 });
    });
  }

  // Inbox (route.box tabs) and the share sheet: scrolling conversation lists.
  function renderConversationList(ctx, state, hover) {
    const t = tokens();
    const route = state.route;
    const sharing = route.section === 'share';
    if (sharing) {
      ctx.fillStyle = t.hex.ink2;
      ctx.font = '40px ' + t.font.sans;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const what = route.share && route.share.kind === 'pack' ? 'pack' : 'reel';
      ctx.fillText(truncate(ctx, 'Send this ' + what + ' to a chat', SEARCH_BAR.w), SEARCH_BAR.x, SEARCH_BAR.y + SEARCH_BAR.h / 2);
    } else {
      const counts = state.unreadBox || {};
      BOX_TABS.forEach((b, i) => drawButton(ctx, boxTabRect(i), b.label + (counts[b.arg] ? '  ' + counts[b.arg] : ''), {
        active: (route.box || 'inbox') === b.arg, hover: hover === 'box:' + b.arg, size: 36,
      }));
    }
    if (renderStatus(ctx, route, sharing ? 'No chats to share to yet' : (route.box === 'requests' ? 'No message requests' : 'No messages yet'))) return;
    const items = route.items || [];
    const first = route.scroll || 0;
    for (let slot = 0; slot < LIST_ROWS; slot++) {
      const conv = items[first + slot];
      if (!conv) break;
      const r = listRowRect(slot);
      let right = null;
      let sub = messagePreview(conv.last_message, conv.participant);
      if (sharing) {
        const sent = (route.sent || {})[conv.id];
        right = { label: { sending: 'SENDING…', sent: 'SENT ✓', failed: 'RETRY' }[sent] || 'SEND', accent: sent !== 'sending' };
        sub = '@' + ((conv.participant && conv.participant.username) || '');
      } else if (conv.unread_count) {
        right = { label: conv.unread_count + ' NEW', accent: true };
      } else if (conv.is_request) {
        right = { label: 'REQUEST' };
      }
      const key = sharing ? 'share-to:' + (first + slot) : 'chip:/messages/' + conv.id;
      renderConversationRow(ctx, r, conv, sub, right, hover === key);
    }
    renderScrollButtons(ctx, route, SCROLL_BTNS, Math.max(0, items.length - LIST_ROWS), hover);
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
    const route = state.route;
    const det = route.detail;
    const f = state.field || {};
    if (det) {
      const p = det.participant || {};
      const cy = SEARCH_BAR.y + SEARCH_BAR.h / 2;
      drawAvatar(ctx, SEARCH_BAR.x + 52, cy, 52, p);
      ctx.fillStyle = t.hex.ink;
      ctx.font = '44px ' + t.font.sans;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const name = truncate(ctx, p.display_name || p.username || '', 640);
      ctx.fillText(name, SEARCH_BAR.x + 136, cy);
      const note = det.is_request ? 'wants to message you' : (det.state === 'pending' ? 'request sent' : '');
      if (note) {
        ctx.fillStyle = t.hex.ink2;
        ctx.font = '32px ' + t.font.mono;
        ctx.fillText(note, SEARCH_BAR.x + 136 + ctx.measureText(name).width + 40, cy + 2);
      }
      detailButtons(route).forEach((b) => drawButton(ctx, b, b.label, {
        primary: b.primary, disabled: b.disabled, size: 36, hover: !b.disabled && hover === b.action,
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
        ctx.fillStyle = m.mine ? t.hex.accent : t.hex.surface2;
        ctx.fillRect(x, row.y, w, row.h);
        ctx.fillStyle = m.mine ? t.hex.onAccent : (m.deleted ? t.hex.inkMuted : t.hex.ink);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + 32, row.y + row.h / 2 + 2);
        ctx.globalAlpha = 1;
      }
      renderScrollButtons(ctx, route, THREAD_SCROLL, Math.max(0, items.length - THREAD_ROWS), hover);
    }
    const canMessage = !!(det && det.can_message);
    if (canMessage) {
      QUICK_REPLIES.forEach((q, i) => drawButton(ctx, quickRect(i), q, { hover: hover === 'quick-reply:' + q, size: 32 }));
    }
    const typing = f.focused && f.id === 'compose';
    const r = COMPOSE_BAR;
    ctx.fillStyle = t.hex.surface2;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = typing ? t.hex.accent : (hover === 'compose-focus' ? t.hex.ink : t.hex.rule);
    ctx.lineWidth = 4;
    ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
    const draft = typing ? f.text + '|' : (route.draft || '');
    let placeholder = 'Message ' + (route.label || '');
    if (det && !canMessage) placeholder = det.state === 'pending' ? 'Waiting for them to accept' : "You can't reply in this chat";
    ctx.fillStyle = draft ? t.hex.ink : t.hex.inkMuted;
    ctx.font = '40px ' + t.font.sans;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // Long drafts show their end, where typing happens.
    let shown = draft || placeholder;
    while (shown.length > 1 && ctx.measureText(shown).width > r.w - 64) shown = shown.slice(1);
    ctx.fillText(shown, r.x + 32, r.y + r.h / 2);
    drawButton(ctx, SEND_BTN, 'SEND', {
      primary: canMessage && !!(typing ? f.text : route.draft), disabled: !canMessage,
      hover: canMessage && hover === 'compose-send', size: 40,
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

  // Wallet: balance + reward progress in the tool row, BUY on the right, ledger rows below.
  function renderWallet(ctx, state, hover) {
    const t = tokens();
    const route = state.route;
    const w = route.detail;
    if (w) {
      const avail = Number(w.available_credits) || 0;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = t.hex.accent;
      ctx.font = '76px ' + t.font.display;
      const balance = avail.toLocaleString('en-US');
      ctx.fillText(balance, SEARCH_BAR.x, SEARCH_BAR.y + SEARCH_BAR.h / 2);
      const x = SEARCH_BAR.x + ctx.measureText(balance).width + 32;
      ctx.fillStyle = t.hex.ink;
      ctx.font = '34px ' + t.font.display;
      ctx.fillText('CREDITS', x, SEARCH_BAR.y + SEARCH_BAR.h * 0.3);
      ctx.fillStyle = t.hex.ink2;
      ctx.font = '28px ' + t.font.mono;
      const r = state.rewards;
      let line = 'Reserved ' + fmtCount(w.reserved_credits) + ' · Earned ' + fmtCount(w.lifetime_earned) + ' · Spent ' + fmtCount(w.lifetime_spent);
      if (r) line += r.capped ? ' · Reel rewards: daily cap reached' : ' · Reels: ' + r.progress + '/10 to next credit';
      ctx.fillText(truncate(ctx, line, SEARCH_BAR.w - DETAIL_BTN_W - 48 - (x - SEARCH_BAR.x)), x, SEARCH_BAR.y + SEARCH_BAR.h * 0.72);
    }
    detailButtons(route).forEach((b) => drawButton(ctx, b, b.label, { primary: b.primary, hover: hover === b.action, size: 36 }));
    if (renderStatus(ctx, route, 'No credit activity yet')) return;
    const items = route.items || [];
    const first = route.scroll || 0;
    for (let slot = 0; slot < LIST_ROWS; slot++) {
      const e = items[first + slot];
      if (!e) break;
      const r = listRowRect(slot);
      ctx.fillStyle = t.hex.surface;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = t.hex.ink;
      ctx.font = '40px ' + t.font.sans;
      ctx.fillText(truncate(ctx, ledgerLabel(e), r.w - 640), r.x + 32, r.y + r.h * 0.34);
      ctx.fillStyle = t.hex.ink2;
      ctx.font = '30px ' + t.font.mono;
      ctx.fillText(String(e.created_at || '').slice(0, 10), r.x + 32, r.y + r.h * 0.7);
      const delta = ledgerDelta(e);
      ctx.textAlign = 'right';
      ctx.fillStyle = delta.gain ? t.hex.accent : t.hex.ink;
      ctx.font = '44px ' + t.font.display;
      ctx.fillText(delta.text, r.x + r.w - 32, r.y + r.h * 0.38);
      ctx.fillStyle = t.hex.inkMuted;
      ctx.font = '26px ' + t.font.mono;
      ctx.fillText('balance ' + (Number(e.balance_available) || 0).toLocaleString('en-US'), r.x + r.w - 32, r.y + r.h * 0.76);
    }
    renderScrollButtons(ctx, route, SCROLL_BTNS, Math.max(0, items.length - LIST_ROWS), hover);
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
    if (section === 'messages' || section === 'share') { renderConversationList(ctx, s, hover); return; }
    if (section === 'thread') { renderThread(ctx, s, hover); return; }
    if (section === 'wallet') { renderWallet(ctx, s, hover); return; }
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

  // Laser keyboard (own panel, shown while a field is focused).
  const KB_W = 1280;
  const KB_H = 480;
  const KB_GAP = 12;
  const KB_KEY_W = (KB_W - KB_GAP * 11) / 10;
  const KB_KEY_H = (KB_H - KB_GAP * 5) / 4;
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
    const rowY = (r) => KB_GAP + r * (KB_KEY_H + KB_GAP);
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

  function renderKeyboard(ctx, hover, field) {
    const t = tokens();
    const shift = !!(field && field.shift);
    ctx.clearRect(0, 0, KB_W, KB_H);
    ctx.fillStyle = t.hex.bg;
    ctx.globalAlpha = 0.94;
    ctx.fillRect(0, 0, KB_W, KB_H);
    ctx.globalAlpha = 1;
    keyboardRects(field).forEach((k) => drawButton(ctx, k, k.label, {
      primary: k.id === 'enter', active: k.id === 'shift' && shift,
      hover: hover === 'key:' + k.id, size: Array.from(k.label).length > 1 ? 36 : 48,
    }));
  }

  function resolveKeyboardHit(x, y, field) {
    const k = keyboardRects(field).find((r) => inRect(r, x, y));
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
