import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Hero, Section, SpecRow, Eyebrow, BlockingBanner, GatedReason, Mono, AccentBlock } from '../components/ui/primitives.jsx';
import { Segmented, Button, Field, ToggleRow } from '../components/ui/controls.jsx';
import UploadZone from '../components/ui/UploadZone.jsx';
import JobRunner from '../components/ui/JobRunner.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import CustomModelPanel from '../components/ui/CustomModelPanel.jsx';
import LocationField from '../components/ui/LocationField.jsx';
import { useHealthContext } from '../hooks/HealthContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';
import { useObjectUrl } from '../hooks/useObjectUrl.js';

// Upload wizard — single-file intake that will eventually replace the
// standalone Image/Video extender pages (which stay mounted for now).
// The extend step below mirrors those pages' full pipeline options
// (models, custom endpoints, LoRA, trim, cost estimate) per media kind.

const PATH_OPTS = ['SHARE DIRECTLY', 'EXTEND ANYWAY'];
const MODES = ['OUTPAINT + UPSCALE', 'UPSCALE ONLY'];
const IMG_ENGINES = ['FAST', 'FAL AI'];
const VID_ENGINES = ['FAST', 'STUDIO', 'FAL AI'];
const TITLE_MAX = 100;
const CAPTION_MAX = 2200;
const TAGS_MAX = 5;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm'];

const FALLBACK_FAL_MODELS = ['Clarity Upscaler', 'CCSR', 'AuraSR', 'ESRGAN'];
const FALLBACK_FAL_MODEL_IDS = {
  'Clarity Upscaler': 'fal-ai/clarity-upscaler',
  CCSR: 'fal-ai/ccsr',
  AuraSR: 'fal-ai/aura-sr',
  ESRGAN: 'fal-ai/esrgan',
};
const STOCK_OUTPAINT_IMG = 'fal-ai/flux/outpaint';
const IMG_PROMPT_DEFAULT = 'Seamlessly extend the background environment, high details, matching texture and lighting.';
const VID_PROMPT_DEFAULT = 'Seamlessly extend the background environment, cool lighting, neutral color temperature, matching original white balance and color palette.';
const VID_NEG_DEFAULT = 'yellow tint, sepia, warm cast, color distortion, discoloration, overexposure, oversaturated';

function fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function kindOf(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return null;
}

