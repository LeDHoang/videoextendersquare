import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExploreTile from './ExploreTile.jsx';

const video = (extra = {}) => ({
  path: 'a.mp4',
  url: '/media/a.mp4',
  preview_url: '/media/a-explore.mp4',
  media_type: 'video',
  title: 'Reel A',
  filename: 'a.mp4',
  duration_ms: 14967,
  likes: 0,
  views: 0,
  ...extra,
});

function renderTile(props = {}) {
  return render(<MemoryRouter><ExploreTile video={video()} onOpen={() => {}} {...props} /></MemoryRouter>);
}

const badge = (container) => container.querySelector('.sx-explore-order');

function playAt(container, { currentTime, duration, event = 'timeUpdate' }) {
  const el = container.querySelector('video');
  Object.defineProperty(el, 'duration', { value: duration, configurable: true });
  Object.defineProperty(el, 'currentTime', { value: currentTime, configurable: true });
  act(() => { fireEvent[event](el); });
}

describe('ExploreTile order and runtime badge', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows no badge unless an order label is given (Explore is unchanged)', () => {
    const { container } = renderTile();
    expect(badge(container)).toBeNull();
  });

  it('starts at the full runtime from the API', () => {
    const { container } = renderTile({ orderLabel: '01' });
    expect(badge(container)).toHaveTextContent('01 · 0:15');
  });

  it('counts down while the preview plays', () => {
    const { container } = renderTile({ orderLabel: '02' });
    playAt(container, { currentTime: 0, duration: 15, event: 'loadedMetadata' });
    expect(badge(container)).toHaveTextContent('02 · 0:15');
    playAt(container, { currentTime: 4.2, duration: 15 });
    expect(badge(container)).toHaveTextContent('02 · 0:11');
    playAt(container, { currentTime: 9.9, duration: 15 });
    expect(badge(container)).toHaveTextContent('02 · 0:05');
    playAt(container, { currentTime: 14.9, duration: 15 });
    expect(badge(container)).toHaveTextContent('02 · 0:00');
  });

  it('starts over when the looping preview wraps around', () => {
    const { container } = renderTile({ orderLabel: '01' });
    playAt(container, { currentTime: 14.8, duration: 15 });
    expect(badge(container)).toHaveTextContent('0:00');
    playAt(container, { currentTime: 0.1, duration: 15 });
    expect(badge(container)).toHaveTextContent('0:15');
  });

  it('keeps counting in whole seconds only (no needless re-renders)', () => {
    const { container } = renderTile({ orderLabel: '01' });
    let renders = 0;
    const observer = new MutationObserver(() => { renders += 1; });
    observer.observe(badge(container), { childList: true, characterData: true, subtree: true });
    playAt(container, { currentTime: 3.0, duration: 15 });
    const afterFirst = badge(container).textContent;
    playAt(container, { currentTime: 3.2, duration: 15 });
    playAt(container, { currentTime: 3.4, duration: 15 });
    expect(badge(container).textContent).toBe(afterFirst);
    observer.disconnect();
    expect(renders).toBeLessThanOrEqual(1);
  });

  it('uses the preview length when the API does not know the runtime', () => {
    const { container } = renderTile({ orderLabel: '03', video: video({ duration_ms: null }) });
    expect(badge(container)).toHaveTextContent(/^03$/);
    playAt(container, { currentTime: 0, duration: 8, event: 'loadedMetadata' });
    expect(badge(container)).toHaveTextContent('03 · 0:08');
  });

  it('ignores a preview whose length is not known yet', () => {
    const { container } = renderTile({ orderLabel: '01' });
    playAt(container, { currentTime: 0, duration: NaN });
    expect(badge(container)).toHaveTextContent('01 · 0:15');
  });

  it('shows only the order on an image reel', () => {
    const { container } = renderTile({ orderLabel: '04', video: video({ media_type: 'image', poster_url: '/p.jpg', duration_ms: 40 }) });
    expect(badge(container)).toHaveTextContent(/^04$/);
  });
});
