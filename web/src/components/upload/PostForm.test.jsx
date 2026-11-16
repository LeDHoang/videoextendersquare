import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PostForm from './PostForm.jsx';
import { emptyDraft } from './mediaItems.js';

const NOTE = 'Only you and anyone with the link can see it.';

describe('PostForm private toggle', () => {
  afterEach(cleanup);

  it('makes the draft private when PRIVATE POST is ticked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PostForm draft={emptyDraft('t')} onChange={onChange} />);
    expect(screen.queryByText(NOTE)).toBeNull();
    await user.click(screen.getByLabelText('PRIVATE POST'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private' }));
  });

  it('says who can see a private post', () => {
    render(<PostForm draft={{ ...emptyDraft('t'), visibility: 'private' }} onChange={() => {}} />);
    expect(screen.getByLabelText('PRIVATE POST').checked).toBe(true);
    expect(screen.getByText(NOTE)).toBeTruthy();
  });
});
