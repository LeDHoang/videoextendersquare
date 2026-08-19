import { useEffect, useRef, useState } from 'react';

// Subscribe to a job's SSE progress stream. Returns {job, error} where job is
// the latest server payload ({status, phase, progress, elapsed, messages,
// result, error}) or null while connecting.
export function useSSE(url) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    if (!url) return undefined;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        setState(data);
        if (data.status === 'complete' || data.status === 'failed') {
          es.close();
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; only surface an error if we already
      // received a terminal state or the stream never opened.
      setError(new Error('SSE connection lost'));
    };

    return () => es.close();
  }, [url]);

  return { job: state, error };
}