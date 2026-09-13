(function (root) {
  'use strict';

  function thresholdMs(mediaType, durationMs) {
    if (String(mediaType || '').toLowerCase() === 'image') return 3000;
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return Math.min(10000, Math.max(3000, Math.round(duration * 0.5)));
  }

  function progressMessage(result) {
    const payload = result || {};
    if (payload.credit_awarded) {
      return '+1 ECHO CREDIT · ' + Number(payload.credits_earned_today || 0) + '/5 EARNED TODAY';
    }
    if (payload.daily_cap_reached) return 'DAILY REEL CREDIT CAP REACHED';
    const progress = Math.max(0, Number(payload.progress || 0));
    const target = Math.max(1, Number(payload.target || 10));
    return progress + '/' + target + ' ELIGIBLE REELS · ' + Math.max(0, target - progress) + ' TO NEXT CREDIT';
  }

  const api = { thresholdMs, progressMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ReelsRewards = api;
})(typeof window !== 'undefined' ? window : globalThis);
