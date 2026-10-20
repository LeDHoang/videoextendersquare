import { describe, expect, it } from 'vitest';
import { assertUploadSize, oversizeMessage, uploadLimitMb } from './uploadLimits.js';

const MB = 1024 * 1024;
const config = { upload_limits: { image_mb: 25, video_mb: 500 } };

describe('upload limits from /api/config', () => {
  it('reads the per-kind cap and ignores missing or invalid values', () => {
    expect(uploadLimitMb(config, 'image')).toBe(25);
    expect(uploadLimitMb(config, 'video')).toBe(500);
    expect(uploadLimitMb({}, 'image')).toBeNull();
    expect(uploadLimitMb(null, 'video')).toBeNull();
    expect(uploadLimitMb({ upload_limits: { image_mb: 0 } }, 'image')).toBeNull();
  });

  it('rejects an oversize file before upload with a 413-shaped error', () => {
    const big = { name: 'big.jpg', size: 26 * MB };
    expect(oversizeMessage(big, 'image', config)).toBe('big.jpg is 26.0 MB — image uploads must be 25 MB or smaller.');
    expect(() => assertUploadSize(big, 'image', config)).toThrow(
      expect.objectContaining({ status: 413, code: 'UPLOAD_TOO_LARGE' }),
    );
  });

  it('allows files at the cap, and everything when the server publishes no cap', () => {
    expect(oversizeMessage({ name: 'ok.jpg', size: 25 * MB }, 'image', config)).toBeNull();
    expect(() => assertUploadSize({ name: 'huge.mp4', size: 9000 * MB }, 'video', {})).not.toThrow();
  });
});
