import { useState } from 'react';
import { Pills } from '../ui/controls.jsx';

// Moderation overview: health checks, activity, safety queue and server health.
// Charts are plain SVG and CSS, no chart library; hover text comes from <title>.

const WINDOWS = {
  '24h': { now: 'the last 24 hours', before: 'the 24 hours before' },
  '7d': { now: 'the last 7 days', before: 'the 7 days before' },
};

// `up` says whether a rise is good news, bad news or neither (colours the change).
const METRICS = [
  { key: 'reports', label: 'REPORTS FILED', def: 'User reports about profiles, posts, packs, comments or messages.', up: 'bad', pick: (w) => w.reports },
  { key: 'signups', label: 'VERIFIED SIGN-UPS', def: 'New accounts that finished email verification.', up: 'good', pick: (w) => w.registrations.active },
  { key: 'unverified', label: 'UNVERIFIED SIGN-UPS', def: 'New accounts still waiting on email. A sudden jump can mean bots.', up: 'bad', pick: (w) => w.registrations.pending },
  { key: 'posts', label: 'NEW POSTS', def: 'Videos and images people published.', up: 'good', pick: (w) => w.posts },
  { key: 'credits_captured', label: 'CREDITS SPENT', def: 'Credits charged for finished AI jobs.', up: 'good', pick: (w) => w.credits_captured },
  { key: 'messages', label: 'DIRECT MESSAGES', def: 'Messages sent between users.', up: 'neutral', pick: (w) => w.messages },
  { key: 'support_requests', label: 'SUPPORT REQUESTS', def: 'Appeals and help requests sent to staff.', up: 'bad', pick: (w) => w.support_requests },
];

const REPORT_STATUSES = [
  { key: 'open', label: 'OPEN', color: 'var(--sx-accent)' },
  { key: 'resolved', label: 'RESOLVED', color: 'var(--sx-success)' },
  { key: 'dismissed', label: 'DISMISSED', color: 'var(--sx-ink-muted)' },
];

// 429 is its own status class in server/metrics.py, apart from other 4xx.
const OUTCOMES = {
  '2xx': ['OK', 'var(--sx-success)'],
  '3xx': ['REDIRECT', 'var(--sx-ink-2)'],
  '4xx': ['CLIENT ERROR', 'var(--sx-warn)'],
  '429': ['RATE-LIMITED', 'var(--sx-accent)'],
  '5xx': ['SERVER ERROR', 'var(--sx-danger)'],
};
// Spelled out: JS lists the integer-like key '429' first in OUTCOMES.
const OUTCOME_ORDER = ['2xx', '3xx', '4xx', '429', '5xx'];

// The SPA catch-all and unmatched paths have no readable template of their own.
const ROUTE_NAMES = { '/{full_path:path}': 'PAGES + STATIC FILES', other: 'UNMATCHED PATHS' };

const HOUR = 3600000;
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const fmt = (value) => (value === null || value === undefined ? 'N/A' : Number(value).toLocaleString('en-US'));
const pct = (value, digits = 1) => (value * 100).toFixed(digits) + '%';
const utcHour = (time) => String(new Date(time).getUTCHours()).padStart(2, '0') + ':00';
const utcDay = (time) => DAY_NAMES[new Date(time).getUTCDay()] + ' ' + new Date(time).getUTCDate();
const label = (value) => value.replace(/_/g, ' ').toUpperCase();
const routeName = (row) => (row.method ? row.method + ' ' : '') + (ROUTE_NAMES[row.route] || row.route);
// Rough width of a mono label at 10px, for axis gutters.
const textWidth = (text) => String(text).length * 6.2;

// Up to ~4 round tick values from 0 covering `max`.
function ticks(max) {
  const raw = Math.max(1, max) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw));
  const top = Math.ceil(Math.max(1, max) / step) * step;
  return { top, list: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
}

// A ring slice from angle a0 to a1 (radians, 0 at the top, clockwise).
function arcPath(inner, outer, a0, a1) {
  const end = Math.min(a1, a0 + Math.PI * 2 - 0.0001);
  const at = (r, a) => (r * Math.sin(a)).toFixed(2) + ' ' + (-r * Math.cos(a)).toFixed(2);
  const large = end - a0 > Math.PI ? 1 : 0;
  return 'M' + at(outer, a0) + 'A' + outer + ' ' + outer + ' 0 ' + large + ' 1 ' + at(outer, end)
    + 'L' + at(inner, end) + 'A' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + at(inner, a0) + 'Z';
}

