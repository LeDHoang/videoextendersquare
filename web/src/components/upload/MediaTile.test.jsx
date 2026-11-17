import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MediaTile from './MediaTile.jsx';
import { mergeServerRenders } from './mediaItems.js';

const ROW = {
  job_id: '75cef635bbf4', kind: 'video', role: 'square', source_stage_id: '2006876381', source_job_id: null,
  filename: 'clip.mp4', status: 'ready', kept: false, post_id: null,
  created_at: '2026-11-15T16:19:38Z', updated_at: '2026-11-15T16:20:10Z', expires_at: '2026-11-15T22:19:38Z',
  download_url: '/api/video/jobs/75cef635bbf4/download', media_url: '/api/video/jobs/75cef635bbf4/download?kind=preview', thumb_url: null,
};
const RETENTION = { stage_seconds: 21600, result_seconds: 21600 };

function tileFor(row) {
  const [item] = mergeServerRenders([], [row], []);
  const noop = () => {};
  return render(<ul><MediaTile item={item} now={Date.parse('2026-11-15T17:00:00Z')} retention={RETENTION} onOpen={noop} /></ul>);
}

describe('MediaTile picture after a reload', () => {
  it('plays the result preview when a video result has no thumbnail', () => {
    const { container } = tileFor(ROW);
    expect(container.querySelector('video').getAttribute('src')).toBe(ROW.media_url);
  });

  it('shows the result when an image result has no thumbnail', () => {
    const { container } = tileFor({ ...ROW, kind: 'image', media_url: '/api/image/jobs/75cef635bbf4/download' });
    expect(container.querySelector('img').getAttribute('src')).toBe('/api/image/jobs/75cef635bbf4/download');
  });

  it('prefers the saved thumbnail', () => {
    const { container } = tileFor({ ...ROW, thumb_url: '/thumb.jpg' });
    expect(container.querySelector('img').getAttribute('src')).toBe('/thumb.jpg');
    expect(container.querySelector('video')).toBeNull();
  });
});
