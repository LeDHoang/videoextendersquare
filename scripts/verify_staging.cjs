#!/usr/bin/env node
// Live checks against the local staging stack (docs/local-staging.md):
// production boot, edge gates, invite-only sign-up, publish to the media
// bucket, Range + CORS on the media origin, and unpublish removing the object.
//
//   node scripts/verify_staging.cjs
//   node scripts/verify_staging.cjs --app https://localhost:8443 --media https://localhost:9443
//
// Backup/restore drill (docs/local-staging.md): seed before the backup, check
// after the restore that the DM still decrypts and the post media still serves.
//
//   node scripts/verify_staging.cjs --drill seed
//   node scripts/verify_staging.cjs --drill check --marker <m> --media-url <url>
//
// Publish timing (P0 item 7): uploads a large video, publishes it and times
// both steps against the 100 s Cloudflare origin timeout, then times the
// background encodes (poster, Explore preview, web proxy) landing.
//
//   node scripts/verify_staging.cjs --time-publish ~/clips/4k-hevc-95mb.mp4
//
// Registers alice@ and bob@example.com (SX_REGISTRATION_ALLOWLIST in
// deploy/env.staging.example) on first run and logs in on later runs. Free:
// it never calls fal.ai. Exits 1 when any check fails.
'use strict';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const APP = flag('--app', 'https://localhost:8443').replace(/\/$/, '');
const MEDIA = flag('--media', 'https://localhost:9443').replace(/\/$/, '');
const EMAIL = flag('--email', 'alice@example.com');
const PASSWORD = flag('--password', 'staging-only-password-1');
const PEER = flag('--peer', 'bob@example.com');
const DRILL = flag('--drill', '');
const TIME_PUBLISH = flag('--time-publish', '');
// Inline publish must finish well inside Cloudflare's 100 s origin timeout;
// above this, move the preview encode to a background job (docs/to-beta.md).
const PUBLISH_BUDGET_S = 60;
// Background encodes of a 95 MB 4K clip; generous, it only proves they land.
const DERIVED_BUDGET_S = 900;

