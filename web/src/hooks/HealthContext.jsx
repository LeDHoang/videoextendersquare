import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const HealthContext = createContext(null);

// Single shared poller for /api/health, mounted once in AppShell. Previously
// every page called useHealth() itself *in addition to* AppShell, so /image
// and /video each ran two independent 8s intervals against the same probe
// endpoint. refresh() is now a stable callback (not a new closure every
// render) so it doesn't tear down and recreate the interval on every call.
//
// Polling vs probing: the backend caches probe results for ~60s (probes spawn
// ffmpeg smoke-tests, so re-probing every 8s would hammer the machine). The
// 8s interval therefore fetches the cheap cached snapshot, while refresh()
// passes ?refresh=true to force a real re-probe (sidebar RECHECK button,
// FAL-key save). `refreshing` lets the UI show a spinner during the slow
// forced probe instead of looking dead.
export function HealthProvider({ children, intervalMs = 8000 }) {
  const [health, setHealth] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const aliveRef = useRef(true);

  // Cheap poll — serves the backend's cached snapshot.
  const poll = useCallback(() => {
    api
      .get('/api/health')
      .then((d) => aliveRef.current && setHealth(d))
      .catch(() => aliveRef.current && setHealth({ probes: {}, fal_key: null }));
  }, []);

  // Forced re-probe — bypasses the backend cache (?refresh=true).
  const refresh = useCallback(() => {
    setRefreshing(true);
    return api
      .get('/api/health', { refresh: 'true' })
      .then((d) => aliveRef.current && setHealth(d))
      .catch(() => aliveRef.current && setHealth({ probes: {}, fal_key: null }))
      .finally(() => aliveRef.current && setRefreshing(false));
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [intervalMs, poll]);

  const value = { ...health, refresh, refreshing };
  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}

export function useHealthContext() {
  return useContext(HealthContext) ?? {};
}
