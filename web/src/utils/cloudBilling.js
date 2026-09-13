export function imageBillingParameters({
  prompt,
  upscaleOnly,
  sharpening,
  falPicked,
  upscaleModel,
  outpaintModel,
  customOutpaintArgs,
  customUpscaleArgs,
}) {
  return {
    prompt: upscaleOnly ? '' : prompt,
    upscale_only: Boolean(upscaleOnly),
    sharpening: Number(sharpening),
    upscale_engine: falPicked ? 'fal' : 'fast',
    upscale_model: upscaleModel,
    outpaint_model: outpaintModel,
    custom_outpaint_args: customOutpaintArgs || {},
    custom_upscale_args: customUpscaleArgs || {},
  };
}

export function videoBillingParameters({
  prompt,
  upscaleOnly,
  falPicked,
  studioPicked,
  sharpening,
  outpaintModel,
  upscaleModel,
  ltxResolution,
  ltxAudio,
  ltxGuidance,
  ltxPromptExpansion,
  ltxNegativePrompt,
  ltxLoras,
  wanResolution = '720p',
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
    prompt: upscaleOnly ? '' : prompt,
    upscale_only: Boolean(upscaleOnly),
    upscale_engine: falPicked ? 'fal' : studioPicked ? 'studio' : 'fast',
    sharpening: Number(sharpening),
    outpaint_model: outpaintModel,
    upscale_model: upscaleModel,
    ltx_resolution: ltxResolution,
    ltx_audio: Boolean(ltxAudio),
    ltx_guidance: Number(ltxGuidance),
    ltx_prompt_expansion: Boolean(ltxPromptExpansion),
    ltx_negative_prompt: ltxNegativePrompt,
    ltx_loras: ltxLoras || [],
    wan_resolution: wanResolution,
    seedvr_factor: Number(seedvrFactor),
    seedvr_target: seedvrTarget,
    bytedance_target_res: bytedanceTargetRes,
    bytedance_target_fps: bytedanceTargetFps,
    bytedance_tier: bytedanceTier,
    bytedance_preset: bytedancePreset,
    bytedance_fidelity: bytedanceFidelity,
    trim_enabled: Boolean(trimEnabled),
    trim_start: Number(trimStart),
    trim_duration: Number(trimDuration),
    custom_outpaint_args: customOutpaintArgs || {},
    custom_upscale_args: customUpscaleArgs || {},
  };
}

export function appendProcessingParameters(formData, parameters) {
  Object.entries(parameters).forEach(([key, value]) => {
    const encoded = value && typeof value === 'object' ? JSON.stringify(value) : String(value);
    formData.append(key, encoded);
  });
  return formData;
}

export function stagedItemNeedsCloud(item, parameters) {
  if (parameters?.upscale_engine === 'fal') return true;
  if (parameters?.upscale_only) return false;

  const width = Number(item?.width);
  const height = Number(item?.height);
  const hasDimensions = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  return !hasDimensions || width !== height;
}
