import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel, lastMessagePreview, listTime, matchesConversation } from './messageFormat.js';

const NOW = new Date(2026, 9, 5, 15, 30); // Oct 5 2026, local time

const local = (month, day, hour = 12, year = 2026) => new Date(year, month, day, hour).toISOString();

describe('dayLabel / listTime', () => {
  it('labels today, yesterday and older days', () => {
    expect(dayLabel(local(9, 5, 1), NOW)).toBe('TODAY');
    expect(dayLabel(local(9, 4, 23), NOW)).toBe('YESTERDAY');
    expect(dayLabel(local(9, 1), NOW)).toBe('OCT 1');
    expect(dayLabel(local(11, 31, 12, 2025), NOW)).toBe('DEC 31, 2025');
  });

  it('handles month and year boundaries for yesterday', () => {
    const newYear = new Date(2027, 0, 1, 9);
    expect(dayLabel(new Date(2026, 11, 31, 22).toISOString(), newYear)).toBe('YESTERDAY');
  });

  it('shows a clock time for today and a day label otherwise', () => {
    expect(listTime(local(9, 5, 9), NOW)).toMatch(/\d/);
    expect(listTime(local(9, 5, 9), NOW)).not.toBe('TODAY');
    expect(listTime(local(9, 4, 9), NOW)).toBe('YESTERDAY');
    expect(listTime(local(8, 20), NOW)).toBe('SEP 20');
  });

  it('returns empty strings for missing or invalid dates', () => {
    expect(dayLabel(null, NOW)).toBe('');
    expect(dayLabel('not-a-date', NOW)).toBe('');
    expect(listTime(undefined, NOW)).toBe('');
    expect(dayKey('nope')).toBe('');
  });

  it('groups messages from the same local day under one key', () => {
    expect(dayKey(local(9, 5, 1))).toBe(dayKey(local(9, 5, 23)));
    expect(dayKey(local(9, 5, 1))).not.toBe(dayKey(local(9, 6, 1)));
  });
});

describe('lastMessagePreview', () => {
  const base = (last) => ({ last_message: last });

  it('describes every message kind', () => {
    expect(lastMessagePreview({}, 'me')).toBe('New conversation');
    expect(lastMessagePreview(base({ deleted: true }), 'me')).toBe('Message deleted');
    expect(lastMessagePreview(base({ kind: 'gif', text: '' }), 'me')).toBe('GIF');
    expect(lastMessagePreview(base({ kind: 'reel', post: { id: 'p' } }), 'me')).toBe('Shared a reel');
    expect(lastMessagePreview(base({ kind: 'reel', post: null }), 'me')).toBe('Reel unavailable');
    expect(lastMessagePreview(base({ kind: 'pack', pack: { title: 'Neon' } }), 'me')).toBe('Shared a Reel Pack · Neon');
    expect(lastMessagePreview(base({ kind: 'pack', pack: null }), 'me')).toBe('Reel Pack unavailable');
    expect(lastMessagePreview(base({ kind: 'emote', text: '👍' }), 'me')).toBe('👍');
    expect(lastMessagePreview(base({ kind: 'text', text: 'hello' }), 'me')).toBe('hello');
  });

  it('prefixes your own messages with "You:"', () => {
    expect(lastMessagePreview(base({ kind: 'text', text: 'hi', sender_id: 'me' }), 'me')).toBe('You: hi');
    expect(lastMessagePreview(base({ kind: 'text', text: 'hi', sender_id: 'them' }), 'me')).toBe('hi');
  });
});

describe('matchesConversation', () => {
  const row = { participant: { username: 'kira_vr', display_name: 'Kira' }, last_message: { text: 'Spatial outpaint' } };

  it('matches handle, display name and message text, ignoring case and a leading @', () => {
    expect(matchesConversation(row, '')).toBe(true);
    expect(matchesConversation(row, '  ')).toBe(true);
    expect(matchesConversation(row, '@KIRA')).toBe(true);
    expect(matchesConversation(row, 'vr')).toBe(true);
    expect(matchesConversation(row, 'outpaint')).toBe(true);
    expect(matchesConversation(row, 'zzz')).toBe(false);
  });

  it('tolerates rows with missing data', () => {
    expect(matchesConversation({}, 'x')).toBe(false);
    expect(matchesConversation({}, '')).toBe(true);
  });
});
