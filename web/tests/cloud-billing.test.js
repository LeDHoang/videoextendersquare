import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendProcessingParameters,
  imageBillingParameters,
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
    outpaintModel: 'fal-ai/wan-vace-14b/outpainting',
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
