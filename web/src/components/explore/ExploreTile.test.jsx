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

  it('folds the image kind into the order chip instead of a second, overlapping badge', () => {
    const { container } = renderTile({ orderLabel: '04', video: video({ media_type: 'image', poster_url: '/p.jpg', duration_ms: 40 }) });
    expect(badge(container)).toHaveTextContent(/^04 · IMAGE$/);
    expect(container.querySelector('.sx-explore-kind')).toBeNull();
  });

  it('labels a multi-image post with its image count', () => {
    const images = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];
    const inPack = renderTile({ orderLabel: '01', video: video({ media_type: 'image', poster_url: '/p.jpg', images }) });
    expect(badge(inPack.container)).toHaveTextContent(/^01 · IMAGES · 3$/);
    cleanup();
    const inExplore = renderTile({ video: video({ media_type: 'image', poster_url: '/p.jpg', images }) });
    expect(inExplore.container.querySelector('.sx-explore-kind')).toHaveTextContent('IMAGES · 3');
  });
});

describe('ExploreTile autoplay', () => {
  let observers;
  let play;
  let pause;
  let started;

  beforeEach(() => {
    observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    });
    started = 0;
    // Like a browser: a <video> with no source rejects play() instead of starting.
    play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(function () {
      if (!this.getAttribute('src')) return Promise.reject(new DOMException('no source', 'NotSupportedError'));
      started += 1;
      Object.defineProperty(this, 'paused', { value: false, configurable: true });
      return Promise.resolve();
    });
    pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    play.mockRestore();
    pause.mockRestore();
    vi.unstubAllGlobals();
  });

  const show = () => act(() => { observers.forEach((o) => o.cb([{ isIntersecting: true }])); });

  it('plays a tile that is already visible when it mounts, once its source is attached', () => {
    const { container } = renderTile();
    show();
    expect(container.querySelector('video')).toHaveAttribute('src', '/media/a-explore.mp4');
    expect(started).toBe(1);
  });

  it('retries when the browser reports the media ready after an earlier attempt could not play', () => {
    const { container } = renderTile();
    show();
    const el = container.querySelector('video');
    Object.defineProperty(el, 'paused', { value: true, configurable: true });
    act(() => { fireEvent.canPlay(el); });
    expect(started).toBe(2);
  });

  it('plays again from the original file when the preview fails to load', () => {
    const { container } = renderTile();
    show();
    const el = container.querySelector('video');
    Object.defineProperty(el, 'paused', { value: true, configurable: true });
    act(() => { fireEvent.error(el); });
    expect(el).toHaveAttribute('src', '/media/a.mp4');
    expect(started).toBe(2);
  });

  it('does not play a tile that has not scrolled into view', () => {
    const { container } = renderTile();
    act(() => { observers.forEach((o) => o.cb([{ isIntersecting: false }])); });
    act(() => { fireEvent.canPlay(container.querySelector('video')); });
    expect(play).not.toHaveBeenCalled();
  });
});

describe('ExploreTile 3D posts', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('tags stereo posts as 3D and plays their 2D preview uncropped', () => {
    const { container } = renderTile({ video: video({ stereo_layout: 'sbs', stereo_crop: false, url: '/media/a-mono.mp4' }) });
    expect(container.querySelector('.sx-explore-kind').textContent).toBe('3D');
    expect(container.querySelector('video').className).toBe('sx-explore-video');
  });

  it('crops legacy stereo files without a 2D rendition to the left eye', () => {
    const { container } = renderTile({
      video: video({ stereo_layout: 'tb', stereo_crop: true, poster_url: '/media/a-poster.jpg', media_type: 'image', images: [{}, {}] }),
    });
    expect(container.querySelector('.sx-explore-kind').textContent).toBe('IMAGES · 2 · 3D');
    expect(container.querySelector('img').className).toContain('sx-stereo-crop-tb');
  });

  it('keeps mono tiles unbadged', () => {
    const { container } = renderTile({ video: video({ stereo_layout: 'mono' }) });
    expect(container.querySelector('.sx-explore-kind')).toBeNull();
  });

  it('names 3D posts as 3D for screen readers', () => {
    const { getByRole } = renderTile({ video: video({ stereo_layout: 'sbs' }) });
    expect(getByRole('button', { name: 'Open Reel A (3D) in Reels player' })).toBeInTheDocument();
    cleanup();
    const mono = renderTile({ video: video({ stereo_layout: 'mono' }) });
    expect(mono.getByRole('button', { name: 'Open Reel A in Reels player' })).toBeInTheDocument();
  });
});

describe('ExploreTile video loading', () => {
  let observers;

  beforeEach(() => {
    observers = [];
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const fire = (observer, isIntersecting = true) => act(() => { observer.callback([{ isIntersecting }]); });
  const near = (index) => observers.filter((o) => o.options.rootMargin === '300px')[index];
  const visible = (index) => observers.filter((o) => o.options.rootMargin === '0px')[index];

  function renderTiles(count, extra = () => ({})) {
    return render(
      <MemoryRouter>
        {Array.from({ length: count }, (_, i) => (
          <ExploreTile key={i} video={video({ path: i + '.mp4', url: '/media/' + i + '.mp4', preview_url: '/media/' + i + '-explore.mp4', ...extra(i) })} onOpen={() => {}} />
        ))}
      </MemoryRouter>,
    );
  }

  const sources = (container) => [...container.querySelectorAll('video')].map((el) => el.getAttribute('src'));

  it('looks 300px ahead, not 800px', () => {
    renderTiles(1);
    expect(near(0)).toBeDefined();
    expect(observers.some((o) => o.options.rootMargin === '800px')).toBe(false);
  });

  it('loads at most four nearby previews at once', () => {
    const { container } = renderTiles(6);
    for (let i = 0; i < 6; i += 1) fire(near(i));
    expect(sources(container).filter(Boolean)).toHaveLength(4);
  });

  it('frees a slot when a preview has loaded', () => {
    const { container } = renderTiles(6);
    for (let i = 0; i < 6; i += 1) fire(near(i));
    act(() => { fireEvent.loadedData(container.querySelectorAll('video')[0]); });
    expect(sources(container).filter(Boolean)).toHaveLength(5);
  });

  it('lets a tile that scrolls into view jump the queue', () => {
    const { container } = renderTiles(6);
    for (let i = 0; i < 6; i += 1) fire(near(i));
    expect(sources(container)[5]).toBeNull();
    fire(visible(5));
    act(() => { fireEvent.loadedData(container.querySelectorAll('video')[0]); });
    expect(sources(container)[5]).toBe('/media/5-explore.mp4');
    expect(sources(container)[4]).toBeNull();
  });

  it('shows only the poster under reduced motion', () => {
    vi.stubGlobal('matchMedia', (query) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    const { container } = renderTiles(1, () => ({ poster_url: '/media/0.jpg' }));
    fire(near(0));
    fire(visible(0));
    expect(sources(container)).toEqual([null]);
  });
});
