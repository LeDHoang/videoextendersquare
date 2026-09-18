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
  const GUIDE_H = 560;
  const CPANEL_W = 560;
  const CPANEL_H = 680;
  const OVERLAY_W = 1024;
  const OVERLAY_H = 1024;
  const EARTH_PREVIEW_W = 512;
  const EARTH_PREVIEW_H = 512;

  // Panel layout metrics
  const CP_HEADER_H = 48;
  const CP_FOOTER_H = 112;
  const CP_LIST_TOP = CP_HEADER_H;
  const CP_LIST_BOTTOM = CPANEL_H - CP_FOOTER_H;
  const CP_LIST_X = 0;
  const CP_LIST_W = 520;
  const CP_SCROLL_X = 524;
  const CP_SCROLL_W = 32;
  const CP_ITEM_H = 104;
  const CP_ITEM_GAP = 8;

  // Button definitions for the UI controls panel (WebXR HUD Media Control Dock)
  const CTRL_BUTTONS = [
    // Left secondary column (Pills)
    { label: 'AUTO',  action: 'mode',  x: 24,  y: 66,  w: 156, h: 44 },
    { label: 'DOME',  action: 'curve', x: 24,  y: 120, w: 156, h: 44 },

    // Center primary transport controls
    { label: '◀◀',   action: 'rew',   x: 228, y: 92,  w: 48,  h: 48 },
    { label: '⏮',    action: 'prev',  x: 290, y: 88,  w: 56,  h: 56 },
    { label: '▶',     action: 'play',  x: 360, y: 76,  w: 80,  h: 80 },
    { label: '⏭',    action: 'next',  x: 454, y: 88,  w: 56,  h: 56 },
    { label: '▶▶',   action: 'fwd',   x: 524, y: 92,  w: 48,  h: 48 },

    // Right secondary column (Pills)
    { label: 'LOCK',  action: 'lock',  x: 620, y: 66,  w: 156, h: 44 },
    { label: 'AUDIO', action: 'mute',  x: 620, y: 120, w: 156, h: 44 },

    // Header comment pill → toggles the VR comments panel
    { label: '💬',    action: 'comments', x: 476, y: 13, w: 64, h: 22 },

    // Open Earth activity mode, or restore All Locations after a location feed.
    { label: 'EARTH MAP', action: 'earth', x: 622, y: 8, w: 114, h: 32 },

    // Header exit button
    { label: '✕',     action: 'exit',  x: 746, y: 13,  w: 30,  h: 22 },

    // Existing reel actions remain available in both feed and pack playback.
    { label: 'LIKE',       action: 'like',       x: 24,  y: 184, w: 112, h: 42 },
    { label: 'SAVE REEL',  action: 'save_reel',  x: 144, y: 184, w: 112, h: 42 },
    { label: 'SHARE REEL', action: 'share_reel', x: 264, y: 184, w: 112, h: 42 },
    { label: 'FOLLOW',     action: 'follow',     x: 384, y: 184, w: 112, h: 42 },
    { label: 'PROFILE',    action: 'profile',    x: 504, y: 184, w: 112, h: 42 },
    { label: 'REPORT',     action: 'report',     x: 624, y: 184, w: 152, h: 42 },

    // Pack-level actions are intentionally separate from reel-level actions.
    { label: 'SAVE PACK',  action: 'save_pack',  x: 218, y: 238, w: 174, h: 42 },
    { label: 'SHARE PACK', action: 'share_pack', x: 408, y: 238, w: 174, h: 42 },

    // Feed-mode collection shortcut (opens the SAVE TO card).
    { label: 'COLLECT',    action: 'collect',    x: 24,  y: 238, w: 174, h: 42 },

    // Bottom progress scrub track
    { label: 'TRACK', action: 'seek',  x: 24,  y: 314, w: 752, h: 32 },
  ];

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function getInitials(name) {
    if (!name) return '??';
    const parts = name.split(/[_\s]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function wrapTextLines(ctx, text, maxW, maxLines) {
    const words = String(text || '').split(/\s+/);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      const test = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width <= maxW) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        cur = words[i];
        if (lines.length >= maxLines - 1) break;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (lines.length === maxLines && words.length > 0) {
      const last = lines[lines.length - 1];
      if (ctx.measureText(last + '…').width <= maxW) {
        lines[lines.length - 1] = last + '…';
      }
    }
    return lines;
  }

  function isReelAction(action) {
    return action === 'like' || action === 'save_reel' || action === 'share_reel' ||
      action === 'follow' || action === 'profile' || action === 'report';
  }

  function isPackAction(action) {
    return action === 'save_pack' || action === 'share_pack';
  }

  function isControlVisible(action, source, itemState, isPackExp) {
    if (isPackAction(action)) return !!isPackExp;
    if (action === 'collect') return !isPackExp;
    if (isReelAction(action)) return source.kind !== 'static-card' && (!itemState || itemState.available !== false);
    if (source.kind === 'static-card' &&
        (action === 'rew' || action === 'prev' || action === 'play' ||
         action === 'next' || action === 'fwd' || action === 'seek')) return false;
    if (source.kind === 'image' && (action === 'rew' || action === 'fwd' || action === 'seek')) return false;
    return true;
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

  // ─── Render Controls Dock ──────────────────────────────────────────
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
      isCurved = true,
      curvatureMode = 1,
      lockToViewer = false,
      sceneMode = 'reels',
      notificationText = '',
      notificationUntil = 0,
      callbacks = {},
    } = options;

    const isPaused = source.paused !== false;
    const isMuted = source.muted !== false;
    const currentTime = Number(source.currentTime) || 0;
    const duration = Number(source.duration) || 0;
    const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;

    ctx.clearRect(0, 0, CONTROLS_W, CONTROLS_H);

    // 1. Dark Glass Container Background
    ctx.fillStyle = 'rgba(12, 14, 17, 0.96)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, CONTROLS_W, CONTROLS_H, 4);
    else ctx.rect(0, 0, CONTROLS_W, CONTROLS_H);
    ctx.fill();

    // 2. Vermilion Glow Outer Border
    ctx.strokeStyle = '#FF3B1F';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, CONTROLS_W, CONTROLS_H, 4);
    else ctx.rect(0, 0, CONTROLS_W, CONTROLS_H);
    ctx.stroke();

    // 3. Top Telemetry Header
    ctx.fillStyle = '#FF3B1F';
    ctx.fillRect(24, 14, 4, 20);

    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(packMode ? 'REEL PACK' : '4K VR REELS', 36, 24);

    let dispName = packMode && packContext
      ? (packContext.title || 'UNTITLED PACK')
      : (item ? (item.title || item.filename) : 'SYS_RENDER_004.mp4');
    if (dispName.length > 26) dispName = dispName.slice(0, 24) + '…';
    ctx.fillStyle = '#E3E2E3';
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.fillText(dispName, 144, 24);

    // Comment pill
    const commentBtnIdx = CTRL_BUTTONS.findIndex((b) => b.action === 'comments');
    const isCommentHover = (hoveredButton === commentBtnIdx);
    ctx.fillStyle = isCommentHover ? '#1D2126' : '#101214';
    ctx.strokeStyle = isCommentHover ? '#FF3B1F' : '#3A4047';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(476, 13, 64, 22, 3);
    else ctx.rect(476, 13, 64, 22);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isCommentHover ? '#FFFFFF' : '#E7BDB5';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`💬 ${comments.length || 0}`, 508, 24);

    // Index pill
    ctx.fillStyle = '#101214';
    ctx.strokeStyle = '#3A4047';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(548, 13, 72, 22, 3);
    else ctx.rect(548, 13, 72, 22);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#E7BDB5';
    ctx.fillText(`${playlist.length ? idx + 1 : 0} / ${playlist.length}`, 584, 24);

    // Earth button
    const earthBtnIdx = CTRL_BUTTONS.findIndex((b) => b.action === 'earth');
    const earthButton = CTRL_BUTTONS[earthBtnIdx];
    const isEarthHover = (hoveredButton === earthBtnIdx);
    const earthActive = sceneMode === 'earth' || isEarthHover || (packMode && packContext && packContext.queueOpen);
    ctx.fillStyle = earthActive ? '#093D5B' : '#0B202D';
    ctx.strokeStyle = earthActive ? '#55E7FF' : '#2B8DA4';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(earthButton.x, earthButton.y, earthButton.w, earthButton.h, 5);
    else ctx.rect(earthButton.x, earthButton.y, earthButton.w, earthButton.h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = earthActive ? '#FFFFFF' : '#55E7FF';
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(packMode ? 'QUEUE' : 'EARTH MAP', earthButton.x + earthButton.w / 2, earthButton.y + earthButton.h / 2);

    // Exit button
    const exitBtnIdx = CTRL_BUTTONS.findIndex((b) => b.action === 'exit');
    const exitBtn = CTRL_BUTTONS[exitBtnIdx];
    ctx.fillStyle = '#101214';
    ctx.strokeStyle = '#FF3B1F';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(exitBtn.x, exitBtn.y, exitBtn.w, exitBtn.h, 3);
    else ctx.rect(exitBtn.x, exitBtn.y, exitBtn.w, exitBtn.h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#FF3B1F';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('✕', exitBtn.x + exitBtn.w / 2, exitBtn.y + exitBtn.h / 2);

    // Transport buttons
    for (let i = 0; i < CTRL_BUTTONS.length; i++) {
      const btn = CTRL_BUTTONS[i];
      if (btn.action === 'comments' || btn.action === 'earth' || btn.action === 'exit' || btn.action === 'seek') continue;
      if (!isControlVisible(btn.action, source, itemState, packMode)) continue;

      const isHover = (hoveredButton === i);
      let btnLabel = btn.label;
      if (btn.action === 'play') btnLabel = isPaused ? '▶' : '❚❚';
      if (btn.action === 'mute') btnLabel = isMuted ? 'UNMUTE' : 'MUTE';
      if (btn.action === 'lock') btnLabel = lockToViewer ? 'LOCKED' : 'UNLOCKED';
      if (btn.action === 'curve') {
        btnLabel = curvatureMode === 1 ? 'DOME' : (curvatureMode === 2 ? 'SQ CURVE' : 'FLAT');
      }

      ctx.fillStyle = isHover ? '#FF3B1F' : '#141619';
      ctx.strokeStyle = isHover ? '#FFFFFF' : '#3A4047';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 4);
      else ctx.rect(btn.x, btn.y, btn.w, btn.h);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isHover ? '#000000' : '#E3E2E3';
      ctx.font = btn.action === 'play' ? 'bold 24px sans-serif' : 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(btnLabel, btn.x + btn.w / 2, btn.y + btn.h / 2);
    }

    // Scrubber track
    const trackBtn = CTRL_BUTTONS.find((b) => b.action === 'seek');
    if (trackBtn) {
      ctx.fillStyle = '#1A1D24';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(trackBtn.x, trackBtn.y + 12, trackBtn.w, 8, 4);
      else ctx.rect(trackBtn.x, trackBtn.y + 12, trackBtn.w, 8);
      ctx.fill();

      // Filled progress
      ctx.fillStyle = '#FF3B1F';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(trackBtn.x, trackBtn.y + 12, trackBtn.w * progress, 8, 4);
      else ctx.rect(trackBtn.x, trackBtn.y + 12, trackBtn.w * progress, 8);
      ctx.fill();

      // Scrubber thumb
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(trackBtn.x + trackBtn.w * progress, trackBtn.y + 16, 8, 0, Math.PI * 2);
      ctx.fill();

      // Time texts
      ctx.fillStyle = '#9BA1A8';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(formatTime(currentTime), trackBtn.x, trackBtn.y + 32);
      ctx.textAlign = 'right';
      ctx.fillText(formatTime(duration), trackBtn.x + trackBtn.w, trackBtn.y + 32);
    }
  }

  // ─── Resolve Controls Hit ──────────────────────────────────────────
  function resolveControlsHit(canvasX, canvasY, options = {}) {
    const { source = {}, itemState = {}, sceneMode = 'reels', packMode = false } = options;
    for (let i = 0; i < CTRL_BUTTONS.length; i++) {
      const btn = CTRL_BUTTONS[i];
      if (sceneMode === 'earth' && btn.action !== 'earth' && btn.action !== 'exit') continue;
      if (!isControlVisible(btn.action, source, itemState, packMode)) continue;
      if (canvasX >= btn.x && canvasX <= btn.x + btn.w &&
          canvasY >= btn.y && canvasY <= btn.y + btn.h) {
        return i;
      }
    }
    return -1;
  }

  // ─── Resolve Comments Region ────────────────────────────────────────
  function resolveCommentsPanelRegion(canvasX, canvasY, options = {}) {
    const { comments = [], cPanelTab = 'all', cPanelScrollY = 0 } = options;
    let filtered = comments;
    if (cPanelTab === 'sync') filtered = comments.filter((c) => c.timestamp !== null && c.timestamp !== undefined);
    else if (cPanelTab === 'general') filtered = comments.filter((c) => c.timestamp === null || c.timestamp === undefined);

    if (canvasY < CP_HEADER_H) {
      if (canvasX >= 296 && canvasX < 344 && canvasY >= 16 && canvasY < 46) return 'tab:all';
      if (canvasX >= 352 && canvasX < 416 && canvasY >= 16 && canvasY < 46) return 'tab:sync';
      if (canvasX >= 424 && canvasX < 502 && canvasY >= 16 && canvasY < 46) return 'tab:general';
      if (canvasX >= 522 && canvasX < 548 && canvasY >= 16 && canvasY < 46) return 'close';
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
      if (canvasY >= y + 8 && canvasY < y + 36) {
        const hasTime = c.timestamp !== null && c.timestamp !== undefined;
        if (canvasX >= itemX + 8 && canvasX < itemX + 174) return 'profile:' + (c.author_name || '');
        if (hasTime && canvasX >= itemX + 180 && canvasX < itemX + 280) return 'seek:' + c.id;
        if (canvasX >= itemX + itemW - 46 && canvasX < itemX + itemW - 6) return 'like:' + c.id;
      }
    }
    return 'list';
  }

  // ─── Render Comments Panel ──────────────────────────────────────────
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
    } = options;

    let filtered = comments;
    if (cPanelTab === 'sync') filtered = comments.filter((c) => c.timestamp !== null && c.timestamp !== undefined);
    else if (cPanelTab === 'general') filtered = comments.filter((c) => c.timestamp === null || c.timestamp === undefined);

    const listH = CP_LIST_BOTTOM - CP_LIST_TOP;
    const contentH = filtered.length * (CP_ITEM_H + CP_ITEM_GAP);
    const accent = '#FF3B1F';

    ctx.clearRect(0, 0, CPANEL_W, CPANEL_H);

    // Container
    ctx.fillStyle = 'rgba(13, 14, 15, 0.97)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, CPANEL_W, CPANEL_H, 6);
    else ctx.rect(0, 0, CPANEL_W, CPANEL_H);
    ctx.fill();
    ctx.strokeStyle = '#343536';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, CPANEL_W, 3);

    // Header
    ctx.fillStyle = '#0d0e0f';
    ctx.fillRect(0, 3, CPANEL_W, CP_HEADER_H - 3);
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = accent;
    ctx.fillText('💬', 18, 33);
    ctx.font = '700 11px "JetBrains Mono", monospace';
    ctx.fillText('COMMENTS', 40, 33);
    ctx.fillStyle = 'rgba(255,85,58,0.7)';
    const titleW = ctx.measureText('COMMENTS').width;
    ctx.fillText('(' + comments.length + ')', 40 + titleW + 10, 33);

    const tabs = [
      { key: 'all', label: 'ALL', x: 296, w: 48 },
      { key: 'sync', label: 'SYNC', x: 352, w: 64 },
      { key: 'general', label: 'GENERAL', x: 424, w: 78 },
    ];
    tabs.forEach((tab) => {
      const active = cPanelTab === tab.key;
      const hover = cPanelHover === ('tab:' + tab.key);
      ctx.fillStyle = active ? accent : (hover ? '#1D2126' : '#1f2021');
      ctx.strokeStyle = active ? accent : (hover ? accent : '#343536');
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(tab.x, 16, tab.w, 30, 3);
      else ctx.rect(tab.x, 16, tab.w, 30);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = active ? '#5a0600' : (hover ? '#FFFFFF' : '#ff553a');
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(tab.label, tab.x + tab.w / 2, 31);
    });

    // Close button
    ctx.fillStyle = cPanelHover === 'close' ? '#292a2b' : '#1f2021';
    ctx.strokeStyle = cPanelHover === 'close' ? accent : '#343536';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(522, 16, 26, 30, 3);
    else ctx.rect(522, 16, 26, 30);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = cPanelHover === 'close' ? '#FFFFFF' : accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('✕', 535, 31);

    // List items
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, CP_LIST_TOP, CP_LIST_X + CP_LIST_W, listH);
    ctx.clip();

    if (filtered.length === 0) {
      ctx.fillStyle = accent;
      ctx.font = '700 10px "JetBrains Mono", monospace';
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
        if (ctx.roundRect) ctx.roundRect(itemX, y, itemW, CP_ITEM_H, 4);
        else ctx.rect(itemX, y, itemW, CP_ITEM_H);
        ctx.fill();
        ctx.strokeStyle = highlighted ? accent : '#343536';
        ctx.lineWidth = highlighted ? 2.5 : 1;
        ctx.stroke();

        ctx.fillStyle = border;
        ctx.fillRect(itemX, y, 3, CP_ITEM_H);

        // Avatar
        ctx.fillStyle = '#1f2021';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(itemX + 8, y + 12, 40, 40, 4);
        else ctx.rect(itemX + 8, y + 12, 40, 40);
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.stroke();
        ctx.fillStyle = border;
        ctx.font = '700 11px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(getInitials(c.author_name), itemX + 28, y + 33);

        // Author name
        ctx.fillStyle = border;
        ctx.font = '700 11px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let name = c.author_name || 'Anonymous';
        if (name.length > 16) name = name.slice(0, 15) + '…';
        ctx.fillText(name, itemX + 56, y + 14);

        // Time pill
        const hasTime = c.timestamp !== null && c.timestamp !== undefined;
        const pillX = itemX + 180;
        ctx.fillStyle = '#292a2b';
        ctx.strokeStyle = accent;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(pillX, y + 10, 100, 24, 3);
        else ctx.rect(pillX, y + 10, 100, 24);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.font = '700 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(hasTime ? ('⏱ ' + formatTime(c.timestamp)) : 'GENERAL', pillX + 50, y + 23);

        // Text
        ctx.fillStyle = '#e3e2e3';
        ctx.font = '500 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const lines = wrapTextLines(ctx, c.text || '', itemW - 70, 2);
        lines.forEach((line, li) => {
          ctx.fillText(line, itemX + 56, y + 48 + li * 18);
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
    if (ctx.roundRect) ctx.roundRect(16, footerY + 54, CPANEL_W - 32, 44, 4);
    else ctx.rect(16, footerY + 54, CPANEL_W - 32, 44);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#5a0600';
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+ ADD COMMENT', CPANEL_W / 2, footerY + 77);
  }

  // ─── Render Earth Preview ───────────────────────────────────────────
  function renderEarthPreviewCanvas(ctx, options = {}) {
    if (!ctx) return;
    const {
      location = null,
      previewVideo = null,
      earthPreviewStatus = 'idle',
      earthPreviewItems = [],
      earthPreviewIndex = 0,
      reducedMotion = false,
    } = options;
    if (!location) return;

    ctx.clearRect(0, 0, EARTH_PREVIEW_W, EARTH_PREVIEW_H);
    ctx.fillStyle = 'rgba(8, 30, 48, 0.98)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(2, 2, EARTH_PREVIEW_W - 4, EARTH_PREVIEW_H - 4, 24);
    else ctx.rect(2, 2, EARTH_PREVIEW_W - 4, EARTH_PREVIEW_H - 4);
    ctx.fill();
    ctx.strokeStyle = '#55E7FF';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#BFF5FF';
    ctx.font = '800 17px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('LIVE LOCATION PREVIEW', 26, 26);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '800 28px sans-serif';
    ctx.fillText(truncatePreviewText(location.name || location.slug, 29), 26, 57);
    ctx.fillStyle = '#8EDCEC';
    ctx.font = '800 13px "JetBrains Mono", monospace';
    ctx.fillText(
      Math.round((Number(location.heat) || 0) * 100) + '% HEAT · ' +
        (Number(location.active_reel_count) || 0) + ' ACTIVE',
      26,
      82
    );

    const mediaX = 24, mediaY = 104, mediaW = EARTH_PREVIEW_W - 48, mediaH = 380;
    ctx.fillStyle = '#020713';
    ctx.fillRect(mediaX, mediaY, mediaW, mediaH);
    if (previewVideo && previewVideo.readyState >= 2) {
      try {
        drawVideoCover(ctx, previewVideo, mediaX, mediaY, mediaW, mediaH);
      } catch (e) {}
    } else {
      ctx.strokeStyle = 'rgba(85, 231, 255, 0.18)';
      ctx.lineWidth = 2;
      for (let y = mediaY + 12; y < mediaY + mediaH; y += 24) {
        ctx.beginPath();
        ctx.moveTo(mediaX, y);
        ctx.lineTo(mediaX + mediaW, y);
        ctx.stroke();
      }
    }
  }

  // ─── Public Module API ──────────────────────────────────────────────
  return {
    CONTROLS_W,
    CONTROLS_H,
    GUIDE_W,
    GUIDE_H,
    CPANEL_W,
    CPANEL_H,
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
    renderEarthPreviewCanvas,
  };
});
