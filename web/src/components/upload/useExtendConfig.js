import { useEffect, useMemo, useRef, useState } from 'react';
import { imageBillingParameters, matchesTarget, videoBillingParameters } from '../../utils/cloudBilling.js';
import { nearestAspect } from '../../utils/aspect.js';
import { H3_REFRAME, LTX25_REFRAME, offeredValue, rateTiers, topTier, videoOptions } from '../../utils/modelOptions.js';

// Extender settings for the Upload Studio, one hook per media kind. Each kind
// keeps its own settings for the whole visit (like the standalone /image and
// /video pages), so staging a new file never wipes a configured pipeline.
// The derivations below mirror ImagePage.jsx / VideoPage.jsx one-for-one so
// both pages and the studio send identical /process payloads.

// Fill with AI paints the file out to a picked shape; Keep shape leaves its
// shape alone (sent as upscale_only).
export const MODES = ['FILL WITH AI', 'KEEP SHAPE'];
export const IMG_ENGINES = ['FAST', 'FAL AI'];
export const VID_ENGINES = ['FAST', 'STUDIO', 'FAL AI'];

// Fallback while /api/config loads (same list as ImagePage).
export const FALLBACK_FAL_MODELS = ['Clarity Upscaler', 'CCSR', 'AuraSR', 'ESRGAN'];
const FALLBACK_FAL_MODEL_IDS = {
  'Clarity Upscaler': 'fal-ai/clarity-upscaler',
  CCSR: 'fal-ai/ccsr',
  AuraSR: 'fal-ai/aura-sr',
  ESRGAN: 'fal-ai/esrgan',
};
export const STOCK_OUTPAINT_IMG = 'fal-ai/image-apps-v2/outpaint';
export const IMG_PROMPT_DEFAULT = 'Seamlessly extend the background environment, high details, matching texture and lighting.';
export const VID_PROMPT_DEFAULT = 'Seamlessly extend the background environment, cool lighting, neutral color temperature, matching original white balance and color palette.';
export const VID_NEG_DEFAULT = 'yellow tint, sepia, warm cast, color distortion, discoloration, overexposure, oversaturated';
export const MAX_LORAS = 3;
const CREDIT_VIDEO_OUTPAINT_MODELS = new Set([
  'fal-ai/ltx-2.3-quality/outpaint',
  'fal-ai/ltx-2.3-quality/outpaint/lora',
  'luma/agent/ray/v3.2/reframe',
  H3_REFRAME,
  LTX25_REFRAME,
]);
const CREDIT_VIDEO_UPSCALE_MODELS = new Set([
  'fal-ai/bytedance-upscaler/upscale/video',
  'fal-ai/seedvr/upscale/video',
]);
const VALID_ARGS = { args: {}, ok: true, error: '' };

const nearestOf = (meta) => (Number(meta?.width) > 0 && Number(meta?.height) > 0 ? nearestAspect(Number(meta.width), Number(meta.height)) : '1:1');

// The Fill with AI shape. A pick holds for the whole visit; until then each
// file is made in the shape of the three nearest its own. Under Keep shape a
// file keeps its shape (null).
function useTargetShape(upscaleOnly, noUpscale) {
  const [shape, setShape] = useState(null);
  const shapeFor = (meta) => (upscaleOnly ? null : shape || nearestOf(meta));
  return {
    shape,
    setShape,
    shapeFor,
    // The shape a file must already have to post as it is (null: any). With an
    // upscale under Keep shape, square files still post as they are.
    asIsShapeFor: (meta) => (upscaleOnly ? (noUpscale ? null : '1:1') : shapeFor(meta)),
  };
}

