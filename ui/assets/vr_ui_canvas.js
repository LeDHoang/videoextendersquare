/**
 * ECHO WebXR VR UI Canvas Module — v1.0
 * Decoupled 2D Canvas Rendering Engine for In-VR Overlays & HUD
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VRUICanvas = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const CONTROLS_W = 1024;
  const CONTROLS_H = 384;
  const GUIDE_W = 440;
  const GUIDE_H = 1124;
  const CPANEL_W = 560;
  const CPANEL_H = 920;
  const OVERLAY_W = 1024;
  const OVERLAY_H = 1024;
  const EARTH_PREVIEW_W = 512;
  // 512×716 matches the 0.5 m × 0.7 m billboard (1:1.4) so text is never stretched.
  const EARTH_PREVIEW_H = 716;
  // Reel card button (canvas px): opens the location feed. (RESET ROTATION
  // lives on the WORLD › location panel, drawn in webxr_vr.js.)
  const EARTH_PREVIEW_BUTTONS = [
    { action: 'feed', label: 'TRIGGER  ▸  OPEN LOCATION FEED', x: 28, y: 670, w: 456, h: 40 },
  ];

  // Panel layout metrics
  // Creator block (avatar, title, caption, chips, stats) above the comments header.
  const CP_INFO_H = 256;
  const CP_HEADER_H = 56;
  const CP_FOOTER_H = 112;
  const CP_LIST_TOP = CP_INFO_H + CP_HEADER_H;
  const CP_LIST_BOTTOM = CPANEL_H - CP_FOOTER_H;
  // Cards span x 20-540, flush with the creator block; the (undrawn) scroll
  // hit strip lives in the right padding.
  const CP_LIST_X = 10;
  const CP_LIST_W = 540;
  const CP_SCROLL_X = 544;
  const CP_SCROLL_W = 16;
  const CP_ITEM_H = 84;
  const CP_ITEM_GAP = 8;
  // Close sits top-right, to the right of FOLLOW.
  const CP_CLOSE_BTN = { x: 504, y: 26, w: 36, h: 36 };
  const CP_STATS_Y = 198;
  // One time-sync toggle replaces the ALL / SYNC / GENERAL tabs.
  const CP_SYNC_BTN = { x: 504, y: CP_INFO_H + 12, w: 36, h: 32 };
  // Comment name advance (700 11px JetBrains Mono, 0.6em per glyph).
  const CP_NAME_CHAR_W = 6.6;

  // FOLLOW hugs its label (same 700 11px mono), right-aligned 8px left of close.
  function cpFollowBtn(following) {
    const w = 46 + Math.ceil((following ? 'FOLLOWING' : 'FOLLOW').length * CP_NAME_CHAR_W);
    return { x: CP_CLOSE_BTN.x - 8 - w, y: 26, w, h: 36 };
  }

  // Button definitions for the UI controls panel (WebXR HUD Media Control Dock)
  const CTRL_BUTTONS = [
    // Left secondary column (Pills)
    { label: 'AUTO',  action: 'mode',  x: 24,  y: 56,  w: 156, h: 36 },
    { label: 'DOME',  action: 'curve', x: 24,  y: 100, w: 156, h: 36 },

    // Center primary transport controls
    { label: 'REW',   action: 'rew',   x: 244, y: 74,  w: 44,  h: 44 },
    { label: 'PREV',  action: 'prev',  x: 300, y: 70,  w: 52,  h: 52 },
    { label: 'PLAY',  action: 'play',  x: 364, y: 60,  w: 72,  h: 72 },
    { label: 'NEXT',  action: 'next',  x: 448, y: 70,  w: 52,  h: 52 },
    { label: 'FWD',   action: 'fwd',   x: 512, y: 74,  w: 44,  h: 44 },

    // Right secondary column (Pills)
    { label: 'LOCK',  action: 'lock',  x: 620, y: 56,  w: 156, h: 36 },
    { label: 'AUDIO', action: 'mute',  x: 620, y: 100, w: 156, h: 36 },

    // Header comment pill → toggles the VR comments panel
    { label: 'COMMENTS', action: 'comments', x: 664, y: 8, w: 72, h: 32 },

    // Pack queue toggle (packs only). Earth and the main feed live on the
    // shell nav bar under the dock.
    { label: 'QUEUE', action: 'earth', x: 584, y: 8, w: 72, h: 32 },

    // Header exit button
    { label: 'EXIT',  action: 'exit',  x: 744, y: 8,   w: 32,  h: 32 },

    // Existing reel actions remain available in both feed and pack playback.
    // Icon tiles on one row; it ends above the Earth action row (y 238).
    { label: 'LIKE',    action: 'like',       x: 24,  y: 188, w: 87, h: 48 },
    { label: 'SAVE',    action: 'save_reel',  x: 119, y: 188, w: 87, h: 48 },
    { label: 'SHARE',   action: 'share_reel', x: 214, y: 188, w: 87, h: 48 },
    { label: 'FOLLOW',  action: 'follow',     x: 309, y: 188, w: 87, h: 48 },
    { label: 'PROFILE', action: 'profile',    x: 404, y: 188, w: 87, h: 48 },
    { label: 'REPORT',  action: 'report',     x: 499, y: 188, w: 87, h: 48 },

    // Pack-level actions are intentionally separate from reel-level actions.
    { label: 'SAVE PACK',  action: 'save_pack',  x: 594, y: 188, w: 87, h: 48 },
    { label: 'SHARE PACK', action: 'share_pack', x: 689, y: 188, w: 87, h: 48 },

    // Feed-mode collection shortcut (opens the SAVE TO card); takes both pack slots.
    { label: 'COLLECT',    action: 'collect',    x: 594, y: 188, w: 182, h: 48 },

    // Earth-mode zoom map controls (docs/earth-zoom-map-plan.md Z1): their own
    // row in the Earth dock; visible + hittable only in earth scene mode.
    { label: 'OPEN FEED',   action: 'earth_open_feed', x: 24,  y: 238, w: 174, h: 42 },
    { label: 'ZOOM OUT',    action: 'earth_zoom_out',  x: 218, y: 238, w: 174, h: 42 },
    { label: 'GLOBE RESET', action: 'earth_reset',     x: 408, y: 238, w: 174, h: 42 },
    { label: 'NORTH UP',    action: 'earth_north_up',  x: 602, y: 238, w: 174, h: 42 },

    // Progress scrub track under the transport (times sit either side)
    { label: 'TRACK', action: 'seek',  x: 84,  y: 148, w: 632, h: 28 },
  ];

  // Dock header chip shown while a stereo reel is drawn per eye.
  const STEREO_CHIP = { x: 592, y: 8, w: 64, h: 32 };

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // Compact engagement counts (1250 -> "1.2K"); mirrors fmtCount in reels.html.
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  // Post age ("2MO AGO"); mirrors relativeAge in reels.html.
  function relativeAge(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const seconds = Math.max(0, (Date.now() - t) / 1000);
    if (seconds < 60) return 'JUST NOW';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'M AGO';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'H AGO';
    if (seconds < 86400 * 30) return Math.floor(seconds / 86400) + 'D AGO';
    if (seconds < 86400 * 365) return Math.floor(seconds / (86400 * 30)) + 'MO AGO';
    return Math.floor(seconds / (86400 * 365)) + 'Y AGO';
  }

  function getInitials(name) {
    if (!name) return '??';
    const parts = name.split(/[_\s]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  // Square stroke glyphs for the HUD. Emoji render with the system colour font on the
  // headset and ignore the ECHO palette, so draw the few icons we need as plain paths.
  function drawGlyph(ctx, name, cx, cy, size, color) {
    const h = size / 2;
    const prevW = ctx.lineWidth;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.5, size / 9);
    ctx.beginPath();
    if (name === 'chat') {
      ctx.moveTo(cx - h, cy - h * 0.8); ctx.lineTo(cx + h, cy - h * 0.8);
      ctx.lineTo(cx + h, cy + h * 0.45); ctx.lineTo(cx - h * 0.1, cy + h * 0.45);
      ctx.lineTo(cx - h * 0.6, cy + h * 0.95); ctx.lineTo(cx - h * 0.6, cy + h * 0.45);
      ctx.lineTo(cx - h, cy + h * 0.45); ctx.closePath();
      ctx.stroke();
    } else if (name === 'lock' || name === 'unlock') {
      ctx.fillRect(cx - h * 0.8, cy - h * 0.1, size * 0.8, h * 1.1);
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.5, cy - h * 0.1); ctx.lineTo(cx - h * 0.5, cy - h * 0.75);
      ctx.lineTo(cx + h * 0.5, cy - h * 0.75);
      ctx.lineTo(cx + h * 0.5, name === 'lock' ? cy - h * 0.1 : cy - h * 0.35);
      ctx.stroke();
    } else if (name === 'audio' || name === 'mute') {
      ctx.moveTo(cx - h, cy - h * 0.35); ctx.lineTo(cx - h * 0.45, cy - h * 0.35);
      ctx.lineTo(cx + h * 0.1, cy - h * 0.85); ctx.lineTo(cx + h * 0.1, cy + h * 0.85);
      ctx.lineTo(cx - h * 0.45, cy + h * 0.35); ctx.lineTo(cx - h, cy + h * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      if (name === 'audio') {
        ctx.moveTo(cx + h * 0.45, cy - h * 0.45); ctx.lineTo(cx + h * 0.45, cy + h * 0.45);
        ctx.moveTo(cx + h * 0.9, cy - h * 0.8); ctx.lineTo(cx + h * 0.9, cy + h * 0.8);
      } else {
        ctx.moveTo(cx + h * 0.4, cy - h * 0.45); ctx.lineTo(cx + h, cy + h * 0.45);
        ctx.moveTo(cx + h, cy - h * 0.45); ctx.lineTo(cx + h * 0.4, cy + h * 0.45);
      }
      ctx.stroke();
    }
    ctx.lineWidth = prevW;
  }

  // ECHO icon set, ported from web/src/components/icons/svg (24-unit grid) so
  // the dock matches the 2D reels page. Each op: [svg path, 's'troke|'f'ill,
  // paint ('i' ink, 'a' accent, 'k' dark core), lineWidth, alpha].
  const ring = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  const DOCK_ICONS = {
    // ECHO "Echo Glass" mark, at rest: web/src/components/icons/svg/echo-glass.svg at half scale.
    logo: [
      ['M4.5 2L19.5 2L21.5 4L12 12.5L2.5 4ZM4.5 22L19.5 22L21.5 20L12 11.5L2.5 20Z', 's', 'i', 1.7],
      ['M6.9 5.2L17.1 5.2L18.46 6.56L12 12.34L5.54 6.56ZM6.9 18.8L17.1 18.8L18.46 17.44L12 11.66L5.54 17.44Z', 's', 'i', 0.9, 0.5],
      ['M8.7 7.6L15.3 7.6L16.18 8.48L12 12.22L7.82 8.48ZM8.7 16.4L15.3 16.4L16.18 15.52L12 11.78L7.82 15.52Z', 's', 'i', 0.65, 0.28],
      ['M6 12L9 8.75H15L18 12L15 15.25H9Z', 's', 'k', 1.6],
      ['M6 12L9 8.75H15L18 12L15 15.25H9Z', 'f', 'i'],
      ['M12 8.75L15.25 12L12 15.25L8.75 12Z', 'f', 'a'],
      ['M12 10.5L13.5 12L12 13.5L10.5 12Z', 'f', 'k'],
      ['M12.7 10.2H13.5V11H12.7Z', 'f', 'i'],
    ],
    like: [
      ['M12 8.5L9.2 5.8H5.8L4.2 7.8L5.5 11.5L12 18.5L18.5 11.5L19.8 7.8L18.2 5.8H14.8L12 8.5Z', 's', 'i', 1.6],
      ['M5.5 11.5H18.5M12 8.5V18.5', 's', 'i', 1.2, 0.25],
      ['M12 9.8L15.2 13L12 16.2L8.8 13Z', 'f', 'a'],
      [ring(12, 13, 0.9), 'f', 'i'],
    ],
    comment: [
      ['M21 15L19 17H7L3 21V5L5 3H19L21 5V15Z', 's', 'i', 1.5],
      [ring(17, 7, 2), 'f', 'a'],
    ],
    share: [
      [ring(6, 12, 2.5), 'f', 'k'],
      [ring(6, 12, 2.5), 's', 'i', 1.5],
      [ring(6, 12, 0.75), 'f', 'i'],
      ['M18 3.5L20.5 6L18 8.5L15.5 6ZM18 15.5L20.5 18L18 20.5L15.5 18Z', 'f', 'a'],
      ['M8.5 10.8L15.5 7.2M8.5 13.2L15.5 16.8', 's', 'i', 1.6],
      ['M12 8L13.5 11M12 16L13.5 13', 's', 'a', 1.2, 0.8],
    ],
    save: [
      ['M5.5 3.5H18.5V19.5L12 15L5.5 19.5V3.5Z', 's', 'i', 1.6],
      ['M7.5 7.5H16.5', 's', 'i', 1.2, 0.25],
      ['M12 4.5V13.5', 's', 'a', 1.8],
      ['M12 7L14.5 9.5L12 12L9.5 9.5Z', 'f', 'a'],
      [ring(12, 9.5, 0.75), 'f', 'i'],
    ],
    // save.svg bookmark with a vermilion add cross (pick a collection).
    collect: [
      ['M3.5 5.5H15.5V20.5L9.5 16.5L3.5 20.5V5.5Z', 's', 'i', 1.6],
      ['M9.5 8.5V13.5', 's', 'a', 1.8],
      ['M19.5 2.5V8.5M16.5 5.5H22.5', 's', 'a', 1.8],
    ],
    follow: [
      ['M7.5 4L10.5 2.2L13.5 4V7.5L10.5 9.3L7.5 7.5Z', 'f', 'k'],
      ['M7.5 4L10.5 2.2L13.5 4V7.5L10.5 9.3L7.5 7.5Z', 's', 'i', 1.5],
      [ring(10.5, 5.7, 0.8), 'f', 'i'],
      ['M4 19.5V17L7 13.5H14L17 17V19.5', 's', 'i', 1.6],
      ['M6.5 17H14.5', 's', 'i', 1.2, 0.3],
      ['M19.5 8V14M16.5 11H22.5', 's', 'a', 1.8],
    ],
    // follow.svg silhouette, centred, without the add cross.
    profile: [
      ['M9 4.5L12 2.7L15 4.5V8L12 9.8L9 8Z', 'f', 'k'],
      ['M9 4.5L12 2.7L15 4.5V8L12 9.8L9 8Z', 's', 'i', 1.5],
      [ring(12, 6.2, 0.8), 'f', 'a'],
      ['M5.5 20V17.5L8.5 14H15.5L18.5 17.5V20', 's', 'i', 1.6],
      ['M8 17.5H16', 's', 'a', 1.4],
    ],
    report: [
      ['M12 2.5L21 18L18.5 21.5H5.5L3 18Z', 's', 'i', 1.6],
      ['M6.5 18.5H17.5', 's', 'i', 1, 0.3],
      ['M12 7.5V13.5', 's', 'a', 2],
      ['M12 15L13.5 16.5L12 18L10.5 16.5Z', 'f', 'a'],
    ],
    timesync: [
      ['M12 1.5V4', 's', 'a', 1.8],
      ['M10 1.5H14', 's', 'a', 1.5],
      ['M17.5 3.5L19.5 5.5', 's', 'i', 1.4],
      ['M8 4H16L21 9V17L16 22H8L3 17V9Z', 's', 'i', 1.6],
      ['M12 5.5V7M12 19V20.5M4.5 13H6M18 13H19.5', 's', 'i', 1, 0.4],
      ['M12 13V8M12 13L16.5 10', 's', 'a', 1.8],
      ['M12 11.2L13.8 13L12 14.8L10.2 13Z', 'f', 'a'],
      [ring(12, 13, 0.65), 'f', 'i'],
    ],
    location: [
      ['M12 3.5L18 9.5L12 19.5L6 9.5Z', 's', 'i', 1.6],
      [ring(12, 9.5, 2.2), 'f', 'a'],
      [ring(12, 9.5, 0.8), 'f', 'i'],
      ['M8 21H16', 's', 'a', 1.8],
    ],
    more: [
      ['M2.5 12H21.5', 's', 'i', 1, 0.25],
      ['M6 9.8L8.2 12L6 14.2L3.8 12ZM18 9.8L20.2 12L18 14.2L15.8 12Z', 's', 'i', 1.4],
      ['M12 9L15 12L12 15L9 12Z', 'f', 'a'],
    ],
    'mode-auto': [
      ['M13 5L18 10L13 15', 's', 'a', 1.5],
      ['M6 10H18', 's', 'i', 1.5],
      ['M21 5V15', 's', 'a', 1.5],
      ['M3 19H21', 's', 'i', 1, 0.4],
    ],
    'mode-loop': [
      ['M17 1L19 3L17 5M7 23L5 21L7 19', 's', 'a', 1.5],
      ['M19 3V11C19 12.66 17.66 14 16 14H5M5 21V13C5 11.34 6.34 10 8 10H19', 's', 'i', 1.5],
    ],
    // Display mode, seen from above: screen edge in ink, viewer diamond in accent.
    'display-flat': [
      ['M12 17L4 7M12 17L20 7', 's', 'i', 1, 0.35],
      ['M4 7H20', 's', 'i', 1.5],
      ['M4 4V10M20 4V10', 's', 'a', 1.5],
      ['M12 16L14 18L12 20L10 18Z', 'f', 'a'],
    ],
    'display-sq-curve': [
      ['M12 17L4 9M12 17L20 9', 's', 'i', 1, 0.35],
      ['M4 9L7 6H17L20 9', 's', 'i', 1.5],
      ['M4 7V11M20 7V11', 's', 'a', 1.5],
      ['M12 16L14 18L12 20L10 18Z', 'f', 'a'],
    ],
    'display-dome': [
      ['M12 17L4 13M12 17L20 13', 's', 'i', 1, 0.35],
      ['M4 13L5.5 8.5L9 5.5H15L18.5 8.5L20 13', 's', 'i', 1.5],
      ['M4 11V15M20 11V15', 's', 'a', 1.5],
      ['M12 16L14 18L12 20L10 18Z', 'f', 'a'],
    ],
    'sound-audio': [
      ['M11 5L6 9H3V15H6L11 19V5Z', 's', 'i', 1.5],
      ['M15 9C16.1 9 17 9.9 17 11V13C17 14.1 16.1 15 15 15', 's', 'i', 1.5],
      ['M19 7C20.66 7 22 8.34 22 10V14C22 15.66 20.66 17 19 17', 's', 'a', 1.5],
    ],
    'sound-mute': [
      ['M11 5L6 9H3V15H6L11 19V5Z', 's', 'i', 1.5],
      ['M17 9L21 15M21 9L17 15', 's', 'a', 1.5],
    ],
    // Feed is vertical in 2D, so prev/next are the up/down arrows there too.
    prev: [
      ['M12 5V19M12 5L7 10M12 5L17 10', 's', 'i', 1.5],
      ['M5 3H19', 's', 'a', 1.5],
    ],
    next: [
      ['M12 19V5M12 19L7 14M12 19L17 14', 's', 'i', 1.5],
      ['M5 21H19', 's', 'a', 1.5],
    ],
    rew: [
      ['M11.5 6L5.5 12L11.5 18M18.5 6L12.5 12L18.5 18', 's', 'i', 1.6],
      ['M3 6V18', 's', 'a', 1.6],
    ],
    fwd: [
      ['M12.5 6L18.5 12L12.5 18M5.5 6L11.5 12L5.5 18', 's', 'i', 1.6],
      ['M21 6V18', 's', 'a', 1.6],
    ],
    exit: [
      ['M6 6L18 18M18 6L6 18', 's', 'i', 1.8],
    ],
    // VR shell nav bar: back.svg, industrial-reels.svg, compass.svg, message.svg, credits.svg.
    back: [
      ['M10.5 5.5L4 12L10.5 18.5', 's', 'i', 1.8],
      ['M5.5 12H20M20 9.5V14.5', 's', 'a', 1.7],
      ['M13 9.5L15.5 12L13 14.5L10.5 12Z', 'f', 'a'],
      [ring(13, 12, 0.7), 'f', 'i'],
    ],
    reels: [
      ['M3 8L5 6H19L21 8V16L19 18H5L3 16V8Z', 's', 'i', 1.5],
      ['M7 10H9V14H7V10ZM15 10H17V14H15V10Z', 'f', 'a'],
      ['M10 18L12 16L14 18', 's', 'i', 1.5],
    ],
    compass: [
      ['M12 2.5L18.7 5.3L21.5 12L18.7 18.7L12 21.5L5.3 18.7L2.5 12L5.3 5.3Z', 's', 'i', 1.6],
      ['M12 3V7.5M12 16.5V21M3 12H7.5M16.5 12H21', 's', 'i', 1.2, 0.35],
      ['M12 12L10.2 10.2L17.5 6.5L13.8 13.8Z', 'f', 'a'],
      ['M12 12L13.8 13.8L6.5 17.5L10.2 10.2Z', 'f', 'i', 0, 0.85],
      [ring(12, 12, 1.8), 'f', 'k'],
      [ring(12, 12, 1.8), 's', 'a', 1.2],
      [ring(12, 12, 0.65), 'f', 'i'],
    ],
    message: [
      ['M3.5 6.5L12 13L20.5 6.5M3.5 6.5H20.5V18.5H3.5V6.5Z', 's', 'i', 1.6],
      ['M3.5 18.5L9.5 13M20.5 18.5L14.5 13', 's', 'i', 1, 0.25],
      ['M12 10.8L14.2 13L12 15.2L9.8 13Z', 'f', 'a'],
      [ring(12, 13, 0.75), 'f', 'i'],
      [ring(12, 4, 1), 'f', 'a'],
    ],
    credits: [
      [ring(12, 12, 8.2), 's', 'i', 1.6],
      [ring(12, 12, 5.4), 's', 'a', 1.4],
      ['M12 8.2V15.8', 's', 'i', 1.6],
      ['M9.6 10H14.4M9.6 14H14.4', 's', 'i', 1.2, 0.6],
    ],
  };
  const DOCK_ICON_PATHS = {};

  // Draws a DOCK_ICONS entry centred on (cx, cy). Runtimes without Path2D
  // (the node test harness) skip the artwork; layout and labels still draw.
  function drawIcon(ctx, name, cx, cy, size, ink, accent, core) {
    const ops = DOCK_ICONS[name];
    if (!ops || typeof Path2D !== 'function' || !ctx.save) return;
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.lineJoin = 'bevel';
    ctx.lineCap = 'square';
    for (const [d, mode, paint, width, alpha] of ops) {
      const color = paint === 'a' ? (accent || TOKENS.hex.accent) : (paint === 'k' ? (core || TOKENS.hex.surface) : ink);
      const path = DOCK_ICON_PATHS[d] || (DOCK_ICON_PATHS[d] = new Path2D(d));
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      if (mode === 'f') {
        ctx.fillStyle = color;
        ctx.fill(path);
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke(path);
      }
    }
    ctx.restore();
  }

  // Chamfered button outline: the bevelled corner of the ECHO icon set.
  function chamferPath(ctx, x, y, w, h, c) {
    ctx.beginPath();
    ctx.moveTo(x + c, y);
    ctx.lineTo(x + w - c, y);
    ctx.lineTo(x + w, y + c);
    ctx.lineTo(x + w, y + h - c);
    ctx.lineTo(x + w - c, y + h);
    ctx.lineTo(x + c, y + h);
    ctx.lineTo(x, y + h - c);
    ctx.lineTo(x, y + c);
    ctx.closePath();
  }

  function wrapTextLines(ctx, text, maxW, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    let truncated = false;
    const fitWord = (word) => {
      // Hard-break a word wider than the line so it never runs off the panel.
      while (word.length > 1 && ctx.measureText(word).width > maxW) {
        let n = word.length - 1;
        while (n > 1 && ctx.measureText(word.slice(0, n)).width > maxW) n--;
        lines.push(word.slice(0, n));
        word = word.slice(n);
        if (lines.length >= maxLines) { truncated = true; return ''; }
      }
      return word;
    };
    for (let i = 0; i < words.length && !truncated; i++) {
      const test = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width <= maxW) {
        cur = test;
        continue;
      }
      if (cur) lines.push(cur);
      cur = '';
      if (lines.length >= maxLines) { truncated = true; break; }
      cur = fitWord(words[i]);
    }
    if (!truncated && cur) {
      if (lines.length < maxLines) lines.push(cur);
      else truncated = true;
    }
    if (truncated && lines.length) {
      let last = lines[lines.length - 1];
      while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '…';
    }
    return lines.slice(0, maxLines);
  }

  function isReelAction(action) {
    return action === 'like' || action === 'save_reel' || action === 'share_reel' ||
      action === 'follow' || action === 'profile' || action === 'report';
  }

  function isPackAction(action) {
    return action === 'save_pack' || action === 'share_pack';
  }

  // Earth zoom map dock actions (Z1) — only meaningful in earth scene mode.
  function isEarthAction(action) {
    return action === 'earth_open_feed' || action === 'earth_zoom_out' ||
          action === 'earth_reset' || action === 'earth_north_up';
  }

  function isControlVisible(action, source, itemState, isPackExp, sceneMode) {
    if (isEarthAction(action)) return sceneMode === 'earth';
    if (action === 'earth') return !!isPackExp;
    if (isPackAction(action)) return !!isPackExp;
    if (action === 'collect') return !isPackExp && sceneMode !== 'earth';
    if (isReelAction(action)) return source.kind !== 'static-card' && (!itemState || itemState.available !== false);
    if (source.kind === 'static-card' &&
        (action === 'rew' || action === 'prev' || action === 'play' ||
         action === 'next' || action === 'fwd' || action === 'seek')) return false;
    if (source.kind === 'image' && (action === 'rew' || action === 'fwd' || action === 'seek')) return false;
    return true;
  }

  // Earth mode hit-allowlist: the mode toggle, exit, and the zoom-map
  // actions (Z1). Everything else stays decorative behind the globe.
  function isDockControlLive(action, options) {
    const { source = {}, itemState = {}, sceneMode = 'reels', packMode = false } = options;
    if (sceneMode === 'earth' && action !== 'earth' && action !== 'exit' && !isEarthAction(action)) return false;
    return isControlVisible(action, source, itemState, packMode, sceneMode);
  }

  // Dock canvas size fitted to the live controls plus a margin, so the panel
  // has no dead space (e.g. images and Earth drop the seek row). The canvas
  // never exceeds CONTROLS_W x CONTROLS_H.
  const DOCK_MARGIN = 24;
  function controlsCanvasSize(options = {}) {
    let right = 0, bottom = 0;
    for (const btn of CTRL_BUTTONS) {
      if (!isDockControlLive(btn.action, options)) continue;
      right = Math.max(right, btn.x + btn.w);
      bottom = Math.max(bottom, btn.y + btn.h);
    }
    return {
      w: Math.min(CONTROLS_W, right + DOCK_MARGIN),
      h: Math.min(CONTROLS_H, bottom + DOCK_MARGIN),
    };
  }

  function truncatePreviewText(value, limit) {
    const text = String(value || '');
    return text.length > limit ? text.slice(0, Math.max(1, limit - 1)) + '…' : text;
  }

  function drawVideoCover(ctx, video, x, y, width, height) {
    const sourceW = Number(video && video.videoWidth) || width;
    const sourceH = Number(video && video.videoHeight) || height;
    const sourceRatio = sourceW / Math.max(1, sourceH);
    const targetRatio = width / Math.max(1, height);
    let sx = 0, sy = 0, sw = sourceW, sh = sourceH;
    if (sourceRatio > targetRatio) {
      sw = sourceH * targetRatio;
      sx = (sourceW - sw) / 2;
    } else {
      sh = sourceW / targetRatio;
      sy = (sourceH - sh) / 2;
    }
    ctx.drawImage(video, sx, sy, sw, sh, x, y, width, height);
  }

  // ─── Earth Atlas dock ──────────────────────────────────────────────
  // In Earth mode the reels transport (inert behind the globe) is replaced by a
  // purpose-built panel: realm / scale / map-status readouts, a zoom meter and
  // the four map actions, drawn in the same ECHO language as the reels dock
  // (flat surface, square corners, rule borders, vermilion for primary/active).
  // The realm swatch keeps the globe's tier colour as data.
  // Hit rectangles are unchanged (CTRL_BUTTONS); only the drawing differs.
  const EARTH_ICON = {
    earth_open_feed(ctx, cx, cy, c) {
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = c; ctx.beginPath();
      ctx.moveTo(cx - 3, cy - 4); ctx.lineTo(cx + 5, cy); ctx.lineTo(cx - 3, cy + 4); ctx.closePath(); ctx.fill();
    },
    earth_zoom_out(ctx, cx, cy, c) {
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx - 1, cy - 1, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 4, cy - 1); ctx.lineTo(cx + 2, cy - 1);
      ctx.moveTo(cx + 4, cy + 4); ctx.lineTo(cx + 9, cy + 9); ctx.stroke();
    },
    earth_reset(ctx, cx, cy, c) {
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(cx, cy, 3.5, 8, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.stroke();
    },
    earth_north_up(ctx, cx, cy, c) {
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx + 6, cy + 7); ctx.lineTo(cx, cy + 3); ctx.lineTo(cx - 6, cy + 7); ctx.closePath(); ctx.fill();
    },
  };

  function renderEarthDock(ctx, options) {
    const {
      hoveredButton = -1,
      pressedButton = -1,
      earth = {},
    } = options;
    const T = TOKENS.hex;
    const size = controlsCanvasSize(options);

    // Container + border (reels dock parity)
    previewRoundRect(ctx, 0, 0, size.w, size.h, TOKENS.radius);
    ctx.fillStyle = T.surface;
    ctx.fill();
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Header
    ctx.fillStyle = T.accent;
    ctx.fillRect(24, 14, 4, 20);
    ctx.font = `bold 11px ${TOKENS.font.mono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('EARTH ATLAS', 36, 24);
    ctx.fillStyle = T.ink;
    ctx.font = `12px ${TOKENS.font.mono}`;
    ctx.fillText(String(earth.location || 'WORLD').toUpperCase().slice(0, 40), 144, 24);

    // Exit (the way back to reels is the nav bar's REELS tab)
    ctx.lineWidth = 1;
    const xb = CTRL_BUTTONS.find((b) => b.action === 'exit');
    previewRoundRect(ctx, xb.x, xb.y, xb.w, xb.h, TOKENS.radius);
    ctx.fillStyle = T.surface;
    ctx.fill();
    ctx.strokeStyle = T.accent;
    ctx.stroke();
    drawIcon(ctx, 'exit', xb.x + xb.w / 2, xb.y + xb.h / 2, 14, T.accent);

    // Readout tiles
    const tiles = [
      { k: 'REALM', v: earth.tier || 'ORBIT', c: T.ink, swatch: earth.tierColor || T.accent },
      { k: 'SCALE', v: earth.scaleCaption || '—', c: T.ink },
      { k: 'MAP', v: earth.mapStatus || 'ORBITAL', c: earth.mapOffline ? T.accent : T.ink },
    ];
    const tw = 236, th = 96, ty = 70;
    for (let i = 0; i < tiles.length; i++) {
      const tx = 24 + i * (tw + 22);
      previewRoundRect(ctx, tx, ty, tw, th, TOKENS.radius);
      ctx.fillStyle = T.surface2;
      ctx.fill();
      ctx.strokeStyle = T.rule;
      ctx.lineWidth = 1;
      ctx.stroke();
      let kx = tx + 18;
      if (tiles[i].swatch) {
        ctx.fillStyle = tiles[i].swatch;
        ctx.fillRect(kx, ty + 20, 8, 8);
        kx += 16;
      }
      ctx.fillStyle = T.ink3;
      ctx.font = `bold 11px ${TOKENS.font.mono}`;
      ctx.textAlign = 'left';
      ctx.fillText(tiles[i].k, kx, ty + 24);
      ctx.fillStyle = tiles[i].c;
      ctx.font = `800 30px ${TOKENS.font.sans}`;
      ctx.fillText(String(tiles[i].v).slice(0, 14), tx + 18, ty + 62);
    }
    // Zoom meter (scrubber-style track, vermilion fill)
    const zp = Math.max(0, Math.min(100, Number(earth.zoomPct) || 0)) / 100;
    ctx.fillStyle = T.ink3;
    ctx.font = `bold 11px ${TOKENS.font.mono}`;
    ctx.textAlign = 'left';
    ctx.fillText('ZOOM', 24, 190);
    ctx.textAlign = 'right';
    ctx.fillStyle = T.ink;
    ctx.fillText(Math.round(zp * 100) + '%', 776, 190);
    previewRoundRect(ctx, 80, 186, 640, 8, TOKENS.radius);
    ctx.fillStyle = T.surface2;
    ctx.fill();
    if (zp > 0.005) {
      previewRoundRect(ctx, 80, 186, Math.max(8, 640 * zp), 8, TOKENS.radius);
      ctx.fillStyle = T.accent;
      ctx.fill();
    }

    // Action row: OPEN FEED is the primary (vermilion, like play); the map
    // actions are secondary buttons; NORTH UP shows engaged like LOCK.
    for (let i = 0; i < CTRL_BUTTONS.length; i++) {
      const btn = CTRL_BUTTONS[i];
      if (!isEarthAction(btn.action)) continue;
      const hover = hoveredButton === i, pressed = pressedButton === i;
      const feed = btn.action === 'earth_open_feed';
      const live = feed ? !!earth.canOpenFeed : true;
      const lit = btn.action === 'earth_north_up' && earth.northUp;
      const primary = feed && live;
      previewRoundRect(ctx, btn.x, btn.y, btn.w, btn.h, TOKENS.radius);
      if (primary) ctx.fillStyle = (pressed || hover) ? T.accentHi : T.accent;
      else ctx.fillStyle = pressed ? T.bg : ((hover && live) || lit ? T.surface3 : T.surface);
      ctx.fill();
      if (!primary) {
        ctx.strokeStyle = live && (hover || lit) ? T.accent : (live ? T.ruleStrong : T.rule);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const ink = primary ? T.onAccent : (!live ? T.inkMuted : T.ink);
      const iconInk = primary ? T.onAccent : (!live ? T.inkMuted : ((hover || lit) ? T.accent : T.ink2));
      EARTH_ICON[btn.action](ctx, btn.x + 26, btn.y + btn.h / 2, iconInk);
      ctx.fillStyle = ink;
      ctx.font = `bold 13px ${TOKENS.font.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2);
    }
  }

  // ─── Render Controls Dock ──────────────────────────────────────────
  function dockItemTitle(item) {
    if (!item) return '';
    const path = String(item.path || item.rel_path || '');
    return String(item.title || item.filename || path.split('/').pop() || 'UNTITLED REEL');
  }

  function renderControlsCanvas(ctx, options = {}) {
    if (!ctx) return;
    const {
      source = {},
      packMode = false,
      packContext = null,
      itemState = {},
      playlist = [],
      idx = 0,
      item = null,
      comments = [],
      hoveredButton = -1,
      pressedButton = -1,
      isCurved = true,
      curvatureMode = 1,
      lockToViewer = false,
      autoNext = true,
      sceneMode = 'reels',
      notificationText = '',
      notificationUntil = 0,
      stereo = 'mono',
      callbacks = {},
    } = options;

    const isPaused = source.paused !== false;
    const isMuted = source.muted !== false;
    const currentTime = Number(source.currentTime) || 0;
    const duration = Number(source.duration) || 0;
    const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;

    ctx.clearRect(0, 0, CONTROLS_W, CONTROLS_H);

    if (sceneMode === 'earth') {
      renderEarthDock(ctx, options);
      return;
    }

    const size = controlsCanvasSize(options);

    // 1. Dark Glass Container Background
    ctx.fillStyle = TOKENS.hex.surface;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, size.w, size.h, TOKENS.radius);
    else ctx.rect(0, 0, size.w, size.h);
    ctx.fill();

    // 2. Vermilion Glow Outer Border
    ctx.strokeStyle = TOKENS.hex.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, size.w, size.h, TOKENS.radius);
    else ctx.rect(0, 0, size.w, size.h);
    ctx.stroke();

    const T = TOKENS.hex;

    // Square header pill (all header controls share one 32 px height).
    const headerPill = (b, active) => {
      ctx.fillStyle = active ? T.surface3 : T.surface2;
      ctx.strokeStyle = active ? T.accent : T.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, TOKENS.radius);
      else ctx.rect(b.x, b.y, b.w, b.h);
      ctx.fill();
      ctx.stroke();
    };
    // Chamfered body button; returns the ink for its icon and caption.
    const bodyButton = (b, isHover, isPressed, lit) => {
      chamferPath(ctx, b.x, b.y, b.w, b.h, 6);
      ctx.fillStyle = isPressed ? T.bg : ((isHover || lit) ? T.surface3 : T.surface2);
      ctx.fill();
      ctx.strokeStyle = (isHover || lit) ? T.accent : T.rule;
      ctx.lineWidth = 1;
      ctx.stroke();
      return (isHover || lit) ? T.ink : T.ink2;
    };

    // 3. Header: ECHO mark + wordmark, then the current title.
    drawIcon(ctx, 'logo', 38, 24, 26, T.ink, T.accent, T.surface);
    ctx.fillStyle = T.ink;
    ctx.font = `900 16.5px ${TOKENS.font.brand}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('ECHO', 58, 24);

    let dispName = packMode && packContext
      ? (packContext.title || 'UNTITLED PACK')
      : dockItemTitle(item);
    if (dispName.length > 26) dispName = dispName.slice(0, 24) + '…';
    ctx.fillStyle = T.ink2;
    ctx.font = `13.2px ${TOKENS.font.mono}`;
    ctx.fillText(dispName, 144, 24);

    // 3D chip: the screen is drawn per eye (docs/stereo-3d-reels.md).
    if (stereo === 'sbs' || stereo === 'tb') {
      // Sits flush against the comment pill; packs step left of the index pill.
      const chipX = packMode ? STEREO_CHIP.x - 152 : STEREO_CHIP.x;
      ctx.fillStyle = T.accent;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(chipX, STEREO_CHIP.y, STEREO_CHIP.w, STEREO_CHIP.h, TOKENS.radius);
      else ctx.rect(chipX, STEREO_CHIP.y, STEREO_CHIP.w, STEREO_CHIP.h);
      ctx.fill();
      ctx.fillStyle = T.onAccent;
      ctx.font = `bold 12.1px ${TOKENS.font.mono}`;
      ctx.textAlign = 'center';
      ctx.fillText(stereo === 'tb' ? '3D TB' : '3D SBS', chipX + STEREO_CHIP.w / 2, 24);
      ctx.textAlign = 'left';
    }

    // Comment pill
    const commentBtnIdx = CTRL_BUTTONS.findIndex((b) => b.action === 'comments');
    const commentBtn = CTRL_BUTTONS[commentBtnIdx];
    const isCommentHover = (hoveredButton === commentBtnIdx);
    headerPill(commentBtn, isCommentHover);
    drawIcon(ctx, 'comment', commentBtn.x + 20, 24, 16, isCommentHover ? T.ink : T.ink2);
    ctx.fillStyle = isCommentHover ? T.ink : T.ink2;
    ctx.font = `bold 13.2px ${TOKENS.font.mono}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(comments.length || 0), commentBtn.x + 50, 24);

    // Packs only: index pill and queue toggle. The reels feed is an endless
    // scroll, and Earth / all locations live on the nav bar's tabs.
    if (packMode) {
      const earthBtnIdx = CTRL_BUTTONS.findIndex((b) => b.action === 'earth');
      const earthButton = CTRL_BUTTONS[earthBtnIdx];
      const indexPill = { x: earthButton.x - 72, y: 8, w: 64, h: 32 };
      headerPill(indexPill, false);
      ctx.fillStyle = T.ink2;
      ctx.fillText(`${playlist.length ? idx + 1 : 0} / ${playlist.length}`, indexPill.x + indexPill.w / 2, 24);

      const queueActive = hoveredButton === earthBtnIdx || !!(packContext && packContext.queueOpen);
      headerPill(earthButton, queueActive);
      drawIcon(ctx, 'more', earthButton.x + 16, 24, 16, queueActive ? T.ink : T.ink2);
      ctx.fillStyle = queueActive ? T.ink : T.ink2;
      ctx.font = `bold 12.1px ${TOKENS.font.mono}`;
      ctx.fillText('QUEUE', earthButton.x + 16 + (earthButton.w - 16) / 2, 24);
    }

    // Exit button
    const exitBtnIdx = CTRL_BUTTONS.findIndex((b) => b.action === 'exit');
    const exitBtn = CTRL_BUTTONS[exitBtnIdx];
    headerPill(exitBtn, hoveredButton === exitBtnIdx);
    drawIcon(ctx, 'exit', exitBtn.x + exitBtn.w / 2, 24, 14, T.accent);

    // Body controls: mode/curve pills left, transport centre, lock/audio pills
    // right, then a row of icon tiles for reel and pack actions.
    const ACTION_ICON = {
      like: 'like', save_reel: 'save', share_reel: 'share', follow: 'follow',
      profile: 'profile', report: 'report', save_pack: 'save', share_pack: 'share',
    };
    for (let i = 0; i < CTRL_BUTTONS.length; i++) {
      const btn = CTRL_BUTTONS[i];
      if (btn.action === 'comments' || btn.action === 'earth' || btn.action === 'exit' || btn.action === 'seek') continue;
      if (!isControlVisible(btn.action, source, itemState, packMode, sceneMode)) continue;

      const isHover = (hoveredButton === i);
      const isPressed = (pressedButton === i);
      const cy = btn.y + btn.h / 2;

      // Side pills: icon, then the live state label.
      if (btn.action === 'mode' || btn.action === 'curve' || btn.action === 'lock' || btn.action === 'mute') {
        const lit = btn.action === 'lock' && lockToViewer;
        const ink = bodyButton(btn, isHover, isPressed, lit);
        let label, icon = null, glyph = null;
        if (btn.action === 'mode') {
          label = packMode ? 'AUTHORED' : (autoNext ? 'AUTO' : 'LOOP');
          icon = (packMode || autoNext) ? 'mode-auto' : 'mode-loop';
        } else if (btn.action === 'curve') {
          label = curvatureMode === 1 ? 'DOME' : (curvatureMode === 2 ? 'SQ CURVE' : 'FLAT');
          icon = curvatureMode === 1 ? 'display-dome' : (curvatureMode === 2 ? 'display-sq-curve' : 'display-flat');
        } else if (btn.action === 'lock') {
          label = lockToViewer ? 'LOCK' : 'FREE';
          glyph = lockToViewer ? 'lock' : 'unlock';
        } else {
          label = isMuted ? 'MUTED' : 'AUDIO';
          icon = isMuted ? 'sound-mute' : 'sound-audio';
        }
        if (icon) drawIcon(ctx, icon, btn.x + 24, cy, 20, ink);
        else drawGlyph(ctx, glyph, btn.x + 24, cy, 15, (isHover || lit) ? T.accent : T.ink2);
        ctx.fillStyle = ink;
        ctx.font = `bold 12px ${TOKENS.font.mono}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, btn.x + 46, cy);
        continue;
      }

      // Primary play/pause: solid vermilion, chamfered like play.svg.
      if (btn.action === 'play') {
        chamferPath(ctx, btn.x, btn.y, btn.w, btn.h, 10);
        ctx.fillStyle = (isPressed || isHover) ? T.accentHi : T.accent;
        ctx.fill();
        const cx = btn.x + btn.w / 2;
        ctx.fillStyle = T.onAccent;
        ctx.beginPath();
        if (isPaused) {
          ctx.moveTo(cx - 8, cy - 13); ctx.lineTo(cx + 13, cy); ctx.lineTo(cx - 8, cy + 13);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(cx - 10, cy - 12, 6, 24);
          ctx.fillRect(cx + 4, cy - 12, 6, 24);
        }
        continue;
      }

      // Secondary transport (rew, prev, next, fwd)
      if (btn.action === 'rew' || btn.action === 'prev' || btn.action === 'next' || btn.action === 'fwd') {
        bodyButton(btn, isHover, isPressed, false);
        drawIcon(ctx, btn.action, btn.x + btn.w / 2, cy, btn.w >= 52 ? 26 : 22, T.ink);
        continue;
      }

      // Action tiles: icon over a mono caption; COLLECT spans two slots with
      // the caption beside the icon. Liked / saved (SAVE and COLLECT) / followed tiles stay lit.
      const lit = (btn.action === 'like' && itemState.liked) ||
        ((btn.action === 'save_reel' || btn.action === 'collect') && itemState.saved) ||
        (btn.action === 'follow' && itemState.following);
      const ink = bodyButton(btn, isHover, isPressed, lit);
      ctx.font = `bold 10px ${TOKENS.font.mono}`;
      ctx.textBaseline = 'middle';
      if (btn.action === 'collect') {
        drawIcon(ctx, 'collect', btn.x + btn.w / 2 - 34, cy, 22, ink);
        ctx.font = `bold 12px ${TOKENS.font.mono}`;
        ctx.fillStyle = lit ? T.accentHi : ink;
        ctx.textAlign = 'left';
        ctx.fillText(btn.label, btn.x + btn.w / 2 - 16, cy);
        continue;
      }
      drawIcon(ctx, ACTION_ICON[btn.action], btn.x + btn.w / 2, btn.y + 18, 22, ink);
      ctx.fillStyle = lit ? T.accentHi : ink;
      ctx.textAlign = 'center';
      ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + 38);
    }

    // Reel | pack divider on the action row
    if (isControlVisible('save_pack', source, itemState, packMode, sceneMode) &&
        isControlVisible('like', source, itemState, packMode, sceneMode)) {
      ctx.fillStyle = T.ruleStrong;
      ctx.fillRect(589, 196, 1, 32);
    }

    // Scrubber track with the times either side
    const trackBtn = CTRL_BUTTONS.find((b) => b.action === 'seek');
    if (trackBtn && isControlVisible('seek', source, itemState, packMode, sceneMode)) {
      const ty = trackBtn.y + trackBtn.h / 2;
      ctx.fillStyle = T.surface3;
      ctx.fillRect(trackBtn.x, ty - 3, trackBtn.w, 6);
      ctx.fillStyle = T.accent;
      ctx.fillRect(trackBtn.x, ty - 3, trackBtn.w * progress, 6);
      // Square scrubber thumb
      ctx.fillStyle = T.ink;
      ctx.fillRect(trackBtn.x + trackBtn.w * progress - 3, ty - 9, 6, 18);

      ctx.fillStyle = T.ink3;
      ctx.font = `12px ${TOKENS.font.mono}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(formatTime(currentTime), 24, ty);
      ctx.textAlign = 'right';
      ctx.fillText(formatTime(duration), 776, ty);
    }

    // Transient notice (set by showNotification); drawn last so it sits over the controls.
    const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    if (notificationText && notificationUntil > nowMs) {
      const stripW = Math.min(size.w - 48, 560);
      const stripX = (size.w - stripW) / 2;
      const stripH = 36;
      const stripY = size.h - stripH - 12;
      ctx.fillStyle = TOKENS.hex.surface2;
      ctx.fillRect(stripX, stripY, stripW, stripH);
      ctx.fillStyle = TOKENS.hex.accent;
      ctx.fillRect(stripX, stripY, stripW, 2);
      ctx.fillStyle = TOKENS.hex.ink;
      ctx.font = `bold 14px ${TOKENS.font.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let label = String(notificationText);
      while (label.length > 1 && ctx.measureText(label).width > stripW - 24) label = label.slice(0, -2) + '…';
      ctx.fillText(label, stripX + stripW / 2, stripY + stripH / 2 + 1);
    }
  }

  // ─── Resolve Controls Hit ──────────────────────────────────────────
  function resolveControlsHit(canvasX, canvasY, options = {}) {
    for (let i = 0; i < CTRL_BUTTONS.length; i++) {
      const btn = CTRL_BUTTONS[i];
      if (!isDockControlLive(btn.action, options)) continue;
      if (canvasX >= btn.x && canvasX <= btn.x + btn.w &&
          canvasY >= btn.y && canvasY <= btn.y + btn.h) {
        return i;
      }
    }
    return -1;
  }

  // ─── Resolve Comments Region ────────────────────────────────────────
  // Creator of the reel shown in the panel's creator block (null when unavailable).
  function cpCreator(item) {
    return item && item.available !== false ? (item.creator || null) : null;
  }
  // FOLLOW shows for a creator with a handle unless the page hides it (own post).
  function cpFollowVisible(item, itemState) {
    const creator = cpCreator(item);
    return !!(creator && creator.username && (itemState || {}).canFollow !== false);
  }
  function filterPanelComments(comments, cPanelTab) {
    if (cPanelTab !== 'general') return comments;
    return comments.filter((c) => c.timestamp === null || c.timestamp === undefined);
  }
  // Comment head row, shared by render and hit test: the time pill follows the
  // name; general comments get no pill.
  function cpCommentHead(c, itemX, y) {
    let name = c.author_name || 'Anonymous';
    if (name.length > 16) name = name.slice(0, 15) + '…';
    const nameEnd = itemX + 56 + Math.ceil(name.length * CP_NAME_CHAR_W);
    const hasTime = c.timestamp !== null && c.timestamp !== undefined;
    const time = hasTime ? formatTime(c.timestamp) : '';
    const pill = hasTime ? { x: nameEnd + 10, y: y + 9, w: 36 + time.length * 6, h: 22 } : null;
    return { name, nameEnd, time, pill };
  }

  function resolveCommentsPanelRegion(canvasX, canvasY, options = {}) {
    const { comments = [], cPanelTab = 'all', cPanelScrollY = 0, item = null, itemState = {} } = options;
    const filtered = filterPanelComments(comments, cPanelTab);
    const inBox = (b) => canvasX >= b.x && canvasX < b.x + b.w && canvasY >= b.y && canvasY < b.y + b.h;

    if (canvasY < CP_INFO_H) {
      if (inBox(CP_CLOSE_BTN)) return 'close';
      if (cpFollowVisible(item, itemState) && inBox(cpFollowBtn(!!itemState.following))) return 'follow';
      const creator = cpCreator(item);
      if (creator && creator.username && canvasX >= 20 && canvasX < 400 && canvasY >= 20 && canvasY < 68) return 'creator';
      return 'panel';
    }

    if (canvasY < CP_LIST_TOP) {
      // Time-sync toggle: on lists every comment, off lists general only.
      if (inBox(CP_SYNC_BTN)) return cPanelTab === 'general' ? 'tab:all' : 'tab:general';
      return 'panel';
    }

    if (canvasY > CP_LIST_BOTTOM) {
      if (canvasY >= CP_LIST_BOTTOM + 10 && canvasY < CP_LIST_BOTTOM + 44 && canvasX >= 16 && canvasX < 216) return 'account';
      if (canvasY >= CP_LIST_BOTTOM + 54 && canvasY < CP_LIST_BOTTOM + 98 && canvasX >= 16 && canvasX < CPANEL_W - 16) return 'add';
      return 'panel';
    }

    if (canvasX >= CP_SCROLL_X) {
      if (canvasY >= CP_LIST_TOP && canvasY < CP_LIST_TOP + 26) return 'scrollup';
      if (canvasY >= CP_LIST_BOTTOM - 26 && canvasY < CP_LIST_BOTTOM) return 'scrolldown';
      return 'scrollbar';
    }

    const relY = canvasY - CP_LIST_TOP + cPanelScrollY;
    const idx = Math.floor(relY / (CP_ITEM_H + CP_ITEM_GAP));
    if (idx >= 0 && idx < filtered.length) {
      const c = filtered[idx];
      const y = CP_LIST_TOP + idx * (CP_ITEM_H + CP_ITEM_GAP) - cPanelScrollY;
      const itemX = CP_LIST_X + 10;
      const itemW = CP_LIST_W - 20;
      if (canvasY >= y + 4 && canvasY < y + 36) {
        const head = cpCommentHead(c, itemX, y);
        if (canvasX >= itemX + 8 && canvasX < head.nameEnd + 4) return 'profile:' + (c.author_name || '');
        if (head.pill && canvasX >= head.pill.x && canvasX < head.pill.x + head.pill.w) return 'seek:' + c.id;
        if (canvasX >= itemX + itemW - 74 && canvasX < itemX + itemW - 6) return 'like:' + c.id;
      }
    }
    return 'list';
  }

  // ─── Render Comments Panel ──────────────────────────────────────────
  // Creator block, mirroring the 2D docked column: avatar, name, handle + age,
  // FOLLOW, title, caption, chips (tags, place, specs) and the stats row.
  function renderCommentsPanelInfo(ctx, item, itemState, comments, cPanelHover) {
    const accent = TOKENS.hex.accent;
    const unavailable = !item || item.available === false;
    const creator = cpCreator(item);
    const following = !!itemState.following;
    const showFollow = cpFollowVisible(item, itemState);

    ctx.fillStyle = TOKENS.hex.bg;
    ctx.fillRect(0, 3, CPANEL_W, CP_INFO_H - 3);

    // Avatar
    ctx.fillStyle = '#121417';
    ctx.fillRect(20, 20, 48, 48);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(20, 20, 48, 48);
    if (creator) {
      ctx.fillStyle = accent;
      ctx.font = `800 20px ${TOKENS.font.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(creator.display_name || creator.username || '?').slice(0, 1).toUpperCase(), 44, 45);
    }

    // Name + "@handle · AGE"
    const textW = (showFollow ? cpFollowBtn(following).x : CP_CLOSE_BTN.x) - 88;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (creator && creator.username) {
      ctx.fillStyle = cPanelHover === 'creator' ? TOKENS.hex.ink : accent;
      ctx.font = `700 16px ${TOKENS.font.mono}`;
      ctx.fillText(wrapTextLines(ctx, creator.display_name || creator.username, textW, 1)[0] || '', 80, 34);
    }
    const age = unavailable ? '' : relativeAge(item.created_at);
    const handle = creator && creator.username ? '@' + creator.username : '';
    ctx.fillStyle = TOKENS.hex.ink3;
    ctx.font = `600 11px ${TOKENS.font.mono}`;
    ctx.fillText(wrapTextLines(ctx, [handle, age].filter(Boolean).join(' · '), textW, 1)[0] || '', 80, 56);

    // FOLLOW / FOLLOWING
    if (showFollow) {
      const b = cpFollowBtn(following);
      const hover = cPanelHover === 'follow';
      const tone = following ? TOKENS.hex.infoHi : accent;
      ctx.fillStyle = hover ? TOKENS.hex.surface3 : TOKENS.hex.surface2;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = following ? TOKENS.hex.infoHi : (hover ? accent : TOKENS.hex.ruleStrong);
      ctx.lineWidth = following ? 2 : 1;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      // 12px pad, 18px icon, 8px gap, label, 12px pad.
      drawIcon(ctx, 'follow', b.x + 21, b.y + b.h / 2, 18, following ? TOKENS.hex.infoHi : TOKENS.hex.ink, accent, TOKENS.hex.surface2);
      ctx.fillStyle = tone;
      ctx.font = `700 11px ${TOKENS.font.mono}`;
      ctx.textAlign = 'left';
      ctx.fillText(following ? 'FOLLOWING' : 'FOLLOW', b.x + 38, b.y + b.h / 2 + 1);
    }

    // Title + caption
    let y = 84;
    ctx.textBaseline = 'top';
    ctx.fillStyle = TOKENS.hex.ink;
    ctx.font = `800 15px ${TOKENS.font.sans}`;
    const title = unavailable ? 'Reel unavailable' : (item.title || item.filename || '');
    wrapTextLines(ctx, String(title).toUpperCase(), CPANEL_W - 40, 2).forEach((line) => {
      ctx.fillText(line, 20, y);
      y += 20;
    });
    const caption = unavailable ? '' : String(item.caption || '').trim();
    if (caption) {
      y += 4;
      ctx.fillStyle = TOKENS.hex.ink2;
      ctx.font = `400 12px ${TOKENS.font.sans}`;
      wrapTextLines(ctx, caption, CPANEL_W - 40, 2).forEach((line) => {
        ctx.fillText(line, 20, y);
        y += 16;
      });
    }

    // Chips: #tags, place, then specs (3D layout, duration). One row; extras drop.
    const chips = [];
    if (!unavailable) {
      (item.tags || []).forEach((tag) => {
        const label = String(tag).replace(/^#/, '');
        if (label) chips.push({ kind: 'tag', text: '#' + label });
      });
      const location = item.location || {};
      const place = [location.city, location.country].filter(Boolean).join(', ') || location.display_name || '';
      if (place) chips.push({ kind: 'place', text: place });
      const stereo = item.stereo_layout;
      if (Number(item.width) > 0 && Number(item.height) > 0 && (stereo === 'sbs' || stereo === 'tb')) {
        chips.push({ kind: 'spec', key: '3D', text: stereo === 'sbs' ? 'SIDE-BY-SIDE' : 'TOP-BOTTOM' });
      }
      const durationMs = Number(item.duration_ms);
      if (durationMs > 0 && item.media_type !== 'image') chips.push({ kind: 'spec', key: 'DUR', text: formatTime(durationMs / 1000) });
    }
    if (chips.length) {
      const chipY = y + 8;
      let x = 20;
      ctx.font = `600 10px ${TOKENS.font.mono}`;
      ctx.textBaseline = 'middle';
      for (const chip of chips) {
        const keyW = chip.key ? ctx.measureText(chip.key + ' ').width : 0;
        const w = Math.ceil(keyW + ctx.measureText(chip.text).width) + 16;
        if (x + w > CPANEL_W - 20) break;
        ctx.fillStyle = '#121417';
        ctx.fillRect(x, chipY, w, 22);
        ctx.strokeStyle = chip.kind === 'tag' ? 'rgba(255, 59, 31, 0.3)' : TOKENS.hex.rule;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, chipY, w, 22);
        if (chip.key) {
          ctx.fillStyle = TOKENS.hex.ink3;
          ctx.font = `700 10px ${TOKENS.font.mono}`;
          ctx.fillText(chip.key, x + 8, chipY + 11);
          ctx.font = `600 10px ${TOKENS.font.mono}`;
        }
        ctx.fillStyle = chip.kind === 'tag' ? accent : (chip.kind === 'spec' ? TOKENS.hex.ink : TOKENS.hex.ink2);
        ctx.fillText(chip.text, x + 8 + keyW, chipY + 11);
        x += w + 6;
      }
    }

    // Stats row
    const stats = [
      ['LIKES', unavailable ? '0' : fmtCount(item.likes)],
      ['COMMENTS', unavailable ? '0' : fmtCount(comments.length)],
      ['VIEWS', unavailable ? '0' : fmtCount(item.views)],
    ];
    const statsW = CPANEL_W - 40;
    const cellW = statsW / stats.length;
    ctx.fillStyle = '#121417';
    ctx.fillRect(20, CP_STATS_Y, statsW, 46);
    ctx.strokeStyle = TOKENS.hex.rule;
    ctx.lineWidth = 1;
    ctx.strokeRect(20, CP_STATS_Y, statsW, 46);
    ctx.fillStyle = TOKENS.hex.rule;
    for (let i = 1; i < stats.length; i++) ctx.fillRect(20 + cellW * i, CP_STATS_Y, 1, 46);
    ctx.textAlign = 'center';
    stats.forEach(([label, value], i) => {
      const cx = 20 + cellW * i + cellW / 2;
      ctx.fillStyle = TOKENS.hex.ink3;
      ctx.font = `600 9px ${TOKENS.font.mono}`;
      ctx.fillText(label, cx, CP_STATS_Y + 15);
      ctx.fillStyle = TOKENS.hex.ink;
      ctx.font = `800 15px ${TOKENS.font.sans}`;
      ctx.fillText(value, cx, CP_STATS_Y + 32);
    });

    ctx.fillStyle = TOKENS.hex.rule;
    ctx.fillRect(0, CP_INFO_H - 1, CPANEL_W, 1);
  }

  function renderCommentsPanelCanvas(ctx, options = {}) {
    if (!ctx) return;
    const {
      comments = [],
      cPanelTab = 'all',
      cPanelScrollY = 0,
      cPanelHover = '',
      cPanelHighlightId = null,
      user = null,
      currentTime = 0,
      item = null,
      itemState = {},
    } = options;
    const hover = cPanelHover || '';
    const filtered = filterPanelComments(comments, cPanelTab);

    const listH = CP_LIST_BOTTOM - CP_LIST_TOP;
    const contentH = filtered.length * (CP_ITEM_H + CP_ITEM_GAP);
    const accent = TOKENS.hex.accent;

    ctx.clearRect(0, 0, CPANEL_W, CPANEL_H);

    // Container
    ctx.fillStyle = 'rgba(13, 14, 15, 0.97)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, CPANEL_W, CPANEL_H, TOKENS.radius);
    else ctx.rect(0, 0, CPANEL_W, CPANEL_H);
    ctx.fill();
    ctx.strokeStyle = TOKENS.hex.ruleStrong;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, CPANEL_W, 3);

    renderCommentsPanelInfo(ctx, item, itemState || {}, comments, hover);

    // Header
    const headY = CP_INFO_H + CP_HEADER_H / 2;
    ctx.fillStyle = '#0d0e0f';
    ctx.fillRect(0, CP_INFO_H, CPANEL_W, CP_HEADER_H);
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = accent;
    drawGlyph(ctx, 'chat', 24, headY, 12, accent);
    ctx.font = `700 11px ${TOKENS.font.mono}`;
    ctx.fillText('COMMENTS', 40, headY);
    ctx.fillStyle = TOKENS.hex.accentHi;
    const titleW = ctx.measureText('COMMENTS').width;
    ctx.fillText('(' + comments.length + ')', 40 + titleW + 10, headY);

    // Time-sync toggle: lit while synced comments are included (default).
    const syncOn = cPanelTab !== 'general';
    const syncHover = hover.indexOf('tab:') === 0;
    const sb = CP_SYNC_BTN;
    ctx.fillStyle = syncHover ? TOKENS.hex.surface3 : TOKENS.hex.surface2;
    ctx.fillRect(sb.x, sb.y, sb.w, sb.h);
    ctx.strokeStyle = syncOn || syncHover ? accent : TOKENS.hex.ruleStrong;
    ctx.lineWidth = syncOn ? 1.5 : 1;
    ctx.strokeRect(sb.x, sb.y, sb.w, sb.h);
    drawIcon(ctx, 'timesync', sb.x + sb.w / 2, sb.y + sb.h / 2, 20,
      syncOn ? TOKENS.hex.ink : TOKENS.hex.inkMuted, syncOn ? accent : TOKENS.hex.inkMuted, TOKENS.hex.surface2);

    // Close button
    const cb = CP_CLOSE_BTN;
    ctx.fillStyle = hover === 'close' ? TOKENS.hex.surface3 : TOKENS.hex.surface2;
    ctx.strokeStyle = hover === 'close' ? accent : TOKENS.hex.ruleStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cb.x, cb.y, cb.w, cb.h, TOKENS.radius);
    else ctx.rect(cb.x, cb.y, cb.w, cb.h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = hover === 'close' ? TOKENS.hex.ink : accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✕', cb.x + cb.w / 2, cb.y + cb.h / 2);

    // List items
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, CP_LIST_TOP, CP_LIST_X + CP_LIST_W, listH);
    ctx.clip();

    if (filtered.length === 0) {
      ctx.fillStyle = accent;
      ctx.font = `700 10px ${TOKENS.font.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO COMMENTS YET', CPANEL_W / 2, CP_LIST_TOP + 40);
    } else {
      filtered.forEach((c, i) => {
        const y = CP_LIST_TOP + i * (CP_ITEM_H + CP_ITEM_GAP) - cPanelScrollY;
        if (y + CP_ITEM_H < CP_LIST_TOP || y > CP_LIST_BOTTOM) return;

        const itemX = CP_LIST_X + 10;
        const itemW = CP_LIST_W - 20;
        const border = c.avatar_color || accent;
        const highlighted = (c.id === cPanelHighlightId);

        ctx.fillStyle = highlighted ? '#1c1d1f' : '#121315';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(itemX, y, itemW, CP_ITEM_H, TOKENS.radius);
        else ctx.rect(itemX, y, itemW, CP_ITEM_H);
        ctx.fill();
        ctx.strokeStyle = highlighted ? accent : TOKENS.hex.ruleStrong;
        ctx.lineWidth = highlighted ? 2.5 : 1;
        ctx.stroke();

        ctx.fillStyle = border;
        ctx.fillRect(itemX, y, 3, CP_ITEM_H);

        // Avatar
        ctx.fillStyle = TOKENS.hex.surface2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(itemX + 8, y + 12, 40, 40, TOKENS.radius);
        else ctx.rect(itemX + 8, y + 12, 40, 40);
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.stroke();
        ctx.fillStyle = border;
        ctx.font = `700 11px ${TOKENS.font.mono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(getInitials(c.author_name), itemX + 28, y + 33);

        // Author name, then the time pill right after it (none for general)
        const head = cpCommentHead(c, itemX, y);
        ctx.fillStyle = border;
        ctx.font = `700 11px ${TOKENS.font.mono}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(head.name, itemX + 56, y + 20);

        if (head.pill) {
          const p = head.pill;
          ctx.fillStyle = hover === 'seek:' + c.id ? accent : TOKENS.hex.surface3;
          ctx.strokeStyle = accent;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(p.x, p.y, p.w, p.h, TOKENS.radius);
          else ctx.rect(p.x, p.y, p.w, p.h);
          ctx.fill();
          ctx.stroke();
          drawIcon(ctx, 'timesync', p.x + 15, p.y + p.h / 2, 14, TOKENS.hex.ink, accent, TOKENS.hex.surface3);
          ctx.fillStyle = hover === 'seek:' + c.id ? TOKENS.hex.ink : TOKENS.hex.accentHi;
          ctx.font = `700 10px ${TOKENS.font.mono}`;
          ctx.fillText(head.time, p.x + 28, p.y + p.h / 2 + 1);
        }

        // Like: heart + count
        const liked = !!c.liked_by_me;
        const likeHover = hover === 'like:' + c.id;
        const likeTone = liked ? accent : TOKENS.hex.ink;
        drawIcon(ctx, 'like', itemX + itemW - 56, y + 20, 24, likeHover && !liked ? accent : likeTone, accent, '#121315');
        ctx.fillStyle = likeTone;
        ctx.font = `700 12px ${TOKENS.font.mono}`;
        ctx.textAlign = 'left';
        ctx.fillText(fmtCount(c.likes), itemX + itemW - 40, y + 21);

        // Text
        ctx.fillStyle = TOKENS.hex.ink;
        ctx.font = '500 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const lines = wrapTextLines(ctx, c.text || '', itemW - 70, 2);
        lines.forEach((line, li) => {
          ctx.fillText(line, itemX + 56, y + 36 + li * 18);
        });
      });
    }
    ctx.restore();

    // Footer
    const footerY = CP_LIST_BOTTOM + 4;
    ctx.fillStyle = '#0d0e0f';
    ctx.fillRect(0, footerY, CPANEL_W, CPANEL_H - footerY);

    const addHover = cPanelHover === 'add';
    ctx.fillStyle = addHover ? '#ff6a52' : accent;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(16, footerY + 54, CPANEL_W - 32, 44, TOKENS.radius);
    else ctx.rect(16, footerY + 54, CPANEL_W - 32, 44);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = TOKENS.hex.onAccent;
    ctx.font = `bold 11px ${TOKENS.font.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+ ADD COMMENT', CPANEL_W / 2, footerY + 77);
  }

  // ─── Render In-Screen Popup Comment Overlay ─────────────────────────
  // Upstream v5.2 renderOverlayCanvas verbatim: time-synced comments in the
  // active window [timestamp, timestamp + 4.2s], up to 3 stacked on the
  // middle-left of the 1:1 square canvas. Returns the clickable hitbox list
  // (empty when nothing is active); the engine keeps it for hover/click.
  // Time-synced comments inside the active window [timestamp, timestamp +
  // 4.2s]. Shared by renderOverlayCanvas and the engine's dirty check so the
  // overlay only re-renders when the visible set actually changes.
  function filterOverlayComments(comments, currentTime) {
    return (comments || []).filter((c) => {
      if (!c || c.timestamp === null || c.timestamp === undefined) return false;
      const t = Number(c.timestamp);
      return currentTime >= t && currentTime <= (t + 4.2);
    });
  }

  function renderOverlayCanvas(ctx, options = {}) {
    const { comments = [], currentTime = 0, overlayHoverId = null } = options;
    const regions = [];
    if (!ctx) return regions;

    const active = filterOverlayComments(comments, currentTime);

    ctx.clearRect(0, 0, OVERLAY_W, OVERLAY_H);
    if (active.length === 0) return regions;

    // Up to 3 stacked comments on the middle-left area of the 1:1 square canvas
    const maxShow = Math.min(3, active.length);
    const itemHeight = 60;
    const gap = 11;
    const totalH = maxShow * itemHeight + (maxShow - 1) * gap;
    const startY = (OVERLAY_H / 2) - (totalH / 2);

    for (let i = 0; i < maxShow; i++) {
      const c = active[i];
      const y = startY + i * (itemHeight + gap);
      const x = 0.10 * OVERLAY_W; // 10% gap from the left side of the reels
      const isHovered = (c.id === overlayHoverId);

      // Progress fade-in / fade-out alpha
      const elapsed = currentTime - Number(c.timestamp);
      let alpha = 1.0;
      if (elapsed < 0.35) {
        alpha = Math.max(0, elapsed / 0.35);
      } else if (elapsed > 3.6) {
        alpha = Math.max(0, (4.2 - elapsed) / 0.6);
      }

      ctx.save();
      ctx.globalAlpha = alpha;

      // Shadow for high-contrast legibility over video — no background box,
      // but with the 2D twitch-comment-pill typography AND its left accent line.
      ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;

      const authorColor = c.avatar_color || TOKENS.hex.accent;
      const authorName = c.author_name || 'Anonymous';
      const hasTime = c.timestamp !== null && c.timestamp !== undefined;
      const timeStr = hasTime ? formatTime(c.timestamp) : '';

      // Vertical accent line (mirrors the 3px border-left of .twitch-comment-pill)
      const barW = 3;
      const contentX = x + barW + 10; // gap like pill border-left + padding

      // Prepare display text early so the hover pill can be sized and drawn
      // FIRST (behind) so it never covers the accent bar, avatar or name.
      ctx.font = '500 14px "Archivo", sans-serif';
      let dispText = c.text;
      if (dispText.length > 46) {
        dispText = dispText.slice(0, 44) + '…';
      }
      const textW = ctx.measureText(dispText).width;
      const regionW = Math.max(260, textW + 90);
      const regionX = x - 12;
      const regionY = y - 6;
      const regionH = itemHeight + 12;

      // Hover / click affordance background — drawn behind all pill content
      if (isHovered) {
        ctx.fillStyle = 'rgba(18, 19, 21, 0.78)';
        ctx.strokeStyle = TOKENS.hex.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(regionX, regionY, regionW, regionH, TOKENS.radius);
        else ctx.rect(regionX, regionY, regionW, regionH);
        ctx.fill();
        ctx.stroke();
      }

      ctx.fillStyle = authorColor;
      ctx.fillRect(x, y + 8, barW, itemHeight - 16);

      const avatarX = contentX + 25;
      const nameX = contentX + 50;
      const textX = contentX + 50;
      const nameY = y + 11;
      const timeY = y + 14;
      const textY = y + 32;

      // Avatar Icon / Emoji (Middle-Left, like .twitch-avatar)
      ctx.font = '22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.author_avatar || getInitials(c.author_name || 'Anonymous'), avatarX, y + itemHeight / 2);

      // Author Name — bold colored like .twitch-author
      ctx.font = '800 13px "Archivo", sans-serif';
      ctx.fillStyle = authorColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(authorName, nameX, nameY);
      const nameW = ctx.measureText(authorName).width;

      // Timestamp tag — muted monospace like .twitch-tag
      if (hasTime) {
        ctx.font = `700 11px ${TOKENS.font.mono}`;
        ctx.fillStyle = TOKENS.hex.ink2;
        ctx.fillText(timeStr, nameX + nameW + 8, timeY);
      }

      // Comment Text — light Archivo like .twitch-text
      ctx.font = '500 14px "Archivo", sans-serif';
      ctx.fillStyle = TOKENS.hex.ink;
      ctx.textBaseline = 'top';
      ctx.fillText(dispText, textX, textY);

      // Record the clickable hitbox for this pop-up comment
      regions.push({ id: c.id, x: regionX, y: regionY, w: regionW, h: regionH });

      ctx.restore();
    }

    return regions;
  }

  // Map an overlay-canvas hit point to a pop-up comment id, if any
  // (upstream overlayCommentAtHit, regions threaded from renderOverlayCanvas).
  function resolveOverlayCommentAt(canvasX, canvasY, regions) {
    if (!regions || regions.length === 0) return null;
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      if (canvasX >= r.x && canvasX <= r.x + r.w && canvasY >= r.y && canvasY <= r.y + r.h) return r.id;
    }
    return null;
  }

  // ─── Render Controller Guide Panel ────────────────────────────────────
  // ECHO-styled guide (2026-10-24 redesign of the upstream v5.2 panel): the
  // Quest controller PHOTO (`window.QUEST_CONTROLLER_B64`, injected by the
  // backend from `ui/assets/quest_controller_img.js`) with the vector drawing
  // as the fallback, above a control table using the v8.3 control mapping.
  let guidePhoto = null;
  let guidePhotoState = 'idle'; // 'idle' | 'loading' | 'ready' | 'missing'
  let guideArtworkDirty = false;

  function ensureGuidePhoto() {
    if (guidePhotoState !== 'idle') return;
    let src = '';
    try {
      src = (typeof window !== 'undefined' && window.QUEST_CONTROLLER_B64) || '';
    } catch (e) { src = ''; }
    if (!src || typeof Image === 'undefined') {
      guidePhotoState = 'missing';
      return;
    }
    guidePhotoState = 'loading';
    try {
      const img = new Image();
      img.onload = () => {
        guidePhoto = img;
        guidePhotoState = 'ready';
        guideArtworkDirty = true; // engine re-renders + re-uploads once
      };
      img.onerror = () => { guidePhotoState = 'missing'; };
      img.src = src;
    } catch (e) {
      guidePhotoState = 'missing';
    }
  }

  function isGuideArtworkDirty() { return guideArtworkDirty; }
  function clearGuideArtworkDirty() { guideArtworkDirty = false; }
  function drawQuestController(ctx, cx, cy, scale) {
    const s = scale || 1.0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);

    // ── Controller Handle (ergonomic curved grip) ──
    ctx.fillStyle = '#1A1B1F';
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-16, 20);
    ctx.bezierCurveTo(-18, 55, -20, 100, -16, 140);
    ctx.bezierCurveTo(-14, 155, 14, 155, 16, 140);
    ctx.bezierCurveTo(20, 100, 18, 55, 16, 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Handle texture lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 6; i++) {
      const ly = 50 + i * 16;
      ctx.beginPath();
      ctx.moveTo(-12, ly);
      ctx.lineTo(12, ly);
      ctx.stroke();
    }

    // ── Tracking Ring (circular halo around top) ──
    ctx.strokeStyle = '#2A2C32';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(0, -18, 52, 42, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Ring inner highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, -18, 50, 40, 0, Math.PI * 0.9, Math.PI * 1.9);
    ctx.stroke();

    // ── Top Face Plate ──
    ctx.fillStyle = '#222428';
    ctx.beginPath();
    ctx.ellipse(0, -5, 38, 28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#333640';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // ── Thumbstick (left position on face) ──
    ctx.fillStyle = '#0D0E11';
    ctx.beginPath();
    ctx.arc(-14, -12, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#18191D';
    ctx.beginPath();
    ctx.arc(-14, -12, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(-14, -12, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = TOKENS.hex.accent;
    ctx.beginPath();
    ctx.arc(-14, -12, 2, 0, Math.PI * 2);
    ctx.fill();

    // ── A Button (lower right) ──
    ctx.fillStyle = TOKENS.hex.accent;
    ctx.shadowColor = 'rgba(255, 59, 31, 0.5)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(14, -2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = TOKENS.hex.ink;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A', 14, -2);

    // ── B Button (upper right) ──
    ctx.fillStyle = TOKENS.hex.accent;
    ctx.shadowColor = 'rgba(255, 59, 31, 0.35)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(20, -22, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = TOKENS.hex.ink;
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('B', 20, -22);

    // ── Index Trigger (front curved) ──
    ctx.fillStyle = '#2A2C32';
    ctx.strokeStyle = TOKENS.hex.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-12, 18);
    ctx.bezierCurveTo(-14, 28, -10, 36, -2, 38);
    ctx.bezierCurveTo(4, 36, 8, 28, 6, 18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // ── Side Grip Button ──
    ctx.fillStyle = '#2A2C32';
    ctx.strokeStyle = 'rgba(255, 59, 31, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-24, 55, 8, 30, TOKENS.radius);
    else ctx.rect(-24, 55, 8, 30);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  // The photo's own content (callouts + controller) without its baked frame
  // and corner marks, as fractions of the 542x900 source.
  const GUIDE_PHOTO_CROP = { x: 47 / 542, y: 82 / 900, w: 448 / 542, h: 698 / 900 };

  function renderGuideCanvas(ctx) {
    if (!ctx) return;
    ensureGuidePhoto();

    const accent = TOKENS.hex.accent;
    ctx.clearRect(0, 0, GUIDE_W, GUIDE_H);

    // Container (ECHO, matching the comments panel)
    ctx.fillStyle = 'rgba(13, 14, 15, 0.97)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, GUIDE_W, GUIDE_H, TOKENS.radius);
    else ctx.rect(0, 0, GUIDE_W, GUIDE_H);
    ctx.fill();
    ctx.strokeStyle = TOKENS.hex.ruleStrong;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, GUIDE_W, 3);

    // Header
    const headerH = 52;
    ctx.fillStyle = '#0d0e0f';
    ctx.fillRect(0, 3, GUIDE_W, headerH - 3);
    ctx.fillStyle = TOKENS.hex.rule;
    ctx.fillRect(0, headerH - 1, GUIDE_W, 1);
    ctx.fillStyle = accent;
    ctx.fillRect(20, 23, 8, 8);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = TOKENS.hex.ink;
    ctx.font = `700 14px ${TOKENS.font.mono}`;
    ctx.fillText('CONTROLLER GUIDE', 38, 28);
    ctx.textAlign = 'right';
    ctx.fillStyle = TOKENS.hex.ink3;
    ctx.font = `600 11px ${TOKENS.font.mono}`;
    ctx.fillText('META QUEST 3', GUIDE_W - 20, 28);

    // Controller photo, cropped to its content (vector drawing as fallback)
    const photoW = GUIDE_W - 32;
    const photoH = 636;
    const photoY = headerH + 10;
    if (guidePhotoState === 'ready' && guidePhoto) {
      try {
        const natW = guidePhoto.naturalWidth || guidePhoto.width;
        const natH = guidePhoto.naturalHeight || guidePhoto.height;
        const sx = natW * GUIDE_PHOTO_CROP.x;
        const sy = natH * GUIDE_PHOTO_CROP.y;
        const sw = natW * GUIDE_PHOTO_CROP.w;
        const sh = natH * GUIDE_PHOTO_CROP.h;
        const dh = Math.min(photoH, photoW * (sh / sw));
        const dx = (GUIDE_W - photoW) / 2;
        ctx.drawImage(guidePhoto, sx, sy, sw, sh, dx, photoY, photoW, dh);
        // Fade the photo's edges into the panel so it floats instead of
        // reading as a box (its top-left has a lighter glow).
        const fade = (x0, y0, x1, y1, rx, ry, rw, rh) => {
          const g = ctx.createLinearGradient(x0, y0, x1, y1);
          g.addColorStop(0, 'rgba(13, 14, 15, 1)');
          g.addColorStop(1, 'rgba(13, 14, 15, 0)');
          ctx.fillStyle = g;
          ctx.fillRect(rx, ry, rw, rh);
        };
        fade(0, photoY, 0, photoY + 16, dx, photoY, photoW, 16);
        fade(dx, 0, dx + 10, 0, dx, photoY, 10, dh);
        fade(dx + photoW, 0, dx + photoW - 6, 0, dx + photoW - 6, photoY, 6, dh);
        fade(0, photoY + dh, 0, photoY + dh - 6, dx, photoY + dh - 6, photoW, 6);
      } catch (e) {
        drawQuestController(ctx, GUIDE_W / 2, photoY + 194, 2.6);
      }
    } else {
      drawQuestController(ctx, GUIDE_W / 2, photoY + 194, 2.6);
    }

    // Control table: control name | what it does
    const cards = [
      { title: 'THUMBSTICK', desc: 'Up/Down → Next/Prev Reel|Reels: Left/Right → Seek ±5s|Images: Left/Right → Prev/Next' },
      { title: 'A BUTTON', desc: 'Toggle Play / Pause|In-VR Video Control' },
      { title: 'B BUTTON', desc: 'Toggle Guide & Controls|Show/Hide Overlay' },
      { title: 'INDEX TRIGGER', desc: 'Laser Aim & Click|Tap Video → Play/Pause' },
      { title: 'SIDE GRIP', tag: 'HOLD', desc: '6DOF Drag & Reposition|Only when UNLOCKED' },
      { title: 'GRIP + STICK', desc: '↕ Zoom Screen In / Out|↔ Screen Closer / Further' },
    ];
    const tableX = 16;
    const tableW = GUIDE_W - 32;
    const keyW = 136;
    const padY = 10;
    const lineH = 20;
    const tableY = photoY + photoH + 10;
    const rowH = (card) => padY * 2 + card.desc.split('|').length * lineH;
    const tableH = cards.reduce((sum, card) => sum + rowH(card), 0);
    ctx.fillStyle = TOKENS.hex.surface;
    ctx.fillRect(tableX, tableY, tableW, tableH);
    ctx.fillStyle = TOKENS.hex.surface2;
    ctx.fillRect(tableX, tableY, keyW, tableH);

    let y = tableY;
    cards.forEach((card, i) => {
      const h = rowH(card);
      const lineY = (li) => y + padY + lineH / 2 + li * lineH;
      if (i > 0) {
        ctx.fillStyle = TOKENS.hex.rule;
        ctx.fillRect(tableX, y, tableW, 1);
      }
      ctx.fillStyle = accent;
      ctx.fillRect(tableX, y, 3, h);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TOKENS.hex.accentHi;
      ctx.font = `700 13px ${TOKENS.font.mono}`;
      ctx.fillText(card.title, tableX + 14, lineY(0));
      if (card.tag) {
        ctx.fillStyle = TOKENS.hex.ink3;
        ctx.font = `600 10px ${TOKENS.font.mono}`;
        ctx.fillText(card.tag, tableX + 14, lineY(1));
      }

      ctx.fillStyle = TOKENS.hex.ink;
      ctx.font = `16px ${TOKENS.font.sans}`;
      card.desc.split('|').forEach((line, li) => {
        ctx.fillText(line, tableX + keyW + 12, lineY(li));
      });
      y += h;
    });
    ctx.strokeStyle = TOKENS.hex.rule;
    ctx.lineWidth = 1;
    ctx.strokeRect(tableX + 0.5, tableY + 0.5, tableW - 1, tableH - 1);

    // Footer hint
    ctx.fillStyle = TOKENS.hex.ink2;
    ctx.font = `600 12px ${TOKENS.font.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Press B or ✕ to dismiss', GUIDE_W / 2, (tableY + tableH + GUIDE_H) / 2);
  }

  // ─── Earth HUD: breadcrumb panel ────────────────────────────────────
  // Drawn into 3D billboards by webxr_vr.js (it scales the context to its
  // texture size) and by the Flat Panels workbench. Logical sizes below.
  const EARTH_LABEL_W = 640;
  const EARTH_LABEL_H = 148;
  const EARTH_LABEL_RESET_RECT = { x: 444, y: 112, w: 176, h: 28 };
  // Zoom realms; names + colours follow the globe heat ramp. webxr_vr.js keeps
  // the same list for its zoom logic (a test pins them together).
  const EARTH_TIERS = [
    { name: 'ORBIT', max: 3, color: '#39D7FF' },
    { name: 'REGION', max: 24, color: '#4FE3C1' },
    { name: 'CITY', max: 200, color: '#FFC857' },
    { name: 'STREET', max: Infinity, color: '#FF8A5B' },
  ];
  function earthTierIndex(scale) {
    const s = Math.max(1, Number(scale) || 1);
    for (let i = 0; i < EARTH_TIERS.length; i++) if (s < EARTH_TIERS[i].max) return i;
    return EARTH_TIERS.length - 1;
  }
  function earthRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  function drawEarthScaleBar(ctx, bar) {
    // A missing or UNAVAILABLE bar draws nothing (no stale ruler).
    if (!bar || !ctx || bar.caption === 'UNAVAILABLE' || !(bar.pixels > 0)) return;
    const left = 220 - bar.pixels / 2, right = 220 + bar.pixels / 2;
    ctx.strokeStyle = TOKENS.hex.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, 94); ctx.lineTo(right, 94);
    ctx.moveTo(left, 89); ctx.lineTo(left, 99);
    ctx.moveTo(right, 89); ctx.lineTo(right, 99);
    ctx.stroke();
    ctx.fillStyle = TOKENS.hex.ink;
    ctx.font = '700 15px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(bar.caption, 325, 94);
  }
  function resolveEarthLabelHit(x, y) {
    const b = EARTH_LABEL_RESET_RECT;
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h ? 'face' : null;
  }

  function renderEarthLabelCanvas(ctx, o) {
    if (!ctx) return;
    // Logical space is 640×148; the caller scales the context to its texture.
    ctx.clearRect(0, 0, EARTH_LABEL_W, EARTH_LABEL_H);
    const tierIdx = earthTierIndex(o.scale);
    // ECHO panel language (dock / comments parity): flat glass, square
    // corners, rule border, vermilion top bar. Tier colours stay as data only
    // (chip swatch + realm ladder), matching the globe's heat ramp.
    const accent = TOKENS.hex.accent;
    const ink = TOKENS.hex.ink, ink2 = TOKENS.hex.ink2, ink3 = TOKENS.hex.ink3;
    const inkMuted = TOKENS.hex.inkMuted;
    const rule = TOKENS.hex.rule, ruleStrong = TOKENS.hex.ruleStrong;
    const surface = TOKENS.hex.surface, surface2 = TOKENS.hex.surface2, surface3 = TOKENS.hex.surface3;
    const tier = o.offline ? { name: 'OFFLINE', color: accent } : EARTH_TIERS[tierIdx];
    // Panel body
    earthRoundRect(ctx, 1, 1, 638, EARTH_LABEL_H - 2, 0);
    ctx.fillStyle = 'rgba(13, 14, 15, 0.97)';
    ctx.fill();
    ctx.strokeStyle = ruleStrong;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, EARTH_LABEL_W, 3);
    ctx.textBaseline = 'middle';
    // Tier chip
    ctx.font = '700 12px "JetBrains Mono", monospace';
    const chipText = tier.name;
    const chipW = Math.ceil((ctx.measureText ? ctx.measureText(chipText).width : chipText.length * 7.5)) + 34;
    earthRoundRect(ctx, 18, 14, chipW, 26, 0);
    ctx.fillStyle = surface2;
    ctx.fill();
    ctx.strokeStyle = ruleStrong;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = tier.color;
    ctx.fillRect(28, 23, 8, 8);
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.fillText(chipText, 44, 28);
    // Title (the zoom share is carried by the gauge, not repeated in text)
    const titleText = o.zoomed ? String(o.title).replace(/\s·\s\d+%$/, '') : String(o.title);
    const titleX = 18 + chipW + 14;
    const titleMax = 540 - titleX;
    let fs = 25;
    ctx.fillStyle = ink;
    ctx.font = '700 ' + fs + 'px Archivo, sans-serif';
    while (ctx.measureText && fs > 15 && ctx.measureText(titleText).width > titleMax) {
      fs -= 1;
      ctx.font = '700 ' + fs + 'px Archivo, sans-serif';
    }
    ctx.fillText(titleText, titleX, 28);
    // Zoom gauge (right)
    const gx = 592, gy = 34, gr = 20;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = surface3;
    ctx.beginPath(); ctx.arc(gx, gy, gr, 0, Math.PI * 2); ctx.stroke();
    const frac = Math.max(0, Math.min(1, (Number(o.zoomPct) || 0) / 100));
    if (frac > 0.005) {
      ctx.strokeStyle = accent;
      ctx.beginPath(); ctx.arc(gx, gy, gr, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.fillStyle = ink;
    ctx.font = '700 13px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(o.zoomPct || 0)), gx, gy + 1);
    // Detail line
    ctx.textAlign = 'left';
    ctx.fillStyle = o.offline ? TOKENS.hex.accentHi : ink2;
    ctx.font = '700 15px "JetBrains Mono", monospace';
    ctx.fillText(o.detail, 20, 61);
    // Divider
    ctx.fillStyle = rule;
    ctx.fillRect(20, 76, 600, 1);
    // Footer row: scale bar (zoomed) or interaction hint, tier ladder right
    if (o.zoomed) {
      ctx.fillStyle = ink3;
      ctx.font = '700 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('SCALE', 20, 94);
      drawEarthScaleBar(ctx, o.scaleBar);
    } else if (o.hint) {
      ctx.fillStyle = ink3;
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(o.hint, 20, 94);
    }
    // Action row: trigger hint (zoomed) left, RESET ROTATION button right.
    ctx.fillStyle = rule;
    ctx.fillRect(20, 106, 600, 1);
    if (o.zoomed && o.hint) {
      ctx.fillStyle = o.featured ? accent : ink2;
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(o.hint, 20, 127);
    }
    {
      const b = EARTH_LABEL_RESET_RECT;
      const on = !!o.resetEnabled, hot = on && !!o.resetHot;
      earthRoundRect(ctx, b.x, b.y, b.w, b.h, 0);
      ctx.fillStyle = on ? (hot ? surface3 : surface) : surface2;
      ctx.fill();
      ctx.strokeStyle = on ? (hot ? accent : ruleStrong) : rule;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = on ? ink : inkMuted;
      ctx.font = '800 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('⟲  RESET ROTATION', b.x + b.w / 2, b.y + b.h / 2 + 1);
    }
    // Realm ladder: four segments, filled through the current realm
    const segW = 36, segGap = 6, ladderX = 620 - (segW * 4 + segGap * 3);
    for (let i = 0; i < EARTH_TIERS.length; i++) {
      const sx = ladderX + i * (segW + segGap);
      ctx.fillStyle = surface3;
      earthRoundRect(ctx, sx, 91, segW, 6, 0); ctx.fill();
      if (i <= tierIdx) {
        ctx.fillStyle = EARTH_TIERS[i].color;
        earthRoundRect(ctx, sx, 91, segW, 6, 0); ctx.fill();
      }
    }
    // Tile streaming progress hairline along the bottom edge
    if (o.streaming >= 0) {
      ctx.fillStyle = surface3;
      ctx.fillRect(22, EARTH_LABEL_H - 6, 596, 2);
      ctx.fillStyle = accent;
      ctx.fillRect(22, EARTH_LABEL_H - 6, Math.max(4, 596 * o.streaming), 2);
    }
  }

  // ─── Render Earth Preview ───────────────────────────────────────────
  // Location card (ECHO language, matching the comments panel): LIVE header, heat meter, one large hero window (poster, or
  // live video when a decoder frame exists) that plays through the location's
  // reels back to back with story-style segment progress, and an explicit
  // call-to-action. Every state (loading / idle / error) is drawn
  // deliberately; nothing ever shows as an empty frame.
  // Real canvases return a gradient object; stub contexts (tests, exotic
  // runtimes) may not — every gradient fill degrades to a flat colour.
  function canGradient(ctx) {
    try {
      const g = ctx.createLinearGradient && ctx.createLinearGradient(0, 0, 1, 1);
      return !!(g && typeof g.addColorStop === 'function');
    } catch (e) { return false; }
  }

  function previewRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function posterReady(img) {
    return !!(img && img.complete !== false && (Number(img.naturalWidth) || Number(img.width)) > 0);
  }

  function drawCoverRounded(ctx, source, x, y, w, h, r) {
    ctx.save();
    previewRoundRect(ctx, x, y, w, h, r);
    ctx.clip();
    try {
      if (source && source.videoWidth !== undefined) {
        drawVideoCover(ctx, source, x, y, w, h);
      } else {
        const sw0 = Number(source.naturalWidth) || Number(source.width) || w;
        const sh0 = Number(source.naturalHeight) || Number(source.height) || h;
        const ratio = sw0 / Math.max(1, sh0), target = w / Math.max(1, h);
        let sx = 0, sy = 0, sw = sw0, sh = sh0;
        if (ratio > target) { sw = sh0 * target; sx = (sw0 - sw) / 2; }
        else { sh = sw0 / target; sy = (sh0 - sh) / 2; }
        ctx.drawImage(source, sx, sy, sw, sh, x, y, w, h);
      }
    } catch (e) {}
    ctx.restore();
  }

  function drawPreviewPlaceholder(ctx, x, y, w, h, r, phase, label) {
    ctx.save();
    previewRoundRect(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.fillStyle = TOKENS.hex.bg;
    ctx.fillRect(x, y, w, h);
    if (phase >= 0 && canGradient(ctx)) {
      // Loading shimmer: a soft diagonal band sweeping across the slot.
      const bx = x - w * 0.4 + ((phase % 1400) / 1400) * w * 1.8;
      const sg = ctx.createLinearGradient(bx, y, bx + w * 0.35, y + h * 0.2);
      sg.addColorStop(0, 'rgba(242,243,245,0)');
      sg.addColorStop(0.5, 'rgba(242,243,245,0.07)');
      sg.addColorStop(1, 'rgba(242,243,245,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.strokeStyle = TOKENS.hex.rule;
      ctx.lineWidth = 1;
      for (let yy = y + 8; yy < y + h; yy += 14) {
        ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
      }
    }
    ctx.restore();
    if (label) {
      ctx.fillStyle = TOKENS.hex.inkMuted;
      ctx.font = `700 15px ${TOKENS.font.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h / 2);
    }
  }

  function renderEarthPreviewCanvas(ctx, options = {}) {
    if (!ctx) return;
    const {
      location = null,
      previewVideo = null,
      earthPreviewStatus = 'idle',
      earthPreviewItems = [],
      earthPreviewIndex = 0,
      earthPreviewPosters = [],
      earthPreviewHover = '',
      reducedMotion = false,
      time = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0,
    } = options;
    if (!location) return;
    const W = EARTH_PREVIEW_W, H = EARTH_PREVIEW_H;
    const T = TOKENS.hex;
    const hasGrad = canGradient(ctx);
    const items = Array.isArray(earthPreviewItems) ? earthPreviewItems.slice(0, 3) : [];
    const active = items.length ? Math.max(0, Math.min(items.length - 1, Number(earthPreviewIndex) || 0)) : 0;
    const heat = Math.max(0, Math.min(1, Number(location.heat) || 0));

    ctx.clearRect(0, 0, W, H);
    // Panel body (comments-panel parity: flat glass, rule border, accent top bar)
    previewRoundRect(ctx, 0, 0, W, H, TOKENS.radius);
    ctx.fillStyle = 'rgba(13, 14, 15, 0.97)';
    ctx.fill();
    ctx.strokeStyle = T.ruleStrong;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = T.accent;
    ctx.fillRect(0, 0, W, 3);

    // Header: LIVE chip + window label
    const pulse = reducedMotion ? 1 : 0.55 + 0.45 * Math.sin(time * 0.006);
    previewRoundRect(ctx, 28, 26, 78, 28, TOKENS.radius);
    ctx.fillStyle = T.surface2;
    ctx.fill();
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = T.accent;
    ctx.fillRect(41, 35, 10, 10);
    ctx.globalAlpha = 1;
    ctx.fillStyle = T.ink;
    ctx.font = `800 14px ${TOKENS.font.mono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('LIVE', 58, 41);
    ctx.fillStyle = T.ink3;
    ctx.font = `700 13px ${TOKENS.font.mono}`;
    ctx.textAlign = 'right';
    ctx.fillText('TRENDING · 7 DAYS', W - 30, 41);

    // Location name + heat meter
    ctx.fillStyle = T.ink;
    ctx.font = `800 34px ${TOKENS.font.sans}`;
    ctx.textAlign = 'left';
    ctx.fillText(truncatePreviewText(location.name || location.slug, 22), 28, 84);
    ctx.fillStyle = T.ink2;
    ctx.font = `700 14px ${TOKENS.font.mono}`;
    ctx.fillText(Math.round(heat * 100) + '% HEAT  ·  ' + (Number(location.active_reel_count) || 0) + ' ACTIVE', 28, 118);
    previewRoundRect(ctx, 300, 113, 184, 8, TOKENS.radius);
    ctx.fillStyle = T.surface3;
    ctx.fill();
    if (heat > 0.01) {
      previewRoundRect(ctx, 300, 113, Math.max(8, 184 * heat), 8, TOKENS.radius);
      ctx.fillStyle = T.accent;
      ctx.fill();
    }

    // Hero media
    const hx = 28, hy = 144, hw = W - 56, hh = 508;
    const videoLive = previewVideo && previewVideo.readyState >= 2;
    const poster = posterReady(earthPreviewPosters[active]) ? earthPreviewPosters[active] : null;
    if (videoLive) drawCoverRounded(ctx, previewVideo, hx, hy, hw, hh, TOKENS.radius);
    else if (poster) drawCoverRounded(ctx, poster, hx, hy, hw, hh, TOKENS.radius);
    else {
      const loading = earthPreviewStatus === 'loading' || (items.length > 0 && earthPreviewStatus === 'ready');
      drawPreviewPlaceholder(ctx, hx, hy, hw, hh, TOKENS.radius, loading && !reducedMotion ? time : -1,
        earthPreviewStatus === 'error' ? 'PREVIEW UNAVAILABLE'
          : (earthPreviewStatus === 'idle' && !items.length ? 'NO RECENT REELS YET' : ''));
    }
    if (items.length) {
      ctx.save();
      previewRoundRect(ctx, hx, hy, hw, hh, TOKENS.radius);
      ctx.clip();
      if (hasGrad) {
        const vg = ctx.createLinearGradient(0, hy + hh * 0.5, 0, hy + hh);
        vg.addColorStop(0, 'rgba(2,6,14,0)');
        vg.addColorStop(1, 'rgba(2,6,14,0.88)');
        ctx.fillStyle = vg;
        ctx.fillRect(hx, hy + hh * 0.5, hw, hh * 0.5);
      }
      ctx.restore();
      if (!videoLive) {
        // Play tile (the dock's vermilion play button): only while the card
        // is a still (poster/loading); once the clip is decoding it gets out of the way.
        const cx = hx + hw / 2, cy = hy + hh / 2 - 14;
        ctx.fillStyle = T.accent;
        ctx.fillRect(cx - 36, cy - 36, 72, 72);
        ctx.fillStyle = T.onAccent;
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy - 14); ctx.lineTo(cx + 17, cy); ctx.lineTo(cx - 9, cy + 14);
        ctx.closePath(); ctx.fill();
      }
      // Story-style progress: one segment per reel; finished reels are full,
      // the active one fills with the clip's playback, upcoming ones are empty.
      const segGap = 6, segH = 4, segY = hy + 14;
      const segW = (hw - 40 - segGap * (items.length - 1)) / items.length;
      const liveFrac = (videoLive && Number(previewVideo.duration) > 0)
        ? Math.max(0, Math.min(1, (Number(previewVideo.currentTime) || 0) / Number(previewVideo.duration))) : 0;
      for (let i = 0; i < items.length; i++) {
        const sx = hx + 20 + i * (segW + segGap);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        previewRoundRect(ctx, sx, segY, segW, segH, TOKENS.radius);
        ctx.fill();
        const frac = i < active ? 1 : (i === active ? liveFrac : 0);
        if (frac > 0) {
          ctx.fillStyle = T.accent;
          previewRoundRect(ctx, sx, segY, Math.max(segH, segW * frac), segH, TOKENS.radius);
          ctx.fill();
        }
      }
      // Item caption + counter
      const cur = items[active] || {};
      ctx.fillStyle = T.ink;
      ctx.font = `800 22px ${TOKENS.font.sans}`;
      ctx.textAlign = 'left';
      ctx.fillText(truncatePreviewText(cur.title || cur.filename || 'Untitled reel', 30), hx + 20, hy + hh - 32);
      previewRoundRect(ctx, hx + hw - 78, hy + 28, 62, 28, TOKENS.radius);
      ctx.fillStyle = 'rgba(8,9,10,0.78)';
      ctx.fill();
      ctx.fillStyle = T.ink;
      ctx.font = `800 14px ${TOKENS.font.mono}`;
      ctx.textAlign = 'center';
      ctx.fillText((active + 1) + ' / ' + items.length, hx + hw - 47, hy + 43);
    }

    // Button: open the feed (vermilion primary, live only with reels). Hover brightens it.
    for (const b of EARTH_PREVIEW_BUTTONS) {
      const hot = earthPreviewHover === b.action;
      const live = b.action !== 'feed' || items.length > 0;
      previewRoundRect(ctx, b.x, b.y, b.w, b.h, TOKENS.radius);
      ctx.fillStyle = live ? (hot ? T.accentHi : T.accent) : T.surface2;
      ctx.fill();
      if (!live) {
        ctx.strokeStyle = T.rule;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = live ? T.onAccent : T.inkMuted;
      ctx.font = `800 14px ${TOKENS.font.mono}`;
      ctx.textAlign = 'center';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + 21);
    }
  }

  // Canvas px → location-card button action ('' when between buttons).
  function resolveEarthPreviewHit(x, y) {
    for (const b of EARTH_PREVIEW_BUTTONS) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.action;
    }
    return '';
  }

  // ─── ECHO design tokens ─────────────────────────────────────────────
  // Mirror of web/src/styles/tokens.css (colour, font, spacing). The parity test
  // web/tests/echo-token-parity.test.js fails when the two drift apart. Frozen and
  // side-effect free so the module still loads in a bare VM.
  const TOKENS = Object.freeze({
    hex: Object.freeze({
      bg: '#08090a',
      surface: '#101214',
      surface2: '#16191c',
      surface3: '#1d2126',
      rule: '#24282d',
      ruleStrong: '#3a4047',
      ink: '#f2f3f5',
      ink2: '#a4abb3',
      ink3: '#8e959e',
      inkMuted: '#646b74',
      accent: '#ff3b1f',
      accentHi: '#ff5c42',
      onAccent: '#0a0a0a',
      success: '#22c55e',
      successHi: '#4ade80',
      warn: '#f2c744',
      warnHi: '#fde047',
      danger: '#ef4444',
      dangerHi: '#f87171',
      info: '#3b82f6',
      infoHi: '#60a5fa',
    }),
    font: Object.freeze({
      display: "'Archivo Black', Archivo, sans-serif",
      sans: 'Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif',
      mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      brand: "Orbitron, 'Archivo Black', sans-serif",
    }),
    space: Object.freeze({ s1: 4, s2: 8, s3: 12, s4: 16, s5: 24 }),
    radius: 0,
  });

  // ─── Public Module API ──────────────────────────────────────────────
  return {
    CONTROLS_W,
    CONTROLS_H,
    controlsCanvasSize,
    GUIDE_W,
    GUIDE_H,
    CPANEL_W,
    CPANEL_H,
    CP_LIST_TOP,
    CP_LIST_BOTTOM,
    CP_ITEM_H,
    CP_ITEM_GAP,
    OVERLAY_W,
    OVERLAY_H,
    EARTH_PREVIEW_W,
    EARTH_PREVIEW_H,
    CTRL_BUTTONS,
    formatTime,
    getInitials,
    wrapTextLines,
    isControlVisible,
    renderControlsCanvas,
    resolveControlsHit,
    renderCommentsPanelCanvas,
    resolveCommentsPanelRegion,
    renderOverlayCanvas,
    resolveOverlayCommentAt,
    filterOverlayComments,
    drawQuestController,
    renderGuideCanvas,
    isGuideArtworkDirty,
    clearGuideArtworkDirty,
    renderEarthPreviewCanvas,
    resolveEarthPreviewHit,
    EARTH_PREVIEW_BUTTONS,
    EARTH_LABEL_W,
    EARTH_LABEL_H,
    EARTH_LABEL_RESET_RECT,
    EARTH_TIERS,
    earthTierIndex,
    drawEarthScaleBar,
    renderEarthLabelCanvas,
    resolveEarthLabelHit,
    drawIcon,
    chamferPath,
    TOKENS,
  };
});
