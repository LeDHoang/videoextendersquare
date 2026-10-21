#!/usr/bin/env node
// Load and abuse probe for the local staging stack (docs/local-staging.md).
//
//   node scripts/verify_load.cjs                      # load: 50 virtual users, 30 s
//   node scripts/verify_load.cjs --users 100 --duration 60 --p95 1500
//   node scripts/verify_load.cjs --abuse              # bursts must hit the documented 429s
//
// Load mode signs in as alice@ and bob@example.com once each (the login limit is
// 10 per account per 15 minutes) and shares the two sessions between the virtual
// users. Each user loops over: feed page, post view, impression event, messages
// bootstrap. A few users also hold the messages stream open (SX_SSE_MAX_CONN is
// 8 per account). Passes when there are no 5xx responses, no network errors and
// the p95 latency is under --p95 ms. 429 is counted apart: the per-user event
// limit is expected to trip under this much traffic.
//
// Abuse mode sends one burst per limit, each aimed at a target that does not
// exist, so no data is written. Passes when every burst turns into a 429 at or
// before its documented limit and nothing returns 5xx. It spends the staging
// rate-limit budgets: the login burst uses a made-up account, but the register
// burst, the login-IP window (20 per 15 minutes) and the report window (20 per
// hour) stay spent until they expire. Run it last, and against staging only.
//
// Exits 1 when any check fails.
'use strict';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const APP = flag('--app', 'https://localhost:8443').replace(/\/$/, '');
const PASSWORD = flag('--password', 'staging-only-password-1');
const ACCOUNTS = [flag('--email', 'alice@example.com'), flag('--peer', 'bob@example.com')];
const USERS = Number(flag('--users', '50'));
const DURATION_S = Number(flag('--duration', '30'));
const P95_TARGET_MS = Number(flag('--p95', '1500'));
const STREAMS_PER_ACCOUNT = Number(flag('--streams', '4'));
const EVENT_RPM = Number(flag('--event-rpm', '120'));
const ABUSE = args.includes('--abuse');

// Caddy signs localhost with its own CA; accept it for these loopback origins only.
if (/^https:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(APP)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomId = () => Math.random().toString(36).slice(2, 10);

class Session {
  constructor() { this.jar = new Map(); }
  store(res) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  async call(path, { method = 'GET', json, signal } = {}) {
    const headers = { Origin: APP };
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.jar.has('echo_csrf') && method !== 'GET') headers['x-csrf-token'] = this.jar.get('echo_csrf');
    const init = { method, headers, redirect: 'manual', signal };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(APP + path, init);
    this.store(res);
    return res;
  }
}

