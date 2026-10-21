import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', '..', 'ui/assets/reels.html'), 'utf-8');

function httpError(status, code) {
  const err = new Error(code || 'Request failed');
  err.status = status;
  err.code = code || null;
  return err;
}

// maybeClaimReelReward sits between markers in reels.html, so the real retry logic is tested
// against stubbed page globals. `respond(path)` returns a body or throws for each request.
function loadClaim(respond) {
  const match = html.match(/\/\/ <reels-reward-claim>\n([\s\S]*?)\/\/ <\/reels-reward-claim>/);
  assert.ok(match, 'reels-reward-claim markers present');
  const requests = [];
  const toasts = [];
  const timers = [];
  const context = {
    window: { ReelsRewards: { thresholdMs: () => 3000 } },
    currentUser: { id: 'user-1' },
    viewTracker: null,
    video: { currentTime: 4 },
    isPackMode: false,
    packState: {},
    analyticsSource: 'reels',
    recommendationImpressionId: (item) => item.recommendation.impression_id,
    playbackMeasurements: () => ({ foreground_ms: 4000, duration_ms: 8000, watch_ratio: 0.5, playback_quality: null }),
    isImageItem: () => false,
    refreshAccountUI: () => {},
    showRewardProgress: () => {},
    showRewardToast: (message) => toasts.push(message),
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    requestJson: async (path) => {
      requests.push(path);
      return respond(path);
    },
  };
  vm.createContext(context);
  vm.runInContext(match[1] + '\nthis.maybeClaimReelReward = maybeClaimReelReward;\nthis.claimsDisabled = () => rewardClaimsDisabled;', context);

  const newState = (postId = 'post-1') => {
    const state = {
      item: { post_id: postId, media_type: 'video', recommendation: { impression_id: 'imp-' + postId } },
      finished: false,
      rewardClaimSent: false,
      watchMs: 5000,
      rewardEventId: 'evt-' + postId,
    };
    context.viewTracker = state;
    return state;
  };

  // Simulates the playback tick: keep calling the claim while the reel plays, firing any
  // retry timers in between, the way the progress loop does.
  async function play(state, ticks = 30) {
    for (let i = 0; i < ticks; i += 1) {
      await context.maybeClaimReelReward(state);
      const pending = timers.splice(0);
      pending.forEach((timer) => timer.fn());
    }
  }

  return { context, requests, toasts, timers, newState, play };
}

test('REWARDS_DISABLED 503 is terminal: no retry, no toast, no claims for later reels', async () => {
  const claim = loadClaim((path) => {
    if (path === '/api/rewards/reels/claim') throw httpError(503, 'REWARDS_DISABLED');
    return {};
  });
  const first = claim.newState('post-1');
  await claim.play(first);

  assert.deepEqual(claim.requests, ['/api/events', '/api/rewards/reels/claim']);
  assert.deepEqual(claim.toasts, []);
  assert.equal(claim.timers.length, 0);
  assert.equal(claim.context.claimsDisabled(), true);

  await claim.play(claim.newState('post-2'));
  assert.equal(claim.requests.length, 2, 'next reel sends no reward_eligible event or claim');
});

test('generic 5xx retries stop after the cap with doubling backoff', async () => {
  const delays = [];
  const claim = loadClaim((path) => {
    if (path === '/api/rewards/reels/claim') throw httpError(503, 'BILLING_UNAVAILABLE');
    return {};
  });
  const state = claim.newState();
  const originalSetTimeout = claim.context.setTimeout;
  claim.context.setTimeout = (fn, delay) => {
    delays.push(delay);
    originalSetTimeout(fn, delay);
  };
  await claim.play(state);

  const claims = claim.requests.filter((path) => path === '/api/rewards/reels/claim');
  assert.equal(claims.length, 4, 'first attempt plus 3 retries');
  assert.deepEqual(delays, [2000, 4000, 8000]);
  assert.deepEqual(claim.toasts, ['REWARDS UNAVAILABLE RIGHT NOW']);
  assert.equal(claim.context.claimsDisabled(), false, 'a generic outage does not disable the page');
});

test('429 from the event rate limit is capped too', async () => {
  const claim = loadClaim((path) => {
    if (path === '/api/events') throw httpError(429, 'RATE_LIMITED');
    return {};
  });
  await claim.play(claim.newState());
  assert.equal(claim.requests.length, 4);
  assert.ok(claim.requests.every((path) => path === '/api/events'));
});

test('409 duplicate stays terminal with its toast', async () => {
  const claim = loadClaim((path) => {
    if (path === '/api/rewards/reels/claim') throw httpError(409, 'REWARD_ALREADY_CLAIMED');
    return {};
  });
  await claim.play(claim.newState());
  assert.equal(claim.requests.length, 2);
  assert.deepEqual(claim.toasts, ['ALREADY CLAIMED FOR THIS REEL']);
});
