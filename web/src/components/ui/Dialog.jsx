import { useEffect, useLayoutEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog on the native <dialog> element, opened with showModal() while mounted, so it
 * sits in the top layer above the header and the message dock, and the page behind it is inert.
 * Mount it to open it; unmount it to close it.
 *
 * - Focus moves to [data-autofocus], else to the first control that is not the close button
 *   ([data-dialog-close]), else to the close button. It returns to the opener on close.
 * - Tab and Shift+Tab wrap inside the dialog.
 * - Escape, other close requests and a press on the backdrop call onClose, unless `busy`.
 *
 * The <dialog> is the full-screen backdrop and carries `className`; put the visible panel
 * inside it. Name it with aria-labelledby or aria-label, and pass role="alertdialog" for a
 * confirmation.
 */
export default function Dialog({ onClose, busy = false, className = '', children, ...props }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog.showModal();
    const target = dialog.querySelector('[data-autofocus]')
      || [...dialog.querySelectorAll(FOCUSABLE)].find((element) => !element.matches('[data-dialog-close]'))
      || dialog.querySelector('[data-dialog-close]');
    target?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        // Handled here instead of by the native cancel, so `busy` can keep the dialog open.
        event.preventDefault();
        if (!busy) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = ref.current;
      const stops = [...dialog.querySelectorAll(FOCUSABLE)];
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <dialog
      ref={ref}
      className={'sx-dialog' + (className ? ' ' + className : '')}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      {...props}
    >
      {children}
    </dialog>
  );
}
