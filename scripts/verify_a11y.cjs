#!/usr/bin/env node
// Accessibility pass over the main pages of the local staging stack
// (docs/local-staging.md), run in headless Chrome over the DevTools protocol.
//
//   node scripts/verify_a11y.cjs
//   node scripts/verify_a11y.cjs --app https://localhost:8443 --tabs 40
//
// Per page it reports: interactive elements without an accessible name,
// inputs without a label, images without alt, text below WCAG AA contrast,
// the Tab order (a repeat inside the first few stops means a focus trap) and
// focused elements with no visible focus style. Signs in as alice@example.com
// first (see verify_staging.cjs). Findings are written up in
// docs/accessibility-pass.md. Exits 1 when any page has an unnamed control or
// a focus trap; contrast and focus-style findings are reported but advisory.
// Text fields are not checked for focus style (see FOCUS_PROBE).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const APP = flag('--app', 'https://localhost:8443').replace(/\/$/, '');
const EMAIL = flag('--email', 'alice@example.com');
const PASSWORD = flag('--password', 'staging-only-password-1');
const TABS = Number(flag('--tabs', '30'));
const CHROME = flag('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const PORT = Number(flag('--port', '9233'));
const SIGNED_OUT_PAGES = [['/login', 'login'], ['/signup', 'sign up']];
const PAGES = [
  ['/reels', 'reels'], ['/explore', 'explore'],
  ['/profile/alice', 'profile'], ['/settings/profile', 'settings'], ['/wallet', 'wallet'],
  ['/upload', 'upload'], ['/messages', 'messages'], ['/support', 'support'], ['/privacy', 'privacy'],
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs inside the page. Returns the static findings; the Tab walk happens outside.
const AUDIT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const nameOf = (el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) { const text = labelledby.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (text) return text; }
    const label = (el.getAttribute('aria-label') || '').trim(); if (label) return label;
    if (el.labels && [...el.labels].some((l) => l.textContent.trim())) return 'label';
    const text = (el.textContent || '').trim(); if (text) return text;
    const img = el.querySelector('img[alt]:not([alt=""])'); if (img) return img.alt;
    const svgTitle = el.querySelector('svg title'); if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    return (el.getAttribute('title') || '').trim();
  };
  const controls = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=switch], [role=checkbox], [tabindex]:not([tabindex="-1"])')].filter(visible);
  const unnamed = controls.filter((el) => !nameOf(el)).map(describe);
  const noAlt = [...document.images].filter((img) => visible(img) && !img.hasAttribute('alt')).map((img) => describe(img));
  const luminance = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const backgroundOf = (el) => {
    // Blend translucent layers down to the first opaque one.
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a > 0.95) break; }
    }
    let out = [255, 255, 255];
    if (layers.length && layers[layers.length - 1].a > 0.95) out = layers.pop().rgb;
    else if (!layers.length) return out;
    while (layers.length) { const c = layers.pop(); out = out.map((v, i) => Math.round(c.rgb[i] * c.a + v * (1 - c.a))); }
    return out;
  };
  const seen = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el || !visible(el) || el.closest('script,style,noscript')) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color); if (!fg) continue;
    const bg = backgroundOf(el);
    const l1 = luminance(fg.rgb) * fg.a + luminance(bg) * (1 - fg.a), l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < need) {
      const key = s.color + ' on rgb(' + bg.join(',') + ')';
      const hit = seen.get(key) || { key, ratio: +ratio.toFixed(2), need, count: 0, sample: describe(el) + ' "' + node.textContent.trim().slice(0, 30) + '"' };
      hit.count++; seen.set(key, hit);
    }
  }
  return {
    controls: controls.length, unnamed, noAlt,
    lang: document.documentElement.lang || '', h1: document.querySelectorAll('h1').length,
    zoomBlocked: /user-scalable\\s*=\\s*no|maximum-scale\\s*=\\s*1(\\.0)?\\b/.test(document.querySelector('meta[name=viewport]')?.content || ''),
    lowContrast: [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 6),
  };
})()`;

const FOCUS_PROBE = `(() => {
  const el = document.activeElement; if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
  const shadow = s.boxShadow && s.boxShadow !== 'none';
  const r = el.getBoundingClientRect();
  const describe = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ((el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) ? ' "' + (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) + '"' : '');
  // Text fields show focus through a border or box-shadow on themselves or a wrapper
  // (.sx-input:focus, .sx-command-box:focus-within), which this probe cannot diff.
  const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  return { id: describe, styled: outline || shadow || field, onScreen: r.width > 0 && r.bottom > 0 && r.top < innerHeight };
})()`;

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 1; this.pending = new Map(); }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
      this.ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        const waiter = message.id && this.pending.get(message.id);
        if (waiter) { this.pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
      });
    });
  }
  call(method, params = {}, sessionId) {
    const id = this.id++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--ignore-certificate-errors',
    '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  let failed = 0;
  try {
    let version;
    for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
    const browser = new CDP(version.webSocketDebuggerUrl); await browser.open();
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
    const c = (method, params) => browser.call(method, params, sessionId);
    await c('Page.enable'); await c('Runtime.enable');
    await c('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const ev = async (expression) => { const r = await c('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
    const go = async (url, wait = 2500) => { await c('Page.navigate', { url: APP + url }); await sleep(wait); };
    const key = (type, k, code, vk) => c('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk });

    const auditPage = async (url, label) => {
      await go(url);
      const audit = await ev(AUDIT);
      // Tab walk from the top of the page.
      await ev('document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0)');
      const stops = [];
      for (let i = 0; i < TABS; i++) {
        await key('keyDown', 'Tab', 'Tab', 9); await key('keyUp', 'Tab', 'Tab', 9);
        await sleep(120); // let focus transitions settle before reading styles
        stops.push(await ev(FOCUS_PROBE));
      }
      const real = stops.filter(Boolean);
      const trap = real.length > 4 && new Set(real.slice(0, 8).map((s) => s.id)).size <= 2;
      const unstyled = [...new Set(real.filter((s) => !s.styled).map((s) => s.id))];
      const offscreen = real.filter((s) => !s.onScreen).length;
      const problems = audit.unnamed.length + (trap ? 1 : 0);
      if (problems) failed++;
      console.log(`\n${problems ? 'FAIL' : 'PASS'}  ${label} (${url})  controls=${audit.controls} tab stops=${new Set(real.map((s) => s.id)).size}`);
      if (audit.unnamed.length) console.log(`  unnamed controls: ${[...new Set(audit.unnamed)].join(', ')}`);
      if (trap) console.log(`  focus trap: Tab cycles ${[...new Set(real.slice(0, 8).map((s) => s.id))].join(' / ')}`);
      if (audit.noAlt.length) console.log(`  images without alt: ${[...new Set(audit.noAlt)].join(', ')}`);
      if (unstyled.length) console.log(`  no visible focus style (advisory): ${unstyled.slice(0, 6).join(', ')}`);
      if (offscreen) console.log(`  focus moved off screen ${offscreen} time(s) (advisory)`);
      for (const hit of audit.lowContrast) console.log(`  contrast ${hit.ratio} (need ${hit.need}) x${hit.count}: ${hit.key}  e.g. ${hit.sample}`);
      if (!audit.lang) console.log('  <html lang> missing');
      if (audit.h1 !== 1) console.log(`  h1 count is ${audit.h1} (advisory)`);
      if (audit.zoomBlocked) console.log('  viewport blocks pinch zoom');
    };
    for (const [url, label] of SIGNED_OUT_PAGES) await auditPage(url, label);
    await go('/login');
    for (const [selector, text] of [['form input:not([type=password]):not([type=hidden]):not([type=checkbox])', EMAIL], ['form input[type=password]', PASSWORD]]) {
      await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select && el.select(); })()`);
      await c('Input.insertText', { text });
    }
    await ev(`document.querySelector('form').requestSubmit()`);
    await sleep(3000);
    if ((await ev('location.pathname')).startsWith('/login')) throw new Error('sign in failed; run verify_staging.cjs once first');
    for (const [url, label] of PAGES) await auditPage(url, label);
  } catch (error) {
    failed++;
    console.error(error.message);
  } finally {
    chrome.kill();
  }
  console.log(failed ? `\n${failed} page(s) failed` : '\nall pages passed');
  process.exit(failed ? 1 : 0);
})();
