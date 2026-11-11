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

/** Find posts, Reel Packs and comments; remove them, or (admins) restore them or purge a removed post's media. */
export default function ContentPanel({ viewer, onOpenUser }) {
  const [type, setType] = useState('post');
  const [status, setStatus] = useState('all');
  const [draft, setDraft] = useState({ q: '', owner: '' });
  const [filters, setFilters] = useState({ q: '', owner: '' });
  const [dialog, setDialog] = useState(null);
  const [purged, setPurged] = useState(null);
  const list = usePagedList('/api/admin/content', { type, status, ...filters, limit: 25 });
  const isAdmin = viewer.role === 'admin';

  const act = (item, verb) => setDialog({
    title: (verb === 'remove' ? 'REMOVE ' : 'RESTORE ') + item.type.toUpperCase(),
    text: verb === 'remove' && item.type === 'post'
      ? 'Removing a post hides it. Its media files stay stored, so an admin can restore it, or purge them for good.'
      : verb === 'restore' && item.type === 'post' ? 'The post is published again with its original media.'
      : verb === 'restore' && item.type === 'pack' ? 'The pack comes back as a draft; its owner republishes it.' : '',
    confirmLabel: verb.toUpperCase(),
    onSubmit: async (values) => {
      const path = '/api/admin/content/' + item.type + '/' + encodeURIComponent(item.id) + '/' + verb;
      list.replace((await api.post(path, values)).item);
    },
  });

  const purge = (item) => setDialog({
    title: 'PURGE MEDIA OF POST',
    text: 'Deletes the published media files of this post from storage. This cannot be undone and the post can never be restored. Use it for illegal content and legal or privacy requests.',
    confirmLabel: 'PURGE FOREVER',
    onSubmit: async (values) => {
      const result = await api.post('/api/admin/content/post/' + encodeURIComponent(item.id) + '/purge', values);
      setPurged({ id: item.id, urls: result.urls || [] });
      list.replace(result.item);
    },
  });

  return (
    <div>
      {purged ? (
        <div className="sx-error-box" role="status">
          <strong>MEDIA PURGED · POST {purged.id}</strong>
          {purged.urls.length ? (
            <>
              <p>The edge can serve cached copies for up to a day. Purge these URLs in Cloudflare (Caching → Custom Purge):</p>
              <textarea className="sx-ps-input sx-ps-textarea" aria-label="URLs to purge" readOnly rows={Math.min(8, purged.urls.length)} value={purged.urls.join('\n')} />
            </>
          ) : <p>No published file was left to purge at the edge.</p>}
          <p>Two processing copies are not deleted here: the job result (public link, kept 30 days) and the staff-only source copy. Find both under UPLOAD LOGS for this post and delete them in R2 when the case needs it.</p>
          <Button onClick={() => setPurged(null)}>DISMISS</Button>
        </div>
      ) : null}
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
                  {item.type.toUpperCase()} · {item.purged ? 'REMOVED · MEDIA PURGED' : item.removed ? 'REMOVED' : item.status.toUpperCase()} · {when(item.created_at)} · BY{' '}
                  {item.owner_id ? <button type="button" className="sx-staff-link" onClick={() => onOpenUser(item.owner_id)}>@{item.owner}</button> : 'deleted'}
                </Mono>
              </div>
              <div className="sx-profile-actions">
                {!item.removed ? <Button onClick={() => act(item, 'remove')}>REMOVE</Button> : null}
                {item.removed && isAdmin && !item.purged ? <Button onClick={() => act(item, 'restore')}>RESTORE</Button> : null}
                {item.removed && isAdmin && item.type === 'post' ? <Button onClick={() => purge(item)}>PURGE MEDIA</Button> : null}
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
