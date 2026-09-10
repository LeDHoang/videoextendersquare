import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ExploreTile from '../components/explore/ExploreTile.jsx';
import { Button } from '../components/ui/controls.jsx';
import { EmptyState, Hero } from '../components/ui/primitives.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';

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
  const [profile, setProfile] = useState(null);
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState(['all', 'video', 'image'].includes(requestedTab) ? requestedTab : 'all');
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState('');

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
    }
  };

  const openPost = (post) => {
    const params = new URLSearchParams({
      folder: 'ALL FOLDERS',
      codec: 'all',
      sort: 'newest',
      author: profile.username,
      play: post.path,
    });
    navigate('/reels?' + params.toString());
  };

  if (error && !profile) {
    return <EmptyState title="PROFILE UNAVAILABLE" text={error} hint={'@' + username} />;
  }

  return (
    <div>
      <Hero title={profile ? '@' + profile.username : 'PROFILE'} kicker="ECHO · CREATOR PROFILE · POSTS · REELS · PHOTOS" />
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
                  <Button primary={profile.is_following} onClick={toggleFollow}>
                    {profile.is_following ? 'FOLLOWING' : 'FOLLOW'}
                  </Button>
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
                {items.map((post) => <ExploreTile key={post.id} video={post} onOpen={openPost} />)}
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

          {dialog ? <PeopleDialog title={dialog.toUpperCase()} username={profile.username} kind={dialog} onClose={() => setDialog('')} /> : null}
        </>
      ) : (
        <ExploreGridSkeleton label="Loading profile" />
      )}
    </div>
  );
}
