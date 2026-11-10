import { useState } from 'react';
import { api } from '../../api/client.js';
import { Button, Pills } from '../ui/controls.jsx';
import { EmptyState, Mono } from '../ui/primitives.jsx';
import { SectionSkeleton } from '../ui/Skeleton.jsx';
import StaffActionDialog from './StaffActionDialog.jsx';
import { usePagedList, when } from './usePagedList.js';

const STATUS_OPTIONS = [
  { value: 'all', label: 'ALL' },
  { value: 'live', label: 'LIVE' },
  { value: 'blocked', label: 'BLOCKED' },
];

/** Find tags; block them, or (admins) unblock them. A tag nobody used yet can be blocked from the search box. */
export default function TagsPanel({ viewer }) {
  const [status, setStatus] = useState('all');
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState(null);
  const list = usePagedList('/api/admin/tags', { q, status, limit: 25 });
  const isAdmin = viewer.role === 'admin';

  const act = (name, verb) => setDialog({
    title: (verb === 'block' ? 'BLOCK #' : 'UNBLOCK #') + name,
    text: verb === 'block'
      ? 'Hides the tag from posts, packs, search and its own page, and new posts cannot use it. The posts stay up.'
      : 'Posts and packs that carried the tag show it again.',
    confirmLabel: verb.toUpperCase(),
    onSubmit: async (values) => {
      await api.post('/api/admin/tags/' + encodeURIComponent(name) + '/' + verb, values);
      await list.reload();
    },
  });

  const typed = q.replace(/^#/, '');
  const unused = typed && list.items && !list.items.length && status !== 'blocked';

  return (
    <div>
      <form className="sx-staff-search" role="search" onSubmit={(event) => { event.preventDefault(); setQ(draft.trim()); }}>
        <input className="sx-ps-input" aria-label="Search tags" placeholder="#tag" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit">SEARCH</Button>
      </form>
      <div className="sx-moderation-tabs">
        <Pills options={STATUS_OPTIONS} value={status} onChange={setStatus} ariaLabel="Tag status" />
      </div>
      {list.error ? <div className="sx-error-box" role="alert">{list.error}</div> : null}
      {list.items === null ? <SectionSkeleton label="Loading tags" /> : list.items.length ? (
        <ul className="sx-staff-rows">
          {list.items.map((tag) => (
            <li key={tag.slug} className="sx-staff-item">
              <div>
                <strong>{tag.blocked ? '#' + tag.name : <a href={'/explore/tag/' + encodeURIComponent(tag.slug)} target="_blank" rel="noreferrer">#{tag.name}</a>}</strong>
                <Mono>
                  {tag.blocked ? 'BLOCKED ' + when(tag.blocked_at) : 'LIVE'} · {tag.post_count} POSTS · {tag.pack_count} PACKS · FIRST USED {when(tag.created_at)}
                </Mono>
              </div>
              <div className="sx-profile-actions">
                {!tag.blocked ? <Button onClick={() => act(tag.slug, 'block')}>BLOCK</Button> : null}
                {tag.blocked && isAdmin ? <Button onClick={() => act(tag.slug, 'unblock')}>UNBLOCK</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="NO TAGS" text={unused ? 'No post uses this tag yet. You can block it ahead of time.' : 'No tag matches this search.'} />
      )}
      {unused ? <Button onClick={() => act(typed, 'block')}>BLOCK #{typed}</Button> : null}
      {list.hasMore ? <Button onClick={list.more} loading={list.loadingMore}>LOAD MORE</Button> : null}
      {dialog ? <StaffActionDialog {...dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
