import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const HealthContext = createContext(null);

// Single shared poller for /api/health, mounted once in AppShell. Previously
// every page called useHealth() itself *in addition to* AppShell, so /image
// and /video each ran two independent 8s intervals against the same probe
// endpoint. refresh() is now a stable callback (not a new closure every
// render) so it doesn't tear down and recreate the interval on every call.
export function HealthProvider({ children, intervalMs = 8000 }) {
  const [health, setHealth] = useState(null);
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    api
      .get('/api/health')
      .then((d) => aliveRef.current && setHealth(d))
      .catch(() => aliveRef.current && setHealth({ probes: {}, fal_key: null }));
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [intervalMs, load]);

  const value = { ...health, refresh: load };
  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}

export function useHealthContext() {
  return useContext(HealthContext) ?? {};
}
