import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendProcessingParameters,
  imageBillingParameters,
  matchesTarget,
  stagedItemNeedsCloud,
  videoBillingParameters,
} from '../src/utils/cloudBilling.js';

test('image parameters serialize the same values used by quote and submit', () => {
  const parameters = imageBillingParameters({
    prompt: 'extend',
    upscaleOnly: false,
    sharpening: 0.5,
    falPicked: true,
    upscaleModel: 'fal-ai/clarity-upscaler',
    outpaintModel: 'fal-ai/image-apps-v2/outpaint',
    customOutpaintArgs: { expand_left: 100 },
  });
  const form = appendProcessingParameters(new FormData(), parameters);

  assert.equal(form.get('prompt'), 'extend');
  assert.equal(form.get('upscale_only'), 'false');
  assert.equal(form.get('upscale_engine'), 'fal');
  assert.equal(form.get('custom_outpaint_args'), '{"expand_left":100}');
});

test('video parameters preserve quote-sensitive trim and model options', () => {
  const parameters = videoBillingParameters({
    prompt: 'extend',
    upscaleOnly: false,
    falPicked: false,
    studioPicked: false,
    sharpening: 0.25,
    outpaintModel: 'luma/agent/ray/v3.2/reframe',
    upscaleModel: 'fal-ai/bytedance-upscaler/upscale/video',
    trimEnabled: true,
    trimStart: 2,
    trimDuration: 5,
  });

  assert.equal(parameters.upscale_engine, 'fast');
  assert.equal(parameters.trim_enabled, true);
  assert.equal(parameters.trim_duration, 5);
  assert.deepEqual(parameters.ltx_loras, []);
});

test('cloud detection skips square local work but includes outpaint and Fal upscale', () => {
  assert.equal(stagedItemNeedsCloud({ width: 1000, height: 1000 }, { upscale_only: false, upscale_engine: 'fast' }), false);
  assert.equal(stagedItemNeedsCloud({ width: 1000, height: 500 }, { upscale_only: false, upscale_engine: 'fast' }), true);
  assert.equal(stagedItemNeedsCloud({ width: 1000, height: 1000 }, { upscale_only: true, upscale_engine: 'fal' }), true);
});

test('the Fill with AI shape is sent as target_aspect, never under Keep shape', () => {
  const base = { prompt: 'extend', falPicked: false, outpaintModel: 'fal-ai/image-apps-v2/outpaint', upscaleModel: 'fal-ai/clarity-upscaler' };
  const fill = imageBillingParameters({ ...base, upscaleOnly: false, targetAspect: '16:9' });
  assert.equal(appendProcessingParameters(new FormData(), fill).get('target_aspect'), '16:9');
  assert.equal('target_aspect' in imageBillingParameters({ ...base, upscaleOnly: true, targetAspect: '16:9' }), false);
  assert.equal('target_aspect' in imageBillingParameters({ ...base, upscaleOnly: false }), false);
  const video = videoBillingParameters({ ...base, upscaleOnly: false, studioPicked: false, targetAspect: '9:16' });
  assert.equal(video.target_aspect, '9:16');
});

test('cloud detection follows the target shape', () => {
  const fast = { upscale_only: false, upscale_engine: 'fast' };
  assert.equal(stagedItemNeedsCloud({ width: 1920, height: 1080 }, { ...fast, target_aspect: '16:9' }), false);
  assert.equal(stagedItemNeedsCloud({ width: 1920, height: 1080 }, { ...fast, target_aspect: '9:16' }), true);
  assert.equal(stagedItemNeedsCloud({ width: 1000, height: 1000 }, { ...fast, target_aspect: '16:9' }), true);
  assert.equal(stagedItemNeedsCloud({ width: 1500, height: 1200 }, { upscale_only: true, upscale_engine: 'fast' }), false);
  assert.equal(stagedItemNeedsCloud({}, { ...fast, target_aspect: '1:1' }), true);
});

test('matchesTarget takes any shape for a null target and needs dimensions otherwise', () => {
  assert.equal(matchesTarget({ width: 1500, height: 1200 }, null), true);
  assert.equal(matchesTarget({ width: 1910, height: 1080 }, '16:9'), true);
  assert.equal(matchesTarget({ width: 1080, height: 1920 }, '16:9'), false);
  assert.equal(matchesTarget({}, '1:1'), false);
});

test('missing optionals never serialize as undefined or NaN', () => {
  const parameters = videoBillingParameters({
    upscaleOnly: true,
    falPicked: false,
    studioPicked: false,
    outpaintModel: 'luma/agent/ray/v3.2/reframe',
    upscaleModel: 'fal-ai/bytedance-upscaler/upscale/video',
  });
  const form = appendProcessingParameters(new FormData(), { ...parameters, extra: undefined, nil: null });
  for (const value of form.values()) {
    assert.ok(!/undefined|NaN|null/.test(value), `leaked sentinel: ${value}`);
  }
  assert.equal(form.get('prompt'), '');
  assert.equal(Number.isNaN(Number(form.get('sharpening'))), false);
});
