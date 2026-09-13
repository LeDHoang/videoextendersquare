import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from './WalletContext.jsx';

export function useCreditQuotes({ kind, items, parameters, enabled }) {
  const { quote } = useWallet();
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const parameterKey = useMemo(() => JSON.stringify(parameters), [parameters]);

  const refresh = useCallback(async () => {
    if (!enabled || !items.length) {
      setQuotes([]);
      setError('');
      return [];
    }
    setLoading(true);
    setError('');
    try {
      const next = await Promise.all(items.map((item) => quote(kind, item.stage_id, parameters)));
      setQuotes(next);
      return next;
    } catch (requestError) {
      setQuotes([]);
      setError(requestError.message || 'Could not calculate credit quote');
      throw requestError;
    } finally {
      setLoading(false);
    }
  }, [enabled, items, kind, parameterKey, quote]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled || !items.length) {
      setQuotes([]);
      setError('');
      return undefined;
    }
    const timer = setTimeout(() => { refresh().catch(() => {}); }, 250);
    return () => clearTimeout(timer);
  }, [enabled, items, parameterKey, refresh]);

  return {
    quotes,
    loading,
    error,
    totalCredits: quotes.reduce((sum, item) => sum + Number(item.credits || 0), 0),
    totalProviderUsd: quotes.reduce((sum, item) => sum + Number(item.provider_cost_usd || 0), 0),
    refresh,
  };
}
