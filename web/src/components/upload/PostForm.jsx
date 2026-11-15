import { useMemo, useState } from 'react';
import { GatedReason, Mono } from '../ui/primitives.jsx';
import { Button } from '../ui/controls.jsx';
import LocationField from '../ui/LocationField.jsx';
import { LocationIcon } from '../icons/index.jsx';
import { CAPTION_MAX, TAGS_MAX, TITLE_MAX } from './mediaItems.js';

// Title, caption, tags and location of one post. `draft` is
// { title, caption, tags, location }; onChange receives the next draft.
export default function PostForm({ draft, onChange }) {
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState('');
  const { title, caption, tags, location } = draft;
  const set = (change) => onChange({ ...draft, ...change });

  const captionTags = useMemo(() => {
    const found = [];
    const re = /#([A-Za-z0-9_]{1,30})/g;
    let m;
    while ((m = re.exec(caption || '')) && found.length < TAGS_MAX) {
      const t = m[1].toLowerCase();
      if (!found.includes(t)) found.push(t);
    }
    return found;
  }, [caption]);
  const autoTags = captionTags.filter((t) => !tags.includes(t)).slice(0, Math.max(0, TAGS_MAX - tags.length));

  const addTag = () => {
    const t = tagDraft.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '_');
    setTagDraft('');
    if (!t || tags.includes(t)) return;
    if (tags.length >= TAGS_MAX) {
      setTagError(`At most ${TAGS_MAX} tags.`);
      return;
    }
    if (!/^[a-z0-9_]{1,30}$/.test(t)) {
      setTagError('Tags use 1–30 lowercase letters, numbers, or _.');
      return;
    }
    setTagError('');
    set({ tags: [...tags, t] });
  };

  return (
    <div className="sx-media-form">
      <div className="sx-studio-field">
        <div className="sx-studio-label-row">
          <label className="sx-studio-label" htmlFor="post-title">TITLE</label>
          <span className="sx-studio-label-value">{title.length}/{TITLE_MAX}</span>
        </div>
        <input id="post-title" className="sx-input" value={title} maxLength={TITLE_MAX} onChange={(e) => set({ title: e.target.value })} placeholder="Give your post a title…" />
      </div>
      <div className="sx-studio-field">
        <div className="sx-studio-label-row">
          <label className="sx-studio-label" htmlFor="post-caption">CAPTION</label>
          <span className="sx-studio-label-value">{caption.length}/{CAPTION_MAX}</span>
        </div>
        <textarea id="post-caption" className="sx-textarea" rows={3} value={caption} maxLength={CAPTION_MAX} onChange={(e) => set({ caption: e.target.value })} placeholder="Say something… #neon #viral" />
      </div>
      <div className="sx-studio-field">
        <div className="sx-studio-label-row">
          <label className="sx-studio-label" htmlFor="post-tag">TAGS</label>
          <span className="sx-studio-label-value">{tags.length + autoTags.length}/{TAGS_MAX}</span>
        </div>
        <div className="sx-studio-tag-input">
          <input
            id="post-tag"
            className="sx-input"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder="Add a tag… (Enter)"
          />
          <Button onClick={addTag}>+ ADD</Button>
        </div>
        {tagError ? <GatedReason>{tagError}</GatedReason> : null}
        {tags.length + autoTags.length ? (
          <div className="sx-tag-row" aria-label="Tags">
            {tags.map((t) => (
              <button type="button" key={t} className="sx-tag-chip" onClick={() => set({ tags: tags.filter((x) => x !== t) })} title="Remove tag">
                #{t} ✕
              </button>
            ))}
            {autoTags.map((t) => (
              <span key={`c-${t}`} className="sx-tag-chip sx-tag-auto" title="Auto-tagged from caption">#{t}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="sx-studio-field">
        <span className="sx-studio-label">LOCATION</span>
        <LocationField value={location} onChange={(next) => set({ location: next })} />
        {location?.display_name ? (
          <Mono><LocationIcon className="sx-location-inline" /> {location.display_name}</Mono>
        ) : location?.city ? (
          <Mono><LocationIcon className="sx-location-inline" /> {location.city}{location.country ? `, ${location.country}` : ''} (CUSTOM)</Mono>
        ) : null}
      </div>
    </div>
  );
}
