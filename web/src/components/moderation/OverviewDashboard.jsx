// Moderation overview as charts: plain CSS bars, no chart library.

const REPORT_STATUSES = [
  { key: 'open', label: 'OPEN', tone: 'accent' },
  { key: 'resolved', label: 'RESOLVED', tone: 'success' },
  { key: 'dismissed', label: 'DISMISSED', tone: 'muted' },
];

const percent = (value, max) => (max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0);

function Card({ title, sub, children, wide = false }) {
  return (
    <section className={'sx-dash-card' + (wide ? ' sx-dash-wide' : '')}>
      <header className="sx-dash-card-head">
        <h3>{title}</h3>
        {sub ? <span>{sub}</span> : null}
      </header>
      {children}
    </section>
  );
}

function Tile({ label, value, sub, tone = '', onClick }) {
  const body = (
    <>
      <span className="sx-dash-tile-label">{label}</span>
      <strong className="sx-dash-tile-value">{value}</strong>
      {sub ? <span className="sx-dash-tile-sub">{sub}</span> : null}
    </>
  );
  const className = 'sx-dash-tile' + (tone ? ' sx-tone-' + tone : '');
  return onClick
    ? <button type="button" className={className} onClick={onClick}>{body}</button>
    : <div className={className}>{body}</div>;
}

// A filled meter; `max` 0 shows an empty track.
function Meter({ value, max, tone = 'accent', label }) {
  return (
    <div className="sx-dash-meter" role="img" aria-label={label}>
      <span className={'sx-tone-' + tone} style={{ width: percent(value, max) + '%' }} />
    </div>
  );
}

