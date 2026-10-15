import { useEffect, useState } from 'react';

// Subscribe to a job's progress stream over SSE with immediate snapshot fetch
// and polling fallback. Returns {job, error}.
export function useSSE(url) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!url) return undefined;

    let isMounted = true;
    let es = null;
    let pollInterval = null;
    let reconnectTimer = null;

    // Snapshot endpoint (e.g. /api/video/jobs/:id)
    const snapshotUrl = url.replace(/\/stream\/?$/, '');

    const applyData = (data) => {
      if (!isMounted || !data) return;
      setState(data);
      setError(null);
      if ((data.status === 'complete' || data.status === 'failed') && es) {
        es.close();
        if (pollInterval) clearInterval(pollInterval);
      }
    };

    // 1. Fetch initial snapshot immediately so UI doesn't wait on SSE connect
    fetch(snapshotUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) applyData(data);
      })
      .catch(() => {});

    // 2. Open SSE stream
    try {
      es = new EventSource(url);

      const handleEvent = (ev) => {
        try {
          const raw = ev.data;
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          applyData(data);
        } catch {
          /* ignore malformed frames */
        }
      };

      es.onmessage = handleEvent;
      es.addEventListener('progress', handleEvent);
      es.addEventListener('message', handleEvent);

      es.onopen = () => {
        if (isMounted) setError(null);
      };

      es.onerror = () => {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (!isMounted) return;
          // If SSE dropped, start fallback polling
          if (es.readyState !== EventSource.OPEN) {
            if (!pollInterval) {
              pollInterval = setInterval(() => {
                fetch(snapshotUrl)
                  .then((r) => (r.ok ? r.json() : null))
                  .then((data) => {
                    if (data) applyData(data);
                  })
                  .catch(() => {});
              }, 1500);
            }
          }
        }, 3000);
      };
    } catch {
      // If EventSource fails to construct, start polling immediately
      pollInterval = setInterval(() => {
        fetch(snapshotUrl)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data) applyData(data);
          })
          .catch(() => {});
      }, 1500);
    }

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimer);
      if (pollInterval) clearInterval(pollInterval);
      if (es) es.close();
    };
  }, [url]);

  return { job: state, error };
}