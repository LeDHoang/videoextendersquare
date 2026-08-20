export default function Progress({ job, name }) {
  if (!job) return null;
  const { status, phase, progress, elapsed, messages } = job;
  const cls =
    status === 'complete' ? 'sx-done' : status === 'failed' ? 'sx-fail' : status === 'running' ? 'sx-run' : 'sx-queued';
  const pct = Math.round((progress || 0) * 100);

  return (
    <div className="sx-job">
      <div className="sx-job-head">
        <span className="sx-job-name" title={name}>
          {name}
        </span>
        <span className={`sx-job-status ${cls}`}>
          {(status || 'queued').toUpperCase()} · {elapsed}
        </span>
      </div>
      <div className="sx-progress-track">
        <div className="sx-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="sx-job-phase">
        {phase} · {pct}%
      </div>
      {messages && messages.length ? (
        <div className="sx-progress-log">
          {messages.slice(-12).map((m, i) => (
            <div key={i}>{m}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}