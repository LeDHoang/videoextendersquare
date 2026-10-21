import { useEffect, useRef } from 'react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise = null;

function loadTurnstile() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error('turnstile blocked'));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

/*
 * Cloudflare Turnstile widget. Renders nothing without a site key (the server then skips the
 * check too). `onToken(token)` fires with a fresh token, and with '' when it expires or fails;
 * bumping `resetKey` asks for a new challenge (tokens are single use).
 */
export default function Turnstile({ siteKey, onToken, onUnavailable, resetKey = 0 }) {
  const box = useRef(null);
  const widget = useRef(null);
  const callbacks = useRef({ onToken, onUnavailable });
  callbacks.current = { onToken, onUnavailable };

  useEffect(() => {
    if (!siteKey) return undefined;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !box.current) return;
        widget.current = turnstile.render(box.current, {
          sitekey: siteKey,
          theme: 'dark',
          callback: (token) => callbacks.current.onToken?.(token),
          'expired-callback': () => callbacks.current.onToken?.(''),
          'error-callback': () => callbacks.current.onToken?.(''),
        });
      })
      .catch(() => {
        if (!cancelled) callbacks.current.onUnavailable?.();
      });
    return () => {
      cancelled = true;
      try {
        if (widget.current !== null) window.turnstile?.remove(widget.current);
      } catch {
        // The widget may already be gone with its container.
      }
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || widget.current === null) return;
    try {
      window.turnstile?.reset(widget.current);
    } catch {
      // Resetting is best effort; the widget issues a new token on its own.
    }
  }, [resetKey]);

  if (!siteKey) return null;
  return <div ref={box} className="sx-au-turnstile" data-testid="turnstile" />;
}
