import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/controls.jsx';
import ModalDialog from './ui/Dialog.jsx';
import IconButton from './ui/IconButton.jsx';
import { REPORT_REASONS } from '../utils/messageFormat.js';

export const REPORT_DETAILS_LIMIT = 500;

/** Small titled modal on ui/Dialog: Escape and the backdrop close it, focus returns to the opener. */
export function Dialog({ title, onClose, busy = false, children }) {
  const titleId = useId();
  return (
    <ModalDialog className="sx-pk-modal" aria-labelledby={titleId} onClose={onClose} busy={busy}>
      <div className="sx-pk-dialog">
        <header>
          <h2 id={titleId}>{title}</h2>
          <IconButton variant="plain" label="Close dialog" data-dialog-close onClick={onClose} disabled={busy}>×</IconButton>
        </header>
        {children}
      </div>
    </ModalDialog>
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
          <Button variant="primary" type="submit" loading={busy}>SUBMIT REPORT</Button>
        </div>
      </form>
    </Dialog>
  );
}
