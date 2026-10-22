import { useState } from 'react';
import { Button } from '../ui/controls.jsx';
import { EmptyState, Mono } from '../ui/primitives.jsx';
import { SectionSkeleton } from '../ui/Skeleton.jsx';
import { usePagedList, when } from './usePagedList.js';

const ACTIONS = [
  'report.claim', 'report.release', 'report.dismiss', 'report.resolve',
  'user.suspend', 'user.reinstate', 'user.sign_out', 'user.role', 'user.credits', 'user.delete',
  'content.remove', 'content.restore', 'support.update', 'support.file_report',
];

function detailText(details) {
  return Object.entries(details || {}).map(([key, value]) => key + '=' + value).join(' ');
}

/** Admin only: every staff action, newest first. */
export default function AuditPanel({ onOpenUser }) {
  const [draft, setDraft] = useState({ actor: '', target_id: '' });
  const [filters, setFilters] = useState({ actor: '', target_id: '' });
  const [action, setAction] = useState('');
  const list = usePagedList('/api/admin/audit', { ...filters, action, limit: 50 });

  return (
    <div>
      <form
        className="sx-staff-search"
        role="search"
        onSubmit={(event) => { event.preventDefault(); setFilters({ actor: draft.actor.trim(), target_id: draft.target_id.trim() }); }}
      >
        <input className="sx-ps-input" aria-label="Staff username" placeholder="@staff" value={draft.actor} onChange={(event) => setDraft({ ...draft, actor: event.target.value })} />
        <input className="sx-ps-input" aria-label="Target id" placeholder="Target id" value={draft.target_id} onChange={(event) => setDraft({ ...draft, target_id: event.target.value })} />
        <select className="sx-ps-input" aria-label="Action" value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="">ANY ACTION</option>
          {ACTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <Button type="submit">FILTER</Button>
      </form>
      {list.error ? <div className="sx-error-box" role="alert">{list.error}</div> : null}
      {list.items === null ? <SectionSkeleton label="Loading audit log" /> : list.items.length ? (
        <ul className="sx-staff-rows">
          {list.items.map((row) => (
            <li key={row.id} className="sx-staff-item">
              <div>
                <strong>{row.action}</strong>
                <Mono>
                  {when(row.created_at)} · @{row.actor || 'deleted'} · {row.target_type.toUpperCase()}{' '}
                  {row.target_type === 'user'
                    ? <button type="button" className="sx-staff-link" onClick={() => onOpenUser(row.target_id)}>{row.target_label ? '@' + row.target_label : row.target_id}</button>
                    : row.target_id}
                  {row.report_id && row.report_id !== row.target_id ? ' · REPORT ' + row.report_id : ''}
                </Mono>
                {row.reason ? <p>{row.reason}</p> : null}
                {detailText(row.details) ? <Mono>{detailText(row.details)}</Mono> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="NO ACTIONS" text="No staff action matches these filters." />}
      {list.hasMore ? <Button onClick={list.more} loading={list.loadingMore}>LOAD MORE</Button> : null}
    </div>
  );
}
