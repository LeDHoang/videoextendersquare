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

  // Section bodies land in later milestones; M0 shows a labelled placeholder.
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

  function renderMainPanel(ctx, state, hover) {
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
    const section = s.route && s.route.section;
    renderHeader(ctx, SECTION_TITLES[section] || 'ECHO', s.route && s.route.arg ? s.route.arg : '', hover);
    renderSectionBody(ctx, s);
  }

  function resolveMainHit(state, x, y) {
    if (inRect(CLOSE_BTN, x, y)) return { action: 'close' };
    if (state && state.handoff) {
      const b = HANDOFF_BTNS.find((r) => inRect(r, x, y));
      return b ? { action: b.action } : null;
    }
    return null;
  }

  // Hover key for a hit, matching the hover argument the renderers take.
  function hoverKey(hit) {
    if (!hit) return '';
    return hit.action === 'nav' ? hit.arg : hit.action;
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
    renderMainPanel,
    resolveMainHit,
    hoverKey,
  };
});
