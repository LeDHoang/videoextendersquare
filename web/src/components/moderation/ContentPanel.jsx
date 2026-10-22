import { useState } from 'react';
import { api } from '../../api/client.js';
import { Button, Pills } from '../ui/controls.jsx';
import { EmptyState, Mono } from '../ui/primitives.jsx';
import { SectionSkeleton } from '../ui/Skeleton.jsx';
import StaffActionDialog from './StaffActionDialog.jsx';
import { usePagedList, when } from './usePagedList.js';

const TYPE_OPTIONS = [
  { value: 'post', label: 'POSTS' },
  { value: 'pack', label: 'REEL PACKS' },
  { value: 'comment', label: 'COMMENTS' },
];
const STATUS_OPTIONS = [
  { value: 'all', label: 'ALL' },
  { value: 'live', label: 'LIVE' },
  { value: 'removed', label: 'REMOVED' },
];

/** Find posts, Reel Packs and comments; remove them, or (admins) restore packs and comments. */
export default function ContentPanel({ viewer, onOpenUser }) {
  const [type, setType] = useState('post');
  const [status, setStatus] = useState('all');
  const [draft, setDraft] = useState({ q: '', owner: '' });
  const [filters, setFilters] = useState({ q: '', owner: '' });
  const [dialog, setDialog] = useState(null);
  const list = usePagedList('/api/admin/content', { type, status, ...filters, limit: 25 });
  const isAdmin = viewer.role === 'admin';

  const act = (item, verb) => setDialog({
    title: (verb === 'remove' ? 'REMOVE ' : 'RESTORE ') + item.type.toUpperCase(),
    text: verb === 'remove' && item.type === 'post'
      ? 'Removing a post deletes its media. It cannot be restored.'
      : verb === 'restore' && item.type === 'pack' ? 'The pack comes back as a draft; its owner republishes it.' : '',
    confirmLabel: verb.toUpperCase(),
    onSubmit: async (values) => {
      const path = '/api/admin/content/' + item.type + '/' + encodeURIComponent(item.id) + '/' + verb;
      list.replace((await api.post(path, values)).item);
    },
  });

  return (
    <div>
      <form
        className="sx-staff-search"
        role="search"
        onSubmit={(event) => { event.preventDefault(); setFilters({ q: draft.q.trim(), owner: draft.owner.trim() }); }}
      >
        <input className="sx-ps-input" aria-label="Search content" placeholder="Text or id" value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} />
        <input className="sx-ps-input" aria-label="Owner username" placeholder="@owner" value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} />
        <Button type="submit">SEARCH</Button>
      </form>
      <div className="sx-moderation-tabs">
        <Pills options={TYPE_OPTIONS} value={type} onChange={setType} ariaLabel="Content type" />
        <Pills options={STATUS_OPTIONS} value={status} onChange={setStatus} ariaLabel="Content status" />
      </div>
      {list.error ? <div className="sx-error-box" role="alert">{list.error}</div> : null}
      {list.items === null ? <SectionSkeleton label="Loading content" /> : list.items.length ? (
        <ul className="sx-staff-rows">
          {list.items.map((item) => (
            <li key={item.type + item.id} className="sx-staff-item">
              <div>
                <strong>{item.removed ? item.text || item.id : <a href={item.link} target="_blank" rel="noreferrer">{item.text || item.id}</a>}</strong>
                <Mono>
                  {item.type.toUpperCase()} · {item.removed ? 'REMOVED' : item.status.toUpperCase()} · {when(item.created_at)} · BY{' '}
                  {item.owner_id ? <button type="button" className="sx-staff-link" onClick={() => onOpenUser(item.owner_id)}>@{item.owner}</button> : 'deleted'}
                </Mono>
              </div>
              <div className="sx-profile-actions">
                {!item.removed ? <Button onClick={() => act(item, 'remove')}>REMOVE</Button> : null}
                {item.removed && isAdmin && item.type !== 'post' ? <Button onClick={() => act(item, 'restore')}>RESTORE</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="NOTHING FOUND" text="No content matches this search." />}
      {list.hasMore ? <Button onClick={list.more} loading={list.loadingMore}>LOAD MORE</Button> : null}
      {dialog ? <StaffActionDialog {...dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
