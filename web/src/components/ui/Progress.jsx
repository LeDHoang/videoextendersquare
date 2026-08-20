import { useEffect, useRef } from 'react';

export default function Progress({ job, name }) {
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job?.messages]);

  if (!job) return null;
  const { status, phase, progress, elapsed, messages } = job;
  const cls =
    status === 'complete' ? 'sx-done' : status === 'failed' ? 'sx-fail' : status === 'running' ? 'sx-run' : 'sx-queued';
  const pct = Math.min(100, Math.max(0, Math.round((progress || 0) * 100)));

  return (
    <div className="sx-job" aria-live="polite">
      <div className="sx-job-head">
        <span className="sx-job-name" title={name}>
          {name}
        </span>
        <span className={`sx-job-status ${cls}`}>
          {(status || 'queued').toUpperCase()} {elapsed ? `· ${elapsed}` : ''}
        </span>
      </div>

      {/* Accessible Progress Bar */}
      <div
        className="sx-progress-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${phase || 'Processing'} · ${pct}%`}
      >
        <div className="sx-progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="sx-job-phase">
        <span style={{ color: 'var(--sx-ink)' }}>{phase || 'INITIALIZING'}</span> · {pct}%
      </div>

      {/* Live Terminal Log */}
      {messages && messages.length ? (
        <div className="sx-progress-log" ref={logRef} aria-label="Live Process Output">
          {messages.slice(-20).map((m, i) => {
            const isStage = m.startsWith('===') || m.includes('Phase') || m.includes('Stage');
            const isWarn = m.toLowerCase().includes('warn') || m.toLowerCase().includes('slow');
            const isErr = m.toLowerCase().includes('err') || m.toLowerCase().includes('fail');
            return (
              <div
                key={i}
                style={{
                  color: isStage
                    ? 'var(--sx-accent-hi)'
                    : isErr
                    ? 'var(--sx-danger-hi)'
                    : isWarn
                    ? 'var(--sx-warn-hi)'
                    : 'var(--sx-ink-2)',
                  fontWeight: isStage ? 700 : 400,
                }}
              >
                {m}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}