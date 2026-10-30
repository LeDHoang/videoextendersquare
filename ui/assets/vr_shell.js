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
    profile: 'profile', pack: 'explore', messages: 'messages', thread: 'messages', share: 'messages',
    wallet: 'wallet', rewards: 'wallet',
  };

  // Sections that need a signed-in viewer; signed out they show the sign-in handoff.
  const NEEDS_USER = { messages: 1, thread: 1, share: 1, wallet: 1 };

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

  // Grid geometry shared with VRShellCanvas (tiles per row, rows on screen;
  // the profile grid is narrower, beside its hero column).
  const GRID_COLS = 4;
  const GRID_ROWS = 2;
  const PROFILE_COLS = 3;
  // List sections (inbox, share sheet) and the thread scroll one row at a time.
  const LIST_ROWS = 6;
  const THREAD_ROWS = 6;
  const PAGE = {
    messages: [1, LIST_ROWS], share: [1, LIST_ROWS], thread: [1, THREAD_ROWS], wallet: [1, LIST_ROWS],
    profile: [PROFILE_COLS, GRID_ROWS],
  };

  function maxScroll(route) {
    const page = PAGE[route.section] || [GRID_COLS, GRID_ROWS];
    return Math.max(0, Math.ceil((route.items || []).length / page[0]) - page[1]);
  }

  // Laser/mouse drag on the main panel: canvas px of drag become whole scroll
  // steps (dragging up scrolls down). Under `threshold` px it stays a click.
  // A release mid-motion keeps scrolling with the last velocity, decaying.
  function createDragScroll(opts) {
    const o = opts || {};
    const step = o.step || 140;
    const threshold = o.threshold || 12;
    const friction = o.friction || 0.004; // velocity lost per ms
    let start = null, last = null, acc = 0, vel = 0, moved = false, flingT = 0;
    function take(d) {
      acc += d;
      const n = acc > 0 ? Math.floor(acc / step) : Math.ceil(acc / step);
      acc -= n * step;
      return n;
    }
    return {
      begin(y, t) { start = y; last = { y, t }; acc = 0; vel = 0; moved = false; },
      active() { return start !== null; },
      moved() { return moved; },
      move(y, t) {
        if (start === null) return 0;
        if (!moved && Math.abs(y - start) < threshold) return 0;
        moved = true;
        const dy = last.y - y;
        vel = 0.7 * vel + 0.3 * (dy / Math.max(1, t - last.t));
        last = { y, t };
        return take(dy);
      },
      // true when the gesture was a drag (the caller skips the click).
      end(t) {
        if (start === null) return moved;
        start = null;
        if (!moved || t - last.t > 100) vel = 0;
        flingT = t;
        return moved;
      },
      tick(t) {
        if (start !== null || !vel) return 0;
        const dt = Math.max(0, t - flingT);
        flingT = t;
        const n = take(vel * dt);
        vel *= Math.max(0, 1 - friction * dt);
        if (Math.abs(vel) < 0.05) { vel = 0; acc = 0; }
        return n;
      },
      stop() { start = null; vel = 0; acc = 0; moved = false; },
    };
  }

  function enc(s) { return encodeURIComponent(s); }
  function conversations(r) { return Array.isArray(r.conversations) ? r.conversations : []; }
  // 8-64 chars, as the messaging API requires; it dedupes retries of one send.
  function clientId() {
    return 'vr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
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
      // Profile: the author's reels in player shape, the user card for the hero
      // column, and their packs for the highlights strip.
      case 'profile': return {
        path: '/api/reels', query: { author: route.arg, sort: 'newest' },
        detail: '/api/users/' + enc(route.arg),
        highlights: '/api/users/' + enc(route.arg) + '/packs',
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
      // Inbox: one conversation per row; route.box picks inbox or requests.
      case 'messages': return {
        path: '/api/messages/conversations', query: { box: route.box || 'inbox' },
        items: conversations,
      };
      // Thread: oldest first. mine = not sent by the other participant.
      case 'thread': return {
        path: '/api/messages/conversations/' + enc(route.arg) + '/messages', query: {},
        items: (r) => {
          const other = (r.conversation && r.conversation.participant) || {};
          return (Array.isArray(r.messages) ? r.messages : []).map((m) => Object.assign({ mine: m.sender_id !== other.id }, m));
        },
        detailOf: (r) => r.conversation || null,
        label: (r) => {
          const p = r.conversation && r.conversation.participant;
          return p && p.username ? '@' + p.username : '';
        },
      };
      // Share sheet: inbox conversations that can take a message.
      case 'share': return {
        path: '/api/messages/conversations', query: { box: 'inbox' },
        items: (r) => conversations(r).filter((c) => c && c.can_message && c.participant),
        label: () => route.share.title || '',
      };
      // Wallet: newest ledger entries first; the balance card rides along as the detail.
      case 'wallet': return {
        path: '/api/billing/transactions', query: { limit: 50 },
        detail: '/api/billing/wallet',
        items: (r) => (Array.isArray(r.transactions) ? r.transactions : []),
        detailOf: (r, det) => det || null,
      };
      default: return null;
    }
  }

  // deps (all optional): exitAndNavigate(path), getUser(), request(path, query) → Promise<json>,
  // send(method, path, body?) → Promise<json>, playFeed({ videoData, startIndex, label }).
  function create(deps) {
    const d = deps || {};
    let stack = [];
    let handoff = null;
    // The focused text field: 'search' or 'compose' (the open thread). focused shows the keyboard;
    // layout is the keyboard page (alpha | symbols | emoji); shift capitalises the next letter.
    let field = { id: 'search', text: '', focused: false, layout: 'alpha', shift: false };
    let unread = { total: 0, inbox: 0, requests: 0 };
    // Last reel-reward claim reply: { progress, remaining, capped } for the wallet's progress line.
    let rewards = null;
    let version = 0;
    // Version of the last change beyond the focused field's text, layout or
    // shift: the main and nav panels repaint on this, not on every keystroke.
    let contentVersion = 0;
    const listeners = [];

    function dirty(fieldOnly) {
      version += 1;
      if (!fieldOnly) contentVersion = version;
      listeners.forEach((fn) => { try { fn(version); } catch (e) {} });
    }

    function top() { return stack.length ? stack[stack.length - 1] : null; }
    function user() { return d.getUser ? d.getUser() : null; }
    function onStack(route) { return stack.indexOf(route) >= 0; }

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
      return push(route);
    }

    function push(route) {
      if (NEEDS_USER[route.section] && !user()) {
        showHandoff('/login', 'SIGN IN ON 2D', route.section === 'wallet'
          ? 'Sign in on the 2D site to see your credits.' : 'Sign in on the 2D site to use messages.');
        return route;
      }
      handoff = null;
      field.focused = false;
      const cur = top();
      if (!cur || cur.path !== route.path) { stack.push(route); load(route); }
      dirty();
      return route;
    }

    // Share sheet for a reel or pack: { kind: 'reel'|'pack', target_id, title }.
    function share(opts) {
      const o = opts || {};
      if ((o.kind !== 'reel' && o.kind !== 'pack') || !o.target_id) return null;
      const share = { kind: o.kind, target_id: String(o.target_id), title: String(o.title || '') };
      return push({ path: 'share:' + o.kind + ':' + share.target_id, section: 'share', arg: '', share, sent: {} });
    }

    // Nav badge and inbox tab counts.
    function refreshUnread() {
      if (!d.request || !user()) return;
      Promise.resolve().then(() => d.request('/api/messages/unread-count', {})).then((r) => {
        const next = { total: (r && r.unread_count) | 0, inbox: (r && r.inbox) | 0, requests: (r && r.requests) | 0 };
        if (next.total === unread.total && next.inbox === unread.inbox && next.requests === unread.requests) return;
        unread = next;
        dirty();
      }, () => {});
    }

    // Reel-reward claim reply from the player. An awarded credit reloads an open wallet.
    function noteReward(result) {
      if (!result) return;
      rewards = { progress: result.progress | 0, remaining: result.remaining | 0, capped: !!result.daily_cap_reached };
      const route = top();
      if (result.credit_awarded && route && route.section === 'wallet') load(route);
      dirty();
    }

    // Fills route.items/related/status; a reply for a route no longer on the stack is dropped.
    function load(route) {
      const src = sourceFor(route);
      if (!src) return;
      route.items = [];
      route.related = [];
      route.scroll = 0;
      route.detail = null;
      route.highlights = [];
      route.label = src.label ? src.label({}) : '';
      if (!d.request) { route.status = 'error'; return; }
      route.status = 'loading';
      Promise.resolve().then(() => Promise.all([
        d.request(src.path, src.query),
        src.detail ? d.request(src.detail, {}) : null,
        // Highlights are extra: a failed fetch leaves the strip empty, not the page.
        src.highlights ? Promise.resolve().then(() => d.request(src.highlights, {})).catch(() => null) : null,
      ])).then(([res, det, hl]) => {
        if (stack.indexOf(route) < 0) return;
        const r = res || {};
        route.items = src.items ? src.items(r) : (Array.isArray(r.videos) ? r.videos : []);
        route.detail = src.detailOf ? src.detailOf(r, det) : null;
        route.highlights = ((hl && hl.items) || []).filter((p) => p.status === 'published');
        route.related = src.related ? src.related(r) : [];
        if (src.label) route.label = src.label(r);
        route.status = 'ready';
        if (route.section === 'thread') {
          // Newest at the bottom; opening the thread marks it read.
          route.scroll = maxScroll(route);
          if (d.send && route.items.length) {
            Promise.resolve().then(() => d.send('POST', src.path.replace(/messages$/, 'read'), {}))
              .then(refreshUnread, () => {});
          }
        } else if (route.section === 'messages') {
          refreshUnread();
        }
        dirty();
      }, () => {
        if (stack.indexOf(route) < 0) return;
        route.status = 'error';
        dirty();
      });
    }

    // delta in rows; clamped so the last row stays on screen.
    function scroll(delta) {
      const route = top();
      if (handoff || !route || !route.items) return false;
      const next = Math.max(0, Math.min(maxScroll(route), (route.scroll || 0) + (delta | 0)));
      if (next === route.scroll) return false;
      route.scroll = next;
      dirty();
      return true;
    }

    // id: 'search' (default) or 'compose'. Compose keeps an unsent draft on the thread route.
    function focusField(focused, id) {
      const route = top();
      if (focused && !field.focused) {
        field.id = id === 'compose' ? 'compose' : 'search';
        field.layout = 'alpha';
        field.shift = false;
        if (field.id === 'compose') field.text = (route && route.draft) || '';
        else field.text = route && route.section === 'search' ? route.arg : '';
      }
      if (!focused && field.focused && field.id === 'compose' && route && route.section === 'thread') {
        route.draft = field.text;
      }
      field.focused = !!focused;
      dirty();
    }

    const LAYOUT_KEYS = { 'layout:alpha': 'alpha', 'layout:symbols': 'symbols', 'layout:emoji': 'emoji' };
    const FIELD_MAX = { search: 80, compose: 500 };

    // key: one character (or emoji), 'backspace' | 'space' | 'enter' | 'close' | 'shift', or 'layout:<name>'.
    function type(key) {
      if (!field.focused) return false;
      if (key === 'close') { focusField(false); return true; }
      if (LAYOUT_KEYS[key]) { field.layout = LAYOUT_KEYS[key]; dirty(true); return true; }
      if (key === 'shift') { field.shift = !field.shift; dirty(true); return true; }
      if (key === 'enter') {
        const q = field.text.trim();
        if (field.id === 'compose') {
          // Chat stays open for the next message.
          if (q && sendText(q)) field.text = '';
          dirty();
          return true;
        }
        field.focused = false;
        if (q) open('/explore?q=' + enc(q)); else dirty();
        return true;
      }
      let add = '';
      if (key === 'backspace') field.text = Array.from(field.text).slice(0, -1).join('');
      else if (key === 'space') add = ' ';
      else if (typeof key === 'string' && Array.from(key).length === 1) add = field.shift ? key.toUpperCase() : key;
      else return false;
      if (add) {
        if (Array.from(field.text).length >= FIELD_MAX[field.id]) return true;
        field.text += add;
        if (key !== 'space') field.shift = false;
      }
      dirty(true);
      return true;
    }

    function openThread() {
      const route = top();
      return route && route.section === 'thread' && route.status === 'ready' ? route : null;
    }

    // Optimistic bubble; the server reply replaces it, a failure marks it.
    function sendText(text) {
      const route = openThread();
      const det = route && route.detail;
      if (!det || !det.can_message || !d.send) return false;
      const id = clientId();
      const msg = { id: 'local-' + id, kind: 'text', text, mine: true, pending: true };
      route.items = route.items.concat([msg]);
      route.scroll = maxScroll(route);
      dirty();
      Promise.resolve().then(() => d.send('POST', '/api/messages/conversations/' + enc(det.id) + '/messages',
        { kind: 'text', text, client_id: id })).then((res) => {
        const i = route.items.indexOf(msg);
        if (i >= 0 && res && res.message) route.items.splice(i, 1, Object.assign({ mine: true }, res.message));
        else msg.pending = false;
      }, () => {
        msg.pending = false;
        msg.failed = true;
      }).then(() => { if (onStack(route)) dirty(); });
      return true;
    }

    // Accept or decline an incoming request. Decline leaves the thread.
    function decide(kind) {
      const route = openThread();
      const det = route && route.detail;
      if (!det || !d.send || (route.pending && route.pending.decide)) return false;
      if (!(kind === 'accept' ? det.can_accept : det.can_decline)) return false;
      route.pending = Object.assign({}, route.pending, { decide: true });
      dirty();
      Promise.resolve().then(() => d.send('POST', '/api/messages/conversations/' + enc(det.id) + '/' + kind, {}))
        .then(() => {
          route.pending.decide = false;
          refreshUnread();
          if (!onStack(route)) return;
          if (kind === 'decline' && top() === route) back();
          else { load(route); dirty(); }
        }, () => {
          route.pending.decide = false;
          if (onStack(route)) dirty();
        });
      return true;
    }

    // Box tab on the inbox: 'inbox' | 'requests'.
    function setBox(box) {
      const route = top();
      if (!route || route.section !== 'messages' || (route.box || 'inbox') === box) return false;
      route.box = box === 'requests' ? 'requests' : 'inbox';
      load(route);
      dirty();
      return true;
    }

    // Sends the shared reel/pack to one conversation of the share sheet.
    function shareTo(index) {
      const route = top();
      const conv = route && route.section === 'share' && route.items && route.items[index];
      const was = conv && route.sent[conv.id];
      if (!conv || !d.send || (was && was !== 'failed')) return false;
      route.sent = Object.assign({}, route.sent, { [conv.id]: 'sending' });
      dirty();
      const s = route.share;
      Promise.resolve().then(() => d.send('POST', '/api/messages/share-content', {
        kind: s.kind, target_id: s.target_id, usernames: [conv.participant.username], note: '', client_id: clientId(),
      })).then((res) => (res && res.succeeded ? 'sent' : 'failed'), () => 'failed').then((result) => {
        route.sent = Object.assign({}, route.sent, { [conv.id]: result });
        if (onStack(route)) dirty();
      });
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
      focusField(false);
      if (handoff) { handoff = null; if (!stack.length) close(); else dirty(); return; }
      stack.pop();
      if (!stack.length) { close(); return; }
      // The inbox may be stale after reading, replying or deciding in a thread.
      if (top().section === 'messages') load(top());
      dirty();
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
        case 'compose-focus': {
          const route = openThread();
          if (!route || !route.detail || !route.detail.can_message) return false;
          focusField(true, 'compose');
          return true;
        }
        case 'compose-send': {
          const route = openThread();
          const text = (field.focused && field.id === 'compose' ? field.text : (route && route.draft) || '').trim();
          if (!text || !sendText(text)) return false;
          if (field.focused && field.id === 'compose') field.text = '';
          route.draft = '';
          dirty();
          return true;
        }
        case 'quick-reply':
          return sendText(String(hit.arg || ''));
        case 'accept':
        case 'decline':
          return decide(hit.action);
        case 'box':
          setBox(hit.arg);
          return true;
        case 'share-to':
          return shareTo(hit.arg | 0);
        case 'buy':
          showHandoff('/wallet', 'BUY ON 2D', 'Buying credits needs the 2D site. Exit VR to continue.');
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
        field: {
          id: field.id, text: field.text, focused: field.focused && !handoff && !!route,
          layout: field.layout, shift: field.shift,
        },
        unread: unread.total,
        unreadBox: { inbox: unread.inbox, requests: unread.requests },
        rewards,
        version,
        contentVersion,
      };
    }

    return {
      open,
      back,
      close,
      showHandoff,
      share,
      refreshUnread,
      noteReward,
      handleHit,
      scroll,
      type,
      focusField,
      // Redraw without a state change (e.g. a thumbnail finished loading).
      touch() { dirty(); },
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

  return { parseRoute, create, createDragScroll, HANDOFF, GRID_COLS, GRID_ROWS, PROFILE_COLS, LIST_ROWS, THREAD_ROWS };
});