// Hourly series (oldest first, last hour still running) cut into the window and the one before:
// hours for 24 h, 24-hour days for 7 d.
function windowBuckets(hourly, windowKey, key) {
  const series = hourly?.series?.[key];
  if (!series) return null;
  const start = Date.parse(hourly.start);
  const n = series.length;
  const size = windowKey === '24h' ? 1 : 24;
  const cut = (from) => Array.from({ length: windowKey === '24h' ? 24 : 7 }, (_, i) => {
    const first = from + i * size;
    return { value: series.slice(first, first + size).reduce((sum, v) => sum + v, 0), at: start + first * HOUR };
  });
  const span = windowKey === '24h' ? 24 : 168;
  return { now: cut(n - span), before: cut(n - 2 * span) };
}

function Tag({ children }) {
  return <span className="sx-ov-tag">{children}</span>;
}

function Card({ id, title, note, wide = false, children, head }) {
  return (
    <article className={'sx-ov-card' + (wide ? ' sx-ov-span' : '')} id={id}>
      <div className="sx-ov-card-head">
        <div>
          <h3>{title}</h3>
          {note ? <p className="sx-ov-note">{note}</p> : null}
        </div>
        {head}
      </div>
      {children}
    </article>
  );
}

function Track({ value, max, tone = '', ariaLabel }) {
  const width = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="sx-ov-track" role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      <span className={'sx-ov-fill' + (tone ? ' sx-ov-' + tone : '')} style={{ width: width + '%' }} />
    </div>
  );
}

// Horizontal bars, longest first.
function BarList({ rows, empty }) {
  if (!rows.length) return <p className="sx-ov-note">{empty}</p>;
  const max = Math.max(...rows.map((row) => row.value));
  return (
    <ul className="sx-ov-bars">
      {rows.map((row) => (
        <li key={row.label}>
          <span className="sx-ov-bar-label" title={row.label}>{row.label}</span>
          <Track value={row.value} max={max} tone="now" ariaLabel={row.label + ' ' + row.value} />
          <b>{fmt(row.value)}</b>
        </li>
      ))}
    </ul>
  );
}

function Chip({ check, onSelect }) {
  return (
    <button type="button" className="sx-ov-chip" data-state={check.state} onClick={() => onSelect(check)}
      aria-label={check.label + ': ' + check.value + ', ' + check.note + ', ' + check.state}>
      <span className="sx-ov-chip-label"><i className="sx-ov-dot" />{check.label}</span>
      <span className="sx-ov-chip-value">{check.value}</span>
      <span className="sx-ov-chip-note">{check.note}</span>
    </button>
  );
}

