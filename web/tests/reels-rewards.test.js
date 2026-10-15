import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../ui/assets/reels_rewards.js', import.meta.url), 'utf8');

function loadRewards() {
  const window = {};
  const context = vm.createContext({ window, globalThis: window, Number, String, Math });
  vm.runInContext(source, context, { filename: 'reels_rewards.js' });
  return window.ReelsRewards;
}

test('reward thresholds match image and duration-based video rules', () => {
  const rewards = loadRewards();
  assert.equal(rewards.thresholdMs('image', null), 3000);
  assert.equal(rewards.thresholdMs('video', 4000), 3000);
  assert.equal(rewards.thresholdMs('video', 12000), 6000);
  assert.equal(rewards.thresholdMs('video', 60000), 10000);
  assert.equal(rewards.thresholdMs('video', null), null);
});

test('reward messages expose progress and awarded-credit status', () => {
  const rewards = loadRewards();
  assert.match(rewards.progressMessage({ progress: 7, target: 10 }), /7\/10.*3 TO NEXT CREDIT/);
  assert.match(rewards.progressMessage({ credit_awarded: true, credits_earned_today: 2 }), /\+1 ECHO CREDIT.*2\/5/);
  assert.equal(rewards.progressMessage({ daily_cap_reached: true }), 'DAILY REEL CREDIT CAP REACHED');
});
