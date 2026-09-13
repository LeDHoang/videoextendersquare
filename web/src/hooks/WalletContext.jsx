import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';

const WalletContext = createContext(null);

export function WalletProvider({ children }) {
  const { user } = useAuth();
  const [wallet, setWallet] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [catalogStatus, setCatalogStatus] = useState('loading');
  const [falKey, setFalKey] = useState({ configured: false, hint: '' });
  const [loading, setLoading] = useState(true);
  const userIdRef = useRef(null);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!user) {
      setWallet(null);
      setFalKey({ configured: false, hint: '' });
      setLoading(false);
      userIdRef.current = null;
      return null;
    }
    // Never show the previous user's balance while the next user's loads.
    if (userIdRef.current !== user.id) {
      userIdRef.current = user.id;
      setWallet(null);
    }
    if (!silent) setLoading(true);
    try {
      const [walletResult, keyResult] = await Promise.all([
        api.get('/api/billing/wallet'),
        api.get('/api/account/fal-key'),
      ]);
      setWallet(walletResult);
      setFalKey(keyResult);
      return walletResult;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    api.get('/api/billing/catalog')
      .then((result) => { setCatalog(result); setCatalogStatus('ready'); })
      .catch(() => { setCatalog(null); setCatalogStatus('failed'); });
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    // Background updates (reward toasts, N-job batch settlements) refresh
    // silently — no loading flash in the header/sidebar/panel.
    const update = () => refresh({ silent: true }).catch(() => {});
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
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

  const quote = useCallback((kind, stageId, parameters, signal) => (
    api.post('/api/billing/quote', { kind, stage_id: stageId, parameters }, signal ? { signal } : undefined)
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
    catalogStatus,
    falKey,
    loading,
    refresh,
    quote,
    saveFalKey,
    deleteFalKey,
  }), [wallet, catalog, catalogStatus, falKey, loading, refresh, quote, saveFalKey, deleteFalKey]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet must be used inside WalletProvider');
  return value;
}
