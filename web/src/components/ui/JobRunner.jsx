import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { TERMINAL_STATUSES, useSSE } from '../../hooks/useSSE.js';
import { billingErrorMessage } from '../../utils/billingErrors.js';
import Progress from './Progress.jsx';
import { Button } from './controls.jsx';
import Emoji from './Emoji.jsx';

// Cancel control for a queued/running job. POST /api/{kind}/jobs/{id}/cancel
// answers 202 (the server stops before the next stage; the SSE stream then
// reports "cancelled"), 409 when the job already finished, and 404/405 on a
// server without cancel support — the button then hides itself.
function CancelJobButton({ jobId, kind }) {
  const [state, setState] = useState('idle'); // idle | pending | requested | unsupported
  const [message, setMessage] = useState('');
  if (state === 'unsupported') return null;
  const cancel = async () => {
    setState('pending');
    setMessage('');
    try {
      await api.post(`/api/${kind}/jobs/${encodeURIComponent(jobId)}/cancel`);
      setState('requested');
    } catch (err) {
      if (err?.status === 404 || err?.status === 405) {
        setState('unsupported');
      } else if (err?.status === 409) {
        setState('requested');
        setMessage('This job already finished.');
      } else {
        setState('idle');
        setMessage(billingErrorMessage(err, 'Could not cancel the job. Try again.'));
      }
    }
  };
  return (
    <div className="sx-job-cancel">
      <Button onClick={cancel} disabled={state !== 'idle'} loading={state === 'pending'}>
        {state === 'pending' ? 'CANCELLING…' : state === 'requested' ? 'CANCEL REQUESTED' : '✕ CANCEL JOB'}
      </Button>
      {state === 'requested' && !message ? (
        <span className="sx-job-cancel-note">Stops before the next stage; a running step finishes first.</span>
      ) : null}
      {message ? <span className="sx-job-cancel-note" role="status">{message}</span> : null}
    </div>
  );
}

// Tracks a single pipeline job over SSE and renders progress + result.
// onDone(result), when provided, fires exactly once when the job completes.
// onSettled(job) fires once on any terminal state (complete, failed, cancelled).
// showMedia={false} keeps the status + downloads but leaves the rendered
// media to the caller (the Upload Studio shows it on its stage).
// doneLabel / downloadLabel name a job that is not a 4K square render.
export default function JobRunner({
  jobId,
  name,
  kind,
  onDone,
  onSettled,
  showMedia = true,
  doneLabel = '✓ 4K SQUARE COMPLETE',
  downloadLabel = '↓ DOWNLOAD 4K MASTER',
}) {
  const { job, error } = useSSE(`/api/${kind}/jobs/${jobId}/stream`);
  const doneRef = useRef(false);
  const settledRef = useRef(false);

  const done = job?.status === 'complete' && job.result ? job.result : null;
  useEffect(() => {
    if (done && !doneRef.current) {
      doneRef.current = true;
      onDone?.(done);
    }
  }, [done, onDone]);

  useEffect(() => {
    if (!settledRef.current && TERMINAL_STATUSES.has(job?.status)) {
      settledRef.current = true;
      onSettled?.(job);
    }
  }, [job, onSettled]);

  if (!job && !error) {
    return (
      <div className="sx-job" aria-live="polite">
        <div className="sx-job-head">
          <span className="sx-job-name">{name}</span>
          <span className="sx-job-status sx-queued">CONNECTING TO PIPELINE…</span>
        </div>
        <div
          className="sx-progress-track"
          role="progressbar"
          aria-valuenow={10}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext="Connecting to pipeline · 10%"
        >
          <div className="sx-progress-fill" style={{ width: '10%' }} />
        </div>
      </div>
    );
  }

  if (job?.status === 'complete' && job.result) {
    return (
      <div className="sx-job" aria-live="polite">
        <div className="sx-job-head">
          <span className="sx-job-name" title={name}>
            {name}
          </span>
          <span className="sx-job-status sx-done">{doneLabel}</span>
        </div>

        {!showMedia ? null : kind === 'image' ? (
          <img
            className="sx-img"
            src={job.result.download_url}
            alt={`Rendered square result for ${name}`}
            style={{ display: 'block', margin: '12px 0', maxHeight: 460, width: 'auto' }}
          />
        ) : (
          <div style={{ margin: '12px 0' }}>
            <video
              className="sx-video"
              src={job.result.preview_url || job.result.download_url}
              controls
              playsInline
              aria-label={`Rendered square video for ${name}`}
            />
            {!job.result.preview_url ? (
              <div className="sx-gated-reason" style={{ marginTop: 8 }}>
                ℹ HEVC MASTER (4K 1:1) — Browser preview requires an H.264 proxy; download to view in native VR/media player.
              </div>
            ) : null}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: 12 }}>
          <a className="sx-download" href={job.result.download_url} download>
            <Emoji text={downloadLabel} />
          </a>
          {job.result.preview_url && job.result.preview_url !== job.result.download_url ? (
            <a
              className="sx-download"
              style={{ background: 'var(--sx-surface-3)', border: '1px solid var(--sx-rule-strong)' }}
              href={job.result.preview_url}
              download
            >
              <Emoji text="↓ DOWNLOAD H.264 PROXY" />
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  if (job?.status === 'cancelled') {
    return (
      <div className="sx-job" aria-live="polite">
        <div className="sx-job-head">
          <span className="sx-job-name" title={name}>
            {name}
          </span>
          <span className="sx-job-status sx-cancelled">CANCELLED</span>
        </div>
        <div className="sx-job-phase">
          {job.error?.[1] || 'This job was cancelled. Any ECHO Credits reserved for it are released.'}
        </div>
      </div>
    );
  }

  if (job?.status === 'failed' || (!job && error)) {
    const detail = job?.error?.[1] || error?.message || 'Unknown pipeline execution error';
    // Billing/credit failures map to user copy; pipeline errors pass through.
    const headline = job?.error?.[0] || 'PIPELINE EXECUTION FAILED';
    return (
      <div className="sx-error-box" role="alert">
        <div className="sx-error-title">{headline}</div>
        <div>{billingErrorMessage({ message: detail })}</div>
      </div>
    );
  }

  return (
    <>
      <Progress job={job} name={name} />
      <CancelJobButton jobId={jobId} kind={kind} />
    </>
  );
}