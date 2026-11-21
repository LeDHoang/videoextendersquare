import { useCallback, useEffect, useRef, useState } from 'react';
import UploadZone from '../ui/UploadZone.jsx';
import { onRovingKeyDown } from '../ui/roving.js';
import { formatClock, stageLayout } from './stageGeometry.js';
import { TARGET_ASPECTS, aspectMatches, masterSize } from '../../utils/aspect.js';
import { STEREO_LABELS, stereoEyeSize } from '../../utils/mediaFormat.js';

// Left half of the Upload Studio: the master stage in the target shape
// (`target`: '1:1' | '16:9' | '9:16', null for the file's own). Shows where the
// source sits inside it, which bands the outpaint model will generate, and —
// once a render finishes — the extended result.

// Square transport glyphs in currentColor; the Unicode media symbols render as emoji on some platforms.
function TransportGlyph({ name }) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false">
      {name === 'pause' ? (
        <path d="M3 2h4v12H3zM9 2h4v12H9z" />
      ) : name === 'restart' ? (
        <path d="M2 2h2v12H2zM14 2v12L5 8z" />
      ) : (
        <path d="M4 2l10 6-10 6z" />
      )}
    </svg>
  );
}

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

const TRIM_STEP = 0.5;
const roundTenth = (value) => Math.round(value * 10) / 10;