// Caddy signs localhost with its own CA; accept it for these loopback origins only.
if (/^https:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(APP)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const jar = new Map();
function storeCookies(res) {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function call(path, { method = 'GET', json, form, headers = {} } = {}) {
  const init = { method, headers: { Origin: APP, ...headers }, redirect: 'manual' };
  if (jar.size) init.headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (jar.has('echo_csrf') && method !== 'GET') init.headers['x-csrf-token'] = jar.get('echo_csrf');
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form) {
    init.body = form;
  }
  const res = await fetch(APP + path, init);
  storeCookies(res);
  return res;
}

// 64x48 red PNG, so the probe needs no fixture file.
function tinyPng() {
  const zlib = require('zlib');
  const w = 64, h = 48;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) rows[y * (w * 3 + 1) + 1 + x * 3] = 220;
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const handle = (email) => email.split('@')[0].replace(/\W/g, '_');

// Log in, or register the invited address on first run. Login goes first so
// repeat runs do not spend the register rate limit.
async function signIn(email) {
  jar.clear();
  const login = await call('/api/auth/login', { method: 'POST', json: { identifier: email, password: PASSWORD } });
  if (login.status === 200) return login;
  jar.clear();
  const registered = await call('/api/auth/register', {
    method: 'POST',
    json: { email, username: handle(email), password: PASSWORD, accept_terms: true, display_name: handle(email) },
  });
  if (registered.status !== 202) return registered;
  // Sign-up only sends a link; the account exists once the mailed token is used.
  const token = await mailpitToken(email);
  if (!token) return registered;
  return call('/api/auth/verify-email', { method: 'POST', json: { token } });
}

// Reads the newest verification mail for `email` from the staging Mailpit (MAILPIT, default http://localhost:8025).
async function mailpitToken(email) {
  const base = flag('--mailpit', 'http://localhost:8025').replace(/\/$/, '');
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const list = await (await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=1`)).json();
      const id = list.messages && list.messages[0] && list.messages[0].ID;
      if (id) {
        const message = await (await fetch(`${base}/api/v1/message/${id}`)).json();
        const found = /verify-email\?token=([A-Za-z0-9_%-]+)/.exec(`${message.Text || ''} ${message.HTML || ''}`);
        if (found) return decodeURIComponent(found[1]);
      }
    } catch { /* Mailpit not reachable yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return '';
}

async function publishProbe(title) {
  const form = new FormData();
  form.append('file', new Blob([tinyPng()], { type: 'image/png' }), 'staging-probe.png');
  const staged = await call('/api/image/upload', { method: 'POST', form });
  if (staged.status !== 200) return { staged };
  const { stage_id: stageId } = await staged.json();
  const published = await call('/api/uploads/publish', { method: 'POST', json: { kind: 'image', title, stage_id: stageId } });
  return { staged, published, body: published.status === 200 ? await published.json() : {} };
}

async function drillSeed() {
  check('peer signed in', (await signIn(PEER)).status === 200);
  check('user signed in', (await signIn(EMAIL)).status === 200);
  const marker = `drill-${Date.now().toString(36)}`;
  const sent = await call('/api/messages/direct', { method: 'POST', json: { username: handle(PEER), text: `restore ${marker}` } });
  check('DM sent', sent.status === 200, `HTTP ${sent.status}`);
  const { published, body } = await publishProbe(`Drill ${marker}`);
  check('drill post published', published && published.status === 200);
  console.log(`\nAfter the restore run:\n  node scripts/verify_staging.cjs --drill check --marker ${marker} --media-url ${body.media_url}`);
}

async function drillCheck() {
  const marker = flag('--marker', '');
  const mediaUrl = flag('--media-url', '');
  const ready = await fetch(`${APP}/api/readyz`);
  check('readyz 200 after restore', ready.status === 200, ready.status === 200 ? '' : await ready.text());
  check('peer signs in with restored password', (await signIn(PEER)).status === 200);
  // A first DM from someone the peer does not follow lands in "requests".
  const ids = [];
  for (const box of ['inbox', 'requests']) {
    const listed = await call(`/api/messages/conversations?box=${box}`);
    if (listed.status === 200) ids.push(...(JSON.stringify(await listed.json()).match(/"id":"[^"]+"/g) || []));
  }
  let found = false;
  for (const raw of ids) {
    const id = raw.slice(6, -1);
    const messages = await call(`/api/messages/conversations/${encodeURIComponent(id)}/messages`);
    if (messages.status === 200 && JSON.stringify(await messages.json()).includes(`restore ${marker}`)) {
      found = true;
      break;
    }
  }
  check('DM decrypts after restore', found, marker);
  const media = await fetch(mediaUrl);
  check('post media still served', media.status === 200, `HTTP ${media.status}`);
  const local = mediaUrl.replace(`${MEDIA}/`, '');
  check('media URL on media origin', local !== mediaUrl, local);
}

async function timePublish(file) {
  const fs = require('fs');
  const path = require('path');
  const bytes = fs.readFileSync(file);
  console.log(`${path.basename(file)}  ${(bytes.length / 1e6).toFixed(1)} MB`);
  check('user signed in', (await signIn(EMAIL)).status === 200);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), path.basename(file));
  let t0 = Date.now();
  const staged = await call('/api/video/upload', { method: 'POST', form });
  const uploadS = (Date.now() - t0) / 1000;
  check('video staged', staged.status === 200, `HTTP ${staged.status}, ${uploadS.toFixed(1)} s`);
  if (staged.status !== 200) return;
  const { stage_id: stageId } = await staged.json();
  t0 = Date.now();
  const published = await call('/api/uploads/publish', {
    method: 'POST',
    json: { kind: 'video', title: `Timing ${path.basename(file)}`, stage_id: stageId },
  });
  const publishS = (Date.now() - t0) / 1000;
  check(`publish under ${PUBLISH_BUDGET_S} s`, published.status === 200 && publishS < PUBLISH_BUDGET_S,
    `HTTP ${published.status}, ${publishS.toFixed(1)} s`);
  if (published.status !== 200) return;
  const body = await published.json();
  const media = await fetch(body.media_url, { headers: { Range: 'bytes=0-1' } });
  check('published video served', media.status === 206, `HTTP ${media.status}`);
  // Derived files encode in the background after publish; wait for each to
  // land on the media origin (and so in the bucket) before deleting the post.
  const stem = body.media_url.replace(/\.[^./]+$/, '');
  const pending = new Map(['-poster.jpg', '-explore.mp4', '-preview.mp4'].map((suffix) => [suffix, `${stem}${suffix}`]));
  while (pending.size && (Date.now() - t0) / 1000 < DERIVED_BUDGET_S) {
    for (const [suffix, url] of pending) {
      const res = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      if (res.status === 206 || res.status === 200) {
        console.log(`  ${suffix} landed ${((Date.now() - t0) / 1000).toFixed(1)} s after publish started`);
        pending.delete(suffix);
      }
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  check(`derived files landed within ${DERIVED_BUDGET_S} s`, pending.size === 0,
    pending.size ? `missing ${[...pending.keys()].join(', ')}` : `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const removed = await call(`/api/posts/${body.post_id}`, { method: 'DELETE' });
  check('timing post removed', removed.status === 200, `HTTP ${removed.status}`);
}

async function main() {
  if (TIME_PUBLISH) return timePublish(TIME_PUBLISH);
  if (DRILL === 'seed') return drillSeed();
  if (DRILL === 'check') return drillCheck();

  console.log(`app ${APP}  media ${MEDIA}`);

  // ── Boot and gates ──
  const health = await fetch(`${APP}/api/healthz`);
  check('healthz 200', health.status === 200);
  const shell = await fetch(`${APP}/`);
  const shellHtml = await shell.text();
  for (const [label, res] of [['healthz', health], ['SPA', shell]]) {
    const h = res.headers;
    check(`${label}: X-Request-ID`, /^[0-9a-f]{32}$/.test(h.get('x-request-id') || ''), h.get('x-request-id') || 'missing');
    check(`${label}: security headers`,
      h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY'
        && !!h.get('referrer-policy') && !!h.get('permissions-policy'));
  }
  // Production default is report-only (SX_CSP_MODE=report); the nonce in the
  // header must match the one stamped on the shell's scripts.
  const csp = shell.headers.get('content-security-policy-report-only') || '';
  const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
  check('SPA: report-only CSP with matching nonce', !!nonce && shellHtml.includes(`nonce="${nonce}"`), csp ? '' : 'no CSP header');
  const echoed = await fetch(`${APP}/api/healthz`, { headers: { 'X-Request-ID': 'verify-staging-0001' } });
  check('incoming X-Request-ID echoed', echoed.headers.get('x-request-id') === 'verify-staging-0001');
  const ready = await fetch(`${APP}/api/readyz`);
  check('readyz 200', ready.status === 200, ready.status === 200 ? '' : await ready.text());
  check('/media mount gone (404)', (await fetch(`${APP}/media/uploads/x.mp4`)).status === 404);
  check('reels diag hidden (404)', (await fetch(`${APP}/api/reels/diag`)).status === 404);
  const anonForm = new FormData();
  anonForm.append('file', new Blob([tinyPng()], { type: 'image/png' }), 'anon.png');
  check('anonymous upload refused (401)', (await call('/api/image/upload', { method: 'POST', form: anonForm })).status === 401);

  // ── Invite-only sign-up ──
  jar.clear();
  const stranger = await call('/api/auth/register', {
    method: 'POST',
    json: { email: 'stranger@example.com', username: 'stranger', password: PASSWORD, accept_terms: true, display_name: 'stranger' },
  });
  check('uninvited sign-up refused', stranger.status >= 400 && stranger.status < 500, `HTTP ${stranger.status}`);
  jar.clear();

  const auth = await signIn(EMAIL);
  check('invited user signed in', auth.status === 200, `HTTP ${auth.status}`);
  const setCookies = auth.headers.getSetCookie();
  check('session cookie is Secure', setCookies.length > 0 && setCookies.every((c) => /;\s*secure/i.test(c)));
  if (auth.status !== 200) return;

  // ── Publish to the media bucket ──
  const { staged, published, body } = await publishProbe('Staging probe');
  check('upload staged', staged.status === 200, `HTTP ${staged.status}`);
  if (staged.status !== 200) return;
  check('publish 200', published.status === 200, published.status === 200 ? '' : `HTTP ${published.status}`);
  if (published.status !== 200) return;
  check('media_url on media origin', String(body.media_url).startsWith(`${MEDIA}/`), body.media_url);

  // ── Media origin: Range + CORS, as the WebXR texture loader requests it ──
  const ranged = await fetch(body.media_url, { headers: { Origin: APP, Range: 'bytes=0-1' } });
  check('media Range 206', ranged.status === 206, `HTTP ${ranged.status}`);
  check('media Content-Range', /^bytes 0-1\//.test(ranged.headers.get('content-range') || ''), ranged.headers.get('content-range'));
  check('media ACAO = app origin', ranged.headers.get('access-control-allow-origin') === APP, ranged.headers.get('access-control-allow-origin'));
  const plain = await fetch(body.media_url);
  check('media ACAO without Origin header', plain.headers.get('access-control-allow-origin') === APP);
  check('media Cache-Control', /max-age=86400/.test(plain.headers.get('cache-control') || ''), plain.headers.get('cache-control'));
  if (body.poster_url) check('poster on media origin', (await fetch(body.poster_url)).status === 200, body.poster_url);

  // ── Unpublish removes the object ──
  const removed = await call(`/api/posts/${body.post_id}`, { method: 'DELETE' });
  check('owner delete 200', removed.status === 200, `HTTP ${removed.status}`);
  check('media object gone (404)', (await fetch(body.media_url)).status === 404);
}

main()
  .catch((ex) => check('probe ran', false, ex.message))
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  });
