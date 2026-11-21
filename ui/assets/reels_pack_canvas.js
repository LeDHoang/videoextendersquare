/**
 * ECHO reel-pack VR canvas: the 1024x1024 queue / pack-complete / unavailable
 * cards the engine shows in a pack, plus the frame and buttons the player's
 * collect card reuses. Pure 2D on the ctx it is handed: the player and the
 * immersive-preview workbench both draw with it, so the 2D check is what VR shows.
 *
 * create({ tok, icons, onIconReady }):
 *   tok(name, fallback)  reads an --sx-* token (canvas cannot use var()).
 *   icons                svg markup by role (see ICON_ROLES); the player passes
 *                        its injected __ICON_*__ tokens, the workbench the raw files.
 *   onIconReady()        called once per batch of icons that finish rasterising.
 * render(ctx, mode, { pack, items, idx, creatorLabel, scroll }) returns the hit
 * regions in 0..1 units: { action, x, y, w, h, ...extra }. renderQueueOver draws
 * the queue card over a backdrop on a canvas of any shape (see below).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ReelsPackCanvas = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const SIZE = 1024;
  // The queue shows QUEUE_ROWS rows and scrolls the rest; its card covers
  // QUEUE_CARD_SCALE of the screen's short side.
  const QUEUE_ROWS = 7;
  const QUEUE_CARD_SCALE = 0.64;
  const SKIP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" aria-hidden="true"><path d="M5 5l9 7-9 7zM19 5v14"/></svg>';
  // Roles render() reads from opts.icons. row.* are the queue row state boxes.
  const ICON_ROLES = ['replay', 'reels', 'creator', 'complete', 'alert', 'skip', 'save', 'share', 'close', 'back', 'compass', 'upload', 'row.play', 'row.now', 'row.skipped'];

  function create(opts) {
    const tok = (opts && opts.tok) || ((name, fallback) => fallback);
    const icons = (opts && opts.icons) || {};
    const row = icons.row || {};
    const onIconReady = opts && opts.onIconReady;
    const iconCache = new Map();
    let redrawQueued = false;

    function addRegion(regions, action, x, y, w, h, extra) {
      if (regions) regions.push({ action, x: x / SIZE, y: y / SIZE, w: w / SIZE, h: h / SIZE, ...(extra || {}) });
    }

    function setSpacing(ctx, px) {
      if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px';
    }

    function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
      const words = String(text || '').split(/\s+/).filter(Boolean);
      let line = '';
      let lineNo = 0;
      for (let i = 0; i < words.length && lineNo < maxLines; i += 1) {
        const trial = line ? line + ' ' + words[i] : words[i];
        if (ctx.measureText(trial).width > maxWidth && line) {
          ctx.fillText(line, x, y + lineNo * lineHeight);
          line = words[i];
          lineNo += 1;
        } else line = trial;
      }
      if (lineNo < maxLines && line) ctx.fillText(line, x, y + lineNo * lineHeight);
    }

    // Trims text with an ellipsis to fit maxWidth at the current font.
    function fitText(ctx, text, maxWidth) {
      if (ctx.measureText(text).width <= maxWidth) return text;
      let cut = text.length;
      while (cut > 1 && ctx.measureText(text.slice(0, cut) + '…').width > maxWidth) cut -= 1;
      return text.slice(0, cut).trimEnd() + '…';
    }

    // Icon svgs: their inks (currentColor, the accent var, baked #f2f3f5 / #ff3b1f)
    // become literal colours; each variant rasterises once, then redraws.
    function drawIcon(ctx, svg, x, y, size, ink, accent) {
      if (!svg || typeof Image === 'undefined') return;
      const key = ink + '|' + accent + '|' + svg;
      let entry = iconCache.get(key);
      if (!entry) {
        const markup = String(svg)
          .replace(/var\(--sx-icon-accent,\s*var\(--sx-accent,\s*#[0-9a-f]{3,8}\)\)/gi, '__ACC__')
          .replace(/var\(--sx-accent,\s*#[0-9a-f]{3,8}\)/gi, '__ACC__')
          .replace(/#ff3b1f/gi, '__ACC__')
          .replace(/currentColor|#f2f3f5/gi, '__INK__')
          .replace(/__ACC__/g, accent)
          .replace(/__INK__/g, ink)
          .replace(/<svg(?![^>]*xmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"')
          .replace(/<svg/, '<svg width="96" height="96"');
        entry = { img: new Image(), ok: false };
        entry.img.onload = () => {
          entry.ok = true;
          if (!onIconReady || redrawQueued) return;
          redrawQueued = true;
          // setTimeout, not rAF: window rAF does not fire during an XR session.
          setTimeout(() => {
            redrawQueued = false;
            onIconReady();
          }, 0);
        };
        entry.img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
        iconCache.set(key, entry);
      }
      if (entry.ok) ctx.drawImage(entry.img, x, y, size, size);
    }

    function drawStats(ctx, x, y, creatorLabel, count) {
      const ink = tok('ink-3', '#8a919a');
      const accent = tok('accent', '#ff3b1f');
      ctx.fillStyle = ink;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '700 20px "JetBrains Mono", monospace';
      [[icons.creator, creatorLabel], [icons.reels, String(count)]].forEach(([icon, value]) => {
        drawIcon(ctx, icon, x, y - 13, 26, ink, accent);
        ctx.fillText(value, x + 36, y + 1);
        x += 36 + ctx.measureText(value).width + 36;
      });
      ctx.textBaseline = 'alphabetic';
    }

    // Shared obsidian frame for the pack / collect canvases: grid, vermilion glow, corner brackets, status label.
    function drawPackCanvasFrame(ctx, label, accent, chip, frameIcons) {
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = tok('bg', '#0d0e10');
      ctx.fillRect(0, 0, SIZE, SIZE);
      const glow = ctx.createRadialGradient(100, 1000, 0, 100, 1000, 760);
      glow.addColorStop(0, accent === '#ffb224' ? 'rgba(255,178,36,.20)' : 'rgba(255,59,31,.24)');
      glow.addColorStop(1, 'rgba(255,59,31,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.strokeStyle = 'rgba(255,255,255,.035)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let g = 32; g < SIZE; g += 32) {
        ctx.moveTo(g + 0.5, 0); ctx.lineTo(g + 0.5, SIZE);
        ctx.moveTo(0, g + 0.5); ctx.lineTo(SIZE, g + 0.5);
      }
      ctx.stroke();
      ctx.strokeStyle = tok('rule', '#24282e');
      ctx.lineWidth = 2;
      ctx.strokeRect(34, 34, 956, 956);
      ctx.fillStyle = accent;
      ctx.fillRect(34, 34, 956, 6);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 5;
      const arm = 40;
      [[34, 990, 1, -1], [990, 990, -1, -1]].forEach(([cx, cy, dx, dy]) => {
        ctx.beginPath();
        ctx.moveTo(cx, cy + dy * arm); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * arm, cy);
        ctx.stroke();
      });
      const labelIcon = frameIcons && frameIcons.label;
      if (labelIcon) drawIcon(ctx, labelIcon, 88, 81, 36, tok('ink', '#f2f3f5'), accent);
      else { ctx.fillStyle = accent; ctx.fillRect(92, 91, 14, 14); }
      ctx.fillStyle = accent;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '800 22px "JetBrains Mono", monospace';
      setSpacing(ctx, 4);
      ctx.fillText(label, labelIcon ? 136 : 124, 99);
      if (chip) {
        const chipIcon = frameIcons && frameIcons.chip;
        ctx.textAlign = 'right';
        ctx.font = '800 22px "JetBrains Mono", monospace';
        setSpacing(ctx, 1);
        const chipW = ctx.measureText(chip).width + 32 + (chipIcon ? 34 : 0);
        ctx.fillStyle = tok('surface-2', '#16191c');
        ctx.fillRect(932 - chipW, 78, chipW, 42);
        ctx.strokeStyle = '#2f353c';
        ctx.lineWidth = 2;
        ctx.strokeRect(932 - chipW, 78, chipW, 42);
        if (chipIcon) drawIcon(ctx, chipIcon, 932 - chipW + 14, 86, 26, tok('ink-2', '#a4abb3'), accent);
        ctx.fillStyle = tok('ink-2', '#a4abb3');
        ctx.fillText(chip, 916, 99);
      }
      setSpacing(ctx, 0);
      ctx.textBaseline = 'alphabetic';
    }

    function drawPackCanvasButton(ctx, regions, label, x, y, w, h, primary, action, extra, icon) {
      ctx.fillStyle = primary ? tok('accent', '#ff3b1f') : tok('surface-2', '#16191c');
      ctx.strokeStyle = primary ? tok('accent', '#ff3b1f') : '#2f353c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 4);
      ctx.fill();
      ctx.stroke();
      const ink = primary ? tok('on-accent', '#0a0a0a') : tok('ink', '#f2f3f5');
      ctx.fillStyle = ink;
      ctx.font = '800 23px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      setSpacing(ctx, 2);
      if (icon) {
        // Primary icons go one-ink on the accent fill, as the 2D buttons do.
        const iconAccent = primary ? ink : tok('accent', '#ff3b1f');
        const size = Math.round(h * 0.44);
        const textW = label ? ctx.measureText(label).width : 0;
        const gap = label ? 14 : 0;
        const left = x + (w - size - gap - textW) / 2;
        drawIcon(ctx, icon, left, y + (h - size) / 2, size, ink, iconAccent);
        if (label) { ctx.textAlign = 'left'; ctx.fillText(label, left + size + gap, y + h / 2); }
      } else ctx.fillText(label, x + w / 2, y + h / 2);
      setSpacing(ctx, 0);
      addRegion(regions, action, x, y, w, h, extra);
    }

    function render(ctx, mode, state) {
      const regions = [];
      const pack = (state && state.pack) || {};
      const items = (state && state.items) || [];
      const idx = (state && state.idx) || 0;
      const creatorLabel = (state && state.creatorLabel) || 'ECHO CREATOR';
      const button = (...args) => drawPackCanvasButton(ctx, regions, ...args);
      const pad = (n) => String(n).padStart(2, '0');
      const unavailable = mode === 'unavailable';
      const accent = unavailable ? '#ffb224' : '#ff3b1f';
      const label = mode === 'queue' ? 'QUEUE' : mode === 'complete' ? 'PACK COMPLETE' : unavailable ? 'PACK ITEM ' + (idx + 1) + ' OF ' + items.length : 'REEL PACK';
      const chip = mode === 'complete' ? items.length + '/' + items.length : unavailable ? (idx + 1) + '/' + items.length : '';
      const frameIcons = {
        label: mode === 'complete' ? icons.complete : unavailable ? icons.alert : icons.reels,
        chip: icons.reels,
      };
      drawPackCanvasFrame(ctx, label, accent, chip, frameIcons);
      ctx.fillStyle = accent;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      if (mode === 'queue') {
        ctx.fillStyle = tok('ink', '#f2f3f5');
        ctx.font = '400 44px "Archivo Black", "Archivo", sans-serif';
        ctx.fillText(String(pack.title || 'Untitled Pack').toUpperCase().slice(0, 30), 92, 164);
        drawStats(ctx, 92, 196, creatorLabel, items.length);
        // Save / share / close sit top-right as icon buttons, like the 2D queue head.
        button('', 740, 70, 56, 56, !!pack.saved_by_me, 'save', null, icons.save);
        button('', 808, 70, 56, 56, false, 'share', null, icons.share);
        button('', 876, 70, 56, 56, false, 'close', null, icons.close);
        // QUEUE_ROWS rows at a time; state.scroll is the first one shown.
        const win = queueWindow(items.length, state && state.scroll);
        const scrollable = win.max > 0;
        const rowX = 92, rowH = 78, rowGap = 8, rowStart = 236;
        const rowW = scrollable ? 776 : 840;
        const canPublishQueue = !!(pack.viewer_state && pack.viewer_state.can_edit) && pack.status === 'draft';
        items.slice(win.first, win.first + win.rows).forEach((item, offset) => {
          const index = win.first + offset;
          const y = rowStart + offset * (rowH + rowGap);
          const current = index === idx;
          const available = item && item.available !== false;
          ctx.fillStyle = current ? 'rgba(255,59,31,.16)' : tok('surface', '#12151a');
          ctx.strokeStyle = current ? tok('accent', '#ff3b1f') : tok('rule', '#24282e');
          ctx.lineWidth = current ? 3 : 1;
          ctx.fillRect(rowX, y, rowW, rowH);
          ctx.strokeRect(rowX, y, rowW, rowH);
          if (current) { ctx.fillStyle = tok('accent', '#ff3b1f'); ctx.fillRect(rowX, y, 8, rowH); }
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = tok('surface-2', '#16191c');
          ctx.fillRect(rowX + 22, y + 19, 54, 40);
          ctx.strokeStyle = current ? tok('accent', '#ff3b1f') : '#2f353c';
          ctx.lineWidth = 1;
          ctx.strokeRect(rowX + 22, y + 19, 54, 40);
          ctx.fillStyle = current ? tok('accent', '#ff3b1f') : tok('ink-2', '#a4abb3');
          ctx.font = '800 22px "JetBrains Mono", monospace';
          ctx.fillText(pad(index + 1), rowX + 49, y + rowH / 2 + 1);
          ctx.textAlign = 'left';
          ctx.fillStyle = available ? tok('ink', '#f2f3f5') : tok('ink-muted', '#6b727a');
          ctx.font = '700 30px "Archivo", sans-serif';
          const name = available ? (item.title || item.filename || 'Untitled reel') : 'Reel unavailable';
          ctx.fillText(fitText(ctx, String(name), rowW - 186), rowX + 96, y + rowH / 2);
          const box = 48, boxX = rowX + rowW - 64, boxY = y + 15;
          const warn = tok('warn', '#ffb224');
          let stateInk = tok('ink-2', '#a4abb3');
          let stateAccent = tok('accent', '#ff3b1f');
          if (current) {
            ctx.fillStyle = tok('accent', '#ff3b1f');
            ctx.fillRect(boxX, boxY, box, box);
            stateInk = stateAccent = tok('on-accent', '#0a0a0a');
          } else {
            ctx.fillStyle = tok('surface-2', '#16191c');
            ctx.fillRect(boxX, boxY, box, box);
            ctx.strokeStyle = available ? '#2f353c' : warn;
            ctx.lineWidth = 1;
            if (!available) { ctx.setLineDash([4, 3]); stateInk = stateAccent = warn; }
            ctx.strokeRect(boxX + 0.5, boxY + 0.5, box - 1, box - 1);
            ctx.setLineDash([]);
          }
          drawIcon(ctx, row[available ? (current ? 'now' : 'play') : 'skipped'], boxX + 9, boxY + 9, box - 18, stateInk, stateAccent);
          if (available) addRegion(regions, 'select', rowX, y, rowW, rowH, { index });
        });
        const listBottom = rowStart + win.rows * (rowH + rowGap) - rowGap;
        if (scrollable) {
          // Scroll column: step buttons (trigger / click) around a position track.
          const colX = rowX + rowW + 16, colW = 48;
          const arrow = (y, delta, enabled) => {
            button('', colX, y, colW, colW, false, 'scroll', { delta });
            ctx.strokeStyle = enabled ? tok('ink', '#f2f3f5') : tok('ink-muted', '#6b727a');
            ctx.lineWidth = 4;
            ctx.beginPath();
            const cx = colX + colW / 2, cy = y + colW / 2, d = delta * 6;
            ctx.moveTo(cx - 11, cy - d); ctx.lineTo(cx, cy + d); ctx.lineTo(cx + 11, cy - d);
            ctx.stroke();
          };
          arrow(rowStart, -1, win.first > 0);
          arrow(listBottom - colW, 1, win.first < win.max);
          const trackTop = rowStart + colW + 10, trackH = listBottom - colW - 10 - trackTop;
          const thumbH = Math.max(40, Math.round(trackH * win.rows / items.length));
          ctx.fillStyle = tok('rule', '#24282e');
          ctx.fillRect(colX + 20, trackTop, 8, trackH);
          ctx.fillStyle = tok('accent', '#ff3b1f');
          ctx.fillRect(colX + 20, trackTop + Math.round((trackH - thumbH) * win.first / win.max), 8, thumbH);
        }
        if (canPublishQueue) {
          const queuePlayable = items.filter((entry) => entry && entry.available !== false && entry.media_type !== 'static').length;
          if (queuePlayable >= 3) {
            button('PUBLISH COLLECTION', 312, 868, 400, 64, false, 'publish-pack', null, icons.upload);
          } else {
            ctx.fillStyle = tok('ink-muted', '#6b727a');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '800 19px "JetBrains Mono", monospace';
            ctx.fillText('PUBLISH AT 3+ AVAILABLE (' + queuePlayable + '/3)', 512, 900);
          }
        } else if (scrollable) {
          ctx.fillStyle = tok('ink-3', '#8a919a');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = '700 20px "JetBrains Mono", monospace';
          setSpacing(ctx, 2);
          ctx.fillText(pad(win.first + 1) + '–' + pad(win.first + win.rows) + ' OF ' + pad(items.length), 512, 900);
          setSpacing(ctx, 0);
        }
      } else {
        ctx.fillStyle = tok('ink', '#f2f3f5');
        ctx.font = '400 64px "Archivo Black", "Archivo", sans-serif';
        const title = unavailable ? 'REEL UNAVAILABLE' : String(pack.title || 'Untitled Pack').toUpperCase();
        wrapText(ctx, title, 92, 250, 840, 72, 2);
        ctx.fillStyle = tok('ink-2', '#a4abb3');
        ctx.font = '400 26px "Archivo", sans-serif';
        const description = mode === 'complete'
          ? 'You reached the end of this reel pack.'
          : unavailable
            ? 'This item was removed or is inaccessible. It will be skipped.'
            : (pack.description || ('An ordered collection by ' + creatorLabel + '.'));
        wrapText(ctx, description, 92, 420, 840, 38, 3);
        if (mode === 'complete') {
          ctx.strokeStyle = '#2f353c';
          ctx.lineWidth = 2;
          ctx.setLineDash([8, 6]);
          ctx.beginPath(); ctx.moveTo(92, 590); ctx.lineTo(932, 590); ctx.stroke();
          ctx.setLineDash([]);
          drawStats(ctx, 92, 636, creatorLabel, items.length);
          button('REPLAY PACK', 92, 720, 656, 76, true, 'replay', null, icons.replay);
          button('', 764, 720, 76, 76, false, 'return', null, icons.back);
          button('', 856, 720, 76, 76, false, 'explore', null, icons.compass);
        } else if (unavailable) {
          ctx.fillStyle = tok('ink-3', '#8a919a');
          ctx.textAlign = 'left';
          ctx.font = '700 18px "JetBrains Mono", monospace';
          ctx.fillText('SKIPPING WITHOUT EXPOSING PROTECTED MEDIA.', 92, 636);
          button('SKIP ITEM', 337, 720, 350, 76, true, 'skip', null, icons.skip);
        }
        const canPublishHere = !!(pack.viewer_state && pack.viewer_state.can_edit) && pack.status === 'draft' && mode === 'complete';
        if (canPublishHere) {
          const playable = items.filter((entry) => entry && entry.available !== false && entry.media_type !== 'static').length;
          if (playable >= 3) {
            button('PUBLISH COLLECTION', 312, 822, 400, 64, false, 'publish-pack', null, icons.upload);
          } else {
            ctx.fillStyle = tok('ink-muted', '#6b727a');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '800 19px "JetBrains Mono", monospace';
            ctx.fillText('PUBLISH AT 3+ AVAILABLE (' + playable + '/3)', 512, 854);
          }
        }
      }
      return regions;
    }

    // The queue card at QUEUE_CARD_SCALE of the short side, centred over a
    // dimmed backdrop (the paused frame) on a width x height canvas of the
    // post's shape. Regions come back in 0..1 of that canvas.
    function renderQueueOver(ctx, width, height, state, drawBackdrop) {
      ctx.save();
      ctx.fillStyle = '#050608';
      ctx.fillRect(0, 0, width, height);
      if (drawBackdrop) drawBackdrop(ctx, width, height);
      ctx.fillStyle = 'rgba(0,0,0,.58)';
      ctx.fillRect(0, 0, width, height);
      const size = Math.round(Math.min(width, height) * QUEUE_CARD_SCALE);
      const x = Math.round((width - size) / 2);
      const y = Math.round((height - size) / 2);
      ctx.translate(x, y);
      ctx.scale(size / SIZE, size / SIZE);
      const regions = render(ctx, 'queue', state);
      ctx.restore();
      return regions.map((r) => ({
        ...r,
        x: (x + r.x * size) / width,
        y: (y + r.y * size) / height,
        w: (r.w * size) / width,
        h: (r.h * size) / height,
      }));
    }

    return { drawFrame: drawPackCanvasFrame, drawButton: drawPackCanvasButton, render, renderQueueOver };
  }

  // First visible queue row for a scroll request, clamped to the list.
  function queueWindow(count, scroll) {
    const rows = QUEUE_ROWS;
    const max = Math.max(0, (count || 0) - rows);
    const first = Math.max(0, Math.min(max, Math.round(Number(scroll) || 0)));
    return { first, rows, max };
  }

  return { SIZE, QUEUE_ROWS, QUEUE_CARD_SCALE, SKIP_ICON, ICON_ROLES, create, queueWindow };
});
