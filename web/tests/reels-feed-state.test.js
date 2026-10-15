import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../ui/assets/reels_feed_state.js', import.meta.url), 'utf8');

function loadFeedState() {
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'reels_feed_state.js' });
  return window.ReelsFeedState;
}

test('location parameters select recent trending city reels without stale filters', () => {
  const state = loadFeedState();
  const params = state.locationParams({
    codec: 'h264',
    tunnel: 'https://example.test',
    media: 'video',
    folder: 'old-folder',
    tag: 'old-tag',
    post: 'old-post',
    limit: 8,
  }, { slug: 'tokyo-japan' });

  assert.deepEqual({ ...params }, {
    surface: 'for_you',
    codec: 'h264',
    tunnel: 'https://example.test',
    media: 'video',
    sort: 'recent_trending',
    window_days: 7,
    location: 'tokyo-japan',
    limit: 8,
  });
});

test('replacement keeps recommendation attribution and pagination state', () => {
  const state = loadFeedState();
  const item = {
    post_id: 'post-1',
    recommendation: { impression_id: 'imp-1', position: 0, reason_key: 'recent_location' },
  };
  const next = state.fromPage({
    items: [item],
    next_cursor: 'cursor-2',
    has_more: true,
    feed_params: { location: 'tokyo-japan', sort: 'recent_trending' },
  }, { codec: 'h264' }, { slug: 'tokyo-japan', name: 'Tokyo, Japan' });

  assert.equal(next.videoData[0].recommendation.impression_id, 'imp-1');
  assert.equal(next.feedCursor, 'cursor-2');
  assert.equal(next.feedHasMore, true);
  assert.equal(next.activeLocationFeed.name, 'Tokyo, Japan');
});

test('original feed snapshot restores index, cursor, params, and playback state', () => {
  const state = loadFeedState();
  const items = [{ post_id: 'one' }, { post_id: 'two' }];
  const snapshot = state.capture({
    videoData: items,
    idx: 1,
    feedParams: { sort: 'for_you', codec: 'h264' },
    feedCursor: 'cursor-original',
    feedHasMore: true,
    isAutoNext: false,
    isMuted: false,
    currentTime: 42.5,
    wasPlaying: true,
  });
  items.push({ post_id: 'three' });
  const restored = state.restore(snapshot);

  assert.equal(restored.videoData.length, 2);
  assert.equal(restored.idx, 1);
  assert.equal(restored.feedCursor, 'cursor-original');
  assert.equal(restored.feedHasMore, true);
  assert.equal(restored.currentTime, 42.5);
  assert.equal(restored.wasPlaying, true);
  assert.deepEqual({ ...restored.feedParams }, { sort: 'for_you', codec: 'h264' });
});

test('generation tokens reject stale feed responses after cancellation', () => {
  const state = loadFeedState();
  const first = state.nextGeneration(0);
  const afterCancel = state.nextGeneration(first);
  assert.equal(state.isCurrent(first, afterCancel), false);
  assert.equal(state.isCurrent(afterCancel, afterCancel), true);
});
