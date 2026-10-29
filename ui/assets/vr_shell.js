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

  // deps: { exitAndNavigate(path), getUser() } — both optional.
  function create(deps) {
    const d = deps || {};
    let stack = [];
    let handoff = null;
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
      const cur = top();
      if (!cur || cur.path !== route.path) stack.push(route);
      dirty();
      return route;
    }

    function back() {
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
        version,
      };
    }

    return {
      open,
      back,
      close,
      showHandoff,
      handleHit,
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

  return { parseRoute, create, HANDOFF };
});
