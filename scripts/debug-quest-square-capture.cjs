// Black-square glitch capture rig for the VR reels player (Quest 3, USB).
// Orchestrates metavr: logcat stream, metacam screenshot loop, XR diag poll,
// ovrgpuprofiler sampling, and headset VideoShots/Screenshots pull.
//
// Usage (from repo root):
//   node scripts/debug-quest-square-capture.cjs start
//   node scripts/debug-quest-square-capture.cjs stop
//   node scripts/debug-quest-square-capture.cjs status
//
// Artifacts land in reports/quest-squares-<UTC timestamp>/ (gitignored).

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const METAVR = ['npx', '-y', 'metavr'];
const REPO_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');
const PIDFILE = path.join(LOGS_DIR, 'quest-square-capture.json');
const DIAG_URL = process.env.DIAG_URL || 'http://localhost:8000/api/reels/diag';
const SCREENSHOT_INTERVAL_MS = Number(process.env.CAP_INTERVAL_MS || 2000);
const GPUPROFILER_INTERVAL_MS = Number(process.env.GPU_INTERVAL_MS || 15000);

function run(args, opts = {}) {
  const r = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    let out = '';
    r.stdout.on('data', (d) => { out += d; });
    r.stderr.on('data', (d) => { out += d; });
    r.on('close', (code) => resolve({ code, out }));
    r.on('error', (e) => resolve({ code: -1, out: String(e) }));
    if (opts.timeoutMs) setTimeout(() => { try { r.kill('SIGKILL'); } catch (e) {} }, opts.timeoutMs);
  });
}

async function metavr(args, opts = {}) {
  return run([...METAVR, ...args], opts);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function assertDeviceConnected() {
  const { code, out } = await metavr(['device', 'list'], { timeoutMs: 30000 });
  if (code !== 0 || !out.trim()) {
    console.error('No Quest device detected. Check USB cable (data-capable), developer mode, and the USB-debugging prompt.\n--- metavr output ---\n' + out);
    process.exit(1);
  }
  console.log(out.trim());
}

function killPid(pid) {
  if (!pid) return;
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try {
      // Negative pid = kill the whole process group (the detached worker is a
      // group leader, so its npx/adb children die with it).
      process.kill(-pid, sig);
      console.log(`Stopped background sampler pid ${pid} (group)`);
      return;
    } catch (groupErr) {
      try {
        process.kill(pid, sig);
        console.log(`Stopped background sampler pid ${pid}`);
        return;
      } catch (e) {
        if (sig === 'SIGKILL') {
          // already gone
        }
      }
    }
  }
}

