import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export const TOAST_MS = 4000;

const ToastContext = createContext(() => {});

/**
 * Toast: a short note that something worked ("Report submitted.", "Link copied."), shown at
 * the bottom of the screen for TOAST_MS. A new one replaces the last. The live region is
 * always on the page, so screen readers hear each message. Errors are not toasts: they stay
 * inline (role="alert") next to what failed, until the person fixes them.
 *
 * Wrap the app in <ToastProvider> once; a component calls `const toast = useToast()`, then
 * `toast('Link copied.')`.
 */
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const count = useRef(0);
  const timer = useRef(0);

  const show = useCallback((message) => {
    window.clearTimeout(timer.current);
    count.current += 1;
    setToast({ id: count.current, message });
    timer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="sx-toasts" aria-live="polite">
        {toast ? <div key={toast.id} className="sx-toast" role="status">{toast.message}</div> : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
