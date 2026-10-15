import { useCallback, useEffect, useRef, useState } from 'react';
import UploadZone from '../ui/UploadZone.jsx';
import { AccentBlock } from '../ui/primitives.jsx';
import { MASTER_SIDE, formatClock, stageLayout } from './stageGeometry.js';

// Left half of the Upload Studio: the 1:1 master stage. Shows where the
// source sits inside the square, which bands the outpaint model will
// generate, and — once a render finishes — the extended result.

function StageVideo({ src, label, onElement, className, style }) {
  const ref = useCallback((node) => onElement(node), [onElement]);
  return (
    <video
      ref={ref}
      key={src}
      className={className}
      style={style}
      src={src}
      playsInline
      preload="metadata"
      aria-label={label}
    />
  );
}

// Transport for the stage <video>: play/pause, restart, ±1s, seek, loop.
// With trimming on, playback of the original stays inside the trim window
// so the cut that will be rendered can be previewed.
export function StageTransport({ video, trim, status }) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [muted, setMuted] = useState(true);
  const trimWindow = trim?.enabled && duration
    ? { start: Math.min(Math.max(0, Number(trim.start) || 0), duration), end: Math.min(duration, (Number(trim.start) || 0) + (Number(trim.dur) || 0)) }
    : null;

  useEffect(() => {
    if (!video) return undefined;
    video.muted = muted;
    const sync = () => {
      setTime(video.currentTime || 0);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setPlaying(!video.paused && !video.ended);
    };
    const onTime = () => {
      if (trimWindow && video.currentTime >= trimWindow.end - 0.03) {
        if (loop) video.currentTime = trimWindow.start;
        else video.pause();
      }
      sync();
    };
    const onEnded = () => {
      if (loop) {
        video.currentTime = trimWindow ? trimWindow.start : 0;
        video.play().catch(() => {});
      }
      sync();
    };
    sync();
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', sync);
    video.addEventListener('durationchange', sync);
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    video.addEventListener('ended', onEnded);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', sync);
      video.removeEventListener('durationchange', sync);
      video.removeEventListener('play', sync);
      video.removeEventListener('pause', sync);
      video.removeEventListener('ended', onEnded);
    };
  }, [video, loop, muted, trimWindow?.start, trimWindow?.end]);

  const seek = (value) => {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration || 0, value));
    setTime(video.currentTime);
  };
  const toggle = () => {
    if (!video) return;
    if (video.paused || video.ended) {
      if (trimWindow && (video.currentTime < trimWindow.start || video.currentTime >= trimWindow.end - 0.03)) {
        video.currentTime = trimWindow.start;
      }
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const progress = duration ? (time / duration) * 100 : 0;
  return (
    <div className="sx-studio-transport" role="group" aria-label="Stage playback">
      <div className="sx-studio-track">
        <div className="sx-studio-track-fill" style={{ width: `${progress}%` }} />
        {trimWindow ? (
          <div
            className="sx-studio-track-trim"
            style={{ left: `${(trimWindow.start / duration) * 100}%`, width: `${((trimWindow.end - trimWindow.start) / duration) * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
        <input
          type="range"
          className="sx-studio-track-input"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(time, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Seek"
          aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
          disabled={!duration}
        />
      </div>
      <div className="sx-studio-transport-row">
        <div className="sx-studio-transport-buttons">
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="sx-studio-tbtn sx-primary">{playing ? '❚❚' : '▶'}</button>
          <button type="button" onClick={() => seek(trimWindow ? trimWindow.start : 0)} aria-label="Restart" className="sx-studio-tbtn">⏮</button>
          <button type="button" onClick={() => seek(time - 1)} aria-label="Back 1 second" className="sx-studio-tbtn">−1s</button>
          <button type="button" onClick={() => seek(time + 1)} aria-label="Forward 1 second" className="sx-studio-tbtn">+1s</button>
          <span className="sx-studio-clock">{formatClock(time)} <span>/ {formatClock(duration)}</span></span>
        </div>
        <div className="sx-studio-transport-buttons">
          <label className="sx-studio-check">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            <span>LOOP{trimWindow ? ' TRIM' : ''}</span>
          </label>
          <label className="sx-studio-check">
            <input type="checkbox" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} />
            <span>SOUND</span>
          </label>
          {status ? <span className="sx-studio-chip">{status}</span> : null}
        </div>
      </div>
    </div>
  );
}

function statusChip(entry) {
  if (entry.status === 'done') return ['✓ DONE', 'ok'];
  if (entry.status === 'failed') return ['FAILED', 'danger'];
  if (entry.status === 'rendering') return ['RENDERING', 'accent'];
  return ['STAGED', 'muted'];
}

export default function StudioStage({
  layout,
  entries,
  selectedKey,
  onSelect,
  staging,
  pickError,
  accept,
  onFiles,
  dropCaption,
  extendPath,
  upscaleOnly,
  trim,
  outpaintActive,
  onMoveGalleryItem,
  onRemoveGalleryItem,
  onRemoveBatchItem,
  locked,
}) {
  const replaceRef = useRef(null);
  const [view, setView] = useState('original');
  const [videoEl, setVideoEl] = useState(null);
  const selected = entries.find((entry) => entry.key === selectedKey) || entries[0] || null;
  const result = selected?.result || null;
  const geometry = selected ? stageLayout(selected.meta) : null;
  const isSlideshow = layout === 'slideshow';
  const kind = selected?.kind || null;

  // Jump to the extended view as soon as the selected item's render lands.
  const resultUrl = result ? (result.preview_url || result.download_url) : null;
  useEffect(() => {
    setView(resultUrl ? 'extended' : 'original');
  }, [resultUrl, selected?.key]);

  const showExtended = view === 'extended' && resultUrl;
  const showZones = !showExtended && !isSlideshow && geometry && !geometry.square && extendPath && !upscaleOnly;
  const meta = selected?.meta || {};
  const stageLabel = showExtended
    ? `EXTENDED MASTER (${MASTER_SIDE}×${MASTER_SIDE})`
    : isSlideshow
      ? 'PLAYER VIEW · 1:1 CROP'
      : geometry ? `ORIGINAL ${kind === 'video' ? 'CLIP' : 'IMAGE'} (${geometry.width}×${geometry.height})` : '';

  return (
    <div className="sx-studio-stage-col">
      <div className="sx-studio-stage-wrap">
        <div className="sx-studio-toolbar">
          <div className="sx-seg sx-studio-view" role="radiogroup" aria-label="Stage view">
            {['original', 'extended'].map((option) => (
              <button
                type="button"
                key={option}
                role="radio"
                aria-checked={(showExtended ? 'extended' : 'original') === option}
                className={(showExtended ? 'extended' : 'original') === option ? 'sx-selected' : ''}
                disabled={option === 'extended' && !resultUrl}
                onClick={() => setView(option)}
              >
                {option.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="sx-studio-pills">
            {geometry && !isSlideshow ? (
              <>
                <span className="sx-studio-pill"><i className="sx-studio-dot" aria-hidden="true" />{geometry.width}×{geometry.height} ➔ {MASTER_SIDE}×{MASTER_SIDE}</span>
                <span className="sx-studio-pill sx-accent">PAD: {geometry.padLabel}</span>
              </>
            ) : (
              <span className="sx-studio-pill">{isSlideshow ? `${entries.length} IMAGES · AS-IS` : `TARGET ${MASTER_SIDE}×${MASTER_SIDE} · 1:1`}</span>
            )}
          </div>
        </div>

        <div className={`sx-studio-stage ${layout === 'empty' ? 'sx-empty' : ''}`} role="region" aria-label="Square master stage">
          <div className="sx-studio-reticle" aria-hidden="true" />
          {layout === 'empty' && !staging ? (
            <div className="sx-studio-drop">
              <UploadZone accept={accept} multiple onFiles={onFiles} caption={dropCaption} />
            </div>
          ) : null}

          {selected && showExtended ? (
            kind === 'video' ? (
              <StageVideo src={resultUrl} label={`Rendered square video for ${selected.name}`} onElement={setVideoEl} className="sx-studio-fill" />
            ) : (
              <img className="sx-studio-fill" src={resultUrl} alt={`Rendered square result for ${selected.name}`} />
            )
          ) : null}

          {selected && !showExtended && selected.url ? (
            isSlideshow ? (
              <img className="sx-studio-fill sx-cover" src={selected.url} alt={selected.name} />
            ) : (
              <div
                className={`sx-studio-source ${upscaleOnly && extendPath && geometry && !geometry.square ? 'sx-stretched' : ''}`}
                style={upscaleOnly && extendPath ? { left: 0, top: 0, width: '100%', height: '100%' } : geometry?.source}
              >
                {kind === 'video' ? (
                  <StageVideo src={selected.url} label="Source video preview" onElement={setVideoEl} className="sx-studio-media" />
                ) : (
                  <img className="sx-studio-media" src={selected.url} alt={selected.name} />
                )}
              </div>
            )
          ) : null}

          {showZones ? (
            <div className="sx-studio-zones" aria-hidden="true">
              {geometry.zones.map((zone) => (
                <div key={zone.side} className={`sx-studio-zone sx-${zone.side}`} style={zone.style}>
                  <span className="sx-studio-zone-tag">+{zone.px}px {outpaintActive ? 'OUTPAINT' : 'PAD'}</span>
                </div>
              ))}
            </div>
          ) : null}

          {selected && stageLabel ? <span className="sx-studio-stage-label">{stageLabel}</span> : null}
          {selected && !showExtended && geometry?.square && !isSlideshow ? (
            <span className="sx-studio-flag sx-ok">ALREADY 1:1</span>
          ) : null}
          {selected && !showExtended && !extendPath && layout !== 'batch' ? (
            <span className="sx-studio-flag">PUBLISHED AS-IS</span>
          ) : null}
          {selected && !showExtended && extendPath && upscaleOnly && geometry && !geometry.square ? (
            <span className="sx-studio-flag sx-warn">UPSCALE ONLY · STRETCHED TO 1:1</span>
          ) : null}
          {showExtended && kind === 'video' && !result.preview_url ? (
            <span className="sx-studio-flag sx-warn">HEVC MASTER — BROWSER PREVIEW NEEDS AN H.264 PROXY</span>
          ) : null}

          {selected && onFiles && !locked ? (
            <label className="sx-studio-replace">
              <span aria-hidden="true">⇪</span>
              <span>{layout === 'batch' ? 'REPLACE BATCH' : 'REPLACE SOURCE'}</span>
              <input
                ref={replaceRef}
                type="file"
                accept={accept}
                multiple
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = '';
                  if (files.length) onFiles(files);
                }}
              />
            </label>
          ) : null}

          {staging ? (
            <div className="sx-studio-staging" role="status" aria-busy="true" aria-label="Staging upload">
              <span className="sx-studio-dot sx-pulse" aria-hidden="true" />
              STAGING UPLOAD…
            </div>
          ) : null}
        </div>

        {selected && kind === 'video' ? (
          <StageTransport
            video={videoEl}
            trim={showExtended ? null : trim}
            status={showExtended ? (result.preview_url ? 'H.264 PROXY' : 'HEVC MASTER') : 'SOURCE'}
          />
        ) : null}

        {pickError ? (
          <div className="sx-error-box" role="alert">
            <div className="sx-error-title">FILES NOT ADDED</div>
            <div>{pickError}</div>
          </div>
        ) : null}

        {layout !== 'batch' && kind === 'video' && Number(meta.duration) > 10 ? (
          <AccentBlock
            tone="warn"
            title={`${meta.duration}s EXCEEDS THE 10s THRESHOLD`}
            lines={['Cloud video outpainting is billed per second. Consider enabling the 15s Trimmer to optimize costs.']}
          />
        ) : null}

        {isSlideshow ? (
          <ol className="sx-upload-gallery sx-studio-strip" aria-label="Images in post order">
            {entries.map((entry, index) => (
              <li key={entry.key} className={`sx-upload-gallery-item ${entry.key === selected?.key ? 'sx-selected' : ''}`}>
                <button type="button" className="sx-studio-strip-view" onClick={() => onSelect(entry.key)} aria-label={`View ${entry.name}`} aria-pressed={entry.key === selected?.key}>
                  <img src={entry.url} alt={entry.name} />
                </button>
                <span className="sx-upload-gallery-pos">{index === 0 ? 'COVER' : index + 1}</span>
                <div className="sx-upload-gallery-actions">
                  <button type="button" onClick={() => onMoveGalleryItem(index, -1)} disabled={index === 0} aria-label={`Move ${entry.name} earlier`}>←</button>
                  <button type="button" onClick={() => onMoveGalleryItem(index, 1)} disabled={index === entries.length - 1} aria-label={`Move ${entry.name} later`}>→</button>
                  <button type="button" onClick={() => onRemoveGalleryItem(index)} aria-label={`Remove ${entry.name}`}>×</button>
                </div>
              </li>
            ))}
          </ol>
        ) : null}

        {layout === 'batch' ? (
          <ol className="sx-studio-queue" aria-label="Batch queue">
            {entries.map((entry, index) => {
              const [chip, tone] = statusChip(entry);
              return (
                <li key={entry.key} className={`sx-studio-queue-row ${entry.key === selected?.key ? 'sx-selected' : ''}`}>
                  <button type="button" className="sx-studio-queue-main" onClick={() => onSelect(entry.key)} aria-pressed={entry.key === selected?.key} aria-label={`View ${entry.name}`}>
                    <span className="sx-studio-queue-idx">{String(index + 1).padStart(2, '0')}</span>
                    {entry.kind === 'image' ? <img src={entry.url} alt="" /> : <span className="sx-studio-queue-thumb" aria-hidden="true">▶</span>}
                    <span className="sx-studio-queue-name">{entry.name}</span>
                    <span className="sx-studio-queue-dims">{entry.meta?.width}×{entry.meta?.height}{entry.kind === 'video' ? ` · ${entry.meta?.duration}s` : ''}</span>
                  </button>
                  <span className={`sx-studio-chip sx-${tone}`}>{chip}</span>
                  {entry.result ? (
                    <a className="sx-studio-queue-dl" href={entry.result.download_url} download aria-label={`Download 4K master of ${entry.name}`}>↓ 4K</a>
                  ) : null}
                  {!locked && !entry.status ? (
                    <button type="button" className="sx-studio-queue-x" onClick={() => onRemoveBatchItem(entry.key)} aria-label={`Remove ${entry.name}`}>×</button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </div>
  );
}
