import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../ReportDialog.jsx';
import { Button } from '../ui/controls.jsx';

const REASON_LIMIT = 500;
const ROLES = ['user', 'moderator', 'admin'];

function newRequestId() {
  return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/**
 * Confirm a staff action. Every action needs a reason, which goes to the audit log.
 * `kind` adds a field: 'delete' (type the username), 'credits' (signed amount), 'role' (new role).
 * `onSubmit(values)` performs the request and throws on failure; the dialog then shows the
 * error and stays open, or closes after a successful submit.
 */
export default function StaffActionDialog({ title, text, confirmLabel = 'CONFIRM', kind = '', username = '', role = 'user', onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [amount, setAmount] = useState('');
  const [nextRole, setNextRole] = useState(role);
  // One id per opened dialog: resubmitting after a lost response cannot move credits twice.
  const [requestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const amountValue = Number(amount);
  const ready = reason.trim().length >= 3
    && (kind !== 'delete' || confirmName.trim().replace(/^@/, '').toLowerCase() === username.toLowerCase())
    && (kind !== 'credits' || (amount.trim() !== '' && Number.isInteger(amountValue) && amountValue !== 0))
    && (kind !== 'role' || nextRole !== role);

  const submit = async (event) => {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError('');
    const values = { reason: reason.trim() };
    if (kind === 'delete') values.confirm_username = confirmName.trim();
    if (kind === 'credits') Object.assign(values, { amount: amountValue, request_id: requestId });
    if (kind === 'role') values.role = nextRole;
    try {
      await onSubmit(values);
    } catch (requestError) {
      if (mounted.current) {
        setError(requestError?.message || 'Could not complete this action.');
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
        {text ? <p>{text}</p> : null}
        {kind === 'role' ? (
          <label>
            <span>NEW ROLE</span>
            <select aria-label="New role" value={nextRole} onChange={(event) => setNextRole(event.target.value)}>
              {ROLES.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
            </select>
          </label>
        ) : null}
        {kind === 'credits' ? (
          <label>
            <span>AMOUNT (NEGATIVE TO REMOVE)</span>
            <input aria-label="Credit amount" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="50 or -50" />
          </label>
        ) : null}
        <label>
          <span>REASON (REQUIRED, IN THE AUDIT LOG)</span>
          <textarea aria-label="Reason" value={reason} maxLength={REASON_LIMIT} rows={3} onChange={(event) => setReason(event.target.value)} />
          <small>{reason.length}/{REASON_LIMIT}</small>
        </label>
        {kind === 'delete' ? (
          <label>
            <span>TYPE @{username} TO CONFIRM</span>
            <input aria-label="Confirm username" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} autoComplete="off" />
          </label>
        ) : null}
        {error ? <div className="sx-pk-dialog-error" role="alert">{error}</div> : null}
        <div className="sx-pk-dialog-actions">
          <Button onClick={onClose} disabled={busy}>CANCEL</Button>
          <Button primary type="submit" loading={busy} disabled={!ready}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}
