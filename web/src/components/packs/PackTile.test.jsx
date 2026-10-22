import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PackTile from './PackTile.jsx';

vi.mock('../../api/client.js', () => ({ api: { post: vi.fn(() => Promise.resolve({})) } }));

const member = (extra) => ({ media_type: 'video', url: '/media/x.mp4', ...extra });

function renderPack(coverItems, extra = {}) {
  const pack = { id: 'p1', title: 'Pack', cover_items: coverItems, ...extra };
  return render(<MemoryRouter><PackTile pack={pack} onOpen={() => {}} /></MemoryRouter>);
}

describe('PackTile 3D covers', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('crops the poster by the member it actually comes from', () => {
    // The first member has no poster, so the cover is the second (raw SBS) one.
    const { container } = renderPack([
      member({ stereo_layout: 'mono' }),
      member({ poster_url: '/media/b-poster.jpg', stereo_layout: 'sbs', stereo_crop: true }),
    ]);
    const img = container.querySelector('img.sx-explore-poster');
    expect(img.getAttribute('src')).toBe('/media/b-poster.jpg');
    expect(img.className).toContain('sx-stereo-crop-sbs');
  });

  it('does not crop a mono cover because another member is raw 3D', () => {
    const { container } = renderPack([
      member({ poster_url: '/media/a-poster.jpg', stereo_layout: 'mono' }),
      member({ poster_url: '/media/b-poster.jpg', stereo_layout: 'sbs', stereo_crop: true }),
    ]);
    expect(container.querySelector('img.sx-explore-poster').className).toBe('sx-explore-poster');
  });

  it('never crops the pack cover_url fallback', () => {
    const { container } = renderPack(
      [member({ stereo_layout: 'sbs', stereo_crop: true })],
      { cover_url: '/media/pack-cover.jpg' },
    );
    const img = container.querySelector('img.sx-explore-poster');
    expect(img.getAttribute('src')).toBe('/media/pack-cover.jpg');
    expect(img.className).toBe('sx-explore-poster');
  });
});
