window.ReelsFeedState = window.ReelsFeedState || (function () {
  'use strict';

  function capture(state) {
    const source = state || {};
    return {
      videoData: Array.isArray(source.videoData) ? source.videoData.slice() : [],
      idx: Math.max(0, Number(source.idx) || 0),
      feedParams: { ...(source.feedParams || {}) },
      feedCursor: source.feedCursor || null,
      feedHasMore: !!source.feedHasMore,
      isAutoNext: !!source.isAutoNext,
      isMuted: !!source.isMuted,
      currentTime: Math.max(0, Number(source.currentTime) || 0),
      wasPlaying: !!source.wasPlaying,
    };
  }

  function locationParams(current, locationRow) {
    const params = current || {};
    return {
      surface: 'for_you',
      codec: params.codec || 'hevc',
      tunnel: params.tunnel || '',
      media: params.media || '',
      sort: 'recent_trending',
      window_days: 7,
      location: locationRow && locationRow.slug ? String(locationRow.slug) : '',
      limit: params.limit || 12,
    };
  }

  function fromPage(page, params, locationRow) {
    const payload = page || {};
    const items = Array.isArray(payload.items) ? payload.items.slice() : [];
    const cursor = payload.next_cursor || null;
    return {
      videoData: items,
      idx: 0,
      feedParams: { ...(params || {}), ...(payload.feed_params || {}) },
      feedCursor: cursor,
      feedHasMore: !!payload.has_more && !!cursor,
      activeLocationFeed: locationRow && locationRow.slug
        ? { slug: String(locationRow.slug), name: String(locationRow.name || locationRow.slug) }
        : null,
    };
  }

  function restore(snapshot) {
    if (!snapshot) return null;
    return capture(snapshot);
  }

  function nextGeneration(current) {
    return (Number(current) || 0) + 1;
  }

  function isCurrent(expected, current) {
    return Number(expected) === Number(current);
  }

  // Paged /api/reels rows carry comments_count, not comments: the list is fetched once,
  // when the reel is viewed. A failed fetch is not retried; a comment posted meanwhile is kept.
  const commentLoads = new WeakMap();
  function loadComments(item, request) {
    if (!item || item.comments !== undefined || !item.post_id) return null;
    if (!commentLoads.has(item)) {
      commentLoads.set(item, Promise.resolve()
        .then(() => request('/api/posts/' + encodeURIComponent(item.post_id) + '/comments'))
        .then((res) => {
          const fetched = res && Array.isArray(res.comments) ? res.comments : [];
          const ids = new Set(fetched.map((comment) => comment && comment.id));
          item.comments = fetched.concat((item.comments || []).filter((comment) => comment && !ids.has(comment.id)));
          item.comments_count = item.comments.length;
          return item;
        }, () => null));
    }
    return commentLoads.get(item);
  }

  return { capture, locationParams, fromPage, restore, nextGeneration, isCurrent, loadComments };
})();
