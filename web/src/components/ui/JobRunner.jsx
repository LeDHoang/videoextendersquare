import { useEffect, useRef } from 'react';
import { useSSE } from '../../hooks/useSSE.js';
import Progress from './Progress.jsx';
import Emoji from './Emoji.jsx';

// Tracks a single pipeline job over SSE and renders progress + result.
// onDone(result), when provided, fires exactly once when the job completes.
export default function JobRunner({ jobId, name, kind, onDone, onSettled }) {
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
    if (!settledRef.current && (job?.status === 'complete' || job?.status === 'failed')) {
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
        <div className="sx-progress-track">
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
          <span className="sx-job-status sx-done">✓ 4K SQUARE COMPLETE</span>
        </div>

        {kind === 'image' ? (
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
            <Emoji text="↓ DOWNLOAD 4K MASTER" />
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

  if (job?.status === 'failed' || (!job && error)) {
    const detail = job?.error?.[1] || error?.message || 'Unknown pipeline execution error';
    const headline = job?.error?.[0] || 'PIPELINE EXECUTION FAILED';
    return (
      <div className="sx-error-box" role="alert">
        <div className="sx-error-title">{headline}</div>
        <div>{detail}</div>
      </div>
    );
  }

  return <Progress job={job} name={name} />;
}