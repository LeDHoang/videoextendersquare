import { useCallback, useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Button, Pills } from '../components/ui/controls.jsx';
import { EmptyState, Hero, Mono, Section } from '../components/ui/primitives.jsx';
import { SectionSkeleton } from '../components/ui/Skeleton.jsx';
import AuditPanel from '../components/moderation/AuditPanel.jsx';
import ContentPanel from '../components/moderation/ContentPanel.jsx';
import { OpsPanel, OverviewPanel } from '../components/moderation/OverviewDashboard.jsx';
import ReportTarget from '../components/moderation/ReportTarget.jsx';
import StaffActionDialog from '../components/moderation/StaffActionDialog.jsx';
import UserDetail from '../components/moderation/UserDetail.jsx';
import UsersPanel from '../components/moderation/UsersPanel.jsx';
import { when } from '../components/moderation/usePagedList.js';
import { useAuth } from '../hooks/AuthContext.jsx';

const TABS = [
  { value: 'overview', label: 'OVERVIEW' },
  { value: 'reports', label: 'REPORTS' },
  { value: 'support', label: 'SUPPORT' },
  { value: 'users', label: 'USERS' },
  { value: 'content', label: 'CONTENT' },
];
const ADMIN_TABS = [...TABS, { value: 'audit', label: 'AUDIT' }];
// Tabs backed by the report / support queue loader; the others load their own data.
const QUEUE_TABS = ['overview', 'reports', 'support'];
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

