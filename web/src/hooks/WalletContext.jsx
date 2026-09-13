import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';

const WalletContext = createContext(null);

export function WalletProvider({ children }) {
  const { user } = useAuth();
  const [wallet, setWallet] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [falKey, setFalKey] = useState({ configured: false, hint: '' });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setWallet(null);
      setFalKey({ configured: false, hint: '' });
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const [walletResult, keyResult] = await Promise.all([
        api.get('/api/billing/wallet'),
        api.get('/api/account/fal-key'),
      ]);
      setWallet(walletResult);
      setFalKey(keyResult);
      return walletResult;
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    api.get('/api/billing/catalog').then(setCatalog).catch(() => setCatalog(null));
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    const update = () => refresh().catch(() => {});
    const onMessage = (event) => {
      if (event.data?.type === 'echo:credits-awarded') update();
    };
    window.addEventListener('echo:credits-updated', update);
    window.addEventListener('echo:credits-awarded', update);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('echo:credits-updated', update);
      window.removeEventListener('echo:credits-awarded', update);
      window.removeEventListener('message', onMessage);
    };
  }, [refresh]);

  const quote = useCallback((kind, stageId, parameters) => (
    api.post('/api/billing/quote', { kind, stage_id: stageId, parameters })
  ), []);

  const saveFalKey = useCallback(async (value) => {
    const result = await api.put('/api/account/fal-key', { fal_key: value });
    setFalKey(result);
    return result;
  }, []);

  const deleteFalKey = useCallback(async () => {
    const result = await api.delete('/api/account/fal-key');
    setFalKey(result);
    return result;
  }, []);

  const value = useMemo(() => ({
    wallet,
    catalog,
    falKey,
    loading,
    refresh,
    quote,
    saveFalKey,
    deleteFalKey,
  }), [wallet, catalog, falKey, loading, refresh, quote, saveFalKey, deleteFalKey]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet must be used inside WalletProvider');
  return value;
}
