import {
  AlertIcon, CheckIcon, CloudIcon, CubeIcon, DeviceIcon, IndustrialImageIcon, IndustrialVideoIcon, SendIcon, SquareIcon, TrashIcon,
} from '../icons/index.jsx';
import { formatLeft, shelfOf, stereoOf, timeLeft } from './mediaItems.js';

// How much of an item's storage window is left, as a ring that empties.
export function CountdownRing({ left }) {
  const label = formatLeft(left.ms);
  const r = 8;
  const around = 2 * Math.PI * r;
  return (
    <span className={`sx-media-ring ${left.fraction < 0.2 ? 'sx-low' : ''}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r={r} className="sx-media-ring-track" />
        <circle cx="10" cy="10" r={r} className="sx-media-ring-left" strokeDasharray={`${around * left.fraction} ${around}`} transform="rotate(-90 10 10)" />
      </svg>
    </span>
  );
}

function Mark({ label, children }) {
  return <span className="sx-media-mark" role="img" aria-label={label} title={label}>{children}</span>;
}

const STATE = {
  needs: ['Needs to be made square', SquareIcon, 'sx-warn'],
  working: ['Being made square', SquareIcon, 'sx-accent'],
  ready: ['Ready to post', CheckIcon, 'sx-ok', 'Ready'],
  posted: ['Posted', SendIcon, 'sx-ink', 'Posted'],
};

// One file as a square tile: the picture on carbon, with chips for what it is and what it needs.
export default function MediaTile({ item, now, retention, progress, price, onOpen, onCheck, onDiscard }) {
  const shelf = shelfOf(item);
  const [stateLabel, StateIcon, stateTone, stateWord] = STATE[shelf];
  const stereo = stereoOf(item);
  const threeD = stereo || item.convert?.status === 'ready';
  const left = timeLeft(item, retention, now);
  const failed = item.render?.status === 'failed' || item.render?.status === 'cancelled';
  const unsaved = shelf !== 'posted' && item.render?.status === 'ready' && item.render.kept === false;
  const saved = !!item.render?.kept || shelf === 'posted';
  const KindIcon = item.kind === 'video' ? IndustrialVideoIcon : IndustrialImageIcon;
  // After a reload there is no local file, and without cloud storage no thumbnail:
  // fall back to the result's browser-playable copy.
  const resultUrl = item.render?.result?.preview_url;
  const picture = item.kind === 'image' ? item.url || item.thumb || resultUrl : item.thumb;
  const videoUrl = item.url || resultUrl;
  const pct = Math.round((progress?.progress || 0) * 100);

  return (
    <li className={`sx-media-tile sx-${shelf}`}>
      <button type="button" className="sx-media-open" onClick={() => onOpen(item)} aria-label={`Open ${item.name}`} title={item.name}>
        {picture ? (
          <img src={picture} alt="" className={stereo ? `sx-stereo-crop-${stereo}` : undefined} />
        ) : item.kind === 'video' && videoUrl ? (
          <video src={videoUrl} muted playsInline preload="metadata" />
        ) : (
          <KindIcon className="sx-media-placeholder" />
        )}
        {shelf === 'working' ? (
          <span className="sx-media-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Making ${item.name} square`}>
            <i style={{ width: `${pct}%` }} />
          </span>
        ) : null}
      </button>
      {onCheck ? (
        <input type="checkbox" className="sx-media-check" checked={!!item.checked} onChange={(e) => onCheck(item, e.target.checked)} aria-label={`Select ${item.name}`} />
      ) : null}
      {onDiscard ? (
        <button type="button" className="sx-media-discard" onClick={() => onDiscard(item)} aria-label={`Discard ${item.name}`} title="Discard">
          <TrashIcon />
        </button>
      ) : null}
      <div className="sx-media-marks">
        <span className={`sx-media-badge ${stateTone}`}>
          <Mark label={stateLabel}><StateIcon /></Mark>
          {price != null ? <span className="sx-media-price" title="Price to make this square">{price} cr</span> : null}
          {stateWord ? <span aria-hidden="true">{stateWord}</span> : null}
          {shelf === 'working' ? <span aria-hidden="true">{pct}%</span> : null}
        </span>
        {failed ? <span className="sx-media-badge sx-danger"><Mark label="Could not be made square. Try again."><AlertIcon /></Mark></span> : null}
        {unsaved ? <span className="sx-media-badge sx-danger"><Mark label="Not saved to the cloud. Download it now."><AlertIcon /></Mark></span> : null}
        {threeD ? <span className="sx-media-badge sx-accent"><Mark label="3D"><CubeIcon /></Mark></span> : null}
        <span className="sx-media-spacer" />
        <span className="sx-media-chip">
          <Mark label={item.kind === 'video' ? 'Video' : 'Image'}><KindIcon className="sx-media-icon" /></Mark>
          <Mark label={saved ? 'Saved to the cloud' : 'On this device and server for a short time'}>{saved ? <CloudIcon /> : <DeviceIcon />}</Mark>
          {left ? <CountdownRing left={left} /> : null}
        </span>
      </div>
    </li>
  );
}
