import { createContext, useContext } from 'react';
import { useConfig } from './useConfig.js';

const ConfigContext = createContext(null);

// Single shared config state (FAL key status + model/pricing catalog) mounted
// once in AppShell. Pages consume the model catalog via useConfigContext() so
// options and pricing come from the backend's /api/config (core/models.py)
// instead of hardcoded copies that could drift.
export function ConfigProvider({ children }) {
  const cfg = useConfig();
  return <ConfigContext.Provider value={cfg}>{children}</ConfigContext.Provider>;
}

export function useConfigContext() {
  return useContext(ConfigContext);
}