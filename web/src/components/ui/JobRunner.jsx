import { useSSE } from '../../hooks/useSSE.js';
import Progress from './Progress.jsx';
import Emoji from './Emoji.jsx';

// Tracks a single pipeline job over SSE and renders progress + result.
export default function JobRunner({ jobId, name, kind }) {
  const { job, error } = useSSE(`/api/${kind}/jobs/${jobId}/stream`);

  if (!job && !error) {
    return (
      <div className="sx-job">
        <div className="sx-job-head">
          <span className="sx-job-name">{name}</span>
          <span className="sx-job-status sx-queued">CONNECTING…</span>
        </div>
      </div>
    );
  }

  if (job?.status === 'complete' && job.result) {
    return (
      <div className="sx-job">
        <div className="sx-job-head">
          <span className="sx-job-name">{name}</span>
          <span className="sx-job-status sx-done">✓ COMPLETE</span>
        </div>
        {kind === 'image' ? (
          <img
            className="sx-img"
            src={job.result.download_url}
            alt={name}
            style={{ display: 'block', margin: '8px 0', maxHeight: 420 }}
          />
        ) : (
          <>
            <video className="sx-video" src={job.result.preview_url || job.result.download_url} controls playsInline />
            {!job.result.preview_url ? (
              <div className="sx-gated-reason">
                HEVC MASTER — BROWSER PLAYBACK NEEDS THE H.264 PROXY; DOWNLOAD TO VIEW
              </div>
            ) : null}
          </>
        )}
        <a className="sx-download" href={job.result.download_url} download>
          <Emoji text="↓ DOWNLOAD MASTER" />
        </a>
        {job.result.preview_url && job.result.preview_url !== job.result.download_url ? (
          <a className="sx-download" style={{ marginLeft: 8 }} href={job.result.preview_url} download>
            <Emoji text="↓ PROXY (H.264)" />
          </a>
        ) : null}
      </div>
    );
  }

  if (job?.status === 'failed' || (!job && error)) {
    const detail = job?.error?.[1] || error?.message || 'Unknown error';
    const headline = job?.error?.[0] || 'JOB FAILED';
    return (
      <div className="sx-error-box">
        <div className="sx-error-title">{headline}</div>
        <div>{detail}</div>
      </div>
    );
  }

  return <Progress job={job} name={name} />;
}