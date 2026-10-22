import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { Button } from '../ui/controls.jsx';
import { Mono, Section, SpecRow } from '../ui/primitives.jsx';
import { SectionSkeleton } from '../ui/Skeleton.jsx';
import StaffActionDialog from './StaffActionDialog.jsx';
import { when } from './usePagedList.js';

function Rows({ items, empty, render }) {
  if (!items?.length) return <Mono>{empty}</Mono>;
  return <ul className="sx-staff-list">{items.map((item) => <li key={item.id}>{render(item)}</li>)}</ul>;
}

function money(cents, currency) {
  return ((cents || 0) / 100).toFixed(2) + ' ' + (currency || '').toUpperCase();
}

/** One account: status, reports, posts, support, staff history; admins also see credits. */
export default function UserDetail({ userId, viewer, onBack }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null);
  const isAdmin = viewer.role === 'admin';

  const load = useCallback(async () => {
    setError('');
    try {
      setDetail(await api.get('/api/admin/users/' + encodeURIComponent(userId)));
    } catch (requestError) {
      setError(requestError.message || 'Could not load this user.');
    }
  }, [userId]);

  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

  if (!detail) {
    return (
      <div>
        <Button onClick={onBack}>← ALL USERS</Button>
        {error ? <div className="sx-error-box" role="alert">{error}</div> : <SectionSkeleton label="Loading user" />}
      </div>
    );
  }

  const { user } = detail;
  const path = '/api/admin/users/' + encodeURIComponent(user.id);
  const isSelf = user.id === viewer.id;
  const isStaff = user.role !== 'user';
  const act = (config, request) => setDialog({
    ...config,
    onSubmit: async (values) => {
      await request(values);
      await load();
    },
  });

  const actions = [];
  if (!isSelf && user.status === 'active' && user.role !== 'admin' && (isAdmin || !isStaff)) {
    actions.push(['SUSPEND', () => act(
      { title: 'SUSPEND @' + user.username, text: 'Signs them out everywhere and hides their profile and content until reinstated.', confirmLabel: 'SUSPEND' },
      (values) => api.post(path + '/suspend', values),
    )]);
  }
  if (!isSelf && (isAdmin || !isStaff)) {
    actions.push(['SIGN OUT EVERYWHERE', () => act(
      { title: 'SIGN OUT @' + user.username, text: 'Ends every session. The account stays active.', confirmLabel: 'SIGN OUT' },
      (values) => api.post(path + '/sign-out', values),
    )]);
  }
  if (isAdmin && user.status === 'suspended') {
    actions.push(['REINSTATE', () => act(
      { title: 'REINSTATE @' + user.username, confirmLabel: 'REINSTATE' },
      (values) => api.post(path + '/reinstate', values),
    )]);
  }
  if (isAdmin && !isSelf && user.status !== 'deleted') {
    actions.push(['CHANGE ROLE', () => act(
      { title: 'ROLE FOR @' + user.username, kind: 'role', role: user.role, confirmLabel: 'SAVE ROLE', text: user.env_role !== 'user' ? 'SX_ADMIN_USERS / SX_MODERATOR_USERS keep this account at ' + user.env_role.toUpperCase() + ' or above.' : '' },
      (values) => api.put(path + '/role', values),
    )]);
    actions.push(['ADJUST CREDITS', () => act(
      { title: 'CREDITS FOR @' + user.username, kind: 'credits', confirmLabel: 'APPLY', text: 'Writes an admin entry to the credit ledger. Refunds of purchases belong in Stripe.' },
      (values) => api.post(path + '/credits', values),
    )]);
    if (user.role !== 'admin') {
      actions.push(['DELETE ACCOUNT', () => act(
        { title: 'DELETE @' + user.username, kind: 'delete', username: user.username, confirmLabel: 'DELETE FOREVER', text: 'Anonymizes the account and removes its posts, packs and comments. This cannot be undone.' },
        (values) => api.post(path + '/delete', values),
      )]);
    }
  }

  return (
    <div>
      <Button onClick={onBack}>← ALL USERS</Button>
      {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
      <Section num={1} title={'@' + user.username} active note={user.email || ''}>
        <SpecRow cells={[
          ['STATUS', user.status.toUpperCase(), 'JOINED ' + when(user.created_at)],
          ['ROLE', user.role.toUpperCase(), user.env_role !== 'user' ? 'ENV: ' + user.env_role.toUpperCase() : 'SET IN CONSOLE'],
          ['SESSIONS', detail.active_sessions, 'LAST SEEN ' + (when(user.last_seen_at) || 'NEVER')],
          ['POSTS', user.post_count, user.follower_count + ' FOLLOWERS'],
        ]} />
        <Mono>ID: {user.id}</Mono>
        {actions.length ? (
          <div className="sx-profile-actions">
            {actions.map(([label, onClick]) => <Button key={label} onClick={onClick}>{label}</Button>)}
          </div>
        ) : null}
      </Section>
      <Section num={2} title="REPORTS AGAINST" active note={String(detail.reports_against.length)}>
        <Rows items={detail.reports_against} empty="No reports." render={(report) => (
          <Mono>{when(report.created_at)} · {report.target_type.toUpperCase()} · {report.reason.toUpperCase()} · {report.status.toUpperCase()}{report.handled_by ? ' · @' + report.handled_by : ''} · BY @{report.reporter || 'deleted'}</Mono>
        )} />
      </Section>
      <Section num={3} title="POSTS" active note={String(detail.posts.length)}>
        <Rows items={detail.posts} empty="No posts." render={(post) => (
          <Mono>
            {when(post.created_at)} · {post.removed ? 'REMOVED' : <a href={'/reels?post=' + encodeURIComponent(post.id)} target="_blank" rel="noreferrer">{post.title || post.id}</a>} · {post.status.toUpperCase()}
          </Mono>
        )} />
      </Section>
      <Section num={4} title="SUPPORT AND FILED REPORTS" active>
        <Rows items={detail.support_requests} empty="No support requests." render={(row) => (
          <Mono>{when(row.created_at)} · {row.category.toUpperCase()} · {row.status.toUpperCase()} · {row.subject}</Mono>
        )} />
        <Rows items={detail.reports_filed} empty="Filed no reports." render={(row) => (
          <Mono>{when(row.created_at)} · FILED {row.target_type.toUpperCase()} · {row.reason.toUpperCase()} · {row.status.toUpperCase()}</Mono>
        )} />
      </Section>
      <Section num={5} title="STAFF HISTORY" active note={String(detail.history.length)}>
        <Rows items={detail.history} empty="No staff actions yet." render={(row) => (
          <Mono>{when(row.created_at)} · @{row.actor || 'deleted'} · {row.action.toUpperCase()}{row.target_type !== 'user' ? ' ' + row.target_type.toUpperCase() : ''} · {row.reason}</Mono>
        )} />
      </Section>
      {detail.credits ? (
        <Section num={6} title="CREDITS" active note={detail.credits.wallet.available_credits + ' AVAILABLE'}>
          <SpecRow cells={[
            ['AVAILABLE', detail.credits.wallet.available_credits, 'RESERVED ' + detail.credits.wallet.reserved_credits],
            ['PURCHASED', detail.credits.wallet.lifetime_purchased, 'LIFETIME'],
            ['SPENT', detail.credits.wallet.lifetime_spent, 'LIFETIME'],
          ]} />
          <Rows items={detail.credits.ledger} empty="No ledger entries." render={(row) => (
            <Mono>{when(row.created_at)} · {row.type.toUpperCase()} · {row.source.toUpperCase()} · {row.delta_available > 0 ? '+' : ''}{row.delta_available} → {row.balance_available}</Mono>
          )} />
          <Rows items={detail.credits.purchases} empty="No purchases." render={(row) => (
            <Mono>
              {when(row.created_at)} · {row.credits} CREDITS · {money(row.amount_total_cents, row.currency)} · {row.status.toUpperCase()}
              {row.amount_refunded_cents ? ' · REFUNDED ' + money(row.amount_refunded_cents, row.currency) : ''}
              {row.stripe_url ? <> · <a href={row.stripe_url} target="_blank" rel="noreferrer">STRIPE</a></> : null}
            </Mono>
          )} />
        </Section>
      ) : null}
      {dialog ? <StaffActionDialog {...dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
