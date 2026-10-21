import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/controls.jsx';
import { REPORT_REASONS } from '../utils/messageFormat.js';

export const REPORT_DETAILS_LIMIT = 500;

const FOCUSABLE = 'a[href], button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Small modal: Escape and backdrop close it, Tab stays inside, focus returns to the opener. */
export function Dialog({ title, onClose, busy = false, children }) {
  const panelRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector('select, textarea, input, button:not([data-dialog-close])');
    (first || panel)?.focus();
    return () => {
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = Array.from(panel.querySelectorAll(FOCUSABLE));
      if (!stops.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const firstStop = stops[0];
      const lastStop = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === firstStop || !panel.contains(active))) {
        event.preventDefault();
        lastStop.focus();
      } else if (!event.shiftKey && (active === lastStop || !panel.contains(active))) {
        event.preventDefault();
        firstStop.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div className="sx-pk-modal" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="sx-pk-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef} tabIndex={-1}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" data-dialog-close onClick={onClose} disabled={busy} aria-label="Close dialog">×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * Report form in a modal. `onSubmit({ reason, details })` performs the request and throws on failure;
 * the dialog shows the error and stays open, or calls `onClose` after a successful submit.
 */
export default function ReportDialog({ title = 'REPORT', onSubmit, onClose }) {
  const [reason, setReason] = useState(REPORT_REASONS[0][0]);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ reason, details: details.trim() });
    } catch (requestError) {
      if (mounted.current) {
        setError(requestError?.message || 'Could not submit this report.');
        setBusy(false);
      }
      return;
    }
    if (mounted.current) setBusy(false);
    onClose();
  };

  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <form onSubmit={submit}>
        <label>
          <span>REASON</span>
          <select aria-label="Report reason" value={reason} onChange={(event) => setReason(event.target.value)}>
            {REPORT_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>DETAILS (OPTIONAL)</span>
          <textarea
            aria-label="Report details"
            value={details}
            maxLength={REPORT_DETAILS_LIMIT}
            rows={4}
            onChange={(event) => setDetails(event.target.value)}
          />
          <small>{details.length}/{REPORT_DETAILS_LIMIT}</small>
        </label>
        {error ? <div className="sx-pk-dialog-error" role="alert">{error}</div> : null}
        <div className="sx-pk-dialog-actions">
          <Button onClick={onClose} disabled={busy}>CANCEL</Button>
          <Button primary type="submit" loading={busy}>SUBMIT REPORT</Button>
        </div>
      </form>
    </Dialog>
  );
}
