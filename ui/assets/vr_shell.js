/**
 * ECHO VR Shell — router and state for browsing the site inside one XR
 * session. Pure logic (no THREE, no canvas): webxr_vr.js renders
 * getRenderState() with VRShellCanvas and feeds hits back via handleHit().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VRShell = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // Routes that need the 2D site (forms, uploads, payments, auth). Matched on the pathname.
  const HANDOFF = [
    /^\/(login|signup|verify-email|forgot-password|reset-password)$/,
    /^\/(upload|image|video|compare)$/,
    /^\/settings(\/|$)/,
    /^\/packs\/new$/,
    /^\/packs\/[^/]+\/edit$/,
    /^\/(support|moderation|terms|privacy|rules)$/,
  ];

  // Nav tab each section highlights.
  const SECTION_TAB = {
    explore: 'explore', search: 'explore', tag: 'explore', location: 'explore',
    profile: 'profile', pack: 'explore', messages: 'messages', thread: 'messages',
    wallet: 'wallet', rewards: 'wallet',
  };

  function decode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // path → { path, section, arg }. section 'reels' means "close the shell";
  // 'handoff' means the route is only usable on the 2D site.
  function parseRoute(path) {
    const raw = String(path || '');
    const qi = raw.indexOf('?');
    const pathname = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/\/+$/, '') || '/';
    const query = qi >= 0 ? raw.slice(qi + 1) : '';
    const out = (section, arg) => ({ path: raw, section, arg: arg || '' });
    if (!raw.startsWith('/') || raw.startsWith('//')) return out('handoff');
    if (HANDOFF.some((re) => re.test(pathname))) return out('handoff');
    if (pathname === '/' || pathname === '/reels') return out('reels');
    let m;
    if (pathname === '/explore') {
      const q = /(?:^|&)q=([^&]*)/.exec(query);
      return q && q[1] ? out('search', decode(q[1].replace(/\+/g, ' '))) : out('explore');
    }
    if ((m = /^\/explore\/tag\/([^/]+)$/.exec(pathname))) return out('tag', decode(m[1]));
    if ((m = /^\/explore\/location\/([^/]+)$/.exec(pathname))) return out('location', decode(m[1]));
    if ((m = /^\/profile\/([^/]+)$/.exec(pathname))) return out('profile', decode(m[1]));
    if ((m = /^\/packs\/([^/]+)$/.exec(pathname))) return out('pack', decode(m[1]));
    if (pathname === '/messages') return out('messages');
    if ((m = /^\/messages\/([^/]+)$/.exec(pathname))) return out('thread', decode(m[1]));
    if (pathname === '/wallet') return out('wallet');
    return out('handoff');
  }

  // Grid geometry shared with VRShellCanvas (cards per row, rows on screen).
  const GRID_COLS = 5;
  const GRID_ROWS = 2;

  function enc(s) { return encodeURIComponent(s); }
  function chips(rows, base) {
    return (Array.isArray(rows) ? rows : []).filter((r) => r && r.slug)
      .map((r) => ({ label: String(r.name || r.slug), path: base + enc(r.slug) }));
  }

  // Data source for each grid section: request path + query, and how to read the reply.
  function sourceFor(route) {
    switch (route.section) {
      case 'explore': return { path: '/api/reels', query: { sort: 'shuffle' } };
      case 'search': return { path: '/api/reels', query: { search: route.arg, sort: 'shuffle' } };
      case 'tag': return {
        path: '/api/reels/tags/' + enc(route.arg), query: {},
        related: (r) => chips(r.related_tags, '/explore/tag/'),
        label: () => '#' + route.arg,
      };
      case 'location': return {
        path: '/api/reels/locations/' + enc(route.arg), query: {},
        related: (r) => chips(r.related_locations, '/explore/location/'),
        label: (r) => (r.location && r.location.name) || route.arg,
      };
      // Profile: the author's reels in player shape, plus the user card for the header.
      case 'profile': return {
        path: '/api/reels', query: { author: route.arg, sort: 'newest' },
        detail: '/api/users/' + enc(route.arg),
        detailOf: (r, det) => (det && det.user) || null,
        label: () => '@' + route.arg,
      };
      // Pack: the detail reply carries the items; unavailable members are skipped.
      case 'pack': return {
        path: '/api/packs/' + enc(route.arg), query: {},
        items: (r) => ((r.pack && r.pack.items) || []).filter((i) => i && i.available && i.post).map((i) => i.post),
        detailOf: (r) => r.pack || null,
        related: (r) => {
          const c = r.pack && r.pack.creator;
          return c && c.username ? [{ label: '@' + c.username, path: '/profile/' + enc(c.username) }] : [];
        },
        label: (r) => (r.pack && r.pack.title) || '',
      };
      default: return null;
    }
  }

  // deps (all optional): exitAndNavigate(path), getUser(), request(path, query) → Promise<json>,
  // send(method, path) → Promise<json>, playFeed({ videoData, startIndex, label }).
  function create(deps) {
    const d = deps || {};
    let stack = [];
    let handoff = null;
    // The one text field (search). focused shows the keyboard.
    let field = { id: 'search', text: '', focused: false };
    let version = 0;
    const listeners = [];

    function dirty() {
      version += 1;
      listeners.forEach((fn) => { try { fn(version); } catch (e) {} });
    }

    function top() { return stack.length ? stack[stack.length - 1] : null; }

    function close() {
      stack = [];
      handoff = null;
      field.focused = false;
      dirty();
    }

    function showHandoff(path, title, message) {
      handoff = {
        path,
        title: title || 'FINISH ON 2D',
        message: message || 'This page needs the 2D site. Exit VR to continue.',
      };
      dirty();
    }

    function open(path, opts) {
      const route = parseRoute(path);
      if (route.section === 'reels') { close(); return route; }
      if (route.section === 'handoff') {
        const o = opts || {};
        showHandoff(route.path, o.title, o.message);
        return route;
      }
      handoff = null;
      field.focused = false;
      const cur = top();
      if (!cur || cur.path !== route.path) { stack.push(route); load(route); }
      dirty();
      return route;
    }

    // Fills route.items/related/status; a reply for a route no longer on the stack is dropped.
    function load(route) {
      const src = sourceFor(route);
      if (!src) return;
      route.items = [];
      route.related = [];
      route.scroll = 0;
      route.detail = null;
      route.label = src.label ? src.label({}) : '';
      if (!d.request) { route.status = 'error'; return; }
      route.status = 'loading';
      Promise.resolve().then(() => Promise.all([
        d.request(src.path, src.query),
        src.detail ? d.request(src.detail, {}) : null,
      ])).then(([res, det]) => {
        if (stack.indexOf(route) < 0) return;
        const r = res || {};
        route.items = src.items ? src.items(r) : (Array.isArray(r.videos) ? r.videos : []);
        route.detail = src.detailOf ? src.detailOf(r, det) : null;
        route.related = src.related ? src.related(r) : [];
        if (src.label) route.label = src.label(r);
        route.status = 'ready';
        dirty();
      }, () => {
        if (stack.indexOf(route) < 0) return;
        route.status = 'error';
        dirty();
      });
    }

    // delta in grid rows; clamped so the last row stays on screen.
    function scroll(delta) {
      const route = top();
      if (handoff || !route || !route.items) return false;
      const max = Math.max(0, Math.ceil(route.items.length / GRID_COLS) - GRID_ROWS);
      const next = Math.max(0, Math.min(max, (route.scroll || 0) + (delta | 0)));
      if (next === route.scroll) return false;
      route.scroll = next;
      dirty();
      return true;
    }

    function focusField(focused) {
      if (focused && !field.focused) {
        const route = top();
        field.text = route && route.section === 'search' ? route.arg : '';
      }
      field.focused = !!focused;
      dirty();
    }

    // key: a character, or 'backspace' | 'space' | 'enter' | 'close'.
    function type(key) {
      if (!field.focused) return false;
      if (key === 'close') { focusField(false); return true; }
      if (key === 'enter') {
        const q = field.text.trim();
        field.focused = false;
        if (q) open('/explore?q=' + enc(q)); else dirty();
        return true;
      }
      if (key === 'backspace') field.text = field.text.slice(0, -1);
      else if (key === 'space') field.text += ' ';
      else if (typeof key === 'string' && key.length === 1) field.text = (field.text + key).slice(0, 80);
      else return false;
      dirty();
      return true;
    }

    function play(index) {
      const route = top();
      const items = route && route.items;
      if (!items || !items[index]) return false;
      if (d.playFeed) d.playFeed({ videoData: items.slice(), startIndex: index, label: route.label || '' });
      close();
      return true;
    }

    // Optimistic toggles on route.detail: flag field, count field, endpoint.
    const TOGGLES = {
      follow: { section: 'profile', flag: 'is_following', count: 'follower_count',
        path: (det) => '/api/users/' + enc(det.username) + '/follow', reply: 'follower_count' },
      'pack-like': { section: 'pack', flag: 'liked_by_me', count: 'likes',
        path: (det) => '/api/packs/' + enc(det.id) + '/like', reply: 'likes' },
      'pack-save': { section: 'pack', flag: 'saved_by_me', count: 'saves',
        path: (det) => '/api/packs/' + enc(det.id) + '/save', reply: 'saves' },
    };

    // Flips the flag and count now; the reply settles the count, a failure rolls back.
    function toggle(kind) {
      const t = TOGGLES[kind];
      const route = top();
      const det = route && route.section === t.section && route.detail;
      if (!det || det.is_me || (route.pending && route.pending[kind])) return false;
      const u = d.getUser ? d.getUser() : null;
      if (!u || !d.send) { showHandoff('/login', 'SIGN IN ON 2D', 'Sign in on the 2D site to follow, like and save.'); return true; }
      const was = !!det[t.flag];
      const count = det[t.count] | 0;
      det[t.flag] = !was;
      det[t.count] = Math.max(0, count + (was ? -1 : 1));
      route.pending = Object.assign({}, route.pending, { [kind]: true });
      dirty();
      Promise.resolve().then(() => d.send(was ? 'DELETE' : 'PUT', t.path(det))).then((res) => {
        if (res && typeof res[t.reply] === 'number') det[t.count] = res[t.reply];
      }, () => {
        det[t.flag] = was;
        det[t.count] = count;
      }).then(() => {
        route.pending[kind] = false;
        if (stack.indexOf(route) >= 0) dirty();
      });
      return true;
    }

    function back() {
      field.focused = false;
      if (handoff) { handoff = null; if (!stack.length) close(); else dirty(); return; }
      stack.pop();
      if (!stack.length) close(); else dirty();
    }

    function profilePath() {
      const u = d.getUser ? d.getUser() : null;
      return u && u.username ? '/profile/' + encodeURIComponent(u.username) : '/login';
    }

    const NAV_PATHS = { explore: '/explore', messages: '/messages', wallet: '/wallet' };

    // hit: { action, arg } from VRShellCanvas resolvers. Returns true when consumed.
    function handleHit(hit) {
      if (!hit) return false;
      switch (hit.action) {
        case 'nav':
          if (hit.arg === 'back') { if (isOpen()) back(); return true; }
          if (hit.arg === 'reels') { close(); return true; }
          if (hit.arg === 'profile') { open(profilePath()); return true; }
          if (NAV_PATHS[hit.arg]) { open(NAV_PATHS[hit.arg]); return true; }
          return false;
        case 'close':
          close();
          return true;
        case 'play':
          return play(hit.arg | 0);
        case 'follow':
        case 'pack-like':
        case 'pack-save':
          return toggle(hit.action);
        case 'chip':
          open(hit.arg);
          return true;
        case 'scroll':
          scroll(hit.arg);
          return true;
        case 'search-focus':
          focusField(true);
          return true;
        case 'key':
          return type(hit.arg);
        case 'handoff-cancel':
          back();
          return true;
        case 'handoff-confirm': {
          // exitAndNavigate runs before the dirty notification so the host
          // can tell a handoff apart from a plain close.
          const path = handoff && handoff.path;
          if (path && d.exitAndNavigate) d.exitAndNavigate(path);
          stack = [];
          handoff = null;
          dirty();
          return true;
        }
        default:
          return false;
      }
    }

    function isOpen() { return stack.length > 0 || !!handoff; }

    function getRenderState() {
      const route = top();
      return {
        open: isOpen(),
        route,
        handoff,
        depth: stack.length,
        tab: handoff ? '' : (route && SECTION_TAB[route.section]) || '',
        field: { id: field.id, text: field.text, focused: field.focused && !handoff && !!route },
        version,
      };
    }

    return {
      open,
      back,
      close,
      showHandoff,
      handleHit,
      scroll,
      type,
      focusField,
      // Redraw without a state change (e.g. a thumbnail finished loading).
      touch: dirty,
      isOpen,
      section() { return handoff ? 'handoff' : (top() ? top().section : null); },
      getRenderState,
      get version() { return version; },
      onDirty(fn) {
        listeners.push(fn);
        return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
      },
    };
  }

  return { parseRoute, create, HANDOFF, GRID_COLS, GRID_ROWS };
});
