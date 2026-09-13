import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { billingErrorMessage } from '../utils/billingErrors.js';
import { useWallet } from './WalletContext.jsx';

export function useCreditQuotes({ kind, items, parameters, enabled }) {
  const { quote } = useWallet();
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const parameterKey = useMemo(() => JSON.stringify(parameters), [parameters]);
  const seqRef = useRef(0);
  const abortRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!enabled || !items.length) {
      setQuotes([]);
      setError('');
      return [];
    }
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const next = await Promise.all(items.map((item) => quote(kind, item.stage_id, parameters, controller.signal)));
      if (seq !== seqRef.current) return []; // A newer refresh won; drop stale results.
      setQuotes(next);
      return next;
    } catch (requestError) {
      if (seq !== seqRef.current) return []; // Stale (or aborted) — newer refresh owns the state.
      if (requestError?.name === 'AbortError') return [];
      setQuotes([]);
      setError(billingErrorMessage(requestError, 'Could not calculate credit quote'));
      throw requestError;
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [enabled, items, kind, parameterKey, quote]);

  useEffect(() => {
    if (!enabled || !items.length) {
      setQuotes([]);
      setError('');
      return undefined;
    }
    const timer = setTimeout(() => { refresh().catch(() => {}); }, 250);
    return () => clearTimeout(timer);
  }, [enabled, items, parameterKey, refresh]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    quotes,
    loading,
    error,
    totalCredits: quotes.reduce((sum, item) => sum + Number(item.credits || 0), 0),
    totalProviderUsd: quotes.reduce((sum, item) => sum + Number(item.provider_cost_usd || 0), 0),
    refresh,
  };
}
