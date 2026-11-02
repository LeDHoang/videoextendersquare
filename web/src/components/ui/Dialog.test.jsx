import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dialog from './Dialog.jsx';

afterEach(cleanup);

function setup({ busy = false, children } = {}) {
  const onClose = vi.fn();
  const view = render(
    <>
      <button type="button">OPENER</button>
      <Dialog aria-label="Test dialog" className="sx-modal-backdrop" onClose={onClose} busy={busy}>
        <section className="panel">
          {children || (
            <>
              <button type="button" data-dialog-close aria-label="Close">×</button>
              <input aria-label="Name" />
              <button type="button">SAVE</button>
            </>
          )}
        </section>
      </Dialog>
    </>,
  );
  return { onClose, view, dialog: screen.getByRole('dialog', { name: 'Test dialog' }) };
}

describe('Dialog', () => {
  it('opens a native modal <dialog> with the backdrop class', () => {
    const { dialog } = setup();
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveClass('sx-dialog', 'sx-modal-backdrop');
  });

  it('focuses the first control that is not the close button', () => {
    setup();
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('focuses [data-autofocus] first, and falls back to the close button', () => {
    setup({ children: <><button type="button">A</button><button type="button" data-autofocus>B</button></> });
    expect(screen.getByRole('button', { name: 'B' })).toHaveFocus();
    cleanup();
    setup({ children: <button type="button" data-dialog-close aria-label="Close">×</button> });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('closes on Escape and on a press on the backdrop, not inside the panel', () => {
    const { dialog, onClose } = setup();
    fireEvent.mouseDown(document.querySelector('.panel'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog);
    const escape = createEvent.keyDown(document, { key: 'Escape' });
    fireEvent(document, escape);
    expect(onClose).toHaveBeenCalledTimes(2);
    // The native close request is cancelled, so React state decides when it closes.
    expect(escape.defaultPrevented).toBe(true);
  });

  it('leaves Escape to a control inside that handled it, like an open dropdown', () => {
    const { onClose } = setup({
      children: <input aria-label="Combo" onKeyDown={(event) => event.key === 'Escape' && event.preventDefault()} />,
    });
    fireEvent.keyDown(screen.getByLabelText('Combo'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on a press on the backdrop\'s own scrollbar', () => {
    const { dialog, onClose } = setup();
    // A 400px-wide backdrop that scrolls, with a 15px scrollbar on its right edge.
    Object.defineProperty(dialog, 'offsetWidth', { value: 400 });
    Object.defineProperty(dialog, 'clientWidth', { value: 385 });
    dialog.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 600 });
    fireEvent.mouseDown(dialog, { clientX: 390, clientY: 300 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog, { clientX: 380, clientY: 300 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats other close requests (the cancel event) like Escape', () => {
    const { dialog, onClose } = setup();
    const cancel = createEvent('cancel', dialog, { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open while busy', () => {
    const { dialog, onClose } = setup({ busy: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(dialog);
    fireEvent(dialog, createEvent('cancel', dialog, { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('wraps Tab inside the dialog in both directions', () => {
    setup();
    const close = screen.getByRole('button', { name: 'Close' });
    const save = screen.getByRole('button', { name: 'SAVE' });
    save.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(save).toHaveFocus();
  });

  it('closes the <dialog> and returns focus to the opener on unmount', () => {
    render(<button type="button">OPENER</button>);
    const opener = screen.getByRole('button', { name: 'OPENER' });
    opener.focus();
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
    const view = render(<Dialog aria-label="D" onClose={vi.fn()}><input aria-label="Field" /></Dialog>);
    expect(screen.getByLabelText('Field')).toHaveFocus();
    view.unmount();
    expect(close).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
    close.mockRestore();
  });
});
