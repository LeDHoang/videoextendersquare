import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ExploreTile, { formatCompactCount } from '../components/explore/ExploreTile.jsx';
import { DensityToggle, gridClassName, useGridDensity } from '../components/explore/ExploreChrome.jsx';
import PackTile, { packCoverMembers } from '../components/packs/PackTile.jsx';
import { Button, Field } from '../components/ui/controls.jsx';
import RichText from '../components/ui/RichText.jsx';
import { profilePostUrl } from '../utils/profileLinks.js';
import { EmptyState, Mono } from '../components/ui/primitives.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import useExplorePreviews from '../hooks/useExplorePreviews.js';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useMessaging } from '../hooks/MessagingContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';

const TABS = [
  ['all', 'ALL POSTS'],
  ['video', 'REELS'],
  ['image', 'PHOTOS'],
  ['packs', 'PACKS'],
];
const PUBLIC_TABS = TABS.map(([value]) => value);
const SORTS = [
  { label: 'NEWEST FIRST', value: 'newest' },
  { label: 'MOST VIEWED', value: 'views' },
  { label: 'MOST LIKED', value: 'likes' },
];
const HIGHLIGHT_LIMIT = 12;
const NO_POSTS = [];

function joinedLabel(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return 'JOINED ' + date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
}

function highlightCover(pack) {
  const post = packCoverMembers(pack)[0];
  if (!post) return pack?.cover_url || '';
  return post.poster_url || post.preview_url || (post.media_type === 'image' ? post.url : '') || pack?.cover_url || '';
}

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
  const { config } = useConfigContext();
  const packCreationEnabled = config?.features?.reel_packs?.creation !== false;
  const packDiscoveryEnabled = config?.features?.reel_packs?.discovery !== false;
  const [profile, setProfile] = useState(null);
  const [items, setItems] = useState([]);
  const [highlights, setHighlights] = useState([]);
  const [savedKind, setSavedKind] = useState('reels');
  const [sort, setSort] = useState('newest');
  const [density, setDensity] = useGridDensity();
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState('');
  const [followBusy, setFollowBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [shareLabel, setShareLabel] = useState('');
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', caption: '', tags: '' });

  // The active tab is derived from the URL. SAVED is private: it resolves to
  // a real tab only when the viewer is looking at their own profile, so a
  // crafted ?tab=saved on someone else's profile falls back to ALL POSTS and
  // never issues a saved-content request.
  const isOwner = !!profile?.is_me;
  const tab = requestedTab === 'saved'
    ? (isOwner ? 'saved' : 'all')
    : PUBLIC_TABS.includes(requestedTab) ? requestedTab : 'all';
  const savedPacks = tab === 'saved' && savedKind === 'packs';
  const packGrid = tab === 'packs' || savedPacks;

  // Same gallery pipeline as the Explore page: tiles paint instantly from
  // posters while missing previews/posters are generated in the background.
  const { items: galleryItems, previewMessage } = useExplorePreviews(packGrid ? NO_POSTS : items);

  const loadProfile = useCallback(async () => {
    setError('');
    try {
      const result = await api.get('/api/users/' + encodeURIComponent(username));
      setProfile(result.user);
    } catch (requestError) {
      setError(requestError.message || 'Profile not found.');
    }
  }, [username]);

  const loadPosts = useCallback(async (nextCursor = null, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const result = tab === 'packs'
        ? await api.get('/api/users/' + encodeURIComponent(username) + '/packs')
        : savedPacks
          ? await api.get('/api/users/me/saved-packs', { offset: nextCursor || 0, limit: 24 })
          : tab === 'saved'
            ? await api.get('/api/users/me/saved', { cursor: nextCursor, limit: 24 })
            : await api.get('/api/users/' + encodeURIComponent(username) + '/posts', {
              media: tab,
              sort,
              cursor: nextCursor,
              limit: 24,
            });
      setItems((current) => append ? current.concat(result.items || []) : result.items || []);
      setCursor(result.next_cursor ?? result.next_offset ?? null);
    } catch (requestError) {
      setError(requestError.message || 'Could not load posts.');
      if (!append) setItems([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [username, tab, savedPacks, sort]);

  // Reload the profile when the route user or the signed-in account changes
  // (login/logout flips is_me and therefore what the viewer may see).
  useEffect(() => {
    setProfile(null);
    setItems([]);
    setHighlights([]);
    setCursor(null);
    setLoading(true);
    setSavedKind('reels');
    setSort('newest');
    loadProfile();
  }, [username, viewer?.id, loadProfile]);

  useEffect(() => {
    if (!profile) return;
    setItems([]);
    setCursor(null);
    setError('');
    loadPosts();
  }, [profile?.id, tab, savedPacks, sort, loadPosts]);

  // Reel Packs double as the profile "highlights" strip.
  useEffect(() => {
    if (!profile?.id || !(packDiscoveryEnabled || profile.is_me)) {
      setHighlights([]);
      return undefined;
    }
    let alive = true;
    api.get('/api/users/' + encodeURIComponent(profile.username) + '/packs')
      .then((result) => {
        if (alive) setHighlights((result.items || []).filter((pack) => pack.status === 'published'));
      })
      .catch(() => { if (alive) setHighlights([]); });
    return () => { alive = false; };
  }, [profile?.id, profile?.username, profile?.is_me, packDiscoveryEnabled]);

  const selectTab = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('tab');
    else next.set('tab', value);
    setSearchParams(next, { replace: true });
  };

  const selectSavedKind = (value) => {
    if (value === savedKind) return;
    setSavedKind(value);
  };

  const shareProfile = async () => {
    const url = window.location.origin + '/profile/' + encodeURIComponent(profile.username);
    try {
      if (navigator.share) {
        await navigator.share({ title: '@' + profile.username + ' on ECHO', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShareLabel('LINK COPIED');
    } catch {
      setShareLabel(window.prompt('Copy profile link', url) === null ? '' : 'LINK COPIED');
    }
    setTimeout(() => setShareLabel(''), 2000);
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

  const updatePack = (updated) => {
    setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
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
    <div className="sx-wide-page">
      {profile ? (
        <>
          <section className="sx-pf-hero" aria-label="Creator profile">
            <div className="sx-pf-hero-main">
              <Avatar user={profile} large />
              <div className="sx-pf-identity">
                <div className="sx-pf-namerow">
                  <h1 className="sx-pf-name">{profile.display_name || profile.username}</h1>
                  {profile.account_type !== 'real' ? <span className="sx-profile-demo">DEMO PROFILE</span> : null}
                </div>
                <p className="sx-pf-handle">
                  @{profile.username}
                  {joinedLabel(profile.created_at) ? <span> · {joinedLabel(profile.created_at)}</span> : null}
                </p>
                {profile.bio ? <p className="sx-pf-bio"><RichText text={profile.bio} /></p> : null}
                {profile.website ? (
                  <a className="sx-pf-link" href={profile.website} target="_blank" rel="noreferrer noopener">
                    {profile.website.replace(/^https?:\/\//, '')} ↗
                  </a>
                ) : null}
                {profile.top_tags?.length ? (
                  <div className="sx-pf-tags" aria-label="Most used tags">
                    {profile.top_tags.map((tag) => (
                      <Link key={tag.slug} to={'/explore/tag/' + encodeURIComponent(tag.slug)} className="sx-pf-tag" title={tag.count + ' post' + (tag.count === 1 ? '' : 's')}>
                        <span aria-hidden="true">#</span>{tag.name}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="sx-pf-actions">
              {profile.is_me ? (
                <>
                  <button type="button" className="sx-xh-btn sx-xh-btn--primary" onClick={() => navigate('/settings/profile')}>EDIT PROFILE</button>
                  {/* Credits are private to the account owner: this button only renders on your own profile. */}
                  <button type="button" className="sx-xh-btn" onClick={() => navigate('/wallet')}>CREDITS</button>
                  <button type="button" className="sx-xh-btn" onClick={shareProfile}>{shareLabel || 'SHARE'}</button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={'sx-xh-btn' + (profile.is_following ? '' : ' sx-xh-btn--primary')}
                    disabled={followBusy}
                    aria-pressed={profile.is_following}
                    onClick={toggleFollow}
                  >
                    {followBusy ? '…' : profile.is_following ? 'FOLLOWING' : 'FOLLOW +'}
                  </button>
                  <button type="button" className="sx-xh-btn" onClick={() => navigate('/messages?user=' + encodeURIComponent(profile.username))}>MESSAGE</button>
                  <button type="button" className="sx-xh-btn" onClick={shareProfile}>{shareLabel || 'SHARE'}</button>
                  <button type="button" className="sx-xh-btn sx-pf-quiet" onClick={reportProfile}>REPORT</button>
                  <button type="button" className="sx-xh-btn sx-pf-quiet" onClick={blockProfile}>BLOCK</button>
                </>
              )}
            </div>
            <div className="sx-pf-stats" role="group" aria-label="Profile statistics">
              <button type="button" className="sx-pf-stat sx-pf-stat--link sx-pf-stat--lead" onClick={() => setDialog('followers')}>
                <span className="sx-pf-stat-value">{formatCompactCount(profile.follower_count)}</span>
                <span className="sx-pf-stat-label">FOLLOWERS</span>
              </button>
              <button type="button" className="sx-pf-stat sx-pf-stat--link" onClick={() => setDialog('following')}>
                <span className="sx-pf-stat-value">{formatCompactCount(profile.following_count)}</span>
                <span className="sx-pf-stat-label">FOLLOWING</span>
              </button>
              <div className="sx-pf-stat">
                <span className="sx-pf-stat-value sx-pf-stat-value--accent">{formatCompactCount(profile.like_count)}</span>
                <span className="sx-pf-stat-label">LIKES</span>
              </div>
              <div className="sx-pf-stat">
                <span className="sx-pf-stat-value">{formatCompactCount(profile.post_count)}</span>
                <span className="sx-pf-stat-label">POSTS</span>
              </div>
            </div>
          </section>

          {(highlights.length || (profile.is_me && packCreationEnabled)) ? (
            <section className="sx-pf-highlights" aria-label="Highlighted Reel Packs">
              <div className="sx-pf-section-head">
                <h2><span aria-hidden="true" />HIGHLIGHTED REEL PACKS</h2>
                {highlights.length ? (
                  <button type="button" onClick={() => selectTab('packs')}>VIEW ALL ({highlights.length}) →</button>
                ) : null}
              </div>
              <div className="sx-pf-highlight-row">
                {highlights.slice(0, HIGHLIGHT_LIMIT).map((pack) => {
                  const cover = highlightCover(pack);
                  return (
                    <button key={pack.id} type="button" className="sx-pf-highlight" onClick={() => navigate('/packs/' + encodeURIComponent(pack.id))} title={pack.title}>
                      <span className="sx-pf-highlight-cover">
                        {cover ? <img src={cover} alt="" loading="lazy" /> : <b>{(pack.title || 'PACK').slice(0, 4).toUpperCase()}</b>}
                        {pack.reel_count ? <small>{pack.reel_count}</small> : null}
                      </span>
                      <span className="sx-pf-highlight-title">{pack.title}</span>
                    </button>
                  );
                })}
                {profile.is_me && packCreationEnabled ? (
                  <button type="button" className="sx-pf-highlight sx-pf-highlight--new" onClick={() => navigate('/packs/new')}>
                    <span className="sx-pf-highlight-cover"><b aria-hidden="true">+</b></span>
                    <span className="sx-pf-highlight-title">NEW PACK</span>
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <div className="sx-pf-controls">
            <div className="sx-pf-tabs" role="tablist" aria-label="Profile content">
              {TABS.filter(([value]) => value !== 'packs' || packDiscoveryEnabled || profile.is_me).concat(profile.is_me ? [['saved', 'SAVED']] : []).map(([value, label]) => (
                <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'sx-active' : ''} onClick={() => selectTab(value)}>
                  {label}
                </button>
              ))}
            </div>
            {!packGrid && tab !== 'saved' ? (
              <div className="sx-pf-tools">
                <label className="sx-xh-ctl">
                  <span className="sx-xh-ctl-label">SORT:</span>
                  <select className="sx-pf-select" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort posts">
                    {SORTS.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
                  </select>
                </label>
                <DensityToggle value={density} onChange={setDensity} />
              </div>
            ) : null}
          </div>

          {tab === 'saved' ? (
            <div className="sx-pf-private" role="note">
              <span>PRIVATE · ONLY YOU CAN SEE WHAT YOU SAVE</span>
            </div>
          ) : null}

          {tab === 'saved' ? (
            <div className="sx-profile-saved-tabs" role="tablist" aria-label="Saved content type">
              <button type="button" role="tab" aria-selected={savedKind === 'reels'} className={savedKind === 'reels' ? 'sx-active' : ''} onClick={() => selectSavedKind('reels')}>REELS</button>
              <button type="button" role="tab" aria-selected={savedKind === 'packs'} className={savedKind === 'packs' ? 'sx-active' : ''} onClick={() => selectSavedKind('packs')}>PACKS</button>
            </div>
          ) : null}

          {profile.is_me && tab === 'packs' && packCreationEnabled ? (
            <div className="sx-profile-pack-create">
              <Button primary onClick={() => navigate('/packs/new')}>+ CREATE REEL PACK</Button>
            </div>
          ) : null}

          {previewMessage && !packGrid ? <Mono>{previewMessage}</Mono> : null}
          {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
          {loading ? (
            <ExploreGridSkeleton label={packGrid ? 'Loading Reel Packs' : 'Loading profile posts'} />
          ) : items.length ? (
            <>
              <div className={packGrid ? 'sx-pack-grid' : gridClassName(density) + ' sx-profile-grid'}>
                {(packGrid ? items : galleryItems).map((item) => (
                  packGrid ? (
                    <PackTile
                      key={item.id}
                      pack={item}
                      onOpen={(pack) => navigate('/packs/' + encodeURIComponent(pack.id))}
                      onShare={(target) => messaging.openShare(target)}
                      onChanged={updatePack}
                      ownerActions={profile.is_me && tab === 'packs'}
                      source={tab === 'saved' ? 'saved_packs' : 'profile_packs'}
                    />
                  ) : (
                    <ExploreTile
                      key={item.id}
                      video={item}
                      onOpen={openPost}
                      onShare={(post) => messaging.openShare({ ...post, kind: 'reel' })}
                      onEdit={item.viewer_state?.can_edit ? beginEditPost : undefined}
                      onDelete={item.viewer_state?.can_edit && actionBusy !== item.id ? deletePost : undefined}
                    />
                  )
                ))}
              </div>
              {cursor ? (
                <div className="sx-pf-more">
                  <button type="button" className="sx-pf-more-btn" disabled={loadingMore} onClick={() => loadPosts(cursor, true)}>
                    {loadingMore ? 'LOADING…' : '[ LOAD MORE ]'}
                  </button>
                </div>
              ) : null}
              <div className="sx-pf-end">{'END OF LIST · ' + items.length + ' SHOWN' + (cursor ? ' · MORE AVAILABLE' : '')}</div>
            </>
          ) : (
            <EmptyState
              title={tab === 'saved' ? `NO SAVED ${savedKind.toUpperCase()}` : tab === 'packs' ? 'NO REEL PACKS YET' : 'NO POSTS YET'}
              text={savedPacks
                ? 'Packs you save will appear here. Saving a pack never saves its individual reels.'
                : tab === 'saved' ? 'Reels and photos you save will appear here. Only you can see them.'
                : profile.is_me ? 'Published images, reels, and Reel Packs will appear here.' : 'This creator has not published anything in this category.'}
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