const level = (value, bad, warn) => (value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok');

// Red is the server's own alert limit (server/metrics.py alert_limits); amber is a share of it.
function healthChecks(stats, w, ops) {
  const q = stats.queue_limits;
  const spikes = METRICS.filter((m) => m.pick(w).spike).map((m) => m.label);
  const checks = [
    { key: 'spikes', label: 'ACTIVITY SPIKES', state: spikes.length ? 'bad' : 'ok', value: fmt(spikes.length), note: spikes.length ? spikes.join(', ') : 'nothing unusual', target: 'sx-ov-community' },
    { key: 'reports', label: 'REPORT QUEUE', state: level(stats.open_reports, q.open_reports, 1), value: fmt(stats.open_reports), note: (stats.open_reports ? 'waiting for review' : 'queue clear') + ' · limit ' + q.open_reports, tab: 'reports' },
    { key: 'support', label: 'SUPPORT INBOX', state: level(stats.open_support_requests, q.open_support_requests, 1), value: fmt(stats.open_support_requests), note: (stats.open_support_requests ? 'waiting' : 'inbox clear') + ' · limit ' + q.open_support_requests, tab: 'support' },
  ];
  if (ops) {
    const L = ops.limits;
    const r = ops.requests;
    // The server skips rate and latency alerts below min_requests, so those stay amber at most.
    const quiet = r.count < L.min_requests;
    const capped = (state) => (quiet && state === 'bad' ? 'warn' : state);
    const quietNote = 'only ' + r.count + ' requests · no alert under ' + L.min_requests;
    const failures = (ops.events.job_failed || 0) + (ops.events.derived_failed || 0);
    const pool = ops.db_pool;
    checks.push(
      { key: 'errors', label: 'SERVER ERRORS', state: capped(level(r.error_rate, L.error_rate, L.error_rate / 5)), value: pct(r.error_rate), note: quiet ? quietNote : 'of requests failed · limit ' + pct(L.error_rate, 0), target: 'sx-ov-requests' },
      { key: 'latency', label: 'SLOWEST 5% OF CALLS', state: capped(level(r.p95_ms || 0, L.p95_ms, L.p95_ms / 2)), value: r.p95_ms === null ? 'N/A' : fmt(r.p95_ms) + ' ms', note: quiet ? quietNote : 'limit ' + fmt(L.p95_ms) + ' ms', target: 'sx-ov-routes' },
      { key: 'jobs', label: 'AI JOB SLOTS', state: level(ops.jobs.active / ops.jobs.capacity, 1, 0.8), value: fmt(ops.jobs.active), note: 'of ' + ops.jobs.capacity + ' in use', target: 'sx-ov-capacity' },
      { key: 'failures', label: 'FAILED AI JOBS', state: level(failures, L.failures, 1), value: fmt(failures), note: 'last 5 min · limit ' + L.failures, target: 'sx-ov-requests' },
    );
    if (pool.capacity) {
      checks.push({ key: 'db_pool', label: 'DATABASE CONNECTIONS', state: level(pool.checkedout / pool.capacity, 1, 0.8), value: fmt(pool.checkedout), note: 'of ' + pool.capacity + ' checked out', target: 'sx-ov-capacity' });
    }
  }
  (stats.disk || []).forEach((volume) => checks.push({
    key: 'disk_' + volume.volume, label: 'DISK · ' + volume.volume.toUpperCase(), state: volume.ok ? 'ok' : 'bad',
    value: volume.free_gb === null ? 'N/A' : volume.free_gb + ' GB', note: volume.ok ? 'free' : 'free · too low for new renders', target: ops ? 'sx-ov-disk' : undefined,
  }));
  const order = { bad: 0, warn: 1, ok: 2 };
  return checks.sort((a, b) => order[a.state] - order[b.state]);
}

function Takeaway({ checks, windowKey }) {
  const bad = checks.filter((c) => c.state === 'bad');
  const warn = checks.filter((c) => c.state === 'warn');
  if (!bad.length && !warn.length) return <p className="sx-ov-take">Everything looks healthy in {WINDOWS[windowKey].now}.</p>;
  const parts = [];
  if (bad.length) parts.push(bad.length + (bad.length === 1 ? ' problem' : ' problems'));
  if (warn.length) parts.push(warn.length + (warn.length === 1 ? ' thing' : ' things') + ' to watch');
  return (
    <p className="sx-ov-take">
      {parts.join(' and ')}.
      {bad.length ? <> Look first at <b>{bad.map((c) => c.label.toLowerCase()).join(', ')}</b>.</> : null}
    </p>
  );
}

function Sparkline({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <svg className="sx-ov-spark" viewBox={'0 0 ' + rows.length * 4 + ' 28'} preserveAspectRatio="none" aria-hidden="true">
      {rows.map((r, i) => {
        const height = Math.max(1, (r.value / max) * 28);
        return <rect key={i} x={i * 4} y={28 - height} width={3} height={height} className={i === rows.length - 1 ? 'sx-ov-hot' : ''} />;
      })}
    </svg>
  );
}

function KpiCard({ metric, w, spark }) {
  const m = metric.pick(w);
  const change = m.previous ? (m.current - m.previous) / m.previous : null;
  const tone = change === null || change === 0 || metric.up === 'neutral' ? '' : (change > 0) === (metric.up === 'good') ? 'good' : 'bad';
  const max = Math.max(m.current, m.previous);
  return (
    <article className={'sx-ov-card sx-ov-kpi' + (m.spike ? ' sx-ov-spiking' : '')}>
      <div className="sx-ov-kpi-top">
        <h3>{metric.label}</h3>
        {m.spike ? <span className="sx-ov-badge">SPIKE</span> : null}
      </div>
      <div className="sx-ov-kpi-row">
        <b className="sx-ov-big">{fmt(m.current)}</b>
        <span className="sx-ov-delta" data-tone={tone}>
          {change === null ? (m.current ? 'NEW' : '') : (change > 0 ? '▲ +' : change < 0 ? '▼ ' : '') + pct(change, 0) + ' VS BEFORE'}
        </span>
      </div>
      {spark ? <Sparkline rows={spark.now} /> : null}
      <div className="sx-ov-pair">
        <div className="sx-ov-pair-row"><span>NOW</span><Track value={m.current} max={max} tone={m.spike ? 'hot' : 'now'} ariaLabel={metric.label + ' now ' + m.current} /></div>
        <div className="sx-ov-pair-row"><span>BEFORE</span><Track value={m.previous} max={max} ariaLabel={metric.label + ' before ' + m.previous} /></div>
      </div>
      <p className="sx-ov-note">Before: {fmt(m.previous)} · {metric.def}</p>
    </article>
  );
}

function TrendChart({ series, metric, windowKey }) {
  const W = 640, H = 220, bottom = 22, top = 10;
  const { now, before } = series;
  const n = now.length;
  const t = ticks(Math.max(...now.map((r) => r.value), ...before.map((r) => r.value)));
  const left = Math.max(...t.list.map((v) => textWidth(fmt(v)))) + 10;
  const x = (i) => left + (i * (W - 10 - left)) / (n - 1);
  const y = (v) => H - bottom - (v / t.top) * (H - bottom - top);
  const line = (rows) => rows.map((r, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(r.value).toFixed(1)).join(' ');
  const tickText = windowKey === '24h' ? utcHour : utcDay;
  const tipTime = windowKey === '24h' ? (at) => utcDay(at) + ', ' + utcHour(at) + ' UTC' : (at) => '24 H FROM ' + utcDay(at) + ', ' + utcHour(at) + ' UTC';
  const every = Math.ceil(n / 8);
  return (
    <svg className="sx-ov-chart" viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label={metric.label + ' over time, now and before'}>
      <defs>
        <linearGradient id="sx-ov-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--sx-accent)', stopOpacity: 0.26 }} />
          <stop offset="1" style={{ stopColor: 'var(--sx-accent)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {t.list.map((v) => (
        <g key={v}>
          <line className="sx-ov-gridline" x1={left} x2={W - 10} y1={y(v)} y2={y(v)} />
          <text className="sx-ov-tick" x={left - 8} y={y(v) + 3} textAnchor="end">{fmt(v)}</text>
        </g>
      ))}
      {now.map((r, i) => (i % every === 0
        ? <text key={i} className="sx-ov-tick" x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : 'middle'}>{tickText(r.at)}</text>
        : null))}
      <path d={line(now) + ' L' + x(n - 1) + ' ' + y(0) + ' L' + x(0) + ' ' + y(0) + ' Z'} fill="url(#sx-ov-grad)" />
      <path className="sx-ov-line-before" d={line(before)} />
      <path className="sx-ov-line-now" d={line(now)} />
      <circle className="sx-ov-last" cx={x(n - 1)} cy={y(now[n - 1].value)} r={4} />
      {now.map((r, i) => {
        const half = (W - 10 - left) / (n - 1) / 2;
        return (
          <g key={'hit' + i} className="sx-ov-hit">
            <rect x={x(i) - half} y={0} width={half * 2} height={H - bottom} />
            <line x1={x(i)} x2={x(i)} y1={top} y2={H - bottom} />
            <title>{tipTime(r.at) + ' · NOW ' + fmt(r.value) + ' · BEFORE ' + fmt(before[i].value)}</title>
          </g>
        );
      })}
    </svg>
  );
}

