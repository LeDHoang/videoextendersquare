// Maps backend billing/reward error codes to user-facing copy so raw
// Stripe/Fal/500 internals never render verbatim. Unknown 4xx keeps the
// server message (usually validation); 5xx/network fall back to generic.

const CODE_COPY = {
  INSUFFICIENT_CREDITS: 'Not enough ECHO Credits for this job — add credits or use My Fal Key.',
  INVALID_QUOTE: 'The quote expired or no longer matches. Retry to get a fresh quote.',
  BILLING_CONFLICT: 'This job was already submitted.',
  BILLING_MISCONFIGURED: 'Cloud billing is temporarily unavailable. Try again later.',
  BILLING_ERROR: 'Cloud billing is temporarily unavailable. Try again later.',
  CHECKOUT_MISCONFIGURED: 'Checkout is not configured right now. Try again later.',
  CREDITS_DISABLED: 'ECHO Credits are disabled in this environment.',
  STRIPE_DISABLED: 'Card purchases are disabled in this environment.',
  REWARDS_DISABLED: 'Reel rewards are currently disabled.',
  REWARD_ALREADY_CLAIMED: 'This reel was already claimed.',
  REWARD_RETRYABLE: 'Reward service is busy. Try again shortly.',
  AUTH_REQUIRED: 'Sign in to continue.',
  INVALID_STAGE: 'Upload is invalid or expired. Upload again.',
  JOB_ENQUEUE_FAILED: 'Processing could not be queued. Try again shortly.',
  STORAGE_FULL: 'The server is out of upload space right now. Try again later.',
};

function retryHint(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 'Try again shortly.';
  if (n < 60) return `Try again in ${Math.ceil(n)} second${Math.ceil(n) === 1 ? '' : 's'}.`;
  const minutes = Math.ceil(n / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

export function billingErrorMessage(error, fallback = 'Request failed. Try again shortly.') {
  if (!error) return fallback;
  // 429 QUEUE_FULL: the per-user or global job cap is reached; Retry-After says when a slot frees.
  if (error.code === 'QUEUE_FULL') {
    return `Too many jobs are running — wait for one to finish. ${retryHint(error.retryAfter)}`;
  }
  if (error.code && CODE_COPY[error.code]) return CODE_COPY[error.code];
  // REWARD_INELIGIBLE carries deliberate progress feedback ("Watch at least
  // N seconds…") — keep the server message.
  if (error.code === 'REWARD_INELIGIBLE' && error.message) return error.message;
  const status = Number(error.status);
  if (status === 401 || status === 403) return 'Sign in to continue.';
  if (status === 429) {
    return error.retryAfter ? `Too many requests. ${retryHint(error.retryAfter)}` : 'Too many requests — wait a moment and retry.';
  }
  if (status === 507) return CODE_COPY.STORAGE_FULL;
  if (Number.isFinite(status) && status >= 500) return 'Something went wrong on our side. Try again shortly.';
  if (error.message) return error.message;
  return fallback;
}
