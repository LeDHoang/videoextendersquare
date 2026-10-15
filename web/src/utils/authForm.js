// Pure helpers shared by the sign-in, sign-up and password-recovery screens.
// Limits mirror server/social/auth.py (validate_username / validate_password).

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const DISPLAY_NAME_MAX = 60;

export const PENDING_ACTION_KEY = 'echo:pending-action';
export const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

const DEFAULT_NEXT = '/reels';
// Landing back on one of these after authenticating would bounce straight back to them.
const AUTH_PATHS = ['/login', '/signup', '/forgot-password', '/reset-password'];

export function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return DEFAULT_NEXT;
  // "//host" and "/\host" are protocol-relative to a browser; control characters have no business in a path.
  if (value.startsWith('//') || value.startsWith('/\\') || /[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_NEXT;
  const path = value.split(/[?#]/)[0];
  if (AUTH_PATHS.includes(path)) return DEFAULT_NEXT;
  return value;
}

export function normalizeUsername(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

export function validateEmail(value) {
  const email = String(value || '').trim();
  if (!email) return 'Enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address, like name@example.com.';
  return '';
}

export function validateUsername(value) {
  const username = String(value || '');
  if (!username) return 'Choose a username.';
  if (!/^[a-z0-9_]*$/.test(username)) return 'Use lowercase letters, numbers and underscores only.';
  if (username.length < USERNAME_MIN) return 'Usernames need at least ' + USERNAME_MIN + ' characters.';
  if (username.length > USERNAME_MAX) return 'Usernames can be at most ' + USERNAME_MAX + ' characters.';
  return '';
}

export function validateNewPassword(value) {
  const password = String(value || '');
  if (!password) return 'Choose a password.';
  if (password.length < PASSWORD_MIN) return 'Password must be at least ' + PASSWORD_MIN + ' characters.';
  if (password.length > PASSWORD_MAX) return 'Password can be at most ' + PASSWORD_MAX + ' characters.';
  return '';
}

export function passwordChecks(password) {
  const value = String(password || '');
  return {
    length: value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX,
    long: value.length >= 14 && value.length <= PASSWORD_MAX,
    mixed: /\d/.test(value) && /[^A-Za-z0-9]/.test(value),
  };
}

// 0 = nothing usable yet; 1 = meets the server minimum; 2/3 add the advisory checks.
export function passwordStrength(password) {
  const checks = passwordChecks(password);
  if (!checks.length) return { score: 0, label: password ? 'TOO SHORT' : '' };
  const score = 1 + (checks.long ? 1 : 0) + (checks.mixed ? 1 : 0);
  return { score, label: ['', 'MINIMUM MET', 'GOOD', 'STRONG'][score] };
}

export function readPendingAction(now = Date.now()) {
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_ACTION_KEY) || 'null');
  } catch {
    return null;
  }
  if (!pending?.kind || now - Number(pending.created_at || 0) > PENDING_ACTION_TTL_MS) return null;
  return pending;
}

// A short phrase for what will be replayed after sign-in; null for anything the replay doesn't handle.
export function describePending(pending) {
  if (!pending) return null;
  if (pending.kind === 'like' && pending.post_id) return 'LIKE THAT POST';
  if (pending.kind === 'save' && pending.post_id) return 'SAVE THAT POST';
  if (pending.kind === 'follow' && pending.username) return 'FOLLOW @' + String(pending.username).toUpperCase();
  if (pending.kind === 'comment' && pending.post_id && pending.text) return 'POST YOUR COMMENT';
  if (pending.kind === 'comment-like' && pending.comment_id) return 'LIKE THAT COMMENT';
  return null;
}
