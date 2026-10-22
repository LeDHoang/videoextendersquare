import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportDialog from './ReportDialog.jsx';

afterEach(cleanup);

function setup(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  render(
    <>
      <button type="button">OPENER</button>
      <ReportDialog title="REPORT THING" onSubmit={onSubmit} onClose={onClose} />
    </>,
  );
  return { onSubmit, onClose, dialog: screen.getByRole('dialog', { name: 'REPORT THING' }) };
}

describe('ReportDialog', () => {
  it('offers every server-side reason and focuses the reason select', () => {
    const { dialog } = setup();
    const select = within(dialog).getByLabelText('Report reason');
    expect(select).toHaveFocus();
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'spam', 'harassment', 'hate', 'sexual', 'violence', 'impersonation', 'privacy', 'other',
    ]);
  });

  it('submits the trimmed reason and details, then closes', async () => {
    const { dialog, onSubmit, onClose } = setup();
    fireEvent.change(within(dialog).getByLabelText('Report reason'), { target: { value: 'privacy' } });
    fireEvent.change(within(dialog).getByLabelText('Report details'), { target: { value: '  leaked address  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'SUBMIT REPORT' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({ reason: 'privacy', details: 'leaked address' });
  });

  it('caps details at 500 characters and shows the counter', () => {
    const { dialog } = setup();
    const details = within(dialog).getByLabelText('Report details');
    expect(details).toHaveAttribute('maxlength', '500');
    fireEvent.change(details, { target: { value: 'abcd' } });
    expect(within(dialog).getByText('4/500')).toBeInTheDocument();
  });

  it('stays open and shows the error when the request fails', async () => {
    const { dialog, onClose } = setup(vi.fn().mockRejectedValue(new Error('Report limit reached')));
    fireEvent.click(within(dialog).getByRole('button', { name: 'SUBMIT REPORT' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Report limit reached');
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'SUBMIT REPORT' })).not.toBeDisabled();
  });

  it('closes on Escape, the close button and Cancel', () => {
    const { dialog, onClose } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'CANCEL' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('traps Tab inside the dialog in both directions', () => {
    const { dialog } = setup();
    const close = within(dialog).getByRole('button', { name: 'Close dialog' });
    const submit = within(dialog).getByRole('button', { name: 'SUBMIT REPORT' });
    submit.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(submit).toHaveFocus();
  });

  it('returns focus to the opener on unmount', () => {
    cleanup();
    render(<button type="button">OPENER</button>);
    const opener = screen.getByRole('button', { name: 'OPENER' });
    opener.focus();
    const view = render(<ReportDialog onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(opener).not.toHaveFocus();
    view.unmount();
    expect(opener).toHaveFocus();
  });
});
