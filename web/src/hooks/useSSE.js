import { useEffect, useState } from 'react';

// Subscribe to a job's SSE progress stream. Returns {job, error} where job is
// the latest server payload ({status, phase, progress, elapsed, messages,
// result, error}) or null while connecting.
export function useSSE(url) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!url) return undefined;
    const es = new EventSource(url);
    let reconnectTimer = null;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        setState(data);
        setError(null); // a frame arrived — any prior reconnect blip is over
        if (data.status === 'complete' || data.status === 'failed') {
          es.close();
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onopen = () => setError(null);
    es.onerror = () => {
      // EventSource auto-reconnects on a transient blip; only surface an
      // error to the UI if it hasn't recovered within a couple of retries.
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (es.readyState !== EventSource.OPEN) {
          setError(new Error('SSE connection lost'));
        }
      }, 6000);
    };

    return () => {
      clearTimeout(reconnectTimer);
      es.close();
    };
  }, [url]);

  return { job: state, error };
}