export function useImageExtendConfig(models) {
  const outpaintCatalog = models.image_outpaint_catalog || [];
  const upscaleCatalog = models.image_upscale_catalog || [];
  const upscaleOptions = upscaleCatalog.length ? upscaleCatalog.map((e) => e.label) : FALLBACK_FAL_MODELS;

  const [mode, setMode] = useState(MODES[0]);
  const [prompt, setPrompt] = useState(IMG_PROMPT_DEFAULT);
  const [engine, setEngine] = useState('FAST');
  const [falModel, setFalModel] = useState('Clarity Upscaler');
  const [sharpening, setSharpening] = useState(0.5);
  const [outArgs, setOutArgs] = useState(VALID_ARGS);
  const [upArgs, setUpArgs] = useState(VALID_ARGS);

  const upscaleOnly = mode === 'KEEP SHAPE';
  const falPicked = engine === 'FAL AI';
  // No Quality card picked: the file keeps its own resolution, not upscaled to 2K.
  const noUpscale = engine === '';
  const target = useTargetShape(upscaleOnly, noUpscale);
  const targetAspect = upscaleOnly ? null : target.shape;
  const upscaleEntry = upscaleCatalog.find((e) => e.label === falModel) || null;
  const upscaleModel = upscaleEntry?.model || FALLBACK_FAL_MODEL_IDS[falModel] || models.upscale_img;
  const outpaintModel = models.outpaint_img || STOCK_OUTPAINT_IMG;
  const outpaintEntry = outpaintCatalog.find((entry) => entry.model === outpaintModel) || null;
  const outpaintCustom = outpaintModel !== STOCK_OUTPAINT_IMG;
  const outpaintShort = (outpaintModel || '').split('/').filter(Boolean).pop() || 'custom';

  // Preselect the sidebar's CUSTOM(...) override once the catalog arrives.
  const customInit = useRef(false);
  useEffect(() => {
    if (customInit.current || !upscaleCatalog.length) return;
    customInit.current = true;
    const match = upscaleCatalog.find((e) => e.model === models.upscale_img);
    if (match?.is_custom) setFalModel(match.label);
  }, [upscaleCatalog, models]);

  const parameters = useMemo(() => imageBillingParameters({
    prompt,
    upscaleOnly,
    targetAspect,
    sharpening,
    falPicked,
    noUpscale,
    upscaleModel,
    outpaintModel,
    customOutpaintArgs: outpaintCustom ? outArgs.args : {},
    customUpscaleArgs: upscaleEntry?.is_custom ? upArgs.args : {},
  }), [prompt, upscaleOnly, targetAspect, sharpening, falPicked, noUpscale, upscaleModel, outpaintModel, outpaintCustom, outArgs.args, upscaleEntry?.is_custom, upArgs.args]);

  const outpaintCreditSupported = outpaintEntry?.credit_enabled ?? !outpaintCustom;
  const upscaleCreditSupported = upscaleEntry?.credit_enabled ?? upscaleModel === 'fal-ai/clarity-upscaler';

  return {
    kind: 'image',
    engines: IMG_ENGINES,
    mode, setMode,
    ...target,
    prompt, setPrompt,
    engine, setEngine,
    falModel, setFalModel,
    sharpening, setSharpening,
    setOutArgs, setUpArgs,
    upscaleOnly,
    falPicked,
    noUpscale,
    studioPicked: false,
    upscaleCatalog,
    upscaleOptions,
    upscaleEntry,
    upscaleModel,
    outpaintModel,
    outpaintEntry,
    outpaintCustom,
    outpaintShort,
    outpaintLabel: outpaintCustom ? `CUSTOM (${outpaintShort})` : (outpaintEntry?.label || 'Image Apps Outpaint'),
    upscaleLabel: falModel,
    parameters,
    // One file's /process parameters: an unpicked shape is that file's own nearest.
    // Keep shape sends the file's nearest too: upscale_only with a named shape is
    // the server's native-shape upscale (without one it squares, the legacy API).
    parametersFor: (meta) => ({ ...parameters, target_aspect: upscaleOnly ? nearestOf(meta) : target.shapeFor(meta) }),
    byokOnlyFor(items) {
      const needsOutpaintCloud = items.some((item) => !matchesTarget(item, target.shapeFor(item)));
      return (needsOutpaintCloud && !outpaintCreditSupported) || (falPicked && !upscaleCreditSupported);
    },
    validate() {
      if (!upscaleOnly && outpaintCustom && !outArgs.ok) return `Outpaint custom args: ${outArgs.error}`;
      if (falPicked && upscaleEntry?.is_custom && !upArgs.ok) return `Upscale custom args: ${upArgs.error}`;
      return '';
    },
  };
}