// The last 7 days by UTC hour of day; brighter means busier.
function Heatmap({ hourly, metric }) {
  const series = hourly.series[metric.key];
  const start = Date.parse(hourly.start);
  const cells = [];
  for (let i = Math.max(0, series.length - 168); i < series.length; i += 1) {
    const at = start + i * HOUR;
    cells.push({ at, day: new Date(at).toISOString().slice(0, 10), hour: new Date(at).getUTCHours(), value: series[i] });
  }
  const days = [...new Set(cells.map((c) => c.day))];
  const max = Math.max(1, ...cells.map((c) => c.value));
  const left = 52, W = 480, cw = (W - left) / 24, ch = Math.min(22, Math.max(12, cw)), H = days.length * ch + 18;
  return (
    <svg className="sx-ov-chart" viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label={metric.label + ' by hour and day'}>
      {cells.map((c) => (
        <rect key={c.at} x={left + c.hour * cw + 1} y={days.indexOf(c.day) * ch + 1} width={Math.max(1, cw - 2)} height={ch - 2}
          className={c.value ? 'sx-ov-heat' : 'sx-ov-cold'} style={c.value ? { fillOpacity: 0.12 + 0.88 * (c.value / max) } : undefined}>
          <title>{utcDay(c.at) + ', ' + utcHour(c.at) + ' UTC · ' + fmt(c.value)}</title>
        </rect>
      ))}
      {days.map((day, i) => <text key={day} className="sx-ov-tick" x={left - 6} y={i * ch + ch / 2 + 3} textAnchor="end">{utcDay(Date.parse(day))}</text>)}
      {[0, 6, 12, 18].map((hour) => <text key={hour} className="sx-ov-tick" x={left + hour * cw} y={H - 4}>{String(hour).padStart(2, '0') + ':00'}</text>)}
    </svg>
  );
}

function Funnel({ w, windowKey }) {
  const verified = w.registrations.active.current;
  const created = verified + w.registrations.pending.current;
  if (!created) return <p className="sx-ov-note">No sign-ups in {WINDOWS[windowKey].now}.</p>;
  const lost = created - verified;
  return (
    <div className="sx-ov-funnel">
      <div className="sx-ov-funnel-row">
        <span className="sx-ov-bar-label">CREATED AN ACCOUNT</span>
        <Track value={created} max={created} />
        <b>{fmt(created)}</b>
      </div>
      {lost ? <div className="sx-ov-funnel-loss">▼ {fmt(lost)} not verified yet ({pct(lost / created)})</div> : null}
      <div className="sx-ov-funnel-row">
        <span className="sx-ov-bar-label">VERIFIED EMAIL</span>
        <Track value={verified} max={created} tone="now" />
        <b>{fmt(verified) + ' · ' + pct(verified / created, 0)}</b>
      </div>
    </div>
  );
}

