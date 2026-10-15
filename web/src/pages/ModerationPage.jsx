import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Button } from '../components/ui/controls.jsx';
import { EmptyState, Hero, Mono, Section } from '../components/ui/primitives.jsx';
import { SectionSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';

export default function ModerationPage() {
  const { user, loading } = useAuth();
  const [reports, setReports] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await api.get('/api/moderation/reports', { status: 'open', limit: 100 });
      setReports(result.reports || []);
    } catch (requestError) {
      setError(requestError.message || 'Could not load reports.');
      setReports([]);
    }
  }, []);

  useEffect(() => {
    if (user?.can_moderate) load();
  }, [user?.can_moderate, load]);

  if (loading) return <SectionSkeleton label="Loading moderation queue" />;
  if (!user) return <Navigate to={'/login?next=' + encodeURIComponent('/moderation')} replace />;
  if (!user.can_moderate) return <EmptyState title="ACCESS DENIED" text="Moderator access is required." />;

  const act = async (report, action) => {
    const resolution = window.prompt('Moderator note', action.replace('_', ' '));
    if (resolution === null) return;
    setBusy(report.id);
    try {
      await api.patch('/api/moderation/reports/' + encodeURIComponent(report.id), { action, resolution });
      setReports((current) => current.filter((item) => item.id !== report.id));
    } catch (requestError) {
      setError(requestError.message || 'Could not update report.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <Hero title="MODERATION" kicker="OPEN USER REPORTS · BETA SAFETY QUEUE" />
      {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
      {reports === null ? <SectionSkeleton label="Loading reports" /> : reports.length ? reports.map((report, index) => (
        <Section key={report.id} num={index + 1} title={report.target_type.toUpperCase() + ' · ' + report.reason.toUpperCase()} active note={report.created_at || ''}>
          <div className="sx-moderation-report">
            <Mono>REPORTER: @{report.reporter || 'deleted'} · TARGET: {report.target_id}</Mono>
            {report.target?.username ? <p>@{report.target.username} · {report.target.display_name}</p> : null}
            {report.target?.title ? <p>{report.target.title}</p> : null}
            {report.target?.text ? <p>{report.target.text}</p> : null}
            {report.details ? <p>{report.details}</p> : null}
            <div className="sx-profile-actions">
              <Button disabled={busy === report.id} onClick={() => act(report, 'dismiss')}>DISMISS</Button>
              <Button disabled={busy === report.id} onClick={() => act(report, 'resolve')}>RESOLVE</Button>
              {report.target_type !== 'user' ? <Button disabled={busy === report.id} onClick={() => act(report, 'remove_content')}>REMOVE CONTENT</Button> : null}
              <Button disabled={busy === report.id} onClick={() => act(report, 'suspend_user')}>SUSPEND USER</Button>
            </div>
          </div>
        </Section>
      )) : <EmptyState title="QUEUE CLEAR" text="There are no open reports." />}
    </div>
  );
}
