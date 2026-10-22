// Per-file upload caps come from GET /api/config (`upload_limits: { image_mb, video_mb }`) so the
// client never drifts from the server's SX_MAX_IMAGE_UPLOAD_MB / SX_MAX_VIDEO_UPLOAD_MB. When the
// server does not publish them, there is no client-side check: the server's 413 still applies.

const MB = 1024 * 1024;

export function uploadLimitMb(config, kind) {
  const value = Number(config?.upload_limits?.[`${kind}_mb`]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Returns a user-facing message when `file` is over the published cap, otherwise null.
export function oversizeMessage(file, kind, config) {
  const limit = uploadLimitMb(config, kind);
  if (!limit || !file || typeof file.size !== 'number' || file.size <= limit * MB) return null;
  const size = (file.size / MB).toFixed(1);
  return `${file.name} is ${size} MB — ${kind} uploads must be ${limit} MB or smaller.`;
}

// Rejects before any bytes are sent, with the same shape as a server 413.
export function assertUploadSize(file, kind, config) {
  const message = oversizeMessage(file, kind, config);
  if (message) {
    const error = new Error(message);
    error.status = 413;
    error.code = 'UPLOAD_TOO_LARGE';
    throw error;
  }
}
