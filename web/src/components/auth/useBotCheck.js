import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

/*
 * Turnstile state for one form. The site key ships with /api/config; an empty key means the
 * server skips the check. `consume()` hands out the token and asks the widget for a new one,
 * since tokens are single use. Pass `enabled = false` to skip the check (signed-in support).
 */
export default function useBotCheck(enabled = true) {
  const [siteKey, setSiteKey] = useState('');
  const [token, setToken] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const config = await api.get('/api/config');
        if (!cancelled) setSiteKey(config?.turnstile_site_key || '');
      } catch {
        // Without config the form still works; the server decides whether a bot check is required.
      }
    })();
    return () => { cancelled = true; };
  }, [enabled]);

  const active = enabled && Boolean(siteKey);
  const consume = () => {
    const current = token;
    if (active) {
      setToken('');
      setResetKey((value) => value + 1);
    }
    return current;
  };

  return {
    needsToken: active && !token && !unavailable,
    consume,
    widget: { siteKey: active ? siteKey : '', resetKey, onToken: setToken, onUnavailable: () => setUnavailable(true) },
  };
}
