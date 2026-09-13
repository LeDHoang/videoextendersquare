import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

// Read/write app config: model endpoints catalog.
export function useConfig() {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    api
      .get('/api/config')
      .then(setConfig)
      .catch(() => setConfig({ models: {} }));
  }, []);

  const setModels = async (updates) => {
    const res = await api.put('/api/config/models', updates);
    setConfig((c) => ({ ...c, models: res.models }));
    return res;
  };

  return { config, setModels };
}