// The part of a long clip a cloud job makes, as a window on a lane under the
// seek track. Drag its body to move it, its edges to make it shorter or longer
// (1 s up to `max`). `onMove(start, dur, edge)` reports each change while it
// moves; `onDone(start)` fires when a drag or key press ends.
// It lies over the seek track: a click on the range that does not drag seeks
// there through `onSeek(time)`.
function TrimLane({ duration, start, dur, max, onMove, onDone, onSeek }) {
  const laneRef = useRef(null);
  const end = start + dur;
  // New { start, dur } for `part` moved by `delta` seconds from `from`.
  const shift = (part, from, delta) => {
    const fromEnd = from.start + from.dur;
    if (part === 'start') {
      const next = Math.min(Math.max(from.start + delta, 0, fromEnd - max), fromEnd - 1);
      return { start: next, dur: fromEnd - next };
    }
    if (part === 'end') {
      const next = Math.max(Math.min(fromEnd + delta, duration, from.start + max), from.start + 1);
      return { start: from.start, dur: next - from.start };
    }
    return { start: Math.min(Math.max(from.start + delta, 0), duration - from.dur), dur: from.dur };
  };
  const report = (part, next) => {
    onMove(roundTenth(next.start), roundTenth(next.dur), part === 'end' ? 'end' : 'start');
    return roundTenth(next.start);
  };
  const onPointerDown = (part) => (event) => {
    const rect = laneRef.current?.getBoundingClientRect();
    const width = rect?.width;
    if (!width || event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    const from = { start, dur };
    const x = event.clientX;
    const target = event.currentTarget;
    target.focus();
    target.setPointerCapture?.(event.pointerId);
    let last = from.start;
    let moved = false;
    const move = (moveEvent) => {
      if (!moved && Math.abs(moveEvent.clientX - x) < 3) return;
      moved = true;
      last = report(part, shift(part, from, ((moveEvent.clientX - x) / width) * duration));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (!moved && part === 'body') onSeek(((x - rect.left) / width) * duration);
      else onDone(last);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  const onKeyDown = (part) => (event) => {
    const step = { ArrowLeft: -TRIM_STEP, ArrowDown: -TRIM_STEP, ArrowRight: TRIM_STEP, ArrowUp: TRIM_STEP }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    onDone(report(part, shift(part, { start, dur }, step)));
  };
  const handle = (part, label, value, min, maxValue, text) => ({
    role: 'slider',
    tabIndex: 0,
    'aria-label': label,
    'aria-valuemin': roundTenth(min),
    'aria-valuemax': roundTenth(maxValue),
    'aria-valuenow': roundTenth(value),
    'aria-valuetext': text,
    onPointerDown: onPointerDown(part),
    onKeyDown: onKeyDown(part),
  });
  return (
    <div className="sx-studio-trim" ref={laneRef}>
      <div
        className="sx-studio-trim-window"
        style={{ left: `${(start / duration) * 100}%`, width: `${(dur / duration) * 100}%` }}
        {...handle('body', 'Trim range', start, 0, duration - dur, `${formatClock(start)} to ${formatClock(end)}`)}
      >
        <span
          className="sx-studio-trim-edge sx-start"
          {...handle('start', 'Trim start', start, Math.max(0, end - max), end - 1, formatClock(start))}
        />
        <span
          className="sx-studio-trim-edge sx-end"
          {...handle('end', 'Trim end', end, start + 1, Math.min(duration, start + max), formatClock(end))}
        />
      </div>
    </div>
  );
}

// Transport for the stage <video>: play/pause, restart, ±1s, seek, loop.
// `trim` ({ start, dur, max, duration, onChange }) is the part of a long clip a
// cloud job makes: playback stays inside it, and moving it plays it from its
// start. It is laid out on the clip's staged duration, known before the
// <video> loads its metadata.
export function StageTransport({ video, trim, status }) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [muted, setMuted] = useState(false);
  const trimSpan = Number(trim?.duration) || duration;
  const trimWindow = trim && trimSpan
    ? { start: Math.min(Math.max(0, Number(trim.start) || 0), trimSpan), end: Math.min(trimSpan, (Number(trim.start) || 0) + (Number(trim.dur) || 0)) }
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

  // While the range moves the frame at its moving edge shows; once it settles
  // the range plays from its start (and loops when LOOP is on).
  const moveTrim = (start, dur, edge) => {
    trim.onChange(start, dur);
    if (!video) return;
    video.pause();
    video.currentTime = edge === 'end' ? start + dur : start;
    setTime(video.currentTime);
  };
  const playTrim = (start) => {
    if (!video) return;
    video.currentTime = start;
    video.play().catch(() => {});
  };

  const progress = duration ? (time / duration) * 100 : 0;
  return (
    <div className="sx-studio-transport" role="group" aria-label="Stage playback">
      <div className={`sx-studio-track ${trimWindow ? 'sx-trimmed' : ''}`}>
        <div className="sx-studio-track-fill" style={{ width: `${progress}%` }} />
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
        {trimWindow ? (
          <TrimLane
            duration={trimSpan}
            start={trimWindow.start}
            dur={trimWindow.end - trimWindow.start}
            max={Math.min(trim.max, trimSpan)}
            onMove={moveTrim}
            onDone={playTrim}
            onSeek={playTrim}
          />
        ) : null}
      </div>
      {trimWindow ? (
        <div className="sx-studio-readout">
          <span>MAKES <b>{formatClock(trimWindow.start)} → {formatClock(trimWindow.end)}</b> ({(trimWindow.end - trimWindow.start).toFixed(1)}s)</span>
          <span className="sx-studio-accent">MAX {trim.max}s</span>
        </div>
      ) : null}
      <div className="sx-studio-transport-row">
        <div className="sx-studio-transport-buttons">
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="sx-studio-tbtn sx-primary"><TransportGlyph name={playing ? 'pause' : 'play'} /></button>
          <button type="button" onClick={() => seek(trimWindow ? trimWindow.start : 0)} aria-label="Restart" className="sx-studio-tbtn"><TransportGlyph name="restart" /></button>
          <button type="button" onClick={() => seek(time - 1)} aria-label="Back 1 second" className="sx-studio-tbtn">−1s</button>
          <button type="button" onClick={() => seek(time + 1)} aria-label="Forward 1 second" className="sx-studio-tbtn">+1s</button>
          <span className="sx-studio-clock">{formatClock(time)} <span>/ {formatClock(duration)}</span></span>
        </div>
        <div className="sx-studio-transport-buttons">
          <label className="sx-studio-check">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            <span>LOOP{trimWindow ? ' RANGE' : ''}</span>
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
  if (entry.status === 'cancelled') return ['CANCELLED', 'muted'];
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
  stereo,
  upscaleOnly,
  targetLabel,
  target = '1:1',
  trim,
  outpaintActive,
  onMoveGalleryItem,
  onRemoveGalleryItem,
  onRemoveBatchItem,
  locked,
  modeSwitch,
}) {
  const replaceRef = useRef(null);
  const [view, setView] = useState('original');
  const [videoEl, setVideoEl] = useState(null);
  const selected = entries.find((entry) => entry.key === selectedKey) || entries[0] || null;
  const result = selected?.result || null;
  const geometry = selected ? stageLayout(selected.meta, target) : null;
  const isSlideshow = layout === 'slideshow';
  const kind = selected?.kind || null;

  // Jump to the extended view as soon as the selected item's render lands.
  const resultUrl = result ? (result.preview_url || result.download_url) : null;
  useEffect(() => {
    setView(resultUrl ? 'extended' : 'original');
  }, [resultUrl, selected?.key]);

  const showExtended = view === 'extended' && resultUrl;
  // A MAKE 3D result is a side-by-side pair; the stage shows its left eye.
  const resultStereo = result?.stereo_layout || null;
  // 3D stereo uploads show their left eye filling the stage, as 2D views will.
  const stereoEye = stereo && geometry ? stereoEyeSize(stereo, geometry.width, geometry.height) : null;
  // The stage takes the shape of what it shows: the result (its left eye for 3D),
  // the source's eye, the first slide of a post, else the target canvas.
  const cover = entries[0]?.meta;
  const frame = showExtended && result.width
    ? stereoEyeSize(resultStereo, result.width, result.height)
    : stereoEye
      || (isSlideshow && cover?.width && cover?.height ? { width: cover.width, height: cover.height } : null)
      || (geometry && !isSlideshow ? { width: geometry.stageWidth, height: geometry.stageHeight } : null);
  const [masterWidth, masterHeight] = masterSize(1, 1, target || '1:1');
  // The shape a file already has and is kept in: the target, else its own when it is one of the three.
  const already = target || (geometry && TARGET_ASPECTS.find((shape) => aspectMatches(geometry.width, geometry.height, shape))) || null;
  const showZones = !showExtended && !isSlideshow && !stereo && geometry && !geometry.square && extendPath && !upscaleOnly;
  const meta = selected?.meta || {};
  const stageLabel = showExtended
    ? resultStereo ? `3D ${STEREO_LABELS[resultStereo]} · LEFT EYE` : `EXTENDED MASTER${result.width ? ` (${result.width}×${result.height})` : ''}`
    : stereoEye
      ? `LEFT EYE · 2D VIEW (${stereoEye.width}×${stereoEye.height})`
      : isSlideshow
        ? 'PLAYER VIEW · FIRST SLIDE SETS THE SHAPE'
        : '';

  return (
    <div className="sx-studio-stage-col">
      <div className="sx-studio-stage-wrap">
        <div className="sx-studio-toolbar">
          <div className="sx-studio-tabs">
            {modeSwitch}
            <div className="sx-seg sx-studio-view" role="radiogroup" aria-label="Stage view" onKeyDown={onRovingKeyDown}>
              {['original', 'extended'].map((option) => (
                <button
                  type="button"
                  key={option}
                  role="radio"
                  aria-checked={(showExtended ? 'extended' : 'original') === option}
                  tabIndex={(showExtended ? 'extended' : 'original') === option ? 0 : -1}
                  className={(showExtended ? 'extended' : 'original') === option ? 'sx-selected' : ''}
                  disabled={option === 'extended' && !resultUrl}
                  onClick={() => setView(option)}
                >
                  {option === 'extended' && resultStereo ? '3D' : option.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="sx-studio-pills">
            {stereoEye ? (
              <>
                <span className="sx-studio-pill"><i className="sx-studio-dot" aria-hidden="true" />3D {STEREO_LABELS[stereo]} · {geometry.width}×{geometry.height}</span>
                <span className="sx-studio-pill sx-accent">EYE: {stereoEye.width}×{stereoEye.height} ×2</span>
              </>
            ) : geometry && !isSlideshow ? (
              <>
                <span className="sx-studio-pill"><i className="sx-studio-dot" aria-hidden="true" />{[selected.sourceKnown === false ? null : `${geometry.width}×${geometry.height}`, result?.width ? `${result.width}×${result.height}` : targetLabel].filter(Boolean).join(' ➔ ') || target || 'SAME SHAPE'}</span>
              </>
            ) : (
              <span className="sx-studio-pill">{isSlideshow ? `${entries.length} IMAGES · AS-IS` : target ? `TARGET ${masterWidth}×${masterHeight} · ${target}` : 'SAME SHAPE'}</span>
            )}
          </div>
          {selected && onFiles && !locked ? (
            <label
              className="sx-studio-reset"
              title={layout === 'batch' ? 'Replace batch' : 'Replace source'}
              aria-label={layout === 'batch' ? 'Replace batch' : 'Replace source'}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
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
        </div>

        <div
          className={`sx-studio-stage ${layout === 'empty' ? 'sx-empty' : ''} ${frame && frame.height > frame.width ? 'sx-portrait' : ''}`}
          style={frame ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined}
          role="region"
          aria-label="Master stage"
        >
          <div className="sx-studio-reticle" aria-hidden="true" />
          {layout === 'empty' && !staging ? (
            <div className="sx-studio-drop">
              <UploadZone accept={accept} multiple onFiles={onFiles} caption={dropCaption} />
            </div>
          ) : null}

          {selected && showExtended ? (
            kind === 'video' ? (
              <StageVideo
                src={resultUrl}
                label={resultStereo ? `Left eye of the 3D result for ${selected.name}` : `Rendered video for ${selected.name}`}
                onElement={setVideoEl}
                className={resultStereo ? `sx-studio-fill sx-stereo-${resultStereo}` : 'sx-studio-fill'}
              />
            ) : resultStereo ? (
              <img className={`sx-studio-fill sx-stereo-${resultStereo}`} src={resultUrl} alt={`3D result for ${selected.name} (left eye)`} />
            ) : (
              <img className="sx-studio-fill" src={resultUrl} alt={`Rendered result for ${selected.name}`} />
            )
          ) : null}

          {selected && !showExtended && selected.url ? (
            stereo ? (
              kind === 'video' ? (
                <StageVideo src={selected.url} label="Left eye of the 3D source" onElement={setVideoEl} className={`sx-studio-fill sx-stereo-${stereo}`} />
              ) : (
                <img className={`sx-studio-fill sx-stereo-${stereo}`} src={selected.url} alt={`${selected.name} (left eye)`} />
              )
            ) : isSlideshow ? (
              <img className="sx-studio-fill" src={selected.url} alt={selected.name} />
            ) : (
              <div className="sx-studio-source" style={geometry?.source}>
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
          {selected && !showExtended && geometry?.square && !isSlideshow && already ? (
            <span className="sx-studio-flag sx-ok">ALREADY {already}</span>
          ) : null}
          {selected && !showExtended && !extendPath && layout !== 'batch' ? (
            <span className={`sx-studio-flag ${stereo ? 'sx-ok' : ''}`}>{stereo ? '3D · PUBLISHED AS-IS' : 'PUBLISHED AS-IS'}</span>
          ) : null}
          {showExtended && kind === 'video' && !result.preview_url && !resultStereo ? (
            <span className="sx-studio-flag sx-warn">HEVC MASTER — BROWSER PREVIEW NEEDS AN H.264 PROXY</span>
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
            status={showExtended ? (resultStereo ? '3D H.264' : result.preview_url ? 'H.264 PROXY' : 'HEVC MASTER') : 'SOURCE'}
          />
        ) : null}

        {pickError ? (
          <div className="sx-error-box" role="alert">
            <div className="sx-error-title">FILES NOT ADDED</div>
            <div>{pickError}</div>
          </div>
        ) : null}

        {isSlideshow ? (
          <ol className="sx-upload-gallery sx-studio-strip" aria-label="Images in post order">
            {entries.map((entry, index) => (
              <li key={entry.key} className={`sx-upload-gallery-item ${entry.key === selected?.key ? 'sx-selected' : ''}`}>
                <button type="button" className="sx-studio-strip-view" onClick={() => onSelect(entry.key)} aria-label={`View ${entry.name}`} aria-pressed={entry.key === selected?.key}>
                  <img src={entry.url} alt={entry.name} className={stereo ? `sx-stereo-crop-${stereo}` : undefined} />
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
                    {entry.kind === 'image' ? <img src={entry.url} alt="" /> : <span className="sx-studio-queue-thumb" aria-hidden="true"><TransportGlyph name="play" /></span>}
                    <span className="sx-studio-queue-name">{entry.name}</span>
                    <span className="sx-studio-queue-dims">{entry.meta?.width}×{entry.meta?.height}{entry.kind === 'video' ? ` · ${entry.meta?.duration}s` : ''}</span>
                  </button>
                  <span className={`sx-studio-chip sx-${tone}`}>{chip}</span>
                  {entry.result ? (
                    <a className="sx-studio-queue-dl" href={entry.result.download_url} download aria-label={`Download 2K master of ${entry.name}`}>↓ 2K</a>
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
