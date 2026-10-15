import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { billingErrorMessage } from '../utils/billingErrors.js';
import { useWallet } from './WalletContext.jsx';

// Parameters that never change the price (core/pricing.py ignores them).
// Edits to them (typing a prompt, dragging CAS/CFG, editing a LoRA URL) do not
// re-price, which keeps the live quote under the server rate limit. Submits
// still refresh with the full parameters, so credit quotes always match.
const PRICE_NEUTRAL_KEYS = ['prompt', 'ltx_negative_prompt', 'ltx_loras', 'ltx_guidance', 'sharpening'];
const RATE_LIMIT_RETRY_MS = 5000;

function priceKey(parameters) {
  if (!parameters || typeof parameters !== 'object') return JSON.stringify(parameters);
  const priced = { ...parameters };
  PRICE_NEUTRAL_KEYS.forEach((key) => { delete priced[key]; });
  return JSON.stringify(priced);
}

// Prices `items` with the current parameters. With ECHO Credits enabled these
// are authoritative quotes (their quote_id funds a credit render). With credits
// disabled the same pricing comes back as estimates (`estimate: true`, no
// quote_id) so the cost is still visible, e.g. before paying with MY FAL KEY.
export function useCreditQuotes({ kind, items, parameters, enabled: requested }) {
  const { quote, estimate, catalog } = useWallet();
  const estimateOnly = !catalog?.credits_enabled;
  const fetchPrice = estimateOnly ? estimate : quote;
  // Wait for the catalog so a credits-enabled page never quotes as an estimate.
  const enabled = Boolean(requested && catalog);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const parameterKey = useMemo(() => priceKey(parameters), [parameters]);
  // Callers rebuild `items` on every settings change; only the staged ids matter.
  const itemsKey = items.map((item) => item.stage_id).join('|');
  // Latest values for the fetch itself, without re-pricing on neutral edits.
  const parametersRef = useRef(parameters);
  parametersRef.current = parameters;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const seqRef = useRef(0);
  const abortRef = useRef(null);
  const retryRef = useRef(null);

  const refresh = useCallback(async () => {
    const items = itemsRef.current;
    if (!enabled || !items.length) {
      setQuotes([]);
      setError('');
      return [];
    }
    const seq = ++seqRef.current;
    clearTimeout(retryRef.current);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const current = parametersRef.current;
      const next = await Promise.all(items.map((item) => fetchPrice(kind, item.stage_id, current, controller.signal)));
      if (seq !== seqRef.current) return []; // A newer refresh won; drop stale results.
      setQuotes(next);
      return next;
    } catch (requestError) {
      if (seq !== seqRef.current) return []; // Stale (or aborted) — newer refresh owns the state.
      if (requestError?.name === 'AbortError') return [];
      setQuotes([]);
      setError(billingErrorMessage(requestError, 'Could not calculate credit quote'));
      if (Number(requestError?.status) === 429) {
        // Rate limited: retry on our own (every few seconds, well under the
        // limit) instead of waiting for the next settings change.
        retryRef.current = setTimeout(() => { refresh().catch(() => {}); }, RATE_LIMIT_RETRY_MS);
      }
      throw requestError;
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [enabled, itemsKey, kind, parameterKey, fetchPrice]);

  useEffect(() => {
    if (!enabled || !items.length) {
      setQuotes([]);
      setError('');
      return undefined;
    }
    const timer = setTimeout(() => { refresh().catch(() => {}); }, 250);
    return () => clearTimeout(timer);
  }, [enabled, itemsKey, parameterKey, refresh]);

  useEffect(() => () => {
    abortRef.current?.abort();
    clearTimeout(retryRef.current);
  }, []);

  return {
    quotes,
    loading,
    error,
    estimate: estimateOnly,
    approximate: quotes.some((item) => item.approximate),
    totalCredits: quotes.reduce((sum, item) => sum + Number(item.credits || 0), 0),
    totalProviderUsd: quotes.reduce((sum, item) => sum + Number(item.provider_cost_usd || 0), 0),
    refresh,
  };
}
