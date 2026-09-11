import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ExploreTile from '../components/explore/ExploreTile.jsx';
import { Button, Field } from '../components/ui/controls.jsx';
import { profilePostUrl } from '../utils/profileLinks.js';
import { EmptyState } from '../components/ui/primitives.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useMessaging } from '../hooks/MessagingContext.jsx';

const TABS = [
  ['all', 'ALL POSTS'],
  ['video', 'REELS'],
  ['image', 'PHOTOS'],
];

function Avatar({ user, large = false }) {
  const label = (user?.display_name || user?.username || '?').trim();
  return (
    <span
      className={'sx-profile-avatar' + (large ? ' sx-profile-avatar--large' : '')}
      style={{ backgroundColor: user?.avatar_color || 'var(--sx-accent)' }}
      aria-hidden="true"
    >
      {user?.avatar_url ? <img src={user.avatar_url} alt="" /> : label.slice(0, 2).toUpperCase()}
    </span>
  );
}

function PeopleDialog({ title, username, kind, onClose }) {
  const [rows, setRows] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (nextCursor = null, append = false) => {
    if (append) setLoadingMore(true);
    try {
      const result = await api.get('/api/users/' + encodeURIComponent(username) + '/' + kind, {
        cursor: nextCursor,
        limit: 24,
      });
      setRows((current) => append ? (current || []).concat(result.users || []) : result.users || []);
      setCursor(result.next_cursor || null);
    } catch {
      if (!append) setRows([]);
    } finally {
      setLoadingMore(false);
    }
  }, [username, kind]);

  useEffect(() => {
    setRows(null);
    setCursor(null);
    load();
  }, [load]);

  return (
    <div className="sx-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="sx-people-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="sx-people-dialog-head">
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="sx-people-list">
          {rows === null ? <span>LOADING…</span> : rows.map((person) => (
            <Link key={person.id} to={'/profile/' + person.username} onClick={onClose}>
              <Avatar user={person} />
              <span><strong>{person.username}</strong><small>{person.display_name}</small></span>
            </Link>
          ))}
          {rows?.length === 0 ? <span>NO USERS YET</span> : null}
          {cursor ? (
            <button type="button" className="sx-people-more" disabled={loadingMore} onClick={() => load(cursor, true)}>
              {loadingMore ? 'LOADING…' : 'LOAD MORE'}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export default function ProfilePage() {
  const { username = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab') || 'all';
  const { user: viewer } = useAuth();
  const messaging = useMessaging();
  const [profile, setProfile] = useState(null);
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState(['all', 'video', 'image'].includes(requestedTab) ? requestedTab : 'all');
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState('');
  const [followBusy, setFollowBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', caption: '', tags: '' });

  const loadProfile = useCallback(async () => {
    setError('');
    try {
      const result = await api.get('/api/users/' + encodeURIComponent(username));
      setProfile(result.user);
      const nextTab = requestedTab === 'saved' && result.user.is_me
        ? 'saved'
        : ['all', 'video', 'image'].includes(requestedTab) ? requestedTab : 'all';
      setTab(nextTab);
    } catch (requestError) {
      setError(requestError.message || 'Profile not found.');
    }
  }, [username, requestedTab]);

  const loadPosts = useCallback(async (nextCursor = null, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const result = tab === 'saved'
        ? await api.get('/api/users/me/saved', { cursor: nextCursor, limit: 24 })
        : await api.get('/api/users/' + encodeURIComponent(username) + '/posts', {
            media: tab,
            cursor: nextCursor,
            limit: 24,
          });
      setItems((current) => append ? current.concat(result.items || []) : result.items || []);
      setCursor(result.next_cursor || null);
    } catch (requestError) {
      setError(requestError.message || 'Could not load posts.');
      if (!append) setItems([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [username, tab]);

  useEffect(() => {
    setProfile(null);
    setItems([]);
    setTab(['all', 'video', 'image'].includes(requestedTab) ? requestedTab : 'all');
    setCursor(null);
    setLoading(true);
    loadProfile();
  }, [username, loadProfile]);

  useEffect(() => {
    if (profile) loadPosts();
  }, [profile?.id, tab, loadPosts]);

  const selectTab = (value) => {
    setTab(value);
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('tab');
    else next.set('tab', value);
    setSearchParams(next, { replace: true });
  };

  const toggleFollow = async () => {
    if (followBusy) return;
    if (!viewer) {
      try {
        sessionStorage.setItem('echo:pending-action', JSON.stringify({
          kind: 'follow',
          username,
          created_at: Date.now(),
        }));
      } catch {
        // Continue to authentication even if storage is unavailable.
      }
      navigate('/login?next=' + encodeURIComponent('/profile/' + username));
      return;
    }
    const wasFollowing = profile.is_following;
    setFollowBusy(true);
    setProfile((current) => ({
      ...current,
      is_following: !wasFollowing,
      follower_count: Math.max(0, current.follower_count + (wasFollowing ? -1 : 1)),
    }));
    try {
      const result = wasFollowing
        ? await api.delete('/api/users/' + encodeURIComponent(username) + '/follow')
        : await api.put('/api/users/' + encodeURIComponent(username) + '/follow');
      setProfile((current) => ({ ...current, is_following: result.following, follower_count: result.follower_count }));
    } catch (requestError) {
      setProfile((current) => ({
        ...current,
        is_following: wasFollowing,
        follower_count: Math.max(0, current.follower_count + (wasFollowing ? 1 : -1)),
      }));
      setError(requestError.message || 'Could not update follow status.');
    } finally {
      setFollowBusy(false);
    }
  };

  const openPost = (post) => {
    navigate(profilePostUrl(post, profile.username, tab));
  };

  const beginEditPost = (post) => {
    setEditing(post);
    setEditForm({
      title: post.title || '',
      caption: post.caption || '',
      tags: (post.tags || []).join(', '),
    });
  };

  const saveEditedPost = async () => {
    if (!editing) return;
    setActionBusy(editing.id);
    setError('');
    try {
      const result = await api.patch('/api/posts/' + encodeURIComponent(editing.id), {
        title: editForm.title,
        caption: editForm.caption,
        tags: editForm.tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 5),
      });
      setItems((current) => current.map((item) => item.id === editing.id ? { ...item, ...result.post } : item));
      setEditing(null);
    } catch (requestError) {
      setError(requestError.message || 'Could not update post.');
    } finally {
      setActionBusy('');
    }
  };

  const deletePost = async (post) => {
    if (!window.confirm('Delete this post? This cannot be undone from the profile.')) return;
    setActionBusy(post.id);
    setError('');
    try {
      await api.delete('/api/posts/' + encodeURIComponent(post.id));
      setItems((current) => current.filter((item) => item.id !== post.id));
      setProfile((current) => ({ ...current, post_count: Math.max(0, current.post_count - 1) }));
    } catch (requestError) {
      setError(requestError.message || 'Could not delete post.');
    } finally {
      setActionBusy('');
    }
  };

  const reportProfile = async () => {
    if (!viewer) {
      navigate('/login?next=' + encodeURIComponent('/profile/' + username));
      return;
    }
    const reason = window.prompt('Report reason: spam, harassment, hate, sexual, violence, impersonation, privacy, or other');
    if (!reason) return;
    const details = window.prompt('Optional details') || '';
    try {
      await api.post('/api/reports', { target_type: 'user', target_id: profile.id, reason, details });
      window.alert('Report submitted. Thank you.');
    } catch (requestError) {
      setError(requestError.message || 'Could not submit report.');
    }
  };

  const blockProfile = async () => {
    if (!viewer) {
      navigate('/login?next=' + encodeURIComponent('/profile/' + username));
      return;
    }
    if (!window.confirm('Block @' + profile.username + '? You will no longer see each other’s content.')) return;
    try {
      await api.put('/api/users/' + encodeURIComponent(profile.username) + '/block');
      navigate('/reels');
    } catch (requestError) {
      setError(requestError.message || 'Could not block this profile.');
    }
  };

  if (error && !profile) {
    return <EmptyState title="PROFILE UNAVAILABLE" text={error} hint={'@' + username} />;
  }

  return (
    <div>
      {profile ? (
        <>
          <section className="sx-profile-head">
            <Avatar user={profile} large />
            <div className="sx-profile-copy">
              <div className="sx-profile-title-row">
                <div>
                  <h2>{profile.display_name}</h2>
                  <span>@{profile.username}</span>
                </div>
                {profile.is_me ? (
                  <Button onClick={() => navigate('/settings/profile')}>EDIT PROFILE</Button>
                ) : (
                  <div className="sx-profile-actions">
                    <Button onClick={() => navigate('/messages?user=' + encodeURIComponent(profile.username))}>MESSAGE</Button>
                    <Button primary={profile.is_following} loading={followBusy} disabled={followBusy} onClick={toggleFollow}>
                      {profile.is_following ? 'FOLLOWING' : 'FOLLOW'}
                    </Button>
                    <Button onClick={reportProfile}>REPORT</Button>
                    <Button onClick={blockProfile}>BLOCK</Button>
                  </div>
                )}
              </div>
              <div className="sx-profile-counts">
                <span><strong>{profile.post_count}</strong> POSTS</span>
                <button type="button" onClick={() => setDialog('followers')}><strong>{profile.follower_count}</strong> FOLLOWERS</button>
                <button type="button" onClick={() => setDialog('following')}><strong>{profile.following_count}</strong> FOLLOWING</button>
              </div>
              {profile.bio ? <p>{profile.bio}</p> : null}
              {profile.website ? <a href={profile.website} target="_blank" rel="noreferrer">{profile.website}</a> : null}
              {profile.account_type !== 'real' ? <span className="sx-profile-demo">DEMO PROFILE</span> : null}
            </div>
          </section>

          <div className="sx-profile-tabs" role="tablist" aria-label="Profile posts">
            {TABS.concat(profile.is_me ? [['saved', 'SAVED']] : []).map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'sx-active' : ''} onClick={() => selectTab(value)}>
                {label}
              </button>
            ))}
          </div>

          {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
          {loading ? (
            <ExploreGridSkeleton label="Loading profile posts" />
          ) : items.length ? (
            <>
              <div className="sx-explore-grid sx-profile-grid">
                {items.map((post) => (
                  <ExploreTile
                    key={post.id}
                    video={post}
                    onOpen={openPost}
                    onShare={(post) => messaging.openShare(post)}
                    onEdit={post.viewer_state?.can_edit ? beginEditPost : undefined}
                    onDelete={post.viewer_state?.can_edit && actionBusy !== post.id ? deletePost : undefined}
                  />
                ))}
              </div>
              {cursor ? (
                <div className="sx-profile-load-more">
                  <Button loading={loadingMore} disabled={loadingMore} onClick={() => loadPosts(cursor, true)}>LOAD MORE</Button>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState
              title={tab === 'saved' ? 'NO SAVED POSTS' : 'NO POSTS YET'}
              text={profile.is_me ? 'Published images and reels will appear here.' : 'This creator has not published anything in this category.'}
            />
          )}

          {editing ? (
            <div className="sx-modal-backdrop" role="presentation" onMouseDown={() => setEditing(null)}>
              <section className="sx-people-dialog sx-post-editor" role="dialog" aria-modal="true" aria-label="Edit post" onMouseDown={(event) => event.stopPropagation()}>
                <div className="sx-people-dialog-head">
                  <strong>EDIT POST</strong>
                  <button type="button" onClick={() => setEditing(null)} aria-label="Close">×</button>
                </div>
                <div className="sx-post-editor-fields">
                  <Field label="TITLE">
                    <input className="sx-input" maxLength={100} value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} />
                  </Field>
                  <Field label="CAPTION">
                    <textarea className="sx-textarea" maxLength={2200} value={editForm.caption} onChange={(event) => setEditForm({ ...editForm, caption: event.target.value })} />
                  </Field>
                  <Field label="TAGS (COMMA SEPARATED, MAX 5)">
                    <input className="sx-input" value={editForm.tags} onChange={(event) => setEditForm({ ...editForm, tags: event.target.value })} />
                  </Field>
                  <div className="sx-profile-actions">
                    <Button onClick={() => setEditing(null)}>CANCEL</Button>
                    <Button primary loading={actionBusy === editing.id} disabled={actionBusy === editing.id} onClick={saveEditedPost}>SAVE POST</Button>
                  </div>
                </div>
              </section>
            </div>
          ) : null}

          {dialog ? <PeopleDialog title={dialog.toUpperCase()} username={profile.username} kind={dialog} onClose={() => setDialog('')} /> : null}
        </>
      ) : (
        <ExploreGridSkeleton label="Loading profile" />
      )}
    </div>
  );
}
