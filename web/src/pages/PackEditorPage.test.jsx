import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PackEditorPage from './PackEditorPage.jsx';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', username: 'maker' } }) }));
vi.mock('../hooks/ConfigContext.jsx', () => ({ useConfigContext: () => ({ config: {} }) }));

// Rows as /api/reels returns them: post_id, no id.
const feedRow = (n, extra = {}) => ({
  post_id: 'post-' + n,
  title: 'Reel ' + n,
  media_type: 'video',
  poster_url: `/poster-${n}.jpg`,
  creator: { username: 'maker' },
  ...extra,
});

const ROWS = [
  feedRow(1),
  feedRow(2, { media_type: 'image', title: 'Slides 2', images: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] }),
  feedRow(3, { media_type: 'image', title: 'Still 3', images: [{ url: 'a' }] }),
];

function renderEditor() {
  mocks.api.get.mockResolvedValue({ videos: ROWS });
  return render(
    <MemoryRouter initialEntries={['/packs/new']}>
      <Routes>
        <Route path="/packs/new" element={<PackEditorPage />} />
        <Route path="/packs/:packId" element={<div>PACK PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const addButton = (title) => screen.getAllByRole('button').find((button) => button.textContent.includes(title) && button.textContent.includes('PACK'));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PackEditorPage', () => {
  it('adds reels and image posts from the library side by side', async () => {
    renderEditor();
    await waitFor(() => expect(addButton('Reel 1')).toBeTruthy(), { timeout: 2000 });
    expect(addButton('Reel 1')).toHaveTextContent('VIDEO · ADD TO PACK');
    expect(addButton('Slides 2')).toHaveTextContent('IMAGES · 3 · ADD TO PACK');
    expect(addButton('Still 3')).toHaveTextContent('IMAGE · ADD TO PACK');

    fireEvent.click(addButton('Reel 1'));
    // Adding one member must not mark every other library row as already in the pack.
    expect(addButton('Slides 2')).not.toBeDisabled();
    fireEvent.click(addButton('Slides 2'));
    fireEvent.click(addButton('Still 3'));
    expect(addButton('Reel 1')).toBeDisabled();
    expect(addButton('Slides 2')).toHaveTextContent('IN PACK');
  });

  it('publishes a mixed pack with every member post id', async () => {
    mocks.api.post.mockImplementation(async (path, body) => (
      path === '/api/packs'
        ? { pack: { id: 'pack-9', revision: 1, ...body } }
        : { pack: { id: 'pack-9' } }
    ));
    renderEditor();
    await waitFor(() => expect(addButton('Reel 1')).toBeTruthy(), { timeout: 2000 });
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Mixed pack' } });
    ['Reel 1', 'Slides 2', 'Still 3'].forEach((title) => fireEvent.click(addButton(title)));
    fireEvent.click(screen.getByRole('button', { name: 'PUBLISH PACK' }));
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/packs/pack-9/publish', { expected_revision: 1 }));
    const created = mocks.api.post.mock.calls.find(([path]) => path === '/api/packs')[1];
    expect(created.post_ids).toEqual(['post-1', 'post-2', 'post-3']);
    expect(created.cover_post_id).toBe('post-1');
  });
});