async function start(label) {
  await assertDeviceConnected();

  const tag = String(label || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

  // Enable detailed GPU profiling so the ovrgpuprofiler -t sampler can attach.
  // Only applies to applications started AFTER this — the checklist below
  // tells the user to force-close the Quest Browser first.
  const en = await metavr(['adb', 'shell', 'ovrgpuprofiler', '-e'], { timeoutMs: 30000 });
  console.log('ovrgpuprofiler -e: ' + (en.out.trim() || 'enabled'));

  const dir = path.join(REPORTS_DIR, 'quest-squares-' + timestamp() + (tag ? '-' + tag : ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const children = [];

  // 1. Logcat poller — metavr `logcat --follow` buffers silently when piped,
  //    so poll `metavr log` dumps and append lines newer than the last seen
  //    device timestamp (proven working in the 2026-09-20 session).
  const logPollSrc = `
    const fs = require('fs');
    const { spawn } = require('child_process');
    const dir = ${JSON.stringify(dir)};
    const out = fs.createWriteStream(dir + '/logcat.txt', { flags: 'a' });
    let lastTs = Date.now() - 120000; // start ~2min back
    let busy = false;
    function lineToMs(line) {
      const m = line.match(/^(\\d{2})-(\\d{2})\\s+(\\d{2}):(\\d{2}):(\\d{2})\\.(\\d{3})/);
      if (!m) return null;
      return Date.UTC(new Date().getUTCFullYear(), Number(m[2]) - 1, Number(m[1]),
        Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    }
    async function poll() {
      if (busy) return;
      busy = true;
      const p = spawn('npx', ['-y', 'metavr', 'log', '-n', '400'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      p.stdout.on('data', (d) => { buf += d; });
      p.stderr.on('data', (d) => { buf += d; });
      const done = new Promise((r) => { p.on('close', r); p.on('error', r); });
      const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 15000);
      await done;
      clearTimeout(killer);
      busy = false;
      let maxTs = lastTs;
      for (const line of buf.split('\\n')) {
        const ms = lineToMs(line);
        if (ms === null || ms <= lastTs) continue;
        out.write(line + '\\n');
        if (ms > maxTs) maxTs = ms;
      }
      lastTs = maxTs;
    }
    (async function loop() {
      for (;;) { await poll(); await new Promise((r) => setTimeout(r, 5000)); }
    })();
  `;
  const logPollPath = path.join(LOGS_DIR, 'quest-square-logpoll.cjs');
  fs.writeFileSync(logPollPath, logPollSrc);
  const logPoll = spawn(process.execPath, [logPollPath], { stdio: 'ignore', detached: true });
  logPoll.unref();
  children.push({ name: 'logcat', pid: logPoll.pid });
  console.log(`[1/4] logcat poller (5s dumps) -> logcat.txt (pid ${logPoll.pid})`);

  // 2. On-device screencap loop — ONE persistent adb shell on the device does
  //    `screencap` every CAP_INTERVAL_MS into /sdcard/quest_caps/ (timestamps
  //    in the filename); the bulk pull happens at stop. Host-side metavr
  //    invocations cost ~10s each, which capped the old loop at ~15s cadence.
  //    metacam is absent on this device; screencap captures the stereo
  //    eye-buffer surface (both eyes side-by-side).
  const capCount = Number(process.env.CAP_COUNT || 400);
  const capIntervalS = Math.max(1, Math.round(SCREENSHOT_INTERVAL_MS / 1000));
  const capShell = `mkdir -p /sdcard/quest_caps; rm -f /sdcard/quest_caps_stop; i=0; while [ $i -lt ${capCount} ]; do [ -f /sdcard/quest_caps_stop ] && break; i=$((i+1)); screencap -p /sdcard/quest_caps/cap_$(date +%H%M%S)_$i.png; sleep ${capIntervalS}; done`;
  const loopSrc = `
    const { spawn } = require('child_process');
    const shell = ${JSON.stringify(capShell)};
    // Attached (not detached/unref'd): killing this worker's process group
    // takes the adb connection down, which ends the on-device shell loop.
    const p = spawn('npx', ['-y', 'metavr', 'adb', 'shell', shell], { stdio: 'ignore' });
    p.on('error', () => {});
  `;
  const loopPath = path.join(LOGS_DIR, 'quest-square-shotloop.cjs');
  fs.writeFileSync(loopPath, loopSrc);
  const loop = spawn(process.execPath, [loopPath], { stdio: 'ignore', detached: true });
  loop.unref();
  children.push({ name: 'screenshots', pid: loop.pid });
  console.log(`[2/4] on-device screencap loop every ~${capIntervalS}s x${capCount} -> /sdcard/quest_caps (pid ${loop.pid}); pulled at stop`);

  // 3. XR diag poller (1 Hz) — correlates your in-app telemetry with captures.
  const diagSrc = `
    const fs = require('fs');
    const dir = ${JSON.stringify(dir)};
    const out = fs.createWriteStream(dir + '/diag.jsonl', { flags: 'a' });
    (async function poll() {
      for (;;) {
        try {
          const res = await fetch(${JSON.stringify(DIAG_URL)});
          const body = await res.text();
          out.write(JSON.stringify({ t: new Date().toISOString(), diag: JSON.parse(body) }) + '\\n');
        } catch (e) {
          out.write(JSON.stringify({ t: new Date().toISOString(), error: String(e) }) + '\\n');
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
  `;
  const diagPath = path.join(LOGS_DIR, 'quest-square-diag.cjs');
  fs.writeFileSync(diagPath, diagSrc);
  const diag = spawn(process.execPath, [diagPath], { stdio: 'ignore', detached: true });
  diag.unref();
  children.push({ name: 'diag', pid: diag.pid });
  console.log(`[3/4] diag poller 1Hz ${DIAG_URL} -> diag.jsonl (pid ${diag.pid})`);

  // 4. ovrgpuprofiler -t sampler — Meta's documented live FFR/GPU-stage readout.
  const gpuSrc = `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const dir = ${JSON.stringify(dir)};
    const interval = ${GPUPROFILER_INTERVAL_MS};
    (async function next() {
      for (;;) {
        const p = spawn('npx', ['-y', 'metavr', 'adb', 'shell', 'ovrgpuprofiler', '-t'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        await new Promise((r) => p.on('close', r).on('error', r));
        fs.appendFileSync(dir + '/ovrgpuprofiler.txt',
          '=== ' + new Date().toISOString() + ' ===\\n' + out.trim() + '\\n');
        await new Promise((r) => setTimeout(r, interval));
      }
    })();
  `;
  const gpuPath = path.join(LOGS_DIR, 'quest-square-gpu.cjs');
  fs.writeFileSync(gpuPath, gpuSrc);
  const gpu = spawn(process.execPath, [gpuPath], { stdio: 'ignore', detached: true });
  gpu.unref();
  children.push({ name: 'ovrgpuprofiler', pid: gpu.pid });
  console.log(`[4/4] ovrgpuprofiler -t every ${GPUPROFILER_INTERVAL_MS / 1000}s -> ovrgpuprofiler.txt (pid ${gpu.pid})`);

  const state = { dir, label: tag || null, startedAt: new Date().toISOString(), children };
  fs.writeFileSync(PIDFILE, JSON.stringify(state, null, 2));

  console.log('\nSession dir: ' + dir);
  if (tag) console.log('Session label: ' + tag);
  console.log('\nIN-HEADSET CHECKLIST:');
  console.log('  0. IMPORTANT: force-close the Quest Browser app now (dock > browser > close),');
  console.log('     then reopen the player — ovrgpuprofiler -e only traces apps started after it.');
  console.log('  1. Full tab close + reopen the player (reload discipline).');
  console.log('  2. Enter VR, play reels steadily (rapid switching hides the squares).');
  console.log('  3. Optionally hold the capture button to record video during square-prone stretches.');
  console.log('  4. Exit VR, then run: node scripts/debug-quest-square-capture.cjs stop');
  console.log('     (stop pulls the headset VideoShots + Screenshots and kills the samplers)');
}

async function stop() {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(PIDFILE, 'utf8'));
  } catch (e) {
    console.error('No active capture session (missing ' + PIDFILE + ').');
    process.exit(1);
  }
  const dir = state.dir;
  console.log('Stopping session ' + dir + (state.label ? ' [label: ' + state.label + ']' : ''));

  for (const child of state.children || []) killPid(child.pid);

  // Self-terminate the on-device screencap loop (no pkill on device; the loop
  // checks /sdcard/quest_caps_stop each iteration), give it a beat to exit.
  await metavr(['adb', 'shell', 'touch /sdcard/quest_caps_stop'], { timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 5000));

  // Disable detailed GPU profiling (enabled at start).
  await metavr(['adb', 'shell', 'ovrgpuprofiler', '-d'], { timeoutMs: 30000 });

  // Pull headset recordings + screenshots captured today (filename date filter
  // avoids re-pulling years of old VideoShots; mtime check kept as backstop).
  const startedMs = Date.parse(state.startedAt);
  const startedLocal = new Date(startedMs);
  const dateTag = startedLocal.getFullYear().toString() +
    String(startedLocal.getMonth() + 1).padStart(2, '0') +
    String(startedLocal.getDate()).padStart(2, '0');
  for (const [remote, local, filterByDate] of [
    ['/sdcard/Oculus/VideoShots/', 'videos', true],
    ['/sdcard/Oculus/Screenshots/', 'screenshots', true],
  ]) {
    const dest = path.join(dir, local);
    fs.mkdirSync(dest, { recursive: true });
    const { out } = await metavr(['files', 'ls', remote], { timeoutMs: 30000 });
    const files = (out || '').split('\n')
      .map((l) => l.trim())
      .filter((l) => /\.(mp4|jpg|png)$/i.test(l));
    let pulled = 0;
    for (const f of files) {
      // metavr files ls lines may include metadata; take the last token.
      const name = f.split(/\s+/).pop();
      // Headset capture names embed the recording date (…-20260920-….mp4);
      // skip everything older than today so we never re-pull years of VideoShots.
      if (filterByDate && !name.includes(dateTag)) continue;
      const pulledPath = path.join(dest, name);
      if (fs.existsSync(pulledPath)) continue; // idempotent re-pull
      const r = await metavr(['files', 'pull', remote + name, pulledPath], { timeoutMs: 120000 });
      if (r.code === 0 && fs.existsSync(pulledPath) && fs.statSync(pulledPath).mtimeMs >= startedMs - 60000) {
        pulled++;
      } else if (r.code !== 0) {
        try { fs.unlinkSync(pulledPath); } catch (e) {}
      }
    }
    console.log(`Pulled ${pulled} file(s) from ${remote} -> ${dest}`);
  }

  // Bulk-pull the on-device screencap staging dir: raw `adb pull` moves
  // ~33 MB/s in one invocation (metavr per-file pulls cost ~15s each;
  // metavr dir pull and tar-over-shell are broken on this setup).
  // NOTE: do NOT pre-create the target — when the destination exists,
  // adb nests the source dir inside it (…/ondevice-caps/quest_caps/).
  const capsDest = path.join(dir, 'ondevice-caps');
  try {
    const adbBin = execSync('command -v adb', { encoding: 'utf8' }).trim();
    if (adbBin) {
      execSync(`"${adbBin}" pull /sdcard/quest_caps "${capsDest}" 2>&1`, { timeout: 300000 }).toString();
    } else {
      console.log('adb not found; leaving caps on device at /sdcard/quest_caps');
    }
  } catch (e) {
    console.log('Bulk adb pull failed (' + String(e).slice(0, 120) + '); leaving caps on device at /sdcard/quest_caps');
  }
  // adb may nest the dir if the destination pre-existed; normalize layout.
  let capsCount = 0;
  const nested = path.join(capsDest, 'quest_caps');
  if (fs.existsSync(nested)) {
    for (const f of fs.readdirSync(nested)) {
      try { fs.renameSync(path.join(nested, f), path.join(capsDest, f)); } catch (e) {}
    }
    try { fs.rmdirSync(nested); } catch (e) {}
  }
  if (fs.existsSync(capsDest)) {
    capsCount = fs.readdirSync(capsDest).filter((f) => f.endsWith('.png')).length;
  }
  console.log(`Pulled ${capsCount} caps -> ${capsDest}`);
  await metavr(['adb', 'shell', 'rm -rf /sdcard/quest_caps /sdcard/quest_caps_stop'], { timeoutMs: 30000 });

  // Manifest
  const manifest = { label: state.label || null, startedAt: state.startedAt, stoppedAt: new Date().toISOString(), files: [] };
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) continue;
    manifest.files.push({ file: f, bytes: fs.statSync(p).size });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  try { fs.unlinkSync(PIDFILE); } catch (e) {}
  console.log('Manifest written. Session ready for analysis: ' + dir);
}