// Horizontal bars, longest first.
function BarList({ rows, empty, tone = 'accent' }) {
  if (!rows.length) return <p className="sx-dash-empty">{empty}</p>;
  const max = Math.max(...rows.map((row) => row.value));
  return (
    <ul className="sx-dash-bars">
      {rows.map((row) => (
        <li key={row.label}>
          <span className="sx-dash-bar-label">{row.label}</span>
          <Meter value={row.value} max={max} tone={tone} label={row.label + ' ' + row.value} />
          <span className="sx-dash-bar-value">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Trend({ label, metric }) {
  const max = Math.max(metric.current, metric.previous);
  const delta = metric.previous ? Math.round(((metric.current - metric.previous) / metric.previous) * 100) : null;
  const direction = metric.current > metric.previous ? 'up' : metric.current < metric.previous ? 'down' : 'flat';
  return (
    <li className={'sx-dash-trend' + (metric.spike ? ' sx-dash-spike' : '')}>
      <div className="sx-dash-trend-head">
        <span>{label}</span>
        {metric.spike ? <span className="sx-dash-badge">SPIKE</span> : null}
        <strong>{metric.current}</strong>
        <span className={'sx-dash-delta sx-dash-' + direction}>
          {delta === null ? (metric.current ? 'NEW' : '—') : (delta > 0 ? '+' : '') + delta + '%'}
        </span>
      </div>
      <Meter value={metric.current} max={max} tone={metric.spike ? 'danger' : 'accent'} label={label + ' now ' + metric.current} />
      <Meter value={metric.previous} max={max} tone="muted" label={label + ' before ' + metric.previous} />
      <span className="sx-dash-trend-prev">PREVIOUS {metric.previous}</span>
    </li>
  );
}

function StatusBreakdown({ byStatus }) {
  const total = REPORT_STATUSES.reduce((sum, status) => sum + (byStatus[status.key] || 0), 0);
  if (!total) return <p className="sx-dash-empty">No reports in this window.</p>;
  return (
    <>
      <div className="sx-dash-stack" role="img" aria-label={REPORT_STATUSES.map((status) => status.label + ' ' + (byStatus[status.key] || 0)).join(', ')}>
        {REPORT_STATUSES.map((status) => (byStatus[status.key]
          ? <span key={status.key} className={'sx-tone-' + status.tone} style={{ width: percent(byStatus[status.key], total) + '%' }} />
          : null))}
      </div>
      <ul className="sx-dash-legend">
        {REPORT_STATUSES.map((status) => (
          <li key={status.key}><i className={'sx-tone-' + status.tone} />{status.label} <strong>{byStatus[status.key] || 0}</strong></li>
        ))}
      </ul>
    </>
  );
}

const label = (value) => value.replace(/_/g, ' ').toUpperCase();

export function OverviewPanel({ stats, windowKey, onOpenTab }) {
  const w = stats.windows[windowKey];
  const spikes = [
    w.reports.spike && 'REPORTS', w.registrations.active.spike && 'SIGN-UPS', w.registrations.pending.spike && 'UNVERIFIED SIGN-UPS',
    w.messages.spike && 'MESSAGES', w.posts.spike && 'POSTS', w.credits_captured.spike && 'CREDITS', w.support_requests.spike && 'SUPPORT',
  ].filter(Boolean);
  const lowDisk = (stats.disk || []).filter((volume) => !volume.ok);
  const reasons = Object.entries(w.reports.by_reason).map(([reason, value]) => ({ label: label(reason), value })).sort((a, b) => b.value - a.value);
  const senders = w.messages.top_senders.map((row) => ({ label: '@' + row.username, value: row.sent }));
  return (
    <div className="sx-dash">
      {spikes.length ? <div className="sx-error-box" role="alert">SPIKE: {spikes.join(' · ')}. At least {stats.spike_floor} and 3x the period before.</div> : null}
      {lowDisk.length ? <div className="sx-error-box" role="alert">LOW DISK: {lowDisk.map((volume) => volume.volume).join(', ')}</div> : null}
      <div className="sx-dash-tiles">
        <Tile label="OPEN REPORTS" value={stats.open_reports} sub="ALL TIME · OPEN QUEUE" tone={stats.open_reports ? 'accent' : 'success'} onClick={() => onOpenTab('reports')} />
        <Tile label="OPEN SUPPORT" value={stats.open_support_requests} sub="ALL TIME · OPEN INBOX" tone={stats.open_support_requests ? 'warn' : 'success'} onClick={() => onOpenTab('support')} />
        {(stats.disk || []).map((volume) => (
          <Tile key={volume.volume} label={'DISK ' + volume.volume.toUpperCase()} value={volume.free_gb === null ? 'N/A' : volume.free_gb + ' GB'} sub={volume.ok ? 'FREE · OK' : 'FREE · LOW'} tone={volume.ok ? '' : 'danger'} />
        ))}
      </div>
      <div className="sx-dash-grid">
        <Card title="REPORTS BY STATUS" sub={w.reports.current + ' FILED IN WINDOW'}>
          <StatusBreakdown byStatus={w.reports.by_status || {}} />
        </Card>
        <Card title="REPORTS BY REASON">
          <BarList rows={reasons} empty="No reports in this window." />
        </Card>
        <Card title="ACTIVITY VS PREVIOUS PERIOD" sub="BRIGHT BAR NOW · GREY BAR BEFORE" wide>
          <ul className="sx-dash-trends">
            <Trend label="REPORTS" metric={w.reports} />
            <Trend label="SUPPORT REQUESTS" metric={w.support_requests} />
            <Trend label="NEW POSTS" metric={w.posts} />
            <Trend label="SIGN-UPS" metric={w.registrations.active} />
            <Trend label="UNVERIFIED" metric={w.registrations.pending} />
            <Trend label="MESSAGES" metric={w.messages} />
            <Trend label="CREDITS CAPTURED" metric={w.credits_captured} />
          </ul>
        </Card>
        <Card title="TOP MESSAGE SENDERS">
          <BarList rows={senders} empty="No messages in this window." tone="info" />
        </Card>
      </div>
    </div>
  );
}

// Admin only: live numbers from GET /api/ops/metrics over its rolling window (5 min).
export function OpsPanel({ ops }) {
  const r = ops.requests;
  const ms = (value) => (value === null || value === undefined ? 'N/A' : value + ' ms');
  const pool = ops.db_pool;
  const failures = (ops.events.job_failed || 0) + (ops.events.derived_failed || 0);
  const slowest = r.routes.slice(0, 5);
  const slowMax = Math.max(0, ...slowest.map((row) => row.p95_ms || 0));
  return (
    <div className="sx-dash">
      <h3 className="sx-dash-section">OPERATIONS · LAST {Math.round(ops.window_s / 60)} MIN</h3>
      <div className="sx-dash-tiles">
        <Tile label="REQUESTS" value={r.count} sub={'5XX ' + r.errors_5xx + ' (' + (r.error_rate * 100).toFixed(1) + '%)'} tone={r.errors_5xx ? 'danger' : ''} />
        <Tile label="P95 LATENCY" value={ms(r.p95_ms)} sub={'P50 ' + ms(r.p50_ms)} />
        <Tile label="RATE LIMITED" value={r.status['429'] || 0} sub={'QUEUE FULL ' + ((ops.events.queue_full || 0) + (ops.events.queue_full_user || 0))} />
        <Tile label="FAILURES" value={failures} sub="JOBS + DERIVED ENCODES" tone={failures ? 'danger' : ''} />
        <Tile label="SSE STREAMS" value={ops.sse.open_streams} sub="OPEN NOW" />
      </div>
      <div className="sx-dash-grid">
        <Card title="CAPACITY">
          <ul className="sx-dash-bars">
            <li>
              <span className="sx-dash-bar-label">JOB QUEUE</span>
              <Meter value={ops.jobs.active} max={ops.jobs.capacity} label={'Job queue ' + ops.jobs.active + ' of ' + ops.jobs.capacity} />
              <span className="sx-dash-bar-value">{ops.jobs.active + ' / ' + ops.jobs.capacity}</span>
            </li>
            <li>
              <span className="sx-dash-bar-label">DB POOL</span>
              <Meter value={pool.checkedout || 0} max={pool.capacity || 0} tone="info" label={'DB pool ' + (pool.checkedout ?? 'N/A')} />
              <span className="sx-dash-bar-value">{(pool.checkedout ?? 'N/A') + (pool.capacity ? ' / ' + pool.capacity : '')}</span>
            </li>
          </ul>
          <p className="sx-dash-empty">QUEUED {ops.jobs.queued} · RUNNING {ops.jobs.running} · {pool.class}</p>
        </Card>
        <Card title="SLOWEST ROUTES" sub="P95">
          {slowest.length ? (
            <ul className="sx-dash-bars">
              {slowest.map((row) => (
                <li key={row.route}>
                  <span className="sx-dash-bar-label" title={row.route}>{row.route}</span>
                  <Meter value={row.p95_ms || 0} max={slowMax} tone={row.errors_5xx ? 'danger' : 'warn'} label={row.route + ' ' + ms(row.p95_ms)} />
                  <span className="sx-dash-bar-value">{ms(row.p95_ms) + (row.errors_5xx ? ' · 5XX ' + row.errors_5xx : '')}</span>
                </li>
              ))}
            </ul>
          ) : <p className="sx-dash-empty">No requests yet.</p>}
        </Card>
      </div>
    </div>
  );
}