export default function ModerationPage() {
  const { user, loading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = user?.role === 'admin';
  const tabs = isAdmin ? ADMIN_TABS : TABS;
  const tabParam = searchParams.get('tab');
  const tab = tabs.some((option) => option.value === tabParam) ? tabParam : 'reports';
  const openUserId = tab === 'users' ? searchParams.get('user') : null;
  const [status, setStatus] = useState('open');
  const [statsWindow, setStatsWindow] = useState('24h');
  const [stats, setStats] = useState(null);
  const [ops, setOps] = useState(null);
  const loadOps = user?.role === 'admin';
  // Rows carry the tab and filter they were loaded for, so a tab switch never renders
  // report rows with the support renderer (or the reverse) before the reload lands.
  const [loaded, setLoaded] = useState({ key: '', rows: null });
  const queueKey = tab + ':' + status;
  const items = loaded.key === queueKey ? loaded.rows : null;
  const setItems = (update) => setLoaded((current) => ({ ...current, rows: update(current.rows) }));
  const [notes, setNotes] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [dialog, setDialog] = useState(null);

  const load = useCallback(async () => {
    setError('');
    if (!QUEUE_TABS.includes(tab)) return;
    if (tab === 'overview') {
      try {
        // Operations numbers are extra: a failure there never hides the moderation overview.
        const [nextStats, nextOps] = await Promise.all([
          api.get('/api/moderation/stats'),
          loadOps ? api.get('/api/ops/metrics').catch(() => null) : null,
        ]);
        setStats(nextStats);
        setOps(nextOps);
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
  }, [tab, status, loadOps]);

  useEffect(() => {
    if (user?.can_moderate) load();
  }, [user?.can_moderate, load]);

  if (loading) return <SectionSkeleton label="Loading moderation queue" />;
  if (!user) return <Navigate to={'/login?next=' + encodeURIComponent('/moderation')} replace />;
  if (!user.can_moderate) return <EmptyState title="ACCESS DENIED" text="Moderator access is required." />;

  const setNote = (id) => (value) => setNotes((current) => ({ ...current, [id]: value }));
  const switchTab = (value) => {
    setStatus('open');
    setNotes({});
    setSearchParams(value === 'reports' ? {} : { tab: value }, { replace: true });
  };
  const openUser = (id) => setSearchParams({ tab: 'users', user: id });
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

  const claimedByOther = (report) => Boolean(report.claimed_by) && report.claimed_by !== user.username;

  const actOnReport = (report, action) => run(report.id, async () => {
    const resolution = (notes[report.id] || '').trim() || action.replace('_', ' ');
    const body = { action, resolution };
    // Only an admin may act over another moderator's live claim; the server audits the override.
    if (isAdmin && claimedByOther(report)) body.force = true;
    const result = await api.patch('/api/moderation/reports/' + encodeURIComponent(report.id), body);
    replaceOrDrop(result.report);
    setNote(report.id)('');
  });

  const claimReport = (report, release) => run(report.id, async () => {
    const path = '/api/moderation/reports/' + encodeURIComponent(report.id) + '/claim';
    replaceOrDrop((await (release ? api.delete(path) : api.post(path, {}))).report);
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

  const restoreTarget = (report) => setDialog({
    title: 'RESTORE ' + report.target_type.toUpperCase(),
    text: report.target_type === 'post'
      ? 'The post is published again with its original media.'
      : report.target_type === 'pack' ? 'The pack comes back as a draft; its owner republishes it.' : '',
    confirmLabel: 'RESTORE',
    onSubmit: async (values) => {
      await api.post('/api/admin/content/' + report.target_type + '/' + encodeURIComponent(report.target_id) + '/restore', values);
      await load();
    },
  });

  const reportUserId = (report) => (report.target_type === 'user'
    ? report.target_id
    : report.target?.owner_id || report.target?.author_id || report.target?.sender_id || null);

  const renderReport = (report, index) => (
    <Section key={report.id} num={index + 1} title={report.target_type.toUpperCase() + ' · ' + report.reason.replace(/_/g, ' ').toUpperCase()} active note={when(report.created_at)}>
      <div className="sx-moderation-report">
        <div className="sx-report-chips">
          <span className={'sx-report-chip sx-report-' + report.status}>{report.status.toUpperCase()}</span>
          <span className="sx-report-chip">REPORTED BY @{report.reporter || 'deleted'}</span>
          {report.claimed_by ? <span className="sx-report-chip sx-report-claimed">CLAIMED BY: @{report.claimed_by} · {when(report.claimed_at)}</span> : null}
        </div>
        <div className="sx-report-layout">
          <ReportTarget report={report} />
          <div className="sx-report-side">
            <blockquote className="sx-report-note">
              <span>REPORTER NOTE</span>
              <p>{report.details || 'No note left.'}</p>
            </blockquote>
            {report.resolution ? <Mono>RESOLUTION: {report.resolution}</Mono> : null}
            {report.handled_by ? <Mono>HANDLED BY: @{report.handled_by}</Mono> : null}
            {isAdmin && claimedByOther(report) ? <Mono>YOUR ACTION OVERRIDES THIS CLAIM AND IS LOGGED</Mono> : null}
            {report.history?.length ? (
              <ul className="sx-report-history" aria-label="Report history">
                {report.history.map((row, rowIndex) => (
                  <li key={rowIndex}><Mono>{when(row.created_at)} · @{row.actor || 'deleted'} · {row.action.toUpperCase()}{row.reason ? ' · ' + row.reason : ''}</Mono></li>
                ))}
              </ul>
            ) : null}
            <Mono>REPORT {report.id} · TARGET {report.target_id}</Mono>
          </div>
        </div>
        {report.status === 'open' || isAdmin ? (
          <NoteField id={'note-' + report.id} value={notes[report.id] || ''} onChange={setNote(report.id)} placeholder="Optional · defaults to the action name" />
        ) : null}
        <div className="sx-profile-actions">
          {report.status === 'open' && !report.claimed_by ? <Button disabled={busy === report.id} onClick={() => claimReport(report, false)}>CLAIM</Button> : null}
          {report.status === 'open' && report.claimed_by && (!claimedByOther(report) || isAdmin)
            ? <Button disabled={busy === report.id} onClick={() => claimReport(report, true)}>RELEASE</Button>
            : null}
          {reportUserId(report) ? <Button onClick={() => openUser(reportUserId(report))}>OPEN USER</Button> : null}
          {report.status === 'open' ? (
            <>
              <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'dismiss')}>DISMISS</Button>
              <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'resolve')}>RESOLVE</Button>
              {report.target_type !== 'user' && !report.target?.removed ? <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'remove_content')}>REMOVE CONTENT</Button> : null}
              <Button disabled={busy === report.id} onClick={() => actOnReport(report, 'suspend_user')}>SUSPEND USER</Button>
            </>
          ) : null}
          {isAdmin && report.target?.removed ? <Button disabled={busy === report.id} onClick={() => restoreTarget(report)}>RESTORE CONTENT</Button> : null}
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

  const kickers = {
    support: 'SUPPORT INBOX · APPEALS AND REQUESTS',
    overview: 'OPERATIONS · TRENDS AND SPIKES',
    reports: 'USER REPORTS · BETA SAFETY QUEUE',
    users: 'ACCOUNTS · SEARCH AND ACT',
    content: 'POSTS, REEL PACKS AND COMMENTS',
    audit: 'STAFF ACTIONS · ADMIN ONLY',
  };
  const emptyText = tab === 'support' ? 'There are no support requests here.' : 'There are no reports here.';
  return (
    <div>
      <Hero title="MODERATION" kicker={kickers[tab]} />
      <div className="sx-moderation-tabs">
        <Pills options={tabs} value={tab} onChange={switchTab} ariaLabel="Moderation queue" />
        {tab === 'overview' ? <Pills options={WINDOW_OPTIONS} value={statsWindow} onChange={setStatsWindow} ariaLabel="Time window" /> : null}
        {STATUS_FILTERS[tab] ? <Pills options={STATUS_FILTERS[tab]} value={status} onChange={setStatus} ariaLabel="Status filter" /> : null}
      </div>
      {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
      {tab === 'users' ? (
        openUserId
          ? <UserDetail userId={openUserId} viewer={user} onBack={() => setSearchParams({ tab: 'users' })} />
          : <UsersPanel onOpen={openUser} />
      ) : tab === 'content' ? <ContentPanel viewer={user} onOpenUser={openUser} />
        : tab === 'audit' ? <AuditPanel onOpenUser={openUser} />
        : tab === 'overview' ? (
        stats ? (
          <>
            <OverviewPanel stats={stats} windowKey={statsWindow} onOpenTab={switchTab} />
            {ops ? <OpsPanel ops={ops} /> : null}
          </>
        ) : error ? null : <SectionSkeleton label="Loading overview" />
      ) : items === null ? <SectionSkeleton label="Loading queue" /> : items.length
        ? items.map(tab === 'support' ? renderRequest : renderReport)
        : <EmptyState title="QUEUE CLEAR" text={emptyText} />}
      {dialog ? <StaffActionDialog {...dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
