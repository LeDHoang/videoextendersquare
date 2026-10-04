// Tokenizes user-written text (profile bios) into plain / hashtag / mention /
// link parts so the UI can style them. Pure and DOM-free so it is unit-tested.
//
// - #tag      -> links to /explore/tag/<slug>   (slug mirrors server tag_slug)
// - @name     -> links to /profile/<name>        (3-30 of a-z 0-9 _)
// - links     -> http(s)://…, www.…, or domain.tld/path; only http(s) hrefs
//               are ever produced, so javascript:/data: text stays plain.
//               Bare domains (test.com, linktr.ee/me) only match a known TLD
//               so file names and words like "Node.js" or "e.g." stay text.

const TLDS = [
  'com', 'net', 'org', 'io', 'co', 'dev', 'app', 'ai', 'me', 'tv', 'gg', 'xyz', 'info', 'biz',
  'us', 'uk', 'de', 'fr', 'jp', 'vn', 'ly', 'ee', 'link', 'gl', 'be', 'it', 'nl', 'ru', 'cn',
  'in', 'au', 'ca', 'br', 'es', 'kr', 'sg', 'ch', 'se', 'no', 'pl', 'to', 'sh', 'cc', 'fm',
  'so', 'is', 'id', 'site', 'online', 'store', 'shop', 'tech', 'art', 'studio', 'live', 'cloud',
].join('|');

const TOKEN = new RegExp(
  [
    '(?<url>https?:\\/\\/[^\\s<]+|www\\.[^\\s<]+'
      + '|(?:[a-z0-9-]+\\.)+(?:' + TLDS + ')(?![\\p{L}\\p{N}_-])(?::\\d+)?(?:[/?#][^\\s<]*)?)',
    '(?<tag>#[\\p{L}\\p{N}_-]*[\\p{L}\\p{N}_])',
    '(?<mention>@[A-Za-z0-9_]{3,30})(?![A-Za-z0-9_])',
  ].join('|'),
  'giu',
);

const TRAILING = /[.,;:!?)\]}'"»”’]+$/;

export function tagSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}]+|_+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function startsAtBoundary(text, index) {
  if (index === 0) return true;
  return !/[\p{L}\p{N}_@#/.&-]/u.test(text[index - 1]);
}

export function tokenizeRichText(input) {
  const text = String(input ?? '');
  const parts = [];
  let cursor = 0;
  const pushPlain = (end) => {
    if (end > cursor) parts.push({ type: 'text', text: text.slice(cursor, end) });
  };

  for (const match of text.matchAll(TOKEN)) {
    let raw = match[0];
    const index = match.index;
    if (index < cursor || !startsAtBoundary(text, index)) continue;
    const { url, tag, mention } = match.groups;

    if (url) {
      raw = raw.replace(TRAILING, '');
      if (!raw || !/[.]/.test(raw)) continue;
      const href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
      try {
        const parsed = new URL(href);
        if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('.')) continue;
      } catch {
        continue;
      }
      pushPlain(index);
      parts.push({ type: 'link', text: raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, ''), href });
    } else if (tag) {
      const slug = tagSlug(raw);
      if (!slug) continue;
      pushPlain(index);
      parts.push({ type: 'tag', text: raw.slice(1), to: '/explore/tag/' + encodeURIComponent(slug) });
    } else if (mention) {
      pushPlain(index);
      parts.push({ type: 'mention', text: raw.slice(1), to: '/profile/' + encodeURIComponent(raw.slice(1).toLowerCase()) });
    } else {
      continue;
    }
    cursor = index + raw.length;
  }
  pushPlain(text.length);
  return parts;
}
