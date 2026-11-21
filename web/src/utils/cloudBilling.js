import { aspectMatches } from './aspect.js';

// `targetAspect` ('1:1' | '16:9' | '9:16') is the Fill with AI shape. It is sent
// only with extend on; Keep shape (upscale_only) and the legacy pages leave it out.
const targetAspectOf = (upscaleOnly, targetAspect) => (!upscaleOnly && targetAspect ? { target_aspect: targetAspect } : {});

export function imageBillingParameters({
  prompt,
  upscaleOnly,
  targetAspect,
  sharpening,
  falPicked,
  noUpscale,
  upscaleModel,
  outpaintModel,
  customOutpaintArgs,
  customUpscaleArgs,
}) {
  return {
    prompt: upscaleOnly ? '' : (prompt ?? ''),
    upscale_only: Boolean(upscaleOnly),
    sharpening: Number(sharpening ?? 0),
    upscale_engine: noUpscale ? 'none' : falPicked ? 'fal' : 'fast',
    upscale_model: upscaleModel,
    outpaint_model: outpaintModel,
    custom_outpaint_args: customOutpaintArgs || {},
    custom_upscale_args: customUpscaleArgs || {},
    ...targetAspectOf(upscaleOnly, targetAspect),
  };
}

export function videoBillingParameters({
  prompt,
  upscaleOnly,
  targetAspect,
  falPicked,
  studioPicked,
  noUpscale,
  sharpening,
  outpaintModel,
  upscaleModel,
  ltxResolution,
  ltxAudio,
  ltxGuidance,
  ltxPromptExpansion,
  ltxNegativePrompt,
  ltxLoras,
  lumaResolution = '1080p',
  minimaxResolution = '768p',
  minimaxSeed = '',
  ltx25Resolution = '1080p',
  ltx25Anchor = 'center',
  seedvrFactor,
  seedvrTarget,
  bytedanceTargetRes,
  bytedanceTargetFps,
  bytedanceTier,
  bytedancePreset,
  bytedanceFidelity,
  trimEnabled,
  trimStart,
  trimDuration,
  customOutpaintArgs,
  customUpscaleArgs,
}) {
  return {
    prompt: upscaleOnly ? '' : (prompt ?? ''),
    upscale_only: Boolean(upscaleOnly),
    upscale_engine: noUpscale ? 'none' : falPicked ? 'fal' : studioPicked ? 'studio' : 'fast',
    sharpening: Number(sharpening ?? 0),
    outpaint_model: outpaintModel,
    upscale_model: upscaleModel,
    ltx_resolution: ltxResolution,
    ltx_audio: Boolean(ltxAudio),
    ltx_guidance: Number(ltxGuidance ?? 0),
    ltx_prompt_expansion: Boolean(ltxPromptExpansion),
    ltx_negative_prompt: ltxNegativePrompt ?? '',
    ltx_loras: ltxLoras || [],
    luma_resolution: lumaResolution,
    minimax_resolution: minimaxResolution,
    minimax_seed: String(minimaxSeed ?? '').trim(),
    ltx25_resolution: ltx25Resolution,
    ltx25_anchor: ltx25Anchor,
    seedvr_factor: Number(seedvrFactor ?? 2),
    seedvr_target: seedvrTarget,
    bytedance_target_res: bytedanceTargetRes,
    bytedance_target_fps: bytedanceTargetFps,
    bytedance_tier: bytedanceTier,
    bytedance_preset: bytedancePreset,
    bytedance_fidelity: bytedanceFidelity,
    trim_enabled: Boolean(trimEnabled),
    trim_start: Number(trimStart ?? 0),
    trim_duration: Number(trimDuration ?? 15),
    custom_outpaint_args: customOutpaintArgs || {},
    custom_upscale_args: customUpscaleArgs || {},
    ...targetAspectOf(upscaleOnly, targetAspect),
  };
}

export function appendProcessingParameters(formData, parameters) {
  Object.entries(parameters).forEach(([key, value]) => {
    if (value === undefined || value === null) return; // Never emit "undefined"/"null".
    const encoded = value && typeof value === 'object' ? JSON.stringify(value) : String(value);
    formData.append(key, encoded);
  });
  return formData;
}

// Whether a file (staged metadata) already has the `target` shape, so nothing is
// filled. A null target (Keep shape) takes any shape; unknown dims never match.
export function matchesTarget(item, target) {
  if (!target) return true;
  const width = Number(item?.width);
  const height = Number(item?.height);
  const hasDimensions = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  return hasDimensions && aspectMatches(width, height, target);
}

export function stagedItemNeedsCloud(item, parameters) {
  if (parameters?.upscale_engine === 'fal') return true;
  if (parameters?.upscale_only) return false;
  return !matchesTarget(item, parameters?.target_aspect || '1:1');
}
