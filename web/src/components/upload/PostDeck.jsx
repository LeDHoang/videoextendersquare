import { useNavigate } from 'react-router-dom';
import { GatedReason, Mono } from '../ui/primitives.jsx';
import { Button } from '../ui/controls.jsx';
import LocationField from '../ui/LocationField.jsx';
import { DeckSection, DeckLabel } from './ExtendDeck.jsx';

export const TITLE_MAX = 100;
export const CAPTION_MAX = 2200;
export const TAGS_MAX = 5;

// Post details (title, caption, tags, location) for the Upload Studio.
export function DetailsSection({ num, title, setTitle, caption, setCaption, tags, setTags, tagDraft, setTagDraft, captionTags, effectiveTags, addTag, location, setLocation, tagError }) {
  return (
    <DeckSection num={num} title="POST DETAILS" badge="TITLE · CAPTION · TAGS · LOCATION" badgeTone="muted">
      <div className="sx-studio-field">
        <DeckLabel htmlFor="studio-title" value={`${title.length}/${TITLE_MAX}`}>TITLE (COVER TITLE · MAX {TITLE_MAX})</DeckLabel>
        <input
          id="studio-title"
          className="sx-input"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Give your reel a title…"
        />
      </div>
      <div className="sx-studio-field">
        <DeckLabel htmlFor="studio-caption" value={`${caption.length}/${CAPTION_MAX}`}>CAPTION (MAX {CAPTION_MAX} · #HASHTAGS AUTO-TAGGED)</DeckLabel>
        <textarea
          id="studio-caption"
          className="sx-textarea"
          rows={3}
          value={caption}
          maxLength={CAPTION_MAX}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Say something about this reel… #neon #viral"
        />
      </div>
      <div className="sx-studio-field">
        <DeckLabel htmlFor="studio-tag">TAGS (MAX {TAGS_MAX})</DeckLabel>
        <div className="sx-studio-tag-input">
          <input
            id="studio-tag"
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
        {effectiveTags.length ? (
          <div className="sx-tag-row" aria-label="Tags">
            {tags.map((t) => (
              <button type="button" key={t} className="sx-tag-chip" onClick={() => setTags(tags.filter((x) => x !== t))} title="Remove tag">
                #{t} ✕
              </button>
            ))}
            {captionTags.filter((t) => !tags.includes(t)).map((t) => (
              <span key={`c-${t}`} className="sx-tag-chip sx-tag-auto" title="Auto-tagged from caption">
                #{t}
              </span>
            ))}
          </div>
        ) : (
          <div className="sx-monospace-sm">No tags yet — type above or add #hashtags in the caption.</div>
        )}
      </div>
      <div className="sx-studio-field">
        <DeckLabel>LOCATION (FREE TEXT · MATCHED TO MAP)</DeckLabel>
        <LocationField value={location} onChange={setLocation} />
        {location?.display_name ? (
          <Mono>📍 {location.display_name}</Mono>
        ) : location?.city ? (
          <Mono>📍 {location.city}{location.country ? `, ${location.country}` : ''} (CUSTOM)</Mono>
        ) : null}
      </div>
    </DeckSection>
  );
}

// Publish step: gated share button, then links to the live post.
export function ShareSection({ num, user, title, path, jobDone, shareDisabled, publishing, onShare, published, onReset, error }) {
  const navigate = useNavigate();
  return (
    <DeckSection num={num} title="SHARE" badge={published ? 'LIVE' : 'EXPLORE + REELS'} badgeTone={published ? 'ok' : 'accent'} className="sx-studio-share">
      {published ? (
        <>
          <div className="sx-accent-block" role="status">
            <div className="sx-accent-block-title">✓ SHARED — LIVE IN EXPLORE + REELS</div>
            <div className="sx-accent-block-body">
              <p>{published.meta?.title}</p>
            </div>
          </div>
          <div className="sx-studio-actions">
            <Button primary onClick={() => navigate(`/reels?folder=uploads&codec=all&sort=newest&play=${encodeURIComponent(published.rel_path)}`)}>
              ▶ PLAY IN REELS
            </Button>
            <Button onClick={() => navigate('/explore')}>EXPLORE GRID</Button>
            <Button onClick={() => navigate('/profile/' + (published.meta?.creator?.username || user.username))}>VIEW ON PROFILE</Button>
            <Button onClick={onReset}>+ NEW UPLOAD</Button>
          </div>
          <Mono>{published.media_url}</Mono>
        </>
      ) : (
        <>
          {!title.trim() ? <GatedReason>TITLE IS REQUIRED BEFORE SHARING</GatedReason> : null}
          {path === 'extend' && !jobDone ? <GatedReason>RENDER THE 1:1 EXTEND FIRST</GatedReason> : null}
          <Button primary className="sx-studio-render" disabled={shareDisabled} loading={publishing} onClick={onShare}>
            SHARE REEL TO UPLOADS
          </Button>
          {error ? (
            <div className="sx-error-box" role="alert">
              <div className="sx-error-title">SHARE FAILED</div>
              <div>{error}</div>
            </div>
          ) : null}
        </>
      )}
    </DeckSection>
  );
}
