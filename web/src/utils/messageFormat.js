// Display helpers for the messaging UI. Pure functions so they can be tested
// without rendering (and without depending on the machine's locale).

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function parse(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayKey(value) {
  const date = parse(value);
  if (!date) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateLabel(date, now) {
  const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base}, ${date.getFullYear()}`;
}

/** Day divider text inside a thread: TODAY, YESTERDAY, or a short date. */
export function dayLabel(value, now = new Date()) {
  const date = parse(value);
  if (!date) return '';
  const diff = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diff === 0) return 'TODAY';
  if (diff === 1) return 'YESTERDAY';
  return dateLabel(date, now);
}

export function clockTime(value) {
  const date = parse(value);
  return date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

/** Compact timestamp for the conversation list: clock today, else a day label. */
export function listTime(value, now = new Date()) {
  const date = parse(value);
  if (!date) return '';
  const label = dayLabel(value, now);
  return label === 'TODAY' ? clockTime(value) : label;
}

/** One-line preview of a conversation's latest message. */
export function lastMessagePreview(conversation, viewerId) {
  const last = conversation?.last_message;
  if (!last) return 'New conversation';
  if (last.deleted) return 'Message deleted';
  let body;
  if (last.kind === 'pack') body = last.pack ? `Shared a Reel Pack · ${last.pack.title}` : 'Reel Pack unavailable';
  else if (last.kind === 'reel') body = last.post ? 'Shared a reel' : 'Reel unavailable';
  else if (last.kind === 'gif') body = 'GIF';
  else body = last.text || last.content?.emote || last.content?.text || last.kind || 'New conversation';
  return viewerId && last.sender_id === viewerId ? `You: ${body}` : body;
}

export const REPORT_REASONS = [
  ['spam', 'SPAM'],
  ['harassment', 'HARASSMENT'],
  ['hate', 'HATE'],
  ['sexual', 'SEXUAL CONTENT'],
  ['violence', 'VIOLENCE'],
  ['impersonation', 'IMPERSONATION'],
  ['privacy', 'PRIVACY'],
  ['other', 'OTHER'],
];

/** Case-insensitive match on handle, display name and the latest message text. */
export function matchesConversation(conversation, query) {
  const needle = String(query || '').trim().toLowerCase().replace(/^@/, '');
  if (!needle) return true;
  const person = conversation?.participant || {};
  const haystack = [person.username, person.display_name, conversation?.last_message?.text]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}