function StatusDonut({ byStatus, windowKey }) {
  const rows = REPORT_STATUSES.map((status) => ({ ...status, count: byStatus[status.key] || 0 }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  let angle = 0;
  return (
    <div className="sx-ov-split">
      <svg className="sx-ov-donut" viewBox="-80 -80 160 160" role="img" aria-label={rows.map((row) => row.label + ' ' + row.count).join(', ')}>
        {total ? rows.filter((row) => row.count).map((row) => {
          const a0 = angle;
          angle += (row.count / total) * Math.PI * 2;
          return (
            <path key={row.key} d={arcPath(52, 76, a0 + 0.01, angle - 0.01)} style={{ fill: row.color }}>
              <title>{row.label + ' · ' + fmt(row.count) + ' reports · ' + pct(row.count / total)}</title>
            </path>
          );
        }) : <circle r={64} className="sx-ov-ring" />}
        <text className="sx-ov-donut-value" textAnchor="middle" y={2}>{total ? pct((total - rows[0].count) / total, 0) : '—'}</text>
        <text className="sx-ov-donut-label" textAnchor="middle" y={20}>HANDLED</text>
      </svg>
      <ul className="sx-ov-legend">
        {rows.map((row) => <li key={row.key}><i style={{ background: row.color }} />{row.label}<b>{fmt(row.count)}</b></li>)}
        <li className="sx-ov-note">{fmt(total)} filed in {WINDOWS[windowKey].now}</li>
      </ul>
    </div>
  );
}

export function OverviewPanel({ stats, hourly, ops, windowKey, onOpenTab }) {
  const [metricKey, setMetricKey] = useState('reports');
  const w = stats.windows[windowKey];
  const win = WINDOWS[windowKey];
  const checks = healthChecks(stats, w, ops);
  const metric = METRICS.find((m) => m.key === metricKey);
  const trend = windowBuckets(hourly, windowKey, metricKey);
  const reasons = Object.entries(w.reports.by_reason).map(([reason, value]) => ({ label: label(reason), value })).sort((a, b) => b.value - a.value);
  const senders = w.messages.top_senders.map((row) => ({ label: '@' + row.username, value: row.sent }));
  const select = (check) => {
    if (check.tab) onOpenTab(check.tab);
    else if (check.target) document.getElementById(check.target)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };
  return (
    <div className="sx-ov">
      <Takeaway checks={checks} windowKey={windowKey} />

      <section className="sx-ov-sec">
        <h2>NEEDS ATTENTION</h2>
        <p>Green is fine, amber is worth a look, red is over the server's own alert limit. Click a check to jump to its detail.</p>
        <div className="sx-ov-health">
          {checks.map((check) => <Chip key={check.key} check={check} onSelect={select} />)}
        </div>
      </section>

      <section className="sx-ov-sec" id="sx-ov-community">
        <h2>COMMUNITY ACTIVITY</h2>
        <p>Each card compares {win.now} with {win.before}. A spike is at least {stats.spike_floor} events and 3× the period before.</p>
        <div className="sx-ov-grid">
          {METRICS.map((m) => <KpiCard key={m.key} metric={m} w={w} spark={windowBuckets(hourly, windowKey, m.key)} />)}
        </div>
        <div className="sx-ov-grid-wide sx-ov-more">
          {trend ? (
            <Card wide title="ACTIVITY OVER TIME" note={metric.label.toLowerCase() + (windowKey === '24h' ? ' per hour in ' : ' per day in ') + win.now + '. Dashed line: ' + win.before + '.'}
              head={<Pills options={METRICS.map((m) => ({ value: m.key, label: m.label }))} value={metricKey} onChange={setMetricKey} ariaLabel="Metric" />}>
              <TrendChart series={trend} metric={metric} windowKey={windowKey} />
            </Card>
          ) : null}
          {hourly ? (
            <Card title="WHEN IT HAPPENS" note={metric.label.toLowerCase() + ' by hour of day (UTC) over the last 7 days. Brighter means busier.'}>
              <Heatmap hourly={hourly} metric={metric} />
            </Card>
          ) : null}
          <Card title="SIGN-UP VERIFICATION" note={'Accounts created in ' + win.now + ', and how many have confirmed their email. A low share can mean bots or broken email.'}>
            <Funnel w={w} windowKey={windowKey} />
          </Card>
        </div>
        {hourly ? null : <p className="sx-ov-note">Hourly counts did not load, so the charts over time are hidden.</p>}
      </section>

      <section className="sx-ov-sec">
        <h2>SAFETY QUEUE</h2>
        <p>What people reported, and how much of it staff have handled.</p>
        <div className="sx-ov-grid-wide">
          <Card title="WAITING FOR STAFF" note="Open right now, all time">
            <div className="sx-ov-tiles">
              <button type="button" className="sx-ov-tile sx-ov-tile-accent" onClick={() => onOpenTab('reports')}>
                <span className="sx-ov-tile-label">OPEN REPORTS</span><b className="sx-ov-big">{fmt(stats.open_reports)}</b>
              </button>
              <button type="button" className="sx-ov-tile sx-ov-tile-accent" onClick={() => onOpenTab('support')}>
                <span className="sx-ov-tile-label">OPEN SUPPORT</span><b className="sx-ov-big">{fmt(stats.open_support_requests)}</b>
              </button>
            </div>
          </Card>
          <Card title="REPORTS BY OUTCOME" note={'Filed in ' + win.now}>
            <StatusDonut byStatus={w.reports.by_status || {}} windowKey={windowKey} />
          </Card>
          <Card title="WHY PEOPLE REPORTED" note={'Filed in ' + win.now}>
            <BarList rows={reasons} empty="No reports in this window." />
          </Card>
          <Card title="BUSIEST MESSAGE SENDERS" note={'Top 5 in ' + win.now + '. One account far ahead of the rest can be spam.'}>
            <BarList rows={senders} empty="No messages in this window." />
          </Card>
        </div>
      </section>
    </div>
  );
}

function Gauge({ title, value, capacity, detail }) {
  const share = capacity ? Math.min(1, value / capacity) : 0;
  const tone = share >= 1 ? 'var(--sx-danger)' : share >= 0.8 ? 'var(--sx-warn)' : 'var(--sx-accent)';
  const text = capacity ? fmt(value) + ' / ' + fmt(capacity) : fmt(value);
  return (
    <div className="sx-ov-gauge">
      <svg viewBox="-60 -60 120 66" role="img" aria-label={title + ' ' + text}>
        <path d={arcPath(42, 54, -Math.PI / 2, Math.PI / 2)} className="sx-ov-ring-fill" />
        {share ? <path d={arcPath(42, 54, -Math.PI / 2, -Math.PI / 2 + Math.PI * share)} style={{ fill: tone }} /> : null}
        <text className="sx-ov-gauge-value" textAnchor="middle" y={-6}>{text}</text>
      </svg>
      <b>{title}</b>
      <span className="sx-ov-note">{detail}</span>
    </div>
  );
}

function Outcomes({ status }) {
  const rank = (key) => (OUTCOME_ORDER.indexOf(key) + 1) || 99;
  const rows = Object.entries(status).map(([key, count]) => ({ key, count })).sort((a, b) => rank(a.key) - rank(b.key));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!total) return <p className="sx-ov-note">No requests yet.</p>;
  return (
    <>
      <div className="sx-ov-stack" role="img" aria-label={rows.map((row) => row.key + ' ' + row.count).join(', ')}>
        {rows.map((row) => (
          <span key={row.key} style={{ width: (row.count / total) * 100 + '%', background: (OUTCOMES[row.key] || [])[1] || 'var(--sx-ink-muted)' }}
            title={row.key + ' · ' + fmt(row.count) + ' responses · ' + pct(row.count / total)} />
        ))}
      </div>
      <ul className="sx-ov-legend">
        {rows.map((row) => {
          const [name, color] = OUTCOMES[row.key] || [row.key.toUpperCase(), 'var(--sx-ink-muted)'];
          return <li key={row.key}><i style={{ background: color }} />{row.key + ' ' + name}<b>{fmt(row.count) + ' · ' + pct(row.count / total)}</b></li>;
        })}
      </ul>
    </>
  );
}

// Each route as a dot: calls on a log x axis, slowest-5% time on y, red when it returned 5xx.
function EndpointMap({ routes, limit }) {
  const W = 640, H = 260, bottom = 34, top = 12, right = 14;
  const t = ticks(Math.max(limit, ...routes.map((r) => r.p95_ms || 0)) * 1.1);
  const left = Math.max(...t.list.map((v) => textWidth(fmt(v) + ' ms'))) + 10;
  const lo = Math.max(1, Math.min(...routes.map((r) => r.count)) * 0.7);
  const hi = Math.max(lo * 2, Math.max(...routes.map((r) => r.count)) * 1.4);
  const x = (v) => left + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - right - left);
  const y = (v) => H - bottom - (v / t.top) * (H - bottom - top);
  const xTicks = [1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000].filter((v) => v >= lo && v <= hi);
  const tone = (r) => (r.errors_5xx ? 'var(--sx-danger)' : (r.p95_ms || 0) >= limit / 2 ? 'var(--sx-warn)' : 'var(--sx-ink-2)');
  const placed = [];
  const labels = [...routes].sort((a, b) => (b.p95_ms || 0) - (a.p95_ms || 0)).slice(0, 3).flatMap((r) => {
    const px = x(r.count), py = y(r.p95_ms || 0) - 10;
    if (placed.some(([qx, qy]) => Math.abs(qy - py) < 13 && Math.abs(qx - px) < 140)) return [];
    placed.push([px, py]);
    const name = ((ROUTE_NAMES[r.route] || r.route).split('/').filter(Boolean).slice(-1)[0] || r.route).toUpperCase();
    const width = textWidth(name);
    return [{ key: r.method + r.route, name, px: Math.max(left, Math.min(W - right - width, px - width / 2)), py }];
  });
  return (
    <svg className="sx-ov-chart" viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label="Endpoints by calls and slowest 5% time">
      {t.list.map((v) => (
        <g key={v}>
          <line className="sx-ov-gridline" x1={left} x2={W - right} y1={y(v)} y2={y(v)} />
          <text className="sx-ov-tick" x={left - 8} y={y(v) + 3} textAnchor="end">{fmt(v) + ' ms'}</text>
        </g>
      ))}
      {xTicks.map((v) => <text key={v} className="sx-ov-tick" x={x(v)} y={H - bottom + 14} textAnchor="middle">{fmt(v)}</text>)}
      <text className="sx-ov-tick" x={W - right} y={H - 4} textAnchor="end">CALLS IN 5 MIN →</text>
      <line className="sx-ov-limit-line" x1={left} x2={W - right} y1={y(limit)} y2={y(limit)} />
      <text className="sx-ov-limit-text" x={W - right} y={y(limit) - 5} textAnchor="end">{fmt(limit) + ' MS LIMIT'}</text>
      {[...routes].sort((a, b) => a.errors_5xx - b.errors_5xx).map((r) => (
        <circle key={r.method + r.route} className="sx-ov-dotmark" cx={x(r.count)} cy={y(r.p95_ms || 0)} r={5 + 3 * Math.sqrt(r.errors_5xx)} style={{ fill: tone(r) }}>
          <title>{routeName(r) + ' · ' + fmt(r.count) + ' calls · slowest 5% ' + fmt(r.p95_ms) + ' ms · ' + fmt(r.errors_5xx) + ' errors'}</title>
        </circle>
      ))}
      {labels.map((l) => <text key={l.key} className="sx-ov-map-label" x={l.px} y={l.py}>{l.name}</text>)}
    </svg>
  );
}

