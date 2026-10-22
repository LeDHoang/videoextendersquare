import { useState } from 'react';
import { Button, Pills } from '../ui/controls.jsx';
import { EmptyState, Mono } from '../ui/primitives.jsx';
import { SectionSkeleton } from '../ui/Skeleton.jsx';
import { usePagedList, when } from './usePagedList.js';

const STATUS_OPTIONS = [
  { value: '', label: 'ANY STATUS' },
  { value: 'active', label: 'ACTIVE' },
  { value: 'suspended', label: 'SUSPENDED' },
  { value: 'pending', label: 'UNVERIFIED' },
  { value: 'deleted', label: 'DELETED' },
];
const ROLE_OPTIONS = [
  { value: '', label: 'ANY ROLE' },
  { value: 'user', label: 'USER' },
  { value: 'moderator', label: 'MODERATOR' },
  { value: 'admin', label: 'ADMIN' },
];

/** Search accounts by username, email or id; a row opens the user detail. */
export default function UsersPanel({ onOpen }) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const list = usePagedList('/api/admin/users', { q, status, role, limit: 25 });

  return (
    <div>
      <form className="sx-staff-search" onSubmit={(event) => { event.preventDefault(); setQ(draft.trim()); }} role="search">
        <input className="sx-ps-input" aria-label="Search users" placeholder="@username, email or user id" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit">SEARCH</Button>
      </form>
      <div className="sx-moderation-tabs">
        <Pills options={STATUS_OPTIONS} value={status} onChange={setStatus} ariaLabel="Account status" />
        <Pills options={ROLE_OPTIONS} value={role} onChange={setRole} ariaLabel="Role" />
      </div>
      {list.error ? <div className="sx-error-box" role="alert">{list.error}</div> : null}
      {list.items === null ? <SectionSkeleton label="Loading users" /> : list.items.length ? (
        <ul className="sx-staff-rows">
          {list.items.map((row) => (
            <li key={row.id}>
              <button type="button" className="sx-staff-row" onClick={() => onOpen(row.id)}>
                <strong>@{row.username}</strong>
                <span>{row.email || 'no email'}</span>
                <Mono>{row.status.toUpperCase()} · {row.role.toUpperCase()} · JOINED {when(row.created_at)}</Mono>
              </button>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="NO USERS" text="No account matches this search." />}
      {list.hasMore ? <Button onClick={list.more} loading={list.loadingMore}>LOAD MORE</Button> : null}
    </div>
  );
}
