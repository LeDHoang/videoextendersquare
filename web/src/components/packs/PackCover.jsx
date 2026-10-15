function posterFor(item) {
  const post = item?.post || item;
  if (!post) return '';
  // Video <img> sources must never be raw MP4 URLs. Prefer poster, then
  // transcoded preview image; fall back to url only for image media.
  if (post.media_type === 'image') return post.poster_url || post.preview_url || post.url || '';
  return post.poster_url || post.preview_url || '';
}

export default function PackCover({ pack, className = '', decorative = false }) {
  const seen = new Set();
  const candidates = [];
  for (const item of (pack?.cover_items || [])) {
    const src = posterFor(item);
    if (src && !seen.has(src)) {
      seen.add(src);
      candidates.push(src);
    }
    if (candidates.length >= 4) break;
  }
  if (!candidates.length && pack?.cover_url && !seen.has(pack.cover_url)) candidates.push(pack.cover_url);
  return (
    <span
      className={`sx-pack-cover ${className}`}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : `Cover for Reel Pack ${pack?.title || ''}`}
      aria-hidden={decorative || undefined}
    >
      <span className="sx-pack-cover-stack" aria-hidden="true" />
      <span className={`sx-pack-cover-grid sx-pack-cover-grid--${Math.min(4, candidates.length || 1)}`}>
        {candidates.length ? candidates.map((src, index) => (
          <img key={src + index} src={src} alt="" loading="lazy" draggable="false" />
        )) : <span className="sx-pack-cover-empty">▦</span>}
      </span>
      <span className="sx-pack-cover-label">REEL PACK</span>
    </span>
  );
}