// Admin only: live numbers from GET /api/ops/metrics over its rolling window (5 min).
export function OpsPanel({ ops }) {
  const r = ops.requests;
  const L = ops.limits;
  const minutes = Math.round(ops.window_s / 60);
  const ms = (value) => (value === null || value === undefined ? 'N/A' : fmt(value) + ' ms');
  const pool = ops.db_pool;
  const failures = (ops.events.job_failed || 0) + (ops.events.derived_failed || 0);
  const queueFull = (ops.events.queue_full || 0) + (ops.events.queue_full_user || 0);
  const latencyTop = L.p95_ms * 1.5;
  const routeTop = Math.max(L.p95_ms * 1.2, ...r.routes.map((row) => row.p95_ms || 0));
  return (
    <div className="sx-ov">
      <section className="sx-ov-sec" id="sx-ov-requests">
        <h2>SERVER HEALTH · LAST {minutes} MIN</h2>
        <p>Live numbers from the API server. They reset when the server restarts and do not follow the time window above.</p>
        <div className="sx-ov-tiles">
          <div className="sx-ov-tile"><span className="sx-ov-tile-label">REQUESTS</span><b className="sx-ov-big">{fmt(r.count)}</b><span className="sx-ov-note">handled</span></div>
          <div className={'sx-ov-tile' + (r.error_rate >= L.error_rate && r.count >= L.min_requests ? ' sx-ov-tile-bad' : '')}>
            <span className="sx-ov-tile-label">ERROR RATE</span><b className="sx-ov-big">{pct(r.error_rate)}</b>
            <span className="sx-ov-note">{fmt(r.errors_5xx)} server errors · limit {pct(L.error_rate, 0)}</span>
          </div>
          <div className={'sx-ov-tile' + ((r.p95_ms || 0) >= L.p95_ms && r.count >= L.min_requests ? ' sx-ov-tile-bad' : '')}>
            <span className="sx-ov-tile-label">SLOWEST 5% TAKE</span><b className="sx-ov-big">{ms(r.p95_ms)}</b>
            <span className="sx-ov-note">typical {ms(r.p50_ms)}</span>
            <div className="sx-ov-limit">
              <Track value={r.p95_ms || 0} max={latencyTop} tone={(r.p95_ms || 0) >= L.p95_ms ? 'hot' : 'now'} />
              <span className="sx-ov-mark" style={{ left: (L.p95_ms / latencyTop) * 100 + '%' }} />
            </div>
            <span className="sx-ov-note">Line marks the {fmt(L.p95_ms)} ms alert limit</span>
          </div>
          <div className={'sx-ov-tile' + (failures >= L.failures ? ' sx-ov-tile-bad' : '')}>
            <span className="sx-ov-tile-label">FAILED AI JOBS</span><b className="sx-ov-big">{fmt(failures)}</b>
            <span className="sx-ov-note">jobs + encodes · limit {L.failures}</span>
          </div>
          <div className="sx-ov-tile">
            <span className="sx-ov-tile-label">RATE-LIMITED</span><b className="sx-ov-big">{fmt(r.status['429'] || 0)}</b>
            <span className="sx-ov-note">requests turned away · {fmt(queueFull)} on a full queue</span>
          </div>
          <div className="sx-ov-tile"><span className="sx-ov-tile-label">LIVE CONNECTIONS</span><b className="sx-ov-big">{fmt(ops.sse.open_streams)}</b><span className="sx-ov-note">open message streams</span></div>
        </div>
      </section>

      <section className="sx-ov-sec">
        <div className="sx-ov-grid-wide">
          <Card id="sx-ov-capacity" title="CAPACITY IN USE" note="How full the AI job queue and the database connections are. Full means new work waits.">
            <div className="sx-ov-gauges">
              <Gauge title="AI JOB SLOTS" value={ops.jobs.active} capacity={ops.jobs.capacity} detail={fmt(ops.jobs.running) + ' running · ' + fmt(ops.jobs.queued) + ' waiting'} />
              <Gauge title="DATABASE CONNECTIONS" value={pool.checkedout ?? 0} capacity={pool.capacity || 0} detail={pool.class} />
            </div>
          </Card>
          <Card title="REQUEST OUTCOMES" note={'Every response in the last ' + minutes + ' minutes by status class. Rate-limited (429) is its own class, apart from other 4xx.'}>
            <Outcomes status={r.status} />
          </Card>
          <Card id="sx-ov-disk" title="FREE DISK SPACE" note={'Each volume needs at least ' + L.disk_min_free_gb + ' GB free for new renders.'}>
            <div className="sx-ov-tiles">
              {(ops.disk || []).map((volume) => (
                <div key={volume.volume} className={'sx-ov-tile' + (volume.ok ? '' : ' sx-ov-tile-bad')}>
                  <span className="sx-ov-tile-label" data-state={volume.ok ? 'ok' : 'bad'}><i className="sx-ov-dot" />{volume.volume.toUpperCase()} VOLUME</span>
                  <b className="sx-ov-big">{volume.free_gb === null ? 'N/A' : volume.free_gb + ' GB'}</b>
                  <span className="sx-ov-note">{volume.ok ? 'free · fine' : 'free · below ' + L.disk_min_free_gb + ' GB, clean up soon'}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </section>

      <section className="sx-ov-sec" id="sx-ov-routes">
        <h2>SLOWEST ENDPOINTS</h2>
        <p>Endpoints hit in the last {minutes} min, top {r.routes.length || 10} with errors first, then slowest. The bar shows how long the slowest 5% of calls took; the line marks {fmt(L.p95_ms)} ms.</p>
        {r.routes.length ? (
          <div className="sx-ov-stackcol">
            <Card title="ENDPOINT MAP" note="Each dot is an endpoint: further right gets more calls, higher is slower. Red dots returned server errors and grow with the error count.">
              <EndpointMap routes={r.routes} limit={L.p95_ms} />
            </Card>
            <article className="sx-ov-card">
              <div className="sx-ov-table-wrap">
                <table className="sx-ov-table">
                  <thead>
                    <tr><th>ENDPOINT</th><th className="sx-ov-r">CALLS</th><th className="sx-ov-r sx-ov-hide-narrow">TYPICAL</th><th>SLOWEST 5%</th><th className="sx-ov-r">ERRORS</th></tr>
                  </thead>
                  <tbody>
                    {r.routes.map((row) => (
                      <tr key={row.method + ' ' + row.route} title={'Max ' + ms(row.max_ms) + (row.rate_limited ? ' · 429 ' + row.rate_limited : '')}>
                        <td title={row.route}>{routeName(row)}</td>
                        <td className="sx-ov-r">{fmt(row.count)}</td>
                        <td className="sx-ov-r sx-ov-hide-narrow">{ms(row.p50_ms)}</td>
                        <td>
                          <div className="sx-ov-cellbar">
                            <div className="sx-ov-limit">
                              <Track value={row.p95_ms || 0} max={routeTop} tone={(row.p95_ms || 0) >= L.p95_ms ? 'hot' : (row.p95_ms || 0) >= L.p95_ms / 2 ? 'slow' : ''} />
                              <span className="sx-ov-mark" style={{ left: (L.p95_ms / routeTop) * 100 + '%' }} />
                            </div>
                            <span>{ms(row.p95_ms)}</span>
                          </div>
                        </td>
                        <td className={'sx-ov-r' + (row.errors_5xx ? ' sx-ov-err' : '')}>{fmt(row.errors_5xx)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </div>
        ) : <p className="sx-ov-note">No requests yet.</p>}
      </section>
    </div>
  );
}
