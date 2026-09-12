import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { useMessaging } from '../../hooks/MessagingContext.jsx';
import { ReelsPlayerSkeleton } from './Skeleton.jsx';

// Embeds the Reels/VR player directly in the page (no iframe) so it sizes
// itself to the viewport. The backend returns scoped CSS + body HTML + the
// player scripts; we re-inject them in order and clean up on change.
export default function ReelsPlayer({
  params,
  initialIndex = 0,
  previewMode = false,
  previewOptions = {},
  onPreviewReady,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, setUser } = useAuth();
  const messaging = useMessaging();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const mountRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const start = Math.max(0, initialIndex | 0);
  const sig = JSON.stringify({ ...params, start, viewer: user?.id || null });
  const previewSig = JSON.stringify(previewOptions || {});

  useEffect(() => {
    const onNavigate = (event) => {
      const path = event.detail?.path;
      if (!path || !path.startsWith('/') || path.startsWith('//')) return;
      event.preventDefault();
      navigate(path);
    };
    const onAuthRequired = (event) => {
      event.preventDefault();
      setUser(null);
      const next = event.detail?.next || location.pathname + location.search;
      navigate('/login?next=' + encodeURIComponent(next));
    };
    const onShareReel = (event) => {
      const postId = event.detail?.post_id;
      if (postId) messaging.openShare(event.detail);
    };
    window.addEventListener('echo:navigate', onNavigate);
    window.addEventListener('echo:auth-required', onAuthRequired);
    window.addEventListener('echo:share-reel', onShareReel);
    return () => {
      window.removeEventListener('echo:navigate', onNavigate);
      window.removeEventListener('echo:auth-required', onAuthRequired);
      window.removeEventListener('echo:share-reel', onShareReel);
    };
  }, [navigate, location.pathname, location.search, messaging, setUser]);

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
    host.id = 'sxReelsHost';
    host.innerHTML = data.html;
    mount.appendChild(host);

    for (const code of data.scripts) {
      const s = document.createElement('script');
      s.textContent = code;
      mount.appendChild(s);
    }
    let previewFrame = 0;
    if (previewMode) {
      previewFrame = window.requestAnimationFrame(() => {
        try {
          const renderer = window.WebXRVR;
          const canvas = previewCanvasRef.current;
          if (!renderer?.startPreview || !canvas) throw new Error('Preview renderer did not initialize.');
          renderer.startPreview(canvas, previewOptions);
          onPreviewReady?.(renderer);
        } catch (error) {
          setErr(String(error?.message || error));
        }
      });
    }
    // Tear down player timers/handlers (e.g. the image-reel dwell timer).
    return () => {
      if (previewFrame) window.cancelAnimationFrame(previewFrame);
      if (previewMode && window.WebXRVR?.stopPreview) {
        try {
          window.WebXRVR.stopPreview();
        } catch {
          /* best-effort */
        }
      }
      if (typeof window !== 'undefined' && typeof window.__sxReelsCleanup === 'function') {
        try {
          window.__sxReelsCleanup();
        } catch {
          /* best-effort */
        }
      }
    };
  }, [data, previewMode, previewSig]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {err ? (
        <div className="sx-error-box">
          <div className="sx-error-title">PLAYER ERROR</div>
          <div>{err}</div>
        </div>
      ) : null}
      {!data && !err ? <ReelsPlayerSkeleton label="Loading reels player" /> : null}
      {previewMode ? (
        <div className="sx-immersive-preview-stage">
          <canvas
            ref={previewCanvasRef}
            className="sx-immersive-preview-canvas"
            tabIndex="0"
            role="img"
            aria-label="Interactive desktop preview of the immersive Reels scene"
          />
          <div ref={mountRef} id="sxReelsRoot" className="sx-reels-mount sx-immersive-preview-source" aria-hidden="true" />
        </div>
      ) : (
        <div ref={mountRef} id="sxReelsRoot" className="sx-reels-mount" />
      )}
    </div>
  );
}