async function signIn(identifier) {
  const session = new Session();
  const res = await session.call('/api/auth/login', { method: 'POST', json: { identifier, password: PASSWORD } });
  if (res.status !== 200) throw new Error(`sign in as ${identifier} returned ${res.status}; run verify_staging.cjs once first`);
  await res.arrayBuffer();
  return session;
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function runLoad() {
  const sessions = await Promise.all(ACCOUNTS.map(signIn));
  const stats = new Map(); // label -> { ms: [], status: Map }
  let networkErrors = 0;
  const record = (label, ms, status) => {
    if (!stats.has(label)) stats.set(label, { ms: [], status: new Map() });
    const entry = stats.get(label);
    entry.ms.push(ms);
    entry.status.set(status, (entry.status.get(status) || 0) + 1);
  };
  const timed = async (label, session, path, options) => {
    const started = performance.now();
    try {
      const res = await session.call(path, options);
      const body = await res.text();
      record(label, performance.now() - started, res.status);
      return { status: res.status, body };
    } catch {
      networkErrors++;
      return { status: 0, body: '' };
    }
  };

  const feedProbe = await timed('feed', sessions[0], '/api/feed?limit=12');
  let postIds = [];
  try { postIds = JSON.parse(feedProbe.body).items.map((item) => item.id); } catch { /* no posts yet */ }
  if (!postIds.length) console.log('note: the feed is empty, so views and impressions are skipped. Publish a post first (verify_staging.cjs --drill seed).');

  const deadline = Date.now() + DURATION_S * 1000;
  const controller = new AbortController();
  let streamsOpen = 0;
  let streamsRefused = 0;

  const openStream = async (session) => {
    try {
      const res = await session.call('/api/messages/events', { signal: controller.signal });
      if (res.status === 200) {
        streamsOpen++;
        const reader = res.body.getReader();
        while (!(await reader.read()).done) { /* hold the stream open */ }
      } else {
        streamsRefused++;
        await res.arrayBuffer();
      }
    } catch { /* aborted at the end of the run */ }
  };
  sessions.forEach((session) => { for (let i = 0; i < STREAMS_PER_ACCOUNT; i++) openStream(session); });

  const virtualUser = async (index) => {
    const session = sessions[index % sessions.length];
    while (Date.now() < deadline) {
      await timed('feed', session, '/api/feed?limit=12');
      if (postIds.length) {
        const post = postIds[Math.floor(Math.random() * postIds.length)];
        await timed('view', session, `/api/posts/${post}/view`, { method: 'POST', json: { watch_ms: 1500, duration_ms: 8000, source: 'load-test' } });
        await timed('event', session, '/api/events', { method: 'POST', json: { event_type: 'impression', post_id: post, source: 'load-test' } });
      }
      await timed('messages', session, '/api/messages/bootstrap?box=inbox');
      await sleep(200 + Math.random() * 400);
    }
  };
  await Promise.all(Array.from({ length: USERS }, (_, index) => virtualUser(index)));
  controller.abort();

  console.log(`\n${USERS} virtual users for ${DURATION_S} s against ${APP}`);
  let serverErrors = 0;
  const all = [];
  for (const [label, entry] of stats) {
    const codes = [...entry.status].map(([code, count]) => `${code}x${count}`).join(' ');
    for (const [code, count] of entry.status) if (code >= 500) serverErrors += count;
    all.push(...entry.ms);
    console.log(`  ${label.padEnd(9)} n=${String(entry.ms.length).padStart(5)}  p50=${percentile(entry.ms, 50).toFixed(0)} ms  p95=${percentile(entry.ms, 95).toFixed(0)} ms  ${codes}`);
  }
  console.log(`  streams   open=${streamsOpen} refused=${streamsRefused}`);
  check('no 5xx responses', serverErrors === 0, `${serverErrors} seen`);
  check('no network errors', networkErrors === 0, `${networkErrors} seen`);
  const p95 = percentile(all, 95);
  check(`p95 latency under ${P95_TARGET_MS} ms`, p95 < P95_TARGET_MS, `${p95.toFixed(0)} ms over ${all.length} requests`);
  check('message streams open up to the per-account cap', streamsOpen > 0 && streamsRefused === 0, `${streamsOpen} open, ${streamsRefused} refused`);
}

// Send `count` requests one after another. Returns the 1-based attempt that first got a 429 (0 = never) and any 5xx.
async function burst(session, count, build) {
  let firstLimited = 0;
  let serverErrors = 0;
  for (let attempt = 1; attempt <= count; attempt++) {
    const { path, options } = build(attempt);
    const res = await session.call(path, options);
    await res.arrayBuffer();
    if (res.status === 429 && !firstLimited) firstLimited = attempt;
    if (res.status >= 500) serverErrors++;
  }
  return { firstLimited, serverErrors };
}

async function runAbuse() {
  const user = await signIn(ACCOUNTS[0]);
  const anonymous = new Session();
  // [name, session, documented limit, requests to send, request builder]
  const bursts = [
    ['login (per account)', anonymous, 10, 14, () => ({ path: '/api/auth/login', options: { method: 'POST', json: { identifier: `abuse-login-${process.pid}@example.com`, password: 'wrong-password-1' } } })],
    ['register (per IP)', anonymous, 5, 8, () => ({ path: '/api/auth/register', options: { method: 'POST', json: { email: `abuse-${randomId()}@example.com`, username: `abuse${randomId()}`, password: 'wrong-password-1', accept_terms: true } } })],
    ['report', user, 20, 24, () => ({ path: '/api/reports', options: { method: 'POST', json: { target_type: 'post', target_id: crypto.randomUUID(), reason: 'spam' } } })],
    ['follow', user, 120, 126, () => ({ path: `/api/users/abuse-nobody-${process.pid}/follow`, options: { method: 'PUT' } })],
    ['direct message (conversations per hour)', user, 30, 34, () => ({ path: '/api/messages/direct', options: { method: 'POST', json: { username: `abuse-nobody-${process.pid}`, kind: 'text', text: 'x', client_id: randomId() } } })],
    ['events (SX_EVENT_RPM)', user, EVENT_RPM, EVENT_RPM + 6, () => ({ path: '/api/events', options: { method: 'POST', json: { event_type: 'impression', source: 'abuse-test' } } })],
    ['post view (SX_EVENT_RPM)', user, EVENT_RPM, EVENT_RPM + 6, () => ({ path: `/api/posts/${crypto.randomUUID()}/view`, options: { method: 'POST', json: { watch_ms: 100 } } })],
  ];
  for (const [name, session, limit, count, build] of bursts) {
    const { firstLimited, serverErrors } = await burst(session, count, build);
    check(`${name}: 429 by request ${limit + 1}`, firstLimited > 0 && firstLimited <= limit + 1, `first 429 at ${firstLimited || 'never'} of ${count}`);
    check(`${name}: no 5xx`, serverErrors === 0, `${serverErrors} seen`);
  }
}

(async () => {
  try {
    if (ABUSE) await runAbuse(); else await runLoad();
  } catch (error) {
    check('probe ran', false, error.message);
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
