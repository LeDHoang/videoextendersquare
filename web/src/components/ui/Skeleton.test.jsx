import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReelsPlayerSkeleton } from './Skeleton.jsx';

describe('ReelsPlayerSkeleton', () => {
  afterEach(cleanup);

  it('is one polite status region with a screen-reader label', () => {
    render(<ReelsPlayerSkeleton label="Loading reels player" />);
    const status = screen.getByRole('status', { name: 'Loading reels player' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading reels player…');
  });

  it('draws the square stage, plus the gutter and details column used at desktop widths', () => {
    const { container } = render(<ReelsPlayerSkeleton />);
    const stage = container.querySelector('.sx-skel-player-stage');
    expect(stage).not.toBeNull();
    // the frame, rail and meta placeholders live inside the stage so they stay square-relative
    expect(stage.querySelector('.sx-skel-player-frame')).not.toBeNull();
    expect(stage.querySelector('.sx-skel-player-rail')).not.toBeNull();
    expect(stage.querySelector('.sx-skel-player-meta')).not.toBeNull();
    expect(container.querySelector('.sx-skel-player-gutter')).not.toBeNull();
    expect(container.querySelector('.sx-skel-player-side')).not.toBeNull();
  });

  it('hides every decorative placeholder from assistive tech', () => {
    const { container } = render(<ReelsPlayerSkeleton />);
    for (const selector of ['.sx-skel-player-stage', '.sx-skel-player-gutter', '.sx-skel-player-side']) {
      expect(container.querySelector(selector)).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
