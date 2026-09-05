import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';

// Embeds the Reels/VR player directly in the page (no iframe) so it sizes
// itself to the viewport. The backend returns scoped CSS + body HTML + the
// player scripts; we re-inject them in order and clean up on change.
export default function ReelsPlayer({ params, initialIndex = 0 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const mountRef = useRef(null);
  const start = Math.max(0, initialIndex | 0);
  const sig = JSON.stringify({ ...params, start });

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr('');
    api
      .get('/api/reels/player-inline', { ...params, start })
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setErr(String(e.message || e));
      });
    return () => {
      alive = false;
    };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.__sxReelsCleanup === 'function') {
      window.__sxReelsCleanup();
      window.__sxReelsCleanup = null;
    }
    if (!data) return undefined;
    const mount = mountRef.current;
    if (!mount) return undefined;

    mount.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = data.css;
    mount.appendChild(style);

    const host = document.createElement('div');
    host.innerHTML = data.html;
    mount.appendChild(host);

    for (const code of data.scripts) {
      const s = document.createElement('script');
      s.textContent = code;
      mount.appendChild(s);
    }
    return undefined;
  }, [data]);

  return (
    <div>
      {err ? (
        <div className="sx-error-box">
          <div className="sx-error-title">PLAYER ERROR</div>
          <div>{err}</div>
        </div>
      ) : null}
      <div ref={mountRef} id="sxReelsRoot" className="sx-reels-mount" />
    </div>
  );
}