export default function UploadPage() {
  const navigate = useNavigate();
  const health = useHealthContext();
  const cfg = useConfigContext();
  const probes = health?.probes || {};
  const falOk = health?.fal_key?.ok ?? false;
  const studioOk = probes.vapoursynth?.ok && probes.znedi3?.ok;

  const models = cfg?.config?.models || {};
  // Image catalogs (mirror ImagePage).
  const imgUpscaleCatalog = models.image_upscale_catalog || [];
  const imgUpscaleOptions = imgUpscaleCatalog.length
    ? imgUpscaleCatalog.map((e) => e.label)
    : FALLBACK_FAL_MODELS;
  // Video catalogs (mirror VideoPage).
  const vidOutpaintCatalog = models.video_outpaint_catalog || [];
  const vidUpscaleCatalog = models.video_upscale_catalog || [];
  const vidOutpaintOptions = vidOutpaintCatalog.map((e) => e.label);
  const vidUpscaleOptions = vidUpscaleCatalog.map((e) => e.label);

  // ── 01 Select ──
  const [file, setFile] = useState(null);
  const [kind, setKind] = useState(null);
  const [staged, setStaged] = useState(null);
  const [staging, setStaging] = useState(false);

  // ── 02 Square gate + pipeline config ──
  const [path, setPath] = useState('skip'); // 'skip' | 'extend'
  const [mode, setMode] = useState(MODES[0]);
  const [engine, setEngine] = useState('FAST');
  const [prompt, setPrompt] = useState(IMG_PROMPT_DEFAULT);
  const [sharpening, setSharpening] = useState(0.5);
  const [job, setJob] = useState(null);
  const [jobDone, setJobDone] = useState(null);
  const [busy, setBusy] = useState(false);

  // Image-only options.
  const [imgFalModel, setImgFalModel] = useState(FALLBACK_FAL_MODELS[0]);
  const [imgOutArgs, setImgOutArgs] = useState({ args: {}, ok: true, error: '' });
  const [imgUpArgs, setImgUpArgs] = useState({ args: {}, ok: true, error: '' });

  // Video-only options.
  const [outpaintOpt, setOutpaintOpt] = useState(vidOutpaintOptions[0] || 'LTX 2.3 Quality');
  const [falUpscale, setFalUpscale] = useState(vidUpscaleOptions[0] || 'Bytedance Upscaler');
  const [ltxRes, setLtxRes] = useState('720p');
  const [ltxAudio, setLtxAudio] = useState(true);
  const [ltxGuidance, setLtxGuidance] = useState(1.0);
  const [ltxPromptExpansion, setLtxPromptExpansion] = useState(false);
  const [ltxNegativePrompt, setLtxNegativePrompt] = useState(VID_NEG_DEFAULT);
  const [ltxLoras, setLtxLoras] = useState([{ path: '', scale: 1, transformer: 'both' }]);
  const [seedvrFactor, setSeedvrFactor] = useState(2.0);
  const [seedvrTarget, setSeedvrTarget] = useState('1080p');
  const [btdRes, setBtdRes] = useState('4k');
  const [btdFps, setBtdFps] = useState('30fps');
  const [btdTier, setBtdTier] = useState('fast');
  const [btdPreset, setBtdPreset] = useState('general');
  const [btdFidelity, setBtdFidelity] = useState('medium');
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimDur, setTrimDur] = useState(15);
  const [outArgs, setOutArgs] = useState({ args: {}, ok: true, error: '' });
  const [upArgs, setUpArgs] = useState({ args: {}, ok: true, error: '' });

  // ── 03 Details ──
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [tags, setTags] = useState([]);
  const [tagDraft, setTagDraft] = useState('');
  const [location, setLocation] = useState({ city: '', country: '', display_name: '' });

  // ── 04 Share ──
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(null);
  const [error, setError] = useState('');

  const previewUrl = useObjectUrl(file);
  const isSquare = !!staged && (staged.orientation === 'SQUARE' || (staged.width && staged.width === staged.height));
  const upscaleOnly = mode === 'UPSCALE ONLY';
  const falPicked = engine === 'FAL AI';
  const studioPicked = engine === 'STUDIO';
  const needsKey = path === 'extend' && (!upscaleOnly || falPicked);
  const canShareSource = path === 'skip' ? !!staged : !!jobDone;

  const blockedIds = kind === 'video' ? ['ffmpeg', 'ffprobe', 'encoder'] : ['ffmpeg', 'ffprobe'];
  const blocked = blockedIds.filter((id) => probes[id] && !probes[id].ok).map((id) => probes[id]);

  // ── Image derived (mirror ImagePage) ──
  const imgUpscaleEntry = imgUpscaleCatalog.find((e) => e.label === imgFalModel) || null;
  const imgUpscaleModel = imgUpscaleEntry?.model || FALLBACK_FAL_MODEL_IDS[imgFalModel] || models.upscale_img;
  const imgOutpaintModel = models.outpaint_img || STOCK_OUTPAINT_IMG;
  const imgOutpaintCustom = imgOutpaintModel !== STOCK_OUTPAINT_IMG;
  const imgOutpaintShort = (imgOutpaintModel || '').split('/').filter(Boolean).pop() || 'custom';

  // ── Video derived (mirror VideoPage) ──
  const vidOutpaintEntry = vidOutpaintCatalog.find((e) => e.label === outpaintOpt) || vidOutpaintCatalog[0];
  const vidUpscaleEntry = vidUpscaleCatalog.find((e) => e.label === falUpscale) || vidUpscaleCatalog[0];
  const vidOutpaintModel = vidOutpaintEntry?.model || models.outpaint_vid;
  const vidUpscaleModel = vidUpscaleEntry?.model || models.upscale_vid;
  const loraPicked = !upscaleOnly && (outpaintOpt.includes('LoRA') || (vidOutpaintModel || '').includes('/lora'));
  const loraList = loraPicked ? ltxLoras.map((l) => ({ ...l, path: (l.path || '').trim() })).filter((l) => l.path) : [];
  const maxSourceDur = staged?.duration || 60;
  const effDur = trimEnabled ? Math.min(maxSourceDur, trimDur) : (staged?.duration || 0);

  const cost = useMemo(() => {
    const out = { label: 'None (Upscale Only)', value: 0 };
    const up = { label: `Local (${engine} Engine — $0.00)`, value: 0 };
    const resWidth = { '480p': 480, '720p': 720, '1080p': 1080 }[ltxRes] || 720;
    const frames = effDur > 0 ? Math.round(effDur * 24) : 121;
    if (!upscaleOnly && vidOutpaintEntry) {
      if (vidOutpaintEntry.pricing_kind === 'per_mp') {
        out.label = `${vidOutpaintEntry.label} (${ltxRes}) (~$${vidOutpaintEntry.price.toFixed(4)}/MP)`;
        out.value = ((resWidth * resWidth * frames) / 1e6) * vidOutpaintEntry.price;
      } else {
        const rate = vidOutpaintEntry.price || 0.06;
        out.label = `${vidOutpaintEntry.label} ($${rate.toFixed(2)}/s)`;
        out.value = effDur * rate;
      }
    }
    if (falPicked && vidUpscaleEntry) {
      if (vidUpscaleEntry.pricing_kind === 'per_mp') {
        const w = { '720p': 720, '1080p': 1080, '2160p': 2160 }[seedvrTarget] || 1080;
        up.label = `${vidUpscaleEntry.label} (${seedvrTarget}) ($${vidUpscaleEntry.price.toFixed(3)}/MP)`;
        up.value = ((w * w * frames) / 1e6) * vidUpscaleEntry.price;
      } else if (vidUpscaleEntry.model && vidUpscaleEntry.model.includes('bytedance')) {
        const base = vidUpscaleEntry.base_rates?.[btdRes] ?? 0.0288;
        const rate = base * (vidUpscaleEntry.fps_multiplier?.[btdFps] ?? 1) * (vidUpscaleEntry.tier_multiplier?.[btdTier] ?? 1);
        up.label = `Bytedance (${btdRes}, ${btdFps}, ${btdTier}) ($${rate.toFixed(4)}/s)`;
        up.value = effDur * rate;
      } else {
        const rate = vidUpscaleEntry.price || 0.003;
        up.label = `${vidUpscaleEntry.label} ($${rate.toFixed(3)}/s)`;
        up.value = effDur * rate;
      }
    }
    return { out, up, total: out.value + up.value };
  }, [upscaleOnly, vidOutpaintEntry, effDur, ltxRes, falPicked, vidUpscaleEntry, btdRes, btdFps, btdTier, seedvrTarget, engine]);

  // Preselect sidebar CUSTOM overrides once catalogs arrive (mirrors both pages).
  const customInit = useRef(false);
  useEffect(() => {
    if (customInit.current) return;
    if (kind === 'image' && imgUpscaleCatalog.length) {
      customInit.current = true;
      const match = imgUpscaleCatalog.find((e) => e.model === models.upscale_img);
      if (match?.is_custom) setImgFalModel(match.label);
    } else if (kind === 'video' && vidOutpaintCatalog.length && vidUpscaleCatalog.length) {
      customInit.current = true;
      const oc = vidOutpaintCatalog.find((e) => e.model === models.outpaint_vid);
      if (oc?.is_custom) setOutpaintOpt(oc.label);
      const uc = vidUpscaleCatalog.find((e) => e.model === models.upscale_vid);
      if (uc?.is_custom) setFalUpscale(uc.label);
    }
  }, [kind, imgUpscaleCatalog, vidOutpaintCatalog, vidUpscaleCatalog, models]);

  const extendDisabled =
    blocked.length > 0 || (needsKey && !falOk) || (kind === 'video' && studioPicked && !studioOk) || busy;

  const captionTags = useMemo(() => {
    const found = [];
    const re = /#([A-Za-z0-9_]{1,30})/g;
    let m;
    while ((m = re.exec(caption || '')) && found.length < TAGS_MAX) {
      const t = m[1].toLowerCase();
      if (!found.includes(t)) found.push(t);
    }
    return found;
  }, [caption]);

  const effectiveTags = useMemo(() => {
    const merged = [...tags];
    for (const t of captionTags) {
      if (!merged.includes(t) && merged.length < TAGS_MAX) merged.push(t);
    }
    return merged;
  }, [tags, captionTags]);

  const shareDisabled =
    blocked.length > 0 ||
    !staged ||
    !title.trim() ||
    !canShareSource ||
    publishing ||
    busy ||
    (needsKey && !falOk);

  const onFiles = async (files) => {
    const picked = (files || [])[0];
    if (!picked) return;
    setError('');
    setPublished(null);
    setJob(null);
    setJobDone(null);
    const k = kindOf(picked.name);
    if (!k) {
      setError(`Unsupported file type: ${picked.name}. Use PNG/JPG/WEBP or MP4/MOV/AVI/WEBM.`);
      return;
    }
    setFile(picked);
    setKind(k);
    setStaged(null);
    setStaging(true);
    // Reset the extend config to this kind's defaults (pages keep theirs per
    // kind; the wizard is single-file so a clean slate is least surprising).
    setEngine('FAST');
    setMode(MODES[0]);
    setPrompt(k === 'image' ? IMG_PROMPT_DEFAULT : VID_PROMPT_DEFAULT);
    try {
      const meta = await api.upload(k === 'image' ? '/api/image/upload' : '/api/video/upload', picked);
      setStaged(meta);
      const square = meta.orientation === 'SQUARE' || (meta.width && meta.width === meta.height);
      setPath(square ? 'skip' : 'extend');
      if (!title) setTitle(picked.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, TITLE_MAX));
    } catch (e) {
      setError(`Could not stage ${picked.name}: ${e.message}`);
      setFile(null);
      setKind(null);
    } finally {
      setStaging(false);
    }
  };

  const startExtend = async () => {
    if (!staged) return;
    setError('');
    if (kind === 'image') {
      if (!upscaleOnly && imgOutpaintCustom && !imgOutArgs.ok) {
        setError(`Outpaint custom args: ${imgOutArgs.error}`);
        return;
      }
      if (falPicked && imgUpscaleEntry?.is_custom && !imgUpArgs.ok) {
        setError(`Upscale custom args: ${imgUpArgs.error}`);
        return;
      }
    } else {
      if (!upscaleOnly && vidOutpaintEntry?.is_custom && !outArgs.ok) {
        setError(`Outpaint custom args: ${outArgs.error}`);
        return;
      }
      if (falPicked && vidUpscaleEntry?.is_custom && !upArgs.ok) {
        setError(`Upscale custom args: ${upArgs.error}`);
        return;
      }
    }
    setBusy(true);
    setJob(null);
    setJobDone(null);
    try {
      const fd = new FormData();
      if (kind === 'image') {
        fd.append('stage_id', staged.stage_id);
        fd.append('prompt', upscaleOnly ? '' : prompt);
        fd.append('upscale_only', String(upscaleOnly));
        fd.append('sharpening', String(sharpening));
        fd.append('upscale_engine', falPicked ? 'fal' : 'fast');
        fd.append('upscale_model', imgUpscaleModel);
        fd.append('outpaint_model', imgOutpaintModel);
        fd.append('custom_outpaint_args', JSON.stringify(imgOutpaintCustom ? imgOutArgs.args || {} : {}));
        fd.append('custom_upscale_args', JSON.stringify(imgUpscaleEntry?.is_custom ? imgUpArgs.args || {} : {}));
      } else {
        const kv = {
          stage_id: staged.stage_id,
          prompt: upscaleOnly ? '' : prompt,
          upscale_only: String(upscaleOnly),
          upscale_engine: falPicked ? 'fal' : studioPicked ? 'studio' : 'fast',
          sharpening: String(sharpening),
          outpaint_model: upscaleOnly ? 'fal-ai/ltx-2.3-quality/outpaint' : vidOutpaintModel,
          upscale_model: vidUpscaleModel,
          ltx_resolution: ltxRes,
          ltx_audio: String(ltxAudio),
          ltx_guidance: String(ltxGuidance),
          ltx_prompt_expansion: String(ltxPromptExpansion),
          ltx_negative_prompt: ltxNegativePrompt,
          ltx_loras: JSON.stringify(loraList),
          seedvr_factor: String(seedvrFactor),
          seedvr_target: seedvrTarget,
          bytedance_target_res: btdRes,
          bytedance_target_fps: btdFps,
          bytedance_tier: btdTier,
          bytedance_preset: btdPreset,
          bytedance_fidelity: btdFidelity,
          trim_enabled: String(trimEnabled),
          trim_start: String(trimStart),
          trim_duration: String(trimDur),
          custom_outpaint_args: JSON.stringify(vidOutpaintEntry?.is_custom ? outArgs.args || {} : {}),
          custom_upscale_args: JSON.stringify(vidUpscaleEntry?.is_custom ? upArgs.args || {} : {}),
        };
        for (const [k, v] of Object.entries(kv)) fd.append(k, v);
      }
      const res = await api.form(kind === 'image' ? '/api/image/process' : '/api/video/process', fd);
      setJob({ jobId: res.job_id, name: file?.name || 'upload', kind });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addTag = () => {
    const t = tagDraft.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '_');
    setTagDraft('');
    if (!t || tags.includes(t)) return;
    if (tags.length >= TAGS_MAX) {
      setError(`At most ${TAGS_MAX} tags.`);
      return;
    }
    if (!/^[a-z0-9_]{1,30}$/.test(t)) {
      setError('Tags use 1–30 lowercase letters, numbers, or _.');
      return;
    }
    setError('');
    setTags([...tags, t]);
  };

  const share = async () => {
    setError('');
    setPublishing(true);
    try {
      const body = {
        kind,
        title: title.trim(),
        caption,
        tags,
        location: {
          city: location?.city || '',
          country: location?.country || '',
          display_name: location?.display_name || '',
          lat: location?.lat ?? null,
          lon: location?.lon ?? null,
          osm_id: location?.osm_id ?? null,
        },
        ...(path === 'skip' ? { stage_id: staged.stage_id } : { job_id: job.jobId }),
      };
      const res = await api.post('/api/uploads/publish', body);
      setPublished(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const reset = () => {
    setFile(null);
    setKind(null);
    setStaged(null);
    setJob(null);
    setJobDone(null);
    setTitle('');
    setCaption('');
    setTags([]);
    setTagDraft('');
    setLocation({ city: '', country: '', display_name: '' });
    setPublished(null);
    setError('');
    setPath('skip');
  };

  const engines = kind === 'video' ? VID_ENGINES : IMG_ENGINES;

  return (
    <div>
      <Hero title="UPLOAD" kicker="ECHO · SHARE A REEL · FULL EXTENDER PIPELINE · SKIP WHEN ALREADY SQUARE" />

      {blocked.length ? (
        <BlockingBanner
          title="ENVIRONMENT NOT READY"
          lines={blocked.map((p) => `${p.label}: ${p.detail}. ${p.fix}`)}
        />
      ) : null}

      <Section num={1} title="Select Source" active note="Single file · PNG · JPG · WEBP · MP4 · MOV · AVI · WEBM">
        <UploadZone
          accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.avi,.webm"
          multiple={false}
          onFiles={onFiles}
          caption="Drop one image or video, or click to browse"
        />
        {staging ? (
          <div style={{ marginTop: 'var(--sx-3)' }} role="status" aria-busy="true" aria-label="Staging upload">
            <Skeleton h={86} />
            <Mono>STAGING UPLOAD…</Mono>
          </div>
        ) : null}
        {staged ? (
          <div style={{ marginTop: 'var(--sx-4)' }}>
            <SpecRow
              cells={
                kind === 'image'
                  ? [
                    ['SOURCE', `${staged.width}×${staged.height}`, `${staged.orientation} · ${fmtBytes(staged.size_bytes)}`],
                    ['FORMAT', isSquare ? '1:1 SQUARE' : 'NEEDS EXTENDING', staged.filename || ''],
                    ['TARGET', '3840×3840', '1:1 SQUARE MASTER'],
                  ]
                  : [
                    ['SOURCE', `${staged.width}×${staged.height}`, `${staged.orientation} · ${fmtBytes(staged.size_bytes)}`],
                    ['DURATION', `${staged.duration}s`, 'ORIGINAL CLIP'],
                    ['FORMAT', isSquare ? '1:1 SQUARE' : 'NEEDS EXTENDING', 'HEVC MASTER AFTER EXTEND'],
                  ]
              }
            />
            {kind === 'video' && staged.duration > 10 ? (
              <AccentBlock
                tone="warn"
                title={`${staged.duration}s EXCEEDS THE 10s THRESHOLD`}
                lines={['Cloud video outpainting is billed per second. Consider enabling the 15s Trimmer below to optimize costs.']}
              />
            ) : null}
            <div style={{ marginTop: 'var(--sx-3)' }}>
              {kind === 'image' ? (
                <img className="sx-img" style={{ maxHeight: 320, objectFit: 'contain' }} src={previewUrl} alt={file?.name} />
              ) : (
                <video className="sx-video" src={previewUrl} controls playsInline aria-label="Source video preview" />
              )}
            </div>
          </div>
        ) : null}
      </Section>

      <Section num={2} title="Square Gate" active={!!staged} note="EXTEND TO 1:1 OR SKIP">
        {!staged ? (
          <Mono>AWAITING SOURCE FILE…</Mono>
        ) : isSquare ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-4)' }}>
            <div className="sx-accent-block" role="note">
              <div className="sx-accent-block-title">✓ ALREADY 1:1 — YOU CAN SKIP EXTENDING</div>
              <div className="sx-accent-block-body">
                <p>Your media is already square. Share it directly, or extend anyway for AI outpainting.</p>
              </div>
            </div>
            <div>
              <Eyebrow>PUBLISH PATH</Eyebrow>
              <Segmented
                options={PATH_OPTS}
                value={path === 'skip' ? PATH_OPTS[0] : PATH_OPTS[1]}
                onChange={(v) => {
                  setPath(v === PATH_OPTS[0] ? 'skip' : 'extend');
                  setJob(null);
                  setJobDone(null);
                }}
                ariaLabel="Publish path"
              />
            </div>
          </div>
        ) : (
          <div className="sx-accent-block sx-warn" role="note">
            <div className="sx-accent-block-title">1:1 REQUIRED — EXTEND TO CONTINUE</div>
            <div className="sx-accent-block-body">
              <p>This media is {staged.orientation}. Configure the full extender pipeline below.</p>
            </div>
          </div>
        )}

        {staged && path === 'extend' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-4)', marginTop: 'var(--sx-4)' }}>
            <div>
              <Eyebrow>PIPELINE MODE</Eyebrow>
              <Segmented options={MODES} value={mode} onChange={setMode} ariaLabel="Pipeline Mode" />
            </div>

            {!upscaleOnly ? (
              <>
                {kind === 'video' && vidOutpaintOptions.length ? (
                  <div>
                    <Eyebrow>OUTPAINT MODEL</Eyebrow>
                    <Segmented options={vidOutpaintOptions} value={outpaintOpt} onChange={setOutpaintOpt} ariaLabel="Outpaint Model" />
                  </div>
                ) : null}
                {kind === 'video' && vidOutpaintEntry?.is_custom ? (
                  <CustomModelPanel model={vidOutpaintEntry.model} kind="outpaint" entry={vidOutpaintEntry} onArgs={setOutArgs} />
                ) : null}
                {kind === 'image' && imgOutpaintCustom ? (
                  <CustomModelPanel
                    model={imgOutpaintModel}
                    kind="image_outpaint"
                    onArgs={setImgOutArgs}
                    entry={{
                      label: `CUSTOM OUTPAINT (${imgOutpaintShort})`,
                      requirements: 'FAL_KEY set; source image uploaded to fal.ai CDN by the pipeline.',
                      cost_note: 'No estimate stored — pull live pricing via MODEL INFO below before rendering.',
                      expects: 'Sends {image_url, prompt} (padded flux args only apply to fal-ai/flux/outpaint). Check MODEL INFO for the live schema.',
                    }}
                  />
                ) : null}
                <Field label="OUTPAINT EXTENSION PROMPT">
                  <textarea
                    className="sx-textarea"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe the extended square background environment..."
                  />
                </Field>

                {kind === 'video' && outpaintOpt.includes('LTX') ? (
                  <details className="sx-expander">
                    <summary>▸ LTX 2.3 ADVANCED OUTPAINT SETTINGS</summary>
                    <div className="sx-expander-body sx-cols sx-cols-2">
                      <Field label="OUTPUT RESOLUTION TIER">
                        <select className="sx-select" value={ltxRes} onChange={(e) => setLtxRes(e.target.value)}>
                          {['720p', '1080p', '480p'].map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="GUIDANCE SCALE (CFG)">
                        <input
                          className="sx-input"
                          type="number"
                          min={1.0}
                          max={20.0}
                          step={0.1}
                          value={ltxGuidance}
                          onChange={(e) => setLtxGuidance(Number(e.target.value))}
                        />
                      </Field>
                      <Field label="NEGATIVE PROMPT" style={{ gridColumn: '1 / -1' }}>
                        <input
                          className="sx-input"
                          type="text"
                          value={ltxNegativePrompt}
                          onChange={(e) => setLtxNegativePrompt(e.target.value)}
                          placeholder="yellow tint, sepia, warm cast, color distortion, discoloration, overexposure, oversaturated"
                        />
                      </Field>
                      <div style={{ alignSelf: 'center' }}>
                        <ToggleRow label="Preserve Audio Track" checked={ltxAudio} onChange={setLtxAudio} />
                      </div>
                      <div style={{ alignSelf: 'center' }}>
                        <ToggleRow label="Enable Prompt Expansion (LLM Enrich)" checked={ltxPromptExpansion} onChange={setLtxPromptExpansion} />
                      </div>
                    </div>
                  </details>
                ) : null}

                {kind === 'video' && loraPicked ? (
                  <details className="sx-expander" open>
                    <summary>▸ CUSTOM LoRA STACK (MAX 3)</summary>
                    <div className="sx-expander-body sx-cols sx-cols-2">
                      <div style={{ gridColumn: '1 / -1', fontSize: '0.9rem', color: 'var(--sx-muted)', marginBottom: 'var(--sx-2)' }}>
                        Each LoRA must be a direct http(s) URL to a .safetensors file (max 3 GB each). Leave a path empty to skip that slot.
                      </div>
                      {ltxLoras.map((lora, i) => (
                        <div key={i} className="sx-cols sx-cols-2" style={{ gridColumn: '1 / -1', gap: 'var(--sx-3)' }}>
                          <Field label={`LoRA #${i + 1} — SAFETENSORS URL`}>
                            <input
                              className="sx-input"
                              type="url"
                              placeholder="https://example.com/path/to/lora.safetensors"
                              value={lora.path}
                              onChange={(e) => {
                                const next = [...ltxLoras];
                                next[i] = { ...next[i], path: e.target.value };
                                setLtxLoras(next);
                              }}
                            />
                          </Field>
                          <div className="sx-cols sx-cols-2" style={{ gap: 'var(--sx-3)' }}>
                            <Field label="SCALE">
                              <input
                                className="sx-input"
                                type="number"
                                min={0}
                                max={2}
                                step={0.05}
                                value={lora.scale}
                                onChange={(e) => {
                                  const next = [...ltxLoras];
                                  next[i] = { ...next[i], scale: Number(e.target.value) };
                                  setLtxLoras(next);
                                }}
                              />
                            </Field>
                            <Field label="TRANSFORMER">
                              <select
                                className="sx-select"
                                value={lora.transformer}
                                onChange={(e) => {
                                  const next = [...ltxLoras];
                                  next[i] = { ...next[i], transformer: e.target.value };
                                  setLtxLoras(next);
                                }}
                              >
                                {['both', 'high', 'low'].map((o) => (
                                  <option key={o}>{o}</option>
                                ))}
                              </select>
                            </Field>
                          </div>
                          {i > 0 ? (
                            <button
                              type="button"
                              className="sx-link-danger"
                              onClick={() => setLtxLoras(ltxLoras.filter((_, j) => j !== i))}
                            >
                              REMOVE LoRA #{i + 1}
                            </button>
                          ) : null}
                        </div>
                      ))}
                      {ltxLoras.length < 3 ? (
                        <button
                          type="button"
                          className="sx-link"
                          style={{ gridColumn: '1 / -1', alignSelf: 'start' }}
                          onClick={() => setLtxLoras([...ltxLoras, { path: '', scale: 1, transformer: 'both' }])}
                        >
                          + ADD LoRA
                        </button>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </>
            ) : null}

            <div>
              <Eyebrow>UPSCALE ENGINE</Eyebrow>
              <Segmented options={engines} value={engine} onChange={setEngine} ariaLabel="Upscale Engine" />
            </div>

            {falPicked && kind === 'image' ? (
              <>
                <div>
                  <Eyebrow>FAL AI UPSCALE MODEL</Eyebrow>
                  <Segmented options={imgUpscaleOptions} value={imgFalModel} onChange={setImgFalModel} ariaLabel="FAL Model" />
                </div>
                {imgUpscaleEntry?.is_custom ? (
                  <CustomModelPanel model={imgUpscaleEntry.model} kind="image_upscale" entry={imgUpscaleEntry} onArgs={setImgUpArgs} />
                ) : null}
              </>
            ) : null}

            {falPicked && kind === 'video' ? (
              <>
                {vidUpscaleOptions.length ? (
                  <div>
                    <Eyebrow>FAL AI UPSCALE MODEL</Eyebrow>
                    <Segmented options={vidUpscaleOptions} value={falUpscale} onChange={setFalUpscale} ariaLabel="FAL Upscale Model" />
                  </div>
                ) : null}
                {vidUpscaleEntry?.is_custom ? (
                  <CustomModelPanel model={vidUpscaleEntry.model} kind="upscale" entry={vidUpscaleEntry} onArgs={setUpArgs} />
                ) : null}

                {falUpscale.includes('Bytedance') ? (
                  <details className="sx-expander">
                    <summary>▸ BYTEDANCE UPSCALER SETTINGS</summary>
                    <div className="sx-expander-body sx-cols sx-cols-2">
                      <Field label="TARGET RESOLUTION">
                        <select className="sx-select" value={btdRes} onChange={(e) => setBtdRes(e.target.value)}>
                          {['4k', '2k', '1080p'].map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="TARGET FPS">
                        <select className="sx-select" value={btdFps} onChange={(e) => setBtdFps(e.target.value)}>
                          {['30fps', '60fps'].map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="QUALITY TIER">
                        <select className="sx-select" value={btdTier} onChange={(e) => setBtdTier(e.target.value)}>
                          {['fast', 'standard', 'pro'].map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="SCENARIO PRESET">
                        <select className="sx-select" value={btdPreset} onChange={(e) => setBtdPreset(e.target.value)}>
                          {['general', 'ugc', 'short_series', 'aigc', 'old_film'].map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="FIDELITY INTENSITY">
                        <select className="sx-select" value={btdFidelity} onChange={(e) => setBtdFidelity(e.target.value)}>
                          {['medium', 'high'].map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  </details>
                ) : null}

                {falUpscale.includes('SeedVR') ? (
                  <details className="sx-expander">
                    <summary>▸ SEEDVR2 UPSCALE SETTINGS</summary>
                    <div className="sx-expander-body sx-cols sx-cols-2">
                      <Field label="UPSCALE FACTOR">
                        <input
                          className="sx-input"
                          type="number"
                          min={1}
                          max={4}
                          step={0.5}
                          value={seedvrFactor}
                          onChange={(e) => setSeedvrFactor(Number(e.target.value))}
                        />
                      </Field>
                      <Field label="TARGET RESOLUTION TIER">
                        <select className="sx-select" value={seedvrTarget} onChange={(e) => setSeedvrTarget(e.target.value)}>
                          {['1080p', '2160p', '1440p', '720p'].map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  </details>
                ) : null}
              </>
            ) : null}

            {kind === 'video' && studioPicked && !studioOk ? (
              <AccentBlock
                title="STUDIO ENGINE UNAVAILABLE"
                tone="warn"
                lines={[
                  'This system is missing VapourSynth + the znedi3 plugin, so the neural STUDIO upscale engine cannot execute.',
                  'FAST engine uses Lanczos4 + CAS and is fully operational.',
                ]}
                code={['pip install vapoursynth', '+ vsznedi3 plugin']}
              />
            ) : null}

            {!studioPicked ? (
              <div>
                <Eyebrow>CONTRAST ADAPTIVE SHARPENING (CAS)</Eyebrow>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sx-4)' }}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={sharpening}
                    disabled={!probes.cas?.ok}
                    onChange={(e) => setSharpening(Number(e.target.value))}
                    aria-label="CAS Sharpening level"
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={sharpening}
                  />
                  <span className="sx-stat-value" style={{ fontSize: '1.2rem', minWidth: '4ch' }}>
                    {Math.round(sharpening * 100)}%
                  </span>
                </div>
                {!probes.cas?.ok ? <GatedReason>CAS FILTER UNAVAILABLE — SHARPENING WILL BE SKIPPED</GatedReason> : null}
              </div>
            ) : null}

            {kind === 'video' ? (
              <div>
                <Eyebrow>CLIP TRIMMING (MAX 15 SECONDS)</Eyebrow>
                <ToggleRow label="Enable 15s Video Trimming" checked={trimEnabled} onChange={setTrimEnabled} />
                {trimEnabled ? (
                  <div className="sx-cols sx-cols-2" style={{ marginTop: 'var(--sx-2)' }}>
                    <Field label={`START TIME (s) — MAX ${Math.max(0, maxSourceDur - 1).toFixed(1)}`}>
                      <input
                        className="sx-input"
                        type="number"
                        min={0}
                        max={Math.max(0, maxSourceDur - 1)}
                        step={0.5}
                        value={trimStart}
                        onChange={(e) => setTrimStart(Number(e.target.value))}
                      />
                    </Field>
                    <Field label="CLIP DURATION (s — MAX 15s)">
                      <input
                        className="sx-input"
                        type="number"
                        min={1}
                        max={15}
                        step={0.5}
                        value={trimDur}
                        onChange={(e) => setTrimDur(Number(e.target.value))}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            ) : null}

            {kind === 'video' ? (
              <div className="sx-cost-panel">
                <div className="sx-cost-head">
                  <span className="sx-cost-title">ESTIMATED CLOUD BILLING BREAKDOWN</span>
                  <span className="sx-cost-total">EST. TOTAL: ~${cost.total.toFixed(4)} USD</span>
                </div>
                <div className="sx-cost-body">
                  <div>• <b>Batch Scope:</b> 1 video ({effDur.toFixed(1)}s total processing time)</div>
                  <div>• <b>Trimming:</b> {trimEnabled ? `ENABLED (${trimDur}s max)` : 'DISABLED (Full video)'}</div>
                  <div>• <b>Outpaint Stage:</b> ~${cost.out.value.toFixed(4)} USD ({cost.out.label})</div>
                  <div>• <b>Upscale Stage:</b> ~${cost.up.value.toFixed(4)} USD ({cost.up.label})</div>
                </div>
              </div>
            ) : null}

            {blocked.length ? <GatedReason>{blocked[0].label} UNAVAILABLE — CHECK SYSTEM PROBES</GatedReason> : null}
            {!blocked.length && kind === 'video' && studioPicked && !studioOk ? (
              <GatedReason>STUDIO ENGINE NOT INSTALLED — PLEASE SWITCH TO FAST OR FAL AI</GatedReason>
            ) : null}
            {!blocked.length && needsKey && !falOk ? (
              <GatedReason>FAL API KEY REQUIRED FOR OUTPAINTING / CLOUD UPSCALE</GatedReason>
            ) : null}

            <div style={{ marginTop: 'var(--sx-2)' }}>
              <Button primary disabled={extendDisabled} loading={busy} onClick={startExtend}>
                ▶ RENDER 1:1 SQUARE
              </Button>
            </div>

            {error ? (
              <div className="sx-error-box" role="alert">
                <div className="sx-error-title">EXECUTION ERROR</div>
                <div>{error}</div>
              </div>
            ) : null}
            {job ? <JobRunner jobId={job.jobId} name={job.name} kind={job.kind} onDone={setJobDone} /> : null}
            {jobDone ? <Mono>✓ RENDER COMPLETE — READY TO SHARE</Mono> : null}
          </div>
        ) : null}
      </Section>

      <Section num={3} title="Details" active={!!staged} note="TITLE · CAPTION · TAGS · LOCATION">
        {!staged ? (
          <Mono>AWAITING SOURCE FILE…</Mono>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-3)' }}>
            <Field label={`TITLE (COVER TITLE · MAX ${TITLE_MAX})`}>
              <input
                className="sx-input"
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Give your reel a title…"
              />
            </Field>
            <div className="sx-monospace-sm">{title.length}/{TITLE_MAX}</div>
            <Field label={`CAPTION (MAX ${CAPTION_MAX} · #HASHTAGS AUTO-TAGGED)`}>
              <textarea
                className="sx-textarea"
                value={caption}
                maxLength={CAPTION_MAX}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Say something about this reel… #neon #viral"
              />
            </Field>
            <div className="sx-monospace-sm">{caption.length}/{CAPTION_MAX}</div>
            <Field label={`TAGS (MAX ${TAGS_MAX})`}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  className="sx-input"
                  style={{ flex: '1 1 160px', minWidth: 0 }}
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="Add a tag… (Enter)"
                />
                <Button onClick={addTag}>+ ADD</Button>
              </div>
            </Field>
            {effectiveTags.length ? (
              <div className="sx-tag-row" aria-label="Tags">
                {tags.map((t) => (
                  <button type="button" key={t} className="sx-tag-chip" onClick={() => setTags(tags.filter((x) => x !== t))} title="Remove tag">
                    #{t} ✕
                  </button>
                ))}
                {captionTags.filter((t) => !tags.includes(t)).map((t) => (
                  <span key={`c-${t}`} className="sx-tag-chip sx-tag-auto" title="Auto-tagged from caption">
                    #{t}
                  </span>
                ))}
              </div>
            ) : (
              <div className="sx-monospace-sm">No tags yet — type above or add #hashtags in the caption.</div>
            )}
            <Field label="LOCATION (FREE TEXT · MATCHED TO MAP)">
              <LocationField value={location} onChange={setLocation} />
            </Field>
            {location?.display_name ? (
              <Mono>📍 {location.display_name}</Mono>
            ) : location?.city ? (
              <Mono>📍 {location.city}{location.country ? `, ${location.country}` : ''} (CUSTOM)</Mono>
            ) : null}
          </div>
        )}
      </Section>

      <Section num={4} title="Share" active={!!staged} note="PUBLISH TO EXPLORE + REELS">
        {!staged ? (
          <Mono>AWAITING SOURCE FILE…</Mono>
        ) : published ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-3)' }}>
            <div className="sx-accent-block" role="status">
              <div className="sx-accent-block-title">✓ SHARED — LIVE IN EXPLORE + REELS</div>
              <div className="sx-accent-block-body">
                <p>{published.meta?.title}</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button primary onClick={() => navigate(`/reels?folder=uploads&codec=all&sort=newest&play=${encodeURIComponent(published.rel_path)}`)}>
                ▶ PLAY IN REELS
              </Button>
              <Button onClick={() => navigate('/explore')}>EXPLORE GRID</Button>
              <Button onClick={reset}>+ NEW UPLOAD</Button>
            </div>
            <Mono>{published.media_url}</Mono>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-3)' }}>
            {!title.trim() ? <GatedReason>TITLE IS REQUIRED BEFORE SHARING</GatedReason> : null}
            {path === 'extend' && !jobDone ? <GatedReason>RENDER THE 1:1 EXTEND FIRST (STEP 02)</GatedReason> : null}
            {needsKey && !falOk ? <GatedReason>FAL API KEY REQUIRED FOR THE EXTEND PATH</GatedReason> : null}
            <div>
              <Button primary disabled={shareDisabled} loading={publishing} onClick={share}>
                SHARE REEL TO UPLOADS
              </Button>
            </div>
            {error ? (
              <div className="sx-error-box" role="alert">
                <div className="sx-error-title">SHARE FAILED</div>
                <div>{error}</div>
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
