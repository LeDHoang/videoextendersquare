import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const PackState = require('../../ui/assets/reels_pack_state.js');

function item(id, available = true) {
  return { pack_item_id: id, available, media_type: available ? 'video' : 'static' };
}

test('feed payloads retain the existing playing contract', () => {
  const state = PackState.initialState({ surface: 'feed', items: [item('one')] }, 8);
  assert.equal(state.mode, 'feed');
  assert.equal(state.phase, 'playing');
  assert.equal(state.index, 0);
});

test('pack resume follows the stable pack item id after a reorder', () => {
  const state = PackState.initialState({
    surface: 'pack',
    pack: { id: 'pack-1', revision: 4 },
    items: [item('third'), item('first'), item('second')],
    resume: { phase: 'playing', current_item_id: 'second', position_ms: 3210 },
  }, 0);

  assert.equal(state.mode, 'pack');
  assert.equal(state.index, 2);
  assert.equal(state.resumePositionMs, 3210);
  assert.equal(state.revision, 4);
});

test('pack navigation skips unavailable items and completes without feed continuation', () => {
  let state = PackState.initialState({
    surface: 'pack',
    pack: { id: 'pack-1' },
    items: [item('one'), item('gone', false), item('three')],
    restart: true,
  }, 0);

  state = PackState.transition(state, { type: 'START' });
  assert.equal(state.phase, 'playing');
  assert.equal(state.index, 0);

  state = PackState.transition(state, { type: 'NEXT' });
  assert.equal(state.index, 2);

  state = PackState.transition(state, { type: 'NEXT' });
  assert.equal(state.phase, 'complete');
  assert.equal(state.index, 2);
});

test('selection rejects unavailable members and replay finds the first playable member', () => {
  const base = PackState.initialState({
    surface: 'pack',
    pack: { id: 'pack-1' },
    items: [item('gone', false), item('two'), item('three')],
    resume: { phase: 'complete', current_item_id: 'three', position_ms: 0 },
  }, 0);

  assert.equal(PackState.transition(base, { type: 'SELECT', index: 0 }), base);
  const replay = PackState.transition(base, { type: 'REPLAY' });
  assert.equal(replay.phase, 'playing');
  assert.equal(replay.index, 1);
});

test('progress persists stable item identity, media time, and phase', () => {
  const state = PackState.initialState({
    surface: 'pack',
    pack: { id: 'pack-1' },
    items: [item('one')],
    resume: { phase: 'playing', current_item_id: 'one', position_ms: 0 },
  }, 0);
  assert.deepEqual(PackState.progressPayload(state, 12.345), {
    current_item_id: 'one',
    position_ms: 12345,
    phase: 'playing',
  });
});

test('resume onto a now-unavailable item resets media position', () => {
  const state = PackState.initialState({
    surface: 'pack',
    pack: { id: 'pack-1' },
    items: [item('gone', false), item('two')],
    resume: { phase: 'playing', current_item_id: 'gone', position_ms: 9999 },
  }, 0);
  assert.equal(state.index, 1);
  assert.equal(state.resumePositionMs, 0);
});

test('START while already playing preserves position', () => {
  let state = PackState.initialState({
    surface: 'pack',
    pack: { id: 'pack-1' },
    items: [item('one'), item('two')],
    restart: true,
  }, 0);
  state = PackState.transition(state, { type: 'START' });
  const before = state;
  assert.equal(PackState.transition(state, { type: 'START' }), before);
});
