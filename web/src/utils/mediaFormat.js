/** Whole seconds as "0:29", "1:05", "1:02:03" (0 -> "0:00"). */
export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** "0:29", "1:05", "1:02:03" — empty when the runtime is unknown. */
export function formatDuration(ms) {
  const total = Number(ms);
  if (!Number.isFinite(total) || total <= 0) return '';
  return formatClock(Math.max(1, Math.round(total / 1000)));
}

/** "3840×3840" — empty unless both sides are known. */
export function formatResolution(width, height) {
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  return w > 0 && h > 0 ? `${w}×${h}` : '';
}

// Image posts stay on screen this long in the player unless they set dwell_ms.
export const IMAGE_POST_DWELL_MS = 15000;

/** How long an image post plays in the Reels player. */
export function imageDwellMs(post) {
  const ms = Number(post?.dwell_ms);
  return Number.isFinite(ms) && ms >= 1000 ? ms : IMAGE_POST_DWELL_MS;
}

/** "IMAGE" for a one-image post, "IMAGES · 3" for a slideshow, '' for video. */
export function imagePostLabel(post) {
  if (post?.media_type !== 'image') return '';
  const count = post.images?.length || 1;
  return count > 1 ? `IMAGES · ${count}` : 'IMAGE';
}

/**
 * Combined play time of a pack: video runtimes plus each image post's dwell.
 * `complete` is false when some available video has no known runtime, so the
 * total is a lower bound.
 */
export function packRuntime(items) {
  let ms = 0;
  let known = 0;
  let unknown = 0;
  for (const item of items || []) {
    const post = item?.available ? item.post : null;
    if (!post) continue;
    if (post.media_type === 'image') {
      ms += imageDwellMs(post);
      known += 1;
      continue;
    }
    const duration = Number(post.duration_ms);
    if (Number.isFinite(duration) && duration > 0) {
      ms += duration;
      known += 1;
    } else {
      unknown += 1;
    }
  }
  return { ms, known, complete: unknown === 0 };
}

// ─── Stereoscopic 3D posts (docs/stereo-3d-reels.md) ─────────────────────

/** 'sbs' | 'tb' for a 3D post (or a staged upload's chosen layout), else 'mono'. */
export function stereoLayout(item) {
  const layout = item?.stereo_layout;
  return layout === 'sbs' || layout === 'tb' ? layout : 'mono';
}

/** The stereo layout an exact 2:1 / 1:2 frame could hold, else null. */
export function stereoCandidate(width, height) {
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  if (!(w > 0 && h > 0)) return null;
  if (w === 2 * h) return 'sbs';
  if (h === 2 * w) return 'tb';
  return null;
}

/** One eye of a stereo frame: half the width (SBS) or half the height (TB). */
export function stereoEyeSize(layout, width, height) {
  const w = Math.trunc(Number(width)) || 0;
  const h = Math.trunc(Number(height)) || 0;
  if (layout === 'sbs') return { width: Math.round(w / 2), height: h };
  if (layout === 'tb') return { width: w, height: Math.round(h / 2) };
  return { width: w, height: h };
}

export const STEREO_LABELS = { sbs: 'SIDE-BY-SIDE', tb: 'TOP-BOTTOM' };

/** "2048×2048 ×2 · 3D" for a stereo post, the plain resolution otherwise. */
export function formatPostResolution(post) {
  const layout = stereoLayout(post);
  if (layout === 'mono') return formatResolution(post?.width, post?.height);
  const eye = stereoEyeSize(layout, post?.width, post?.height);
  const res = formatResolution(eye.width, eye.height);
  return res ? `${res} ×2 · 3D` : '3D';
}

/**
 * CSS class that crops a raw stereo file to its left eye ('' when not
 * needed). Only legacy 3D posts without a 2D rendition serve the raw file.
 */
export function stereoCropClass(post) {
  const layout = stereoLayout(post);
  return layout !== 'mono' && post?.stereo_crop ? `sx-stereo-crop-${layout}` : '';
}
