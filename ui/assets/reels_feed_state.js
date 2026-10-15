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

  return { capture, locationParams, fromPage, restore, nextGeneration, isCurrent };
})();
