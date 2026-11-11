import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useExplorePreviews from './useExplorePreviews.js';

const mocks = vi.hoisted(() => ({ api: { post: vi.fn() } }));

vi.mock('../api/client.js', () => ({ api: mocks.api }));

const reel = (name) => ({ path: name + '.mp4', title: name });

describe('useExplorePreviews', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps the previews of loaded tiles when a page is appended and makes only the new ones', async () => {
    mocks.api.post.mockImplementation(async (_path, batch) => ({
      generated: Object.fromEntries(batch.map((path) => [path, '/preview/' + path])),
      posters: Object.fromEntries(batch.map((path) => [path, '/poster/' + path])),
    }));
    const firstPage = [reel('a'), reel('b')];
    const { result, rerender } = renderHook(({ videos }) => useExplorePreviews(videos), {
      initialProps: { videos: firstPage },
    });
    await waitFor(() => expect(result.current.items[1].preview_url).toBe('/preview/b.mp4'));

    rerender({ videos: [...firstPage, reel('c')] });

    await waitFor(() => expect(result.current.items[2].preview_url).toBe('/preview/c.mp4'));
    expect(result.current.items.map((item) => item.preview_url)).toEqual(['/preview/a.mp4', '/preview/b.mp4', '/preview/c.mp4']);
    expect(mocks.api.post.mock.calls.map(([, batch]) => batch)).toEqual([['a.mp4', 'b.mp4'], ['c.mp4']]);
  });

  it('starts over for a new list', async () => {
    mocks.api.post.mockResolvedValue({ generated: {}, posters: {} });
    const { result, rerender } = renderHook(({ videos }) => useExplorePreviews(videos), {
      initialProps: { videos: [reel('a')] },
    });

    rerender({ videos: [reel('x'), reel('y')] });

    await waitFor(() => expect(result.current.items.map((item) => item.path)).toEqual(['x.mp4', 'y.mp4']));
    expect(mocks.api.post.mock.calls.at(-1)[1]).toEqual(['x.mp4', 'y.mp4']);
  });
});
