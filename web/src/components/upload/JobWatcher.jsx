import { useEffect, useRef } from 'react';
import { TERMINAL_STATUSES, useSSE } from '../../hooks/useSSE.js';

// Follows one job and draws nothing: the Upload page keeps one per running job,
// so a job is followed once however many tiles and dialogs show it.
// onProgress(job) on every update; onDone(result) once when it completes;
// onSettled(job) once on any final state (complete, failed, cancelled).
export default function JobWatcher({ jobId, kind, onProgress, onDone, onSettled }) {
  const { job } = useSSE(`/api/${kind}/jobs/${jobId}/stream`);
  const handlers = useRef({});
  handlers.current = { onProgress, onDone, onSettled };
  const doneRef = useRef(false);
  const settledRef = useRef(false);

  useEffect(() => {
    if (!job) return;
    handlers.current.onProgress?.(job);
    if (job.status === 'complete' && job.result && !doneRef.current) {
      doneRef.current = true;
      handlers.current.onDone?.(job.result);
    }
    if (TERMINAL_STATUSES.has(job.status) && !settledRef.current) {
      settledRef.current = true;
      handlers.current.onSettled?.(job);
    }
  }, [job]);

  return null;
}
