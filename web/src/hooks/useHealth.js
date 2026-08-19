import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

// Poll /api/health; returns {probes, fal_key, refresh} or null while loading.
export function useHealth(intervalMs = 8000) {
  const [health, setHealth] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get('/api/health')
        .then((d) => alive && setHealth(d))
        .catch(() => alive && setHealth({ probes: {}, fal_key: null }));
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs, tick]);

  return {
    ...health,
    refresh: () => setTick((t) => t + 1),
  };
}