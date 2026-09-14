(function (root) {
  'use strict';

  const PHASES = new Set(['intro', 'playing', 'complete']);

  function clampIndex(items, value) {
    if (!items.length) return 0;
    const parsed = Number(value);
    const index = Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
    return Math.max(0, Math.min(index, items.length - 1));
  }

  function isAvailable(item) {
    return !!item && item.available !== false && item.media_type !== 'static';
  }

  function findPlayable(items, start, direction, includeStart) {
    const step = direction < 0 ? -1 : 1;
    let index = clampIndex(items, start) + (includeStart ? 0 : step);
    while (index >= 0 && index < items.length) {
      if (isAvailable(items[index])) return index;
      index += step;
    }
    return -1;
  }

  function initialState(feed, requestedIndex) {
    const source = feed || {};
    const items = Array.isArray(source.items) ? source.items : [];
    const pack = source.surface === 'pack' && source.pack ? source.pack : null;
    if (!pack) {
      return { mode: 'feed', phase: 'playing', items, index: clampIndex(items, requestedIndex) };
    }

    const resume = source.resume || null;
    const restart = !!source.restart;
    let phase = restart ? 'intro' : (resume && PHASES.has(resume.phase) ? resume.phase : 'intro');
    let index = clampIndex(items, requestedIndex);
    let skippedUnavailable = false;
    if (!restart && resume && resume.current_item_id) {
      const resumeIndex = items.findIndex((item) => item && item.pack_item_id === resume.current_item_id);
      if (resumeIndex >= 0) index = resumeIndex;
    }
    if (phase === 'playing' && !isAvailable(items[index])) {
      const originalIndex = index;
      const forward = findPlayable(items, index, 1, true);
      const backward = findPlayable(items, index, -1, true);
      index = forward >= 0 ? forward : backward;
      skippedUnavailable = index !== originalIndex;
      if (index < 0) phase = 'complete';
    }

    return {
      mode: 'pack',
      phase,
      pack,
      revision: Number(pack.revision) || 1,
      items,
      index: Math.max(0, index),
      resumePositionMs: !restart && resume && phase === 'playing' && !skippedUnavailable ? Math.max(0, Number(resume.position_ms) || 0) : 0,
    };
  }

  function transition(state, event) {
    if (!state || state.mode !== 'pack') return state;
    const type = event && event.type;
    if (type === 'START') {
      // Double-tap RESUME/START while already playing must not wipe clock.
      if (state.phase === 'playing' && isAvailable(state.items[state.index])) return state;
      const preferred = state.index;
      const fromPreferred = findPlayable(state.items, preferred, 1, true);
      const index = fromPreferred >= 0 ? fromPreferred : findPlayable(state.items, 0, 1, true);
      return { ...state, phase: index >= 0 ? 'playing' : 'complete', index: Math.max(0, index), resumePositionMs: 0 };
    }
    if (type === 'REPLAY') {
      const fromPreferred = findPlayable(state.items, 0, 1, true);
      const index = fromPreferred >= 0 ? fromPreferred : findPlayable(state.items, 0, 1, true);
      return { ...state, phase: index >= 0 ? 'playing' : 'complete', index: Math.max(0, index), resumePositionMs: 0 };
    }
    if (type === 'SELECT') {
      const index = clampIndex(state.items, event.index);
      if (!isAvailable(state.items[index])) return state;
      return { ...state, phase: 'playing', index, resumePositionMs: 0 };
    }
    if (type === 'NEXT') {
      const index = findPlayable(state.items, state.index, 1, false);
      return index >= 0
        ? { ...state, phase: 'playing', index, resumePositionMs: 0 }
        : { ...state, phase: 'complete', resumePositionMs: 0 };
    }
    if (type === 'PREV') {
      const index = findPlayable(state.items, state.index, -1, false);
      return index >= 0 ? { ...state, phase: 'playing', index, resumePositionMs: 0 } : state;
    }
    if (type === 'COMPLETE') return { ...state, phase: 'complete', resumePositionMs: 0 };
    return state;
  }

  function progressPayload(state, positionSeconds) {
    if (!state || state.mode !== 'pack') return null;
    const item = state.items[state.index] || null;
    return {
      current_item_id: item && item.pack_item_id ? item.pack_item_id : null,
      position_ms: state.phase === 'playing' ? Math.max(0, Math.round((Number(positionSeconds) || 0) * 1000)) : 0,
      phase: PHASES.has(state.phase) ? state.phase : 'intro',
    };
  }

  const api = { PHASES, clampIndex, isAvailable, findPlayable, initialState, transition, progressPayload };
  root.ReelsPackState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