export function useVideoExtendConfig(models) {
  const outpaintCatalog = models.video_outpaint_catalog || [];
  const upscaleCatalog = models.video_upscale_catalog || [];
  const outpaintOptions = outpaintCatalog.map((e) => e.label);
  const upscaleOptions = upscaleCatalog.map((e) => e.label);

  const [mode, setMode] = useState(MODES[0]);
  const [prompt, setPrompt] = useState(VID_PROMPT_DEFAULT);
  const [engine, setEngine] = useState('FAST');
  const [outpaintOpt, setOutpaintOpt] = useState(outpaintOptions[0] || 'LTX 2.3 Quality');
  const [falUpscale, setFalUpscale] = useState(upscaleOptions[0] || 'Bytedance Upscaler');
  const [sharpening, setSharpening] = useState(0.5);
  const [ltxResPicked, setLtxRes] = useState('720p');
  const [ltxAudio, setLtxAudio] = useState(true);
  const [ltxGuidance, setLtxGuidance] = useState(1.0);
  const [ltxPromptExpansion, setLtxPromptExpansion] = useState(false);
  const [ltxNegativePrompt, setLtxNegativePrompt] = useState(VID_NEG_DEFAULT);
  const [ltxLoras, setLtxLoras] = useState([{ path: '', scale: 1, transformer: 'both' }]);
  const [minimaxResPicked, setMinimaxRes] = useState('768p');
  const [minimaxSeed, setMinimaxSeed] = useState('');
  const [ltx25ResPicked, setLtx25Res] = useState('1080p');
  const [ltx25Anchor, setLtx25Anchor] = useState('center');
  const [seedvrFactor, setSeedvrFactor] = useState(2.0);
  const [seedvrTargetPicked, setSeedvrTarget] = useState('1080p');
  const [btdResPicked, setBtdRes] = useState('2k');
  const [btdFpsPicked, setBtdFps] = useState('30fps');
  const [btdTierPicked, setBtdTier] = useState('fast');
  const [btdPreset, setBtdPreset] = useState('general');
  const [btdFidelity, setBtdFidelity] = useState('medium');
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimDur, setTrimDur] = useState(15);
  const [outArgs, setOutArgs] = useState(VALID_ARGS);
  const [upArgs, setUpArgs] = useState(VALID_ARGS);

  const upscaleOnly = mode === 'KEEP SHAPE';
  const falPicked = engine === 'FAL AI';
  // No Quality card picked: the file keeps its own resolution, not upscaled to 2K.
  const noUpscale = engine === '';
  const target = useTargetShape(upscaleOnly, noUpscale);
  const targetAspect = upscaleOnly ? null : target.shape;
  const studioPicked = engine === 'STUDIO';
  const outpaintEntry = outpaintCatalog.find((e) => e.label === outpaintOpt) || outpaintCatalog[0];
  const upscaleEntry = upscaleCatalog.find((e) => e.label === falUpscale) || upscaleCatalog[0];
  // Options fal still accepts; the server withdraws the others (server/fal_schemas.py).
  const offered = videoOptions(outpaintEntry, upscaleEntry);
  const ltxRes = offeredValue(ltxResPicked, offered.ltxRes);
  const seedvrTarget = offeredValue(seedvrTargetPicked, offered.seedvrTarget);
  const btdRes = offeredValue(btdResPicked, offered.btdRes);
  const btdFps = offeredValue(btdFpsPicked, offered.btdFps);
  const btdTier = offeredValue(btdTierPicked, offered.btdTier);
  const minimaxResOptions = rateTiers(outpaintCatalog, H3_REFRAME, ['480p', '768p', '1080p']);
  const minimaxRes = offeredValue(minimaxResPicked, minimaxResOptions);
  const ltx25ResOptions = rateTiers(outpaintCatalog, LTX25_REFRAME, ['720p', '1080p']);
  const ltx25Res = offeredValue(ltx25ResPicked, ltx25ResOptions);
  const outpaintModel = outpaintEntry?.model || models.outpaint_vid;
  const upscaleModel = upscaleEntry?.model || models.upscale_vid;

  // If the sidebar saved a custom endpoint, the catalog gains a CUSTOM(...)
  // entry after /api/config loads — preselect it once so the override
  // actually takes effect instead of silently staying on the stock default.
  const customInit = useRef(false);
  useEffect(() => {
    if (customInit.current || !outpaintCatalog.length || !upscaleCatalog.length) return;
    customInit.current = true;
    const oc = outpaintCatalog.find((e) => e.model === models.outpaint_vid);
    if (oc?.is_custom) setOutpaintOpt(oc.label);
    const uc = upscaleCatalog.find((e) => e.model === models.upscale_vid);
    if (uc?.is_custom) setFalUpscale(uc.label);
  }, [outpaintCatalog, upscaleCatalog, models]);

  const minimaxPicked = !upscaleOnly && outpaintModel === H3_REFRAME;
  const ltx25Picked = !upscaleOnly && outpaintModel === LTX25_REFRAME;
  // LTX 2.3 settings only: LTX 2.5 Reframe has its own.
  const ltxPicked = !upscaleOnly && outpaintOpt.includes('LTX') && !ltx25Picked;
  const loraPicked = !upscaleOnly && (outpaintOpt.includes('LoRA') || (outpaintModel || '').includes('/lora'));
  const loraList = useMemo(
    () => loraPicked ? ltxLoras.map((lora) => ({ ...lora, path: (lora.path || '').trim() })).filter((lora) => lora.path) : [],
    [loraPicked, ltxLoras],
  );
  const parameters = useMemo(() => videoBillingParameters({
    prompt,
    upscaleOnly,
    targetAspect,
    falPicked,
    studioPicked,
    noUpscale,
    sharpening,
    outpaintModel,
    upscaleModel,
    ltxResolution: ltxRes,
    ltxAudio,
    ltxGuidance,
    ltxPromptExpansion,
    ltxNegativePrompt,
    ltxLoras: loraList,
    // No Ray 3.2 resolution selector either: default to 1080p ($0.36/s).
    lumaResolution: topTier(outpaintCatalog, 'luma/agent/ray/v3.2/reframe', '1080p'),
    minimaxResolution: minimaxRes,
    minimaxSeed,
    ltx25Resolution: ltx25Res,
    ltx25Anchor,
    seedvrFactor,
    seedvrTarget,
    bytedanceTargetRes: btdRes,
    bytedanceTargetFps: btdFps,
    bytedanceTier: btdTier,
    bytedancePreset: btdPreset,
    bytedanceFidelity: btdFidelity,
    trimEnabled,
    trimStart,
    trimDuration: trimDur,
    customOutpaintArgs: outpaintEntry?.is_custom ? outArgs.args : {},
    customUpscaleArgs: upscaleEntry?.is_custom ? upArgs.args : {},
  }), [prompt, upscaleOnly, targetAspect, falPicked, studioPicked, noUpscale, sharpening, outpaintModel, upscaleModel, ltxRes, ltxAudio, ltxGuidance, ltxPromptExpansion, ltxNegativePrompt, loraList, minimaxRes, minimaxSeed, ltx25Res, ltx25Anchor, seedvrFactor, seedvrTarget, btdRes, btdFps, btdTier, btdPreset, btdFidelity, trimEnabled, trimStart, trimDur, outpaintEntry?.is_custom, outArgs.args, upscaleEntry?.is_custom, upArgs.args]);

  const outpaintCreditSupported = outpaintEntry?.credit_enabled ?? CREDIT_VIDEO_OUTPAINT_MODELS.has(outpaintModel);
  const upscaleCreditSupported = upscaleEntry?.credit_enabled ?? CREDIT_VIDEO_UPSCALE_MODELS.has(upscaleModel);

  const updateLora = (index, patch) => {
    setLtxLoras((current) => current.map((lora, position) => (position === index ? { ...lora, ...patch } : lora)));
  };

  return {
    kind: 'video',
    engines: VID_ENGINES,
    mode, setMode,
    ...target,
    prompt, setPrompt,
    engine, setEngine,
    outpaintOpt, setOutpaintOpt,
    falUpscale, setFalUpscale,
    sharpening, setSharpening,
    ltxRes, setLtxRes,
    videoOptions: offered,
    ltxAudio, setLtxAudio,
    ltxGuidance, setLtxGuidance,
    ltxPromptExpansion, setLtxPromptExpansion,
    ltxNegativePrompt, setLtxNegativePrompt,
    ltxLoras,
    updateLora,
    addLora: () => setLtxLoras((current) => (current.length < MAX_LORAS ? [...current, { path: '', scale: 1, transformer: 'both' }] : current)),
    removeLora: (index) => setLtxLoras((current) => current.filter((_, position) => position !== index)),
    minimaxRes, setMinimaxRes, minimaxResOptions,
    minimaxSeed, setMinimaxSeed,
    ltx25Res, setLtx25Res, ltx25ResOptions,
    ltx25Anchor, setLtx25Anchor,
    seedvrFactor, setSeedvrFactor,
    seedvrTarget, setSeedvrTarget,
    btdRes, setBtdRes,
    btdFps, setBtdFps,
    btdTier, setBtdTier,
    btdPreset, setBtdPreset,
    btdFidelity, setBtdFidelity,
    trimEnabled, setTrimEnabled,
    trimStart, setTrimStart,
    trimDur, setTrimDur,
    setOutArgs, setUpArgs,
    upscaleOnly,
    falPicked,
    noUpscale,
    studioPicked,
    ltxPicked,
    minimaxPicked,
    ltx25Picked,
    loraPicked,
    outpaintCatalog,
    outpaintOptions,
    upscaleCatalog,
    upscaleOptions,
    outpaintEntry,
    upscaleEntry,
    outpaintModel,
    upscaleModel,
    outpaintLabel: outpaintOpt,
    upscaleLabel: falUpscale,
    parameters,
    // One file's /process parameters: an unpicked shape is that file's own nearest.
    // Keep shape sends the file's nearest too: upscale_only with a named shape is
    // the server's native-shape upscale (without one it squares, the legacy API).
    parametersFor: (meta) => ({ ...parameters, target_aspect: upscaleOnly ? nearestOf(meta) : target.shapeFor(meta) }),
    byokOnlyFor(items) {
      const needsOutpaintCloud = items.some((item) => !matchesTarget(item, target.shapeFor(item)));
      return (needsOutpaintCloud && !outpaintCreditSupported) || (falPicked && !upscaleCreditSupported);
    },
    validate() {
      if (!upscaleOnly && outpaintEntry?.is_custom && !outArgs.ok) return `Outpaint custom args: ${outArgs.error}`;
      if (falPicked && upscaleEntry?.is_custom && !upArgs.ok) return `Upscale custom args: ${upArgs.error}`;
      return '';
    },
  };
}
