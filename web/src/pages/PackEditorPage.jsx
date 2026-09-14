import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Button, Dropdown, Field } from '../components/ui/controls.jsx';
import { EmptyState, Hero } from '../components/ui/primitives.jsx';
import { ExploreGridSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';

const VISIBILITY_OPTIONS = [
  { label: 'PUBLIC · DISCOVERABLE', value: 'public' },
  { label: 'UNLISTED · LINK ONLY', value: 'unlisted' },
];

const PACK_MIN_PUBLISHED_ITEMS = 3;
const PACK_MAX_ITEMS = 30;

function move(items, from, to) {
  if (to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export default function PackEditorPage() {
  const { packId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { config } = useConfigContext();
  const packCreationEnabled = config?.features?.reel_packs?.creation !== false;
  const [available, setAvailable] = useState(null);
  const [librarySearch, setLibrarySearch] = useState('');
  const [selected, setSelected] = useState([]);
  const [form, setForm] = useState({
    title: '',
    description: '',
    visibility: 'public',
    tags: '',
    city: '',
    country: '',
    coverPostId: '',
  });
  const [pack, setPack] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [dragIndex, setDragIndex] = useState(null);

  useEffect(() => {
    if (!user || !packId) return undefined;
    let alive = true;
    api.get('/api/packs/' + encodeURIComponent(packId)).then((detail) => {
      if (!alive) return;
      const value = detail?.pack;
      if (!value) throw new Error('This Reel Pack is unavailable.');
      if (!value.viewer_state?.can_edit) throw new Error('Only the creator can edit this Reel Pack.');
      setPack(value);
      setSelected(value.items.filter((item) => item.post).map((item) => item.post));
      setForm({
        title: value.title || '',
        description: value.description || '',
        visibility: value.visibility || 'public',
        tags: (value.tags || []).join(', '),
        city: value.location?.city || '',
        country: value.location?.country || '',
        coverPostId: value.cover_post_id || '',
      });
    }).catch((requestError) => {
      if (alive) setError(requestError.message || 'Could not load the Reel Pack editor.');
    });
    return () => { alive = false; };
  }, [packId, user]);

  // Public-reel browser for the collection library: any creator's published
  // reels are now valid members.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api.get('/api/reels', { search: librarySearch, sort: 'alphabetical', codec: 'all' })
        .then((result) => {
          if (!alive) return;
          setAvailable((result.videos || []).filter((row) => row && row.post_id));
        })
        .catch(() => {
          if (alive) setAvailable([]);
        });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [librarySearch]);

  const selectedIds = useMemo(() => new Set(selected.map((post) => post.id)), [selected]);

  const addPost = (post) => {
    if (selected.length >= PACK_MAX_ITEMS || selectedIds.has(post.id)) return;
    setSelected((current) => [...current, post]);
    setForm((current) => ({ ...current, coverPostId: current.coverPostId || post.id }));
  };

  const removePost = (postId) => {
    setSelected((current) => {
      const next = current.filter((post) => post.id !== postId);
      setForm((formState) => {
        if (formState.coverPostId !== postId) return formState;
        const replacement = next[0];
        return { ...formState, coverPostId: replacement?.id || '' };
      });
      return next;
    });
  };

  const payload = () => ({
    title: form.title.trim(),
    description: form.description.trim(),
    visibility: form.visibility,
    tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 5),
    location: { city: form.city.trim(), country: form.country.trim() },
    cover_post_id: form.coverPostId || null,
    post_ids: selected.map((post) => post.id),
  });

  const save = async ({ manageBusy = true } = {}) => {
    if (!pack && !packCreationEnabled) {
      setError('Creating Reel Packs is temporarily unavailable.');
      return null;
    }
    if (!form.title.trim()) {
      setError('Enter a pack title.');
      return null;
    }
    if (manageBusy) setBusy('save');
    setError('');
    try {
      const result = pack
        ? await api.patch('/api/packs/' + encodeURIComponent(pack.id), {
            ...payload(),
            expected_revision: pack.revision,
          })
        : await api.post('/api/packs', payload());
      setPack(result.pack);
      return result.pack;
    } catch (requestError) {
      setError(requestError.message || 'Could not save this Reel Pack.');
      return null;
    } finally {
      if (manageBusy) setBusy('');
    }
  };

  const publish = async () => {
    if (selected.length < PACK_MIN_PUBLISHED_ITEMS) {
      setError(`Publishing requires at least ${PACK_MIN_PUBLISHED_ITEMS} available reels.`);
      return;
    }
    if (busy) return;
    setBusy('publish');
    setError('');
    const saved = await save({ manageBusy: false });
    if (!saved) {
      setBusy('');
      return;
    }
    try {
      const result = await api.post('/api/packs/' + encodeURIComponent(saved.id) + '/publish', {
        expected_revision: saved.revision,
      });
      navigate('/packs/' + encodeURIComponent(result.pack.id));
    } catch (requestError) {
      setPack(saved);
      setError(requestError.message || 'The draft was saved but could not be published.');
    } finally {
      setBusy('');
    }
  };

  const unpublish = async () => {
    if (!pack) return;
    setBusy('unpublish');
    try {
      const result = await api.post('/api/packs/' + encodeURIComponent(pack.id) + '/unpublish', {
        expected_revision: pack.revision,
      });
      setPack(result.pack);
    } catch (requestError) {
      setError(requestError.message || 'Could not unpublish this Reel Pack.');
    } finally {
      setBusy('');
    }
  };

  if (!packId && !packCreationEnabled) {
    return <EmptyState title="PACK CREATION UNAVAILABLE" text="New Reel Packs are temporarily disabled." />;
  }
  if (error && available === null) {
    return <EmptyState title="PACK EDITOR UNAVAILABLE" text={error} />;
  }
  if (available === null) return <ExploreGridSkeleton label="Loading Reel Pack editor" />;

  return (
    <div className="sx-pack-editor">
      <Hero title={pack ? 'EDIT REEL PACK' : 'CREATE REEL PACK'} kicker="3–30 PUBLIC REELS · AUTHORED ORDER · LIVE SHARED REFERENCE" />
      {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
      <div className="sx-pack-editor-layout">
        <section className="sx-pack-editor-form">
          <Field label="PACK TITLE">
            <input className="sx-input" maxLength={80} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </Field>
          <Field label="DESCRIPTION">
            <textarea className="sx-textarea" maxLength={500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </Field>
          <Field label="VISIBILITY">
            <Dropdown value={form.visibility} options={VISIBILITY_OPTIONS} onChange={(visibility) => setForm({ ...form, visibility })} />
          </Field>
          <Field label="TAGS · COMMA SEPARATED · MAX 5">
            <input className="sx-input" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
          </Field>
          <div className="sx-pack-location-fields">
            <Field label="CITY">
              <input className="sx-input" value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} />
            </Field>
            <Field label="COUNTRY">
              <input className="sx-input" value={form.country} onChange={(event) => setForm({ ...form, country: event.target.value })} />
            </Field>
          </div>
          <div className="sx-pack-editor-actions">
            <Button onClick={() => navigate(pack?.id ? '/packs/' + encodeURIComponent(pack.id) : '/profile/' + encodeURIComponent(user?.username || '') + '?tab=packs')}>CANCEL</Button>
            <Button loading={busy === 'save'} disabled={!!busy} onClick={save}>SAVE DRAFT</Button>
            {pack?.status === 'published' ? (
              <Button loading={busy === 'unpublish'} disabled={!!busy} onClick={unpublish}>UNPUBLISH</Button>
            ) : null}
            <Button primary loading={busy === 'publish'} disabled={!!busy || selected.length < PACK_MIN_PUBLISHED_ITEMS} onClick={publish}>PUBLISH PACK</Button>
          </div>
        </section>

        <section className="sx-pack-editor-order">
          <div className="sx-pack-editor-heading">
            <h2>PACK ORDER</h2>
            <span>{selected.length}/{PACK_MAX_ITEMS} · MINIMUM {PACK_MIN_PUBLISHED_ITEMS} TO PUBLISH</span>
          </div>
          {!selected.length ? <p className="sx-mono">Search public reels below and add them to this collection.</p> : null}
          {selected.map((post, index) => (
            <article
              key={post.id}
              className="sx-pack-editor-row"
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragIndex !== null) setSelected((current) => move(current, dragIndex, index));
                setDragIndex(null);
              }}
            >
              <span className="sx-pack-drag" aria-hidden="true">⠿</span>
              <span>{String(index + 1).padStart(2, '0')}</span>
              {post.poster_url || (post.media_type === 'image' && (post.preview_url || post.url)) ? (
                <img src={post.poster_url || post.preview_url || post.url} alt="" />
              ) : <span className="sx-pack-track-placeholder">▶</span>}
              <strong>{post.title || post.path?.split('/').pop() || 'Untitled reel'}</strong>
              <small className="sx-pack-editor-owner">@{post.creator?.username || post.author_name || 'creator'}</small>
              <label>
                <input
                  type="radio"
                  name="pack-cover"
                  checked={form.coverPostId === post.id}
                  onChange={() => setForm({ ...form, coverPostId: post.id })}
                />
                COVER
              </label>
              <button type="button" disabled={index === 0} onClick={() => setSelected((current) => move(current, index, index - 1))} aria-label={`Move ${post.title || 'reel'} up`}>↑</button>
              <button type="button" disabled={index === selected.length - 1} onClick={() => setSelected((current) => move(current, index, index + 1))} aria-label={`Move ${post.title || 'reel'} down`}>↓</button>
              <button type="button" onClick={() => removePost(post.id)} aria-label={`Remove ${post.title || 'reel'}`}>REMOVE</button>
            </article>
          ))}
        </section>
      </div>

      <section className="sx-pack-library">
        <div className="sx-pack-editor-heading">
          <h2>FIND PUBLIC REELS</h2>
          <span>ANY CREATOR'S PUBLISHED REELS CAN JOIN THE COLLECTION</span>
        </div>
        <input
          className="sx-input"
          value={librarySearch}
          onChange={(event) => setLibrarySearch(event.target.value)}
          placeholder="Search reels by title, creator, tag, or place…"
          aria-label="Search public reels to add"
        />
        <div className="sx-pack-library-grid">
          {available.map((post) => {
            const selectedAlready = selectedIds.has(post.id);
            const image = post.poster_url || (post.media_type === 'image' && (post.preview_url || post.url));
            return (
              <button type="button" key={post.id} disabled={selectedAlready || selected.length >= PACK_MAX_ITEMS} onClick={() => addPost(post)}>
                {image ? <img src={image} alt="" loading="lazy" /> : <span>▶</span>}
                <strong>{post.title || post.path?.split('/').pop() || 'Untitled reel'}</strong>
                <small>@{post.creator?.username || post.author_name || 'creator'}</small>
                <small>{selectedAlready ? 'IN PACK' : 'ADD TO PACK'}</small>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
