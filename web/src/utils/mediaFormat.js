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

/**
 * Combined runtime of the video reels in a pack. `complete` is false when some
 * available video has no known runtime, so the total is a lower bound.
 */
export function packRuntime(items) {
  let ms = 0;
  let known = 0;
  let unknown = 0;
  for (const item of items || []) {
    const post = item?.available ? item.post : null;
    if (!post || post.media_type === 'image') continue;
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
