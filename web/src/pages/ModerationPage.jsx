import { useCallback, useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Button, Pills } from '../components/ui/controls.jsx';
import { EmptyState, Hero, Mono, Section, SpecRow } from '../components/ui/primitives.jsx';
import { SectionSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';

const TABS = [
  { value: 'overview', label: 'OVERVIEW' },
  { value: 'reports', label: 'REPORTS' },
  { value: 'support', label: 'SUPPORT' },
];
const WINDOW_OPTIONS = [
  { value: '24h', label: 'LAST 24 H' },
  { value: '7d', label: 'LAST 7 D' },
];
const STATUS_FILTERS = {
  reports: [
    { value: 'open', label: 'OPEN' },
    { value: 'resolved', label: 'RESOLVED' },
    { value: 'dismissed', label: 'DISMISSED' },
    { value: 'all', label: 'ALL' },
  ],
  support: [
    { value: 'open', label: 'OPEN' },
    { value: 'in_progress', label: 'IN PROGRESS' },
    { value: 'closed', label: 'CLOSED' },
    { value: 'all', label: 'ALL' },
  ],
};

// Inline moderator note (replaces the old window.prompt); one per queue item.
function NoteField({ id, value, onChange, placeholder }) {
  return (
    <label className="sx-ps-field" htmlFor={id}>
      <span className="sx-ps-label">MODERATOR NOTE</span>
      <textarea
        id={id}
        className="sx-ps-input sx-ps-textarea sx-moderation-note"
        rows={2}
        maxLength={500}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

// One cell per metric: current window, the window before it, and a loud flag on a spike.
function statCell(label, metric, sub) {
  const detail = 'PREVIOUS ' + metric.previous + (sub ? ' · ' + sub : '');
  return [label + (metric.spike ? ' · SPIKE' : ''), metric.current, detail];
}

function OverviewPanel({ stats, windowKey }) {
  const w = stats.windows[windowKey];
  const topSenders = w.messages.top_senders.map((row) => '@' + row.username + ' ' + row.sent).join(', ') || 'none';
  const reasons = Object.entries(w.reports.by_reason).map(([reason, count]) => reason + ' ' + count).join(', ') || 'none';
  const spikes = [
    w.reports.spike && 'REPORTS', w.registrations.active.spike && 'SIGN-UPS', w.registrations.pending.spike && 'UNVERIFIED SIGN-UPS',
    w.messages.spike && 'MESSAGES', w.posts.spike && 'POSTS', w.credits_captured.spike && 'CREDITS', w.support_requests.spike && 'SUPPORT',
  ].filter(Boolean);
  const lowDisk = (stats.disk || []).filter((volume) => !volume.ok);
  return (
    <div>
      {spikes.length ? <div className="sx-error-box" role="alert">SPIKE: {spikes.join(' · ')}. At least {stats.spike_floor} and 3x the period before.</div> : null}
      {lowDisk.length ? <div className="sx-error-box" role="alert">LOW DISK: {lowDisk.map((volume) => volume.volume).join(', ')}</div> : null}
      <SpecRow cells={[
        ['OPEN REPORTS', stats.open_reports, 'ALL TIME'],
        ['OPEN SUPPORT', stats.open_support_requests, 'ALL TIME'],
        ...(stats.disk || []).map((volume) => ['DISK ' + volume.volume.toUpperCase(), volume.free_gb === null ? 'N/A' : volume.free_gb + ' GB', volume.ok ? 'OK' : 'LOW']),
      ]} />
      <SpecRow cells={[
        statCell('REPORTS', w.reports, reasons),
        statCell('SUPPORT REQUESTS', w.support_requests),
        statCell('NEW POSTS', w.posts),
        statCell('CREDITS CAPTURED', w.credits_captured),
      ]} />
      <SpecRow cells={[
        statCell('SIGN-UPS', w.registrations.active),
        statCell('UNVERIFIED', w.registrations.pending),
        statCell('MESSAGES', w.messages, 'top: ' + topSenders),
      ]} />
    </div>
  );
}

export default function ModerationPage() {
  const { user, loading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab = tabParam === 'support' || tabParam === 'overview' ? tabParam : 'reports';
  const [status, setStatus] = useState('open');
  const [statsWindow, setStatsWindow] = useState('24h');
  const [stats, setStats] = useState(null);
  // Rows carry the tab and filter they were loaded for, so a tab switch never renders
  // report rows with the support renderer (or the reverse) before the reload lands.
  const [loaded, setLoaded] = useState({ key: '', rows: null });
  const queueKey = tab + ':' + status;
  const items = loaded.key === queueKey ? loaded.rows : null;
  const setItems = (update) => setLoaded((current) => ({ ...current, rows: update(current.rows) }));
  const [notes, setNotes] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setError('');
    if (tab === 'overview') {
      try {
        setStats(await api.get('/api/moderation/stats'));
      } catch (requestError) {
        setError(requestError.message || 'Could not load the overview.');
      }
      return;
    }
    const key = tab + ':' + status;
    try {
      const rows = tab === 'support'
        ? (await api.get('/api/moderation/support', { status, limit: 100 })).requests
        : (await api.get('/api/moderation/reports', { status, limit: 100 })).reports;
      setLoaded({ key, rows: rows || [] });
    } catch (requestError) {
      setError(requestError.message || 'Could not load the queue.');
      setLoaded({ key, rows: [] });
    }
  }, [tab, status]);

  useEffect(() => {
    if (user?.can_moderate) load();
  }, [user?.can_moderate, load]);

  if (loading) return <SectionSkeleton label="Loading moderation queue" />;
  if (!user) return <Navigate to={'/login?next=' + encodeURIComponent('/moderation')} replace />;
  if (!user.can_moderate) return <EmptyState title="ACCESS DENIED" text="Moderator access is required." />;

  const isAdmin = user.role === 'admin';
  const setNote = (id) => (value) => setNotes((current) => ({ ...current, [id]: value }));
  const switchTab = (value) => {
    setStatus('open');
    setNotes({});
    setSearchParams(value === 'reports' ? {} : { tab: value }, { replace: true });
  };
  const replaceOrDrop = (updated) => {
    setItems((current) => (status === 'all' || updated.status === status
      ? current.map((item) => (item.id === updated.id ? updated : item))
      : current.filter((item) => item.id !== updated.id)));
  };

  const run = async (id, task) => {
    setBusy(id);
    setError('');
    try {
      await task();
    } catch (requestError) {
      setError(requestError.message || 'Could not update the queue.');
    } finally {
      setBusy('');
    }
  };

  const actOnReport = (report, action) => run(report.id, async () => {
    const resolution = (notes[report.id] || '').trim() || action.replace('_', ' ');
    const result = await api.patch('/api/moderation/reports/' + encodeURIComponent(report.id), { action, resolution });
    replaceOrDrop(result.report);
    setNote(report.id)('');
  });

  const updateRequest = (request, nextStatus) => run(request.id, async () => {
    const body = { note: notes[request.id] ?? request.moderator_note ?? '' };
    if (nextStatus) body.status = nextStatus;
    const result = await api.patch('/api/moderation/support/' + encodeURIComponent(request.id), body);
    replaceOrDrop(result.request);
  });

  const fileReport = (request) => run(request.id, async () => {
    const result = await api.post('/api/moderation/support/' + encodeURIComponent(request.id) + '/file-report', {});
    replaceOrDrop(result.request);
  });

  const renderReport = (report, index) => (
    <Section key={report.id} num={index + 1} title={report.target_type.toUpperCase() + ' · ' + report.reason.toUpperCase()} active note={report.created_at || ''}>
      <div className="sx-moderation-report">
        <Mono>REPORTER: @{report.reporter || 'deleted'} · TARGET: {report.target_id} · {report.status.toUpperCase()}</Mono>
        {report.target?.username ? <p>@{report.target.username} · {report.target.display_name}{report.target.status && report.target.status !== 'active' ? ' · ' + report.target.status.toUpperCase() : ''}</p> : null}
        {report.target?.title ? <p>{report.target.title}</p> : null}
        {report.target?.text ? <p>{report.target.text}</p> : null}
        {report.details ? <p>{report.details}</p> : null}
        {report.resolution ? <Mono>RESOLUTION: {report.resolution}</Mono> : null}
        {report.status === 'open' || isAdmin ? (
          <NoteField id={'note-' + report.id} value={notes[report.id] || ''} onChange={setNote(report.id)} placeholder="Optional · defaults to the action name" />
        ) : null}
        <div className="sx-profile-actions">
          {report.status === 'open' ? (
            <>
              <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'dismiss')}>DISMISS</Button>
              <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'resolve')}>RESOLVE</Button>
              {report.target_type !== 'user' ? <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'remove_content')}>REMOVE CONTENT</Button> : null}
              <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'suspend_user')}>SUSPEND USER</Button>
            </>
          ) : null}
          {isAdmin ? <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'reinstate_user')}>REINSTATE USER</Button> : null}
        </div>
      </div>
    </Section>
  );

  const renderRequest = (request, index) => (
    <Section key={request.id} num={index + 1} title={request.category.replace('_', ' ').toUpperCase() + ' · ' + request.status.replace('_', ' ').toUpperCase()} active note={request.created_at || ''}>
      <div className="sx-moderation-report">
        <Mono>
          ID: {request.id} · FROM: {request.username ? '@' + request.username : 'SIGNED OUT'}{request.email ? ' · ' + request.email : ''}
        </Mono>
        {request.subject ? <p><strong>{request.subject}</strong></p> : null}
        {request.body ? <p style={{ whiteSpace: 'pre-wrap' }}>{request.body}</p> : null}
        {request.link ? <Mono>LINK: {request.link}</Mono> : null}
        {request.report_id ? <Mono>REPORT: {request.report_id} · {(request.report_status || '').toUpperCase()}</Mono> : null}
        {request.handled_by ? <Mono>HANDLED BY: @{request.handled_by}</Mono> : null}
        <NoteField id={'note-' + request.id} value={notes[request.id] ?? request.moderator_note ?? ''} onChange={setNote(request.id)} placeholder="Internal note" />
        <div className="sx-profile-actions">
          <Button disabled={busy === request.id} onClick={() => updateRequest(request, null)}>SAVE NOTE</Button>
          {request.status !== 'in_progress' ? <Button disabled={busy === request.id} onClick={() => updateRequest(request, 'in_progress')}>MARK IN PROGRESS</Button> : null}
          {request.status !== 'closed' ? <Button disabled={busy === request.id} onClick={() => updateRequest(request, 'closed')}>CLOSE</Button> : null}
          {request.status === 'closed' ? <Button disabled={busy === request.id} onClick={() => updateRequest(request, 'open')}>REOPEN</Button> : null}
          {request.can_file_report ? <Button disabled={busy === request.id} onClick={() => fileReport(request)}>FILE REPORT</Button> : null}
        </div>
      </div>
    </Section>
  );

  const kickers = { support: 'SUPPORT INBOX · APPEALS AND REQUESTS', overview: 'OPERATIONS · TRENDS AND SPIKES', reports: 'USER REPORTS · BETA SAFETY QUEUE' };
  const emptyText = tab === 'support' ? 'There are no support requests here.' : 'There are no reports here.';
  return (
    <div>
      <Hero title="MODERATION" kicker={kickers[tab]} />
      <div className="sx-moderation-tabs">
        <Pills options={TABS} value={tab} onChange={switchTab} ariaLabel="Moderation queue" />
        {tab === 'overview'
          ? <Pills options={WINDOW_OPTIONS} value={statsWindow} onChange={setStatsWindow} ariaLabel="Time window" />
          : <Pills options={STATUS_FILTERS[tab]} value={status} onChange={setStatus} ariaLabel="Status filter" />}
      </div>
      {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
      {tab === 'overview' ? (
        stats ? <OverviewPanel stats={stats} windowKey={statsWindow} /> : error ? null : <SectionSkeleton label="Loading overview" />
      ) : items === null ? <SectionSkeleton label="Loading queue" /> : items.length
        ? items.map(tab === 'support' ? renderRequest : renderReport)
        : <EmptyState title="QUEUE CLEAR" text={emptyText} />}
    </div>
  );
}
