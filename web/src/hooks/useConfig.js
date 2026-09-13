import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

// Read/write app config: FAL key status + model endpoints.
export function useConfig() {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    api
      .get('/api/config')
      .then(setConfig)
      .catch(() => setConfig({ fal_key_set: false, fal_key_masked: '', models: {} }));
  }, []);

  const setModels = async (updates) => {
    const res = await api.put('/api/config/models', updates);
    setConfig((c) => ({ ...c, models: res.models }));
    return res;
  };

  return { config, setModels };
}