async function status() {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(PIDFILE, 'utf8'));
  } catch (e) {
    console.log('No active capture session.');
    return;
  }
  console.log('Active session: ' + state.dir + (state.label ? ' [label: ' + state.label + ']' : ''));
  for (const child of state.children || []) {
    if (child.name === 'screenshots') {
      console.log(`  screenshots: device-side shell loop (worker pid ${child.pid} self-exits after spawning)`);
      continue;
    }
    try { process.kill(child.pid, 0); console.log(`  ${child.name}: running (pid ${child.pid})`); } catch (e) { console.log(`  ${child.name}: DEAD (pid ${child.pid})`); }
  }
  const caps = fs.readdirSync(state.dir).filter((f) => /^cap_/.test(f) && f.endsWith('.png')).length;
  console.log(`  host screenshots captured so far: ${caps}`);
  try {
    const dev = await metavr(['adb', 'shell', 'ls /sdcard/quest_caps 2>/dev/null | wc -l'], { timeoutMs: 30000 });
    console.log(`  on-device caps staged: ${(dev.out || '').trim()}`);
  } catch (e) {}
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'start') await start(process.argv[3]);
  else if (cmd === 'stop') await stop();
  else if (cmd === 'status') await status();
  else {
    console.error('Usage: node scripts/debug-quest-square-capture.cjs <start [label]|stop|status>');
    process.exit(2);
  }
})();
