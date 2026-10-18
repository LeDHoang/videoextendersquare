import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { BlockingBanner, Mono } from '../components/ui/primitives.jsx';
import { Segmented, Button, ToggleRow } from '../components/ui/controls.jsx';
import { useHealthContext } from '../hooks/HealthContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';
import { useObjectUrl } from '../hooks/useObjectUrl.js';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useWallet } from '../hooks/WalletContext.jsx';
import { appendProcessingParameters } from '../utils/cloudBilling.js';
import { billingErrorMessage } from '../utils/billingErrors.js';
import { STEREO_LABELS, stereoCandidate, stereoEyeSize } from '../utils/mediaFormat.js';
import StudioStage from '../components/upload/StudioStage.jsx';
import { useImageExtendConfig, useVideoExtendConfig } from '../components/upload/useExtendConfig.js';
import { useRenderFunding } from '../components/upload/useRenderFunding.js';
import { pipelineSummary } from '../components/upload/stageGeometry.js';
import { DeckSection, CoreEngineSection, AdvancedSection, UpscaleSection, ExecuteSection } from '../components/upload/ExtendDeck.jsx';
import { DetailsSection, ShareSection, TITLE_MAX, TAGS_MAX } from '../components/upload/PostDeck.jsx';

// Upload Studio — one place to extend and share. Left: the 1:1 master stage
// (original + extended result). Right: every extender setting of the
// standalone Image/Video pages (which stay mounted), then post details and
// share. BATCH EXTEND renders many files with one configuration and no
// publishing, like the standalone pages' multi-file mode.

const STUDIO_MODES = ['POST', 'BATCH EXTEND'];
const PATH_OPTS = ['SHARE DIRECTLY', 'EXTEND ANYWAY'];
// One post is either a single video or 1–10 images (a slideshow), never both.
const MAX_POST_IMAGES = 10;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm'];
const ACCEPT = '.png,.jpg,.jpeg,.webp,.mp4,.mov,.avi,.webm';

function kindOf(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return null;
}

const isSquareMeta = (meta) => !!meta && (meta.orientation === 'SQUARE' || (meta.width && meta.width === meta.height));
// Stereo layout a staged upload could hold: the server's detection block, or
// the exact 2:1 / 1:2 geometry for older stage responses.
const metaStereoCandidate = (meta) => meta?.stereo?.candidate || stereoCandidate(meta?.width, meta?.height);
const metaStereoDetected = (meta) => !!(meta?.stereo?.detected && metaStereoCandidate(meta));
const titleFromName = (name) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, TITLE_MAX);
const releaseEntries = (entries) => {
  for (const entry of entries) URL.revokeObjectURL(entry.url);
};

// Detection result + 3D toggle for an exact 2:1 / 1:2 upload.
function StereoChoice({ choice, meta, on, onToggle, disabled, slideshow }) {
  const label = STEREO_LABELS[choice.candidate];
  const eye = stereoEyeSize(choice.candidate, meta?.width, meta?.height);
  const how = choice.method === 'metadata'
    ? 'Detected from the file\'s stereo metadata.'
    : choice.method === 'content'
      ? 'Detected: the two halves show the same scene from two eyes.'
      : choice.method === 'no_parallax'
        ? 'The two halves are the same picture with no depth offset (a split-screen copy), so 3D is off.'
        : null;
  return (
    <div className="sx-studio-stereo">
      <div className={`sx-accent-block ${on ? '' : 'sx-muted'}`} role="note">
        <div className="sx-accent-block-title">
          {choice.detected ? `3D ${label} DETECTED` : `${choice.candidate === 'sbs' ? '2:1' : '1:2'} FRAME — IS THIS 3D ${label}?`}
        </div>
        <div className="sx-accent-block-body">
          <p>
            {on
              ? `Published as-is as stereoscopic 3D: each eye gets one ${eye.width}×${eye.height} square in VR, and 2D views show the left eye.`
              : `Turn on if ${slideshow ? 'these images hold' : 'this file holds'} a left/right eye pair ${choice.candidate === 'sbs' ? 'side by side' : 'stacked top over bottom'}. Off extends it to a flat 1:1 square instead.`}
          </p>
          {how ? <p className="sx-monospace-sm">{how}</p> : null}
        </div>
      </div>
      {disabled ? null : (
        <ToggleRow label={`STEREOSCOPIC 3D · ${label}`} checked={on} onChange={onToggle} help="One square per eye; skips the extender" />
      )}
    </div>
  );
}

export default function UploadPage() {
  const { user } = useAuth();
  const { wallet, catalog, falKey, refresh: refreshWallet } = useWallet();
  const health = useHealthContext();
  const cfgCtx = useConfigContext();
  const probes = health?.probes || {};
  const studioOk = probes.vapoursynth?.ok && probes.ffms2?.ok && probes.znedi3?.ok;
  const models = cfgCtx?.config?.models || {};

  // Each kind keeps its own extender settings for the whole visit.
  const imageCfg = useImageExtendConfig(models);
  const videoCfg = useVideoExtendConfig(models);

  const [studioMode, setStudioMode] = useState('post');
  const isBatch = studioMode === 'batch';

  // ── POST: one video, one image, or a 1–10 image slideshow ──
  const [file, setFile] = useState(null);
  const [kind, setKind] = useState(null);
  const [staged, setStaged] = useState(null);
  const [staging, setStaging] = useState(false);
  // Multi-image post: every staged image in post order ({ key, file, meta, url }).
  // Empty for single-file uploads; file/staged then mirror gallery[0].
  const [gallery, setGallery] = useState([]);
  const [galleryView, setGalleryView] = useState(null);
  const isSlideshow = gallery.length > 1;
  const [path, setPath] = useState('skip'); // 'skip' | 'extend'
  // 3D: publish an exact 2:1 / 1:2 upload as full side-by-side / top-bottom
  // stereo (as-is, one square per eye). On by default when detected.
  const [stereoOn, setStereoOn] = useState(false);
  const [job, setJob] = useState(null);
  const [jobDone, setJobDone] = useState(null);
  const [jobSettled, setJobSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renderError, setRenderError] = useState('');
  // Why the last file selection was refused (a refused selection keeps
  // whatever was staged before).
  const [pickError, setPickError] = useState('');

  const [title, setTitle] = useState('');
  // The title last filled in from a file name: a new pick may replace it,
  // but never a title the user typed.
  const autoTitleRef = useRef('');
  const [caption, setCaption] = useState('');
  const [tags, setTags] = useState([]);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState('');
  const [location, setLocation] = useState({ city: '', country: '', display_name: '' });
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(null);
  const [shareError, setShareError] = useState('');

  // ── BATCH: many videos or many images, same settings, no publishing ──
  const [batch, setBatch] = useState([]);
  const [batchKind, setBatchKind] = useState(null);
  const [batchSelected, setBatchSelected] = useState(null);
  const [batchStaging, setBatchStaging] = useState(false);
  const [batchPickError, setBatchPickError] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [batchJobs, setBatchJobs] = useState([]);

  const activeKind = isBatch ? batchKind : kind;
  const cfg = activeKind === 'video' ? videoCfg : imageCfg;
  const previewUrl = useObjectUrl(file);
  const isSquare = isSquareMeta(staged);

  // Every image of a slideshow must hold the same stereo layout.
  const stereoChoice = useMemo(() => {
    if (isBatch || !staged) return null;
    const metas = isSlideshow ? gallery.map((entry) => entry.meta) : [staged];
    const candidate = metaStereoCandidate(metas[0]);
    if (!candidate || metas.some((meta) => metaStereoCandidate(meta) !== candidate)) return null;
    return {
      candidate,
      detected: metas.every(metaStereoDetected),
      method: metas[0]?.stereo?.method || null,
    };
  }, [isBatch, staged, isSlideshow, gallery]);
  const stereo = stereoOn && stereoChoice ? stereoChoice.candidate : null;
  // A set with no shared layout has no 3D switch; drop the old choice so it
  // can't come back on silently when the set changes again.
  useEffect(() => {
    if (!stereoChoice) setStereoOn(false);
  }, [stereoChoice]);

  const renderItems = useMemo(() => {
    if (isBatch) return batch.map((entry) => entry.meta);
    return path === 'extend' && staged ? [staged] : [];
  }, [isBatch, batch, path, staged]);
  const funding = useRenderFunding({ kind: activeKind, items: renderItems, config: cfg, user, wallet, catalog, falKey });

  const blockedIds = activeKind === 'video' ? ['ffmpeg', 'ffprobe', 'encoder'] : ['ffmpeg', 'ffprobe'];
  const blocked = blockedIds.filter((id) => probes[id] && !probes[id].ok).map((id) => probes[id]);
  const studioBlocked = activeKind === 'video' && cfg.studioPicked && !studioOk;

  const postRendering = busy || (!!job && !jobSettled);
  const batchRendering = batchBusy || batch.some((entry) => entry.status === 'rendering');
  const canShareSource = path === 'skip' ? !!staged : !!jobDone;

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

  const shareDisabled = blocked.length > 0 || !staged || !title.trim() || !canShareSource || publishing || busy;

  // ── POST intake ──
  const suggestTitle = (name) => {
    if (title && title !== autoTitleRef.current) return;
    const next = titleFromName(name);
    autoTitleRef.current = next;
    setTitle(next);
  };

  // Keep the cover (file/staged) in step with the slideshow order.
  const applyGallery = (next) => {
    if (next.length > 1) {
      setGallery(next);
      setFile(next[0].file);
      setStaged(next[0].meta);
      setPath('skip');
      setGalleryView((current) => (next.some((entry) => entry.key === current) ? current : next[0].key));
      return;
    }
    releaseEntries(next);
    setGallery([]);
    setGalleryView(null);
    const only = next[0];
    setFile(only ? only.file : null);
    setStaged(only ? only.meta : null);
    setKind(only ? 'image' : null);
    if (!only) return;
    // The 3D switch carries over when it already covered this file;
    // otherwise the remaining file starts from its own detection.
    const on = stereoChoice ? stereoOn : metaStereoDetected(only.meta);
    setStereoOn(on);
    setPath(isSquareMeta(only.meta) || (on && metaStereoCandidate(only.meta)) ? 'skip' : 'extend');
  };

  const moveGalleryItem = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= gallery.length) return;
    const next = gallery.slice();
    [next[index], next[target]] = [next[target], next[index]];
    applyGallery(next);
  };

  const removeGalleryItem = (index) => {
    const removed = gallery[index];
    if (removed) URL.revokeObjectURL(removed.url);
    applyGallery(gallery.filter((_, position) => position !== index));
  };

  const stageGallery = async (images) => {
    setFile(null);
    setKind('image');
    setStaged(null);
    setStaging(true);
    setPath('skip');
    try {
      const metas = await Promise.all(images.map((image) => api.upload('/api/image/upload', image)));
      const layouts = new Set(metas.map(metaStereoCandidate));
      setStereoOn(layouts.size === 1 && metas.every(metaStereoDetected));
      applyGallery(images.map((image, index) => ({
        key: metas[index].stage_id,
        file: image,
        meta: metas[index],
        url: URL.createObjectURL(image),
      })));
      suggestTitle(images[0].name);
    } catch (e) {
      setPickError(`Could not stage the images: ${e.message}`);
      setKind(null);
    } finally {
      setStaging(false);
    }
  };

  const onPostFiles = async (files) => {
    const list = Array.from(files || []);
    const picked = list[0];
    if (!picked) return;
    setPickError('');
    const unsupported = list.find((entry) => !kindOf(entry.name));
    if (unsupported) {
      setPickError(`Unsupported file type: ${unsupported.name}. Use PNG/JPG/WEBP or MP4/MOV/AVI/WEBM.`);
      return;
    }
    if (list.length > 1 && list.some((entry) => kindOf(entry.name) === 'video')) {
      setPickError('A post is either one video or up to 10 images. Images and videos cannot be mixed, and a post holds one video. Use BATCH EXTEND to render several videos.');
      return;
    }
    if (list.length > MAX_POST_IMAGES) {
      setPickError(`An image post holds at most ${MAX_POST_IMAGES} images (you picked ${list.length}).`);
      return;
    }
    setRenderError('');
    setShareError('');
    setPublished(null);
    setJob(null);
    setJobDone(null);
    setJobSettled(false);
    releaseEntries(gallery);
    setGallery([]);
    setGalleryView(null);
    if (list.length > 1) {
      await stageGallery(list);
      return;
    }
    const k = kindOf(picked.name);
    setFile(picked);
    setKind(k);
    setStaged(null);
    setStaging(true);
    try {
      const meta = await api.upload(k === 'image' ? '/api/image/upload' : '/api/video/upload', picked);
      const detected = metaStereoDetected(meta);
      setStaged(meta);
      setStereoOn(detected);
      setPath(isSquareMeta(meta) || detected ? 'skip' : 'extend');
      suggestTitle(picked.name);
    } catch (e) {
      setPickError(`Could not stage ${picked.name}: ${e.message}`);
      setFile(null);
      setKind(null);
    } finally {
      setStaging(false);
    }
  };

  // ── BATCH intake ──
  const clearBatch = () => {
    releaseEntries(batch);
    setBatch([]);
    setBatchKind(null);
    setBatchSelected(null);
    setBatchJobs([]);
    setBatchError('');
  };

  const onBatchFiles = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setBatchPickError('');
    const unsupported = list.find((entry) => !kindOf(entry.name));
    if (unsupported) {
      setBatchPickError(`Unsupported file type: ${unsupported.name}. Use PNG/JPG/WEBP or MP4/MOV/AVI/WEBM.`);
      return;
    }
    const kinds = new Set(list.map((entry) => kindOf(entry.name)));
    if (kinds.size > 1) {
      setBatchPickError('A batch is all videos or all images — they use different pipelines. Pick one kind.');
      return;
    }
    const k = kindOf(list[0].name);
    clearBatch();
    setBatchKind(k);
    setBatchStaging(true);
    const stagedEntries = [];
    for (const entry of list) {
      try {
        const meta = await api.upload(k === 'image' ? '/api/image/upload' : '/api/video/upload', entry);
        stagedEntries.push({ key: meta.stage_id, name: entry.name, file: entry, kind: k, meta, url: URL.createObjectURL(entry), status: null, result: null });
      } catch (e) {
        setBatchError(`Could not read ${k} ${entry.name}: ${e.message}`);
      }
    }
    setBatch(stagedEntries);
    setBatchSelected(stagedEntries[0]?.key || null);
    if (!stagedEntries.length) setBatchKind(null);
    setBatchStaging(false);
  };

  const removeBatchItem = (key) => {
    const next = batch.filter((entry) => entry.key !== key);
    const removed = batch.find((entry) => entry.key === key);
    if (removed) URL.revokeObjectURL(removed.url);
    setBatch(next);
    if (!next.length) setBatchKind(null);
    if (batchSelected === key) setBatchSelected(next[0]?.key || null);
  };

  const patchBatchItem = (key, patch) => {
    setBatch((current) => current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  };

  // ── Render ──
  const processForm = (meta, quoteByStage, name) => {
    const fd = new FormData();
    fd.append('stage_id', meta.stage_id);
    appendProcessingParameters(fd, cfg.parameters);
    if (funding.needsCloud(meta)) {
      fd.append('payment_source', funding.paymentSource);
      if (funding.paymentSource === 'credits') {
        const quote = quoteByStage.get(meta.stage_id);
        if (!quote?.quote_id) throw new Error(name ? `A fresh quote is unavailable for ${name}.` : 'A fresh quote is unavailable for this upload.');
        fd.append('quote_id', quote.quote_id);
      }
    }
    return fd;
  };

  const startExtend = async () => {
    if (!staged) return;
    setRenderError('');
    const invalid = cfg.validate();
    if (invalid) {
      setRenderError(invalid);
      return;
    }
    if (funding.fundingBlocked) {
      setRenderError('Choose an available cloud payment source and wait for a valid quote.');
      return;
    }
    setBusy(true);
    setJob(null);
    setJobDone(null);
    setJobSettled(false);
    try {
      const freshQuotes = funding.paymentSource === 'credits' && funding.cloudRequired ? await funding.quoteState.refresh() : [];
      const fd = processForm(staged, new Map(freshQuotes.map((quote) => [quote.stage_id, quote])));
      const res = await api.form(kind === 'image' ? '/api/image/process' : '/api/video/process', fd);
      setJob({ jobId: res.job_id, name: file?.name || 'upload', kind });
      if (funding.cloudRequired) await refreshWallet();
    } catch (requestError) {
      setRenderError(billingErrorMessage(requestError, 'Could not start cloud processing.'));
    } finally {
      setBusy(false);
    }
  };

  const renderBatch = async () => {
    setBatchError('');
    const invalid = cfg.validate();
    if (invalid) {
      setBatchError(invalid);
      return;
    }
    if (funding.fundingBlocked) {
      setBatchError('Choose an available cloud payment source and wait for a valid quote.');
      return;
    }
    setBatchBusy(true);
    const jobList = [];
    try {
      const freshQuotes = funding.paymentSource === 'credits' && funding.cloudRequired ? await funding.quoteState.refresh() : [];
      const quoteByStage = new Map(freshQuotes.map((quote) => [quote.stage_id, quote]));
      for (const entry of batch) {
        const fd = processForm(entry.meta, quoteByStage, entry.name);
        try {
          const res = await api.form(`/api/${batchKind}/process`, fd);
          jobList.push({ jobId: res.job_id, name: entry.name, kind: batchKind, key: entry.key });
          patchBatchItem(entry.key, { status: 'rendering', result: null });
        } catch (submissionError) {
          setBatchError(billingErrorMessage(submissionError));
          patchBatchItem(entry.key, { status: 'failed', result: null });
        }
      }
      setBatchJobs(jobList);
      if (funding.cloudRequired) await refreshWallet();
    } catch (requestError) {
      setBatchError(billingErrorMessage(requestError, 'Could not prepare cloud billing.'));
    } finally {
      setBatchBusy(false);
    }
  };

  // ── Details + share ──
  const addTag = () => {
    const t = tagDraft.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '_');
    setTagDraft('');
    if (!t || tags.includes(t)) return;
    if (tags.length >= TAGS_MAX) {
      setTagError(`At most ${TAGS_MAX} tags.`);
      return;
    }
    if (!/^[a-z0-9_]{1,30}$/.test(t)) {
      setTagError('Tags use 1–30 lowercase letters, numbers, or _.');
      return;
    }
    setTagError('');
    setTags([...tags, t]);
  };

  const share = async () => {
    setShareError('');
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
        ...(isSlideshow ? { extra_stage_ids: gallery.slice(1).map((entry) => entry.meta.stage_id) } : {}),
        ...(stereo && path === 'skip' ? { stereo_layout: stereo } : {}),
      };
      const res = await api.post('/api/uploads/publish', body);
      setPublished(res);
    } catch (e) {
      setShareError(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const reset = () => {
    setPickError('');
    releaseEntries(gallery);
    setGallery([]);
    setGalleryView(null);
    setFile(null);
    setKind(null);
    setStaged(null);
    setJob(null);
    setJobDone(null);
    setJobSettled(false);
    setTitle('');
    autoTitleRef.current = '';
    setCaption('');
    setTags([]);
    setTagDraft('');
    setTagError('');
    setLocation({ city: '', country: '', display_name: '' });
    setPublished(null);
    setRenderError('');
    setShareError('');
    setPath('skip');
    setStereoOn(false);
  };

  const onStereoToggle = (on) => {
    setStereoOn(on);
    setJob(null);
    setJobDone(null);
    setJobSettled(false);
    // 3D posts are published as-is; a 2D wide/tall frame goes back to extend.
    if (on) setPath('skip');
    else if (!isSquare && !isSlideshow) setPath('extend');
  };

  // ── Stage entries ──
  let stageLayoutMode = 'empty';
  let stageEntries = [];
  let stageSelected = null;
  if (isBatch) {
    stageEntries = batch;
    stageSelected = batchSelected;
    stageLayoutMode = batch.length ? 'batch' : 'empty';
  } else if (isSlideshow) {
    stageEntries = gallery.map((entry) => ({ key: entry.key, name: entry.file.name, kind: 'image', meta: entry.meta, url: entry.url }));
    stageSelected = galleryView;
    stageLayoutMode = 'slideshow';
  } else if (staged) {
    stageEntries = [{ key: staged.stage_id || 'single', name: file?.name || staged.filename || 'upload', kind, meta: staged, url: previewUrl, result: path === 'extend' ? jobDone : null }];
    stageLayoutMode = 'single';
  }
  const maxSourceDur = isBatch
    ? (batch.length ? Math.max(...batch.map((entry) => entry.meta.duration || 0)) : 60)
    : (staged?.duration || 60);

  const extending = isBatch ? batch.length > 0 : !!staged && path === 'extend' && !isSlideshow;
  const pipeline = pipelineSummary({
    kind: activeKind,
    path: extending ? 'extend' : (isBatch || !staged ? 'extend' : 'skip'),
    upscaleOnly: cfg.upscaleOnly,
    outpaintLabel: cfg.outpaintLabel,
    engine: cfg.engine,
    upscaleLabel: cfg.upscaleLabel,
    bytedanceRes: cfg.btdRes,
  });
  const summary = stereo ? `3D ${STEREO_LABELS[stereo]} · AS-IS · NO EXTEND` : pipeline;

  // ── Deck ──
  let sectionNum = 0;
  const next = () => {
    sectionNum += 1;
    return sectionNum;
  };
  const showAdvanced = activeKind === 'video' && (cfg.ltxPicked || cfg.loraPicked);
  const disabledRender = blocked.length > 0 || funding.fundingBlocked || studioBlocked || (isBatch ? batchBusy : busy);
  const renderLabel = isBatch
    ? `▶ RENDER ${batch.length ? `${batch.length} ` : ''}${batchKind === 'video' ? 'VIDEO(S)' : 'IMAGE(S)'} 4K SQUARE`
    : '▶ RENDER 4K SQUARE MASTER';

  const renderExtendSections = () => (
    <>
      <CoreEngineSection cfg={cfg} num={next()} />
      {showAdvanced ? <AdvancedSection cfg={cfg} num={next()} /> : null}
      <UpscaleSection cfg={cfg} num={next()} probes={probes} studioOk={studioOk} maxSourceDur={maxSourceDur} />
      <ExecuteSection
        num={next()}
        cfg={cfg}
        funding={funding}
        blocked={blocked}
        studioOk={studioOk}
        disabled={isBatch ? disabledRender || !batch.length : disabledRender}
        busy={isBatch ? batchBusy : busy}
        label={renderLabel}
        onRender={isBatch ? renderBatch : startExtend}
        error={isBatch ? batchError : renderError}
        jobs={isBatch ? batchJobs : (job ? [job] : [])}
        onJobDone={(doneJob, result) => {
          if (isBatch) patchBatchItem(doneJob.key, { status: 'done', result });
          else setJobDone(result);
        }}
        onJobSettled={(settledJob, state) => {
          if (settledJob.key) {
            if (state?.status === 'failed') patchBatchItem(settledJob.key, { status: 'failed' });
          } else {
            setJobSettled(true);
          }
          refreshWallet({ silent: true });
        }}
        footer={isBatch ? (
          batchJobs.length ? (
            <div className="sx-studio-results">
              <div className="sx-studio-results-head">
                <span>RESULTS</span>
                <span>{batchJobs.length} ITEM(S) · 3840×3840 · {batchKind === 'video' ? 'HEVC 4K MASTER' : 'PNG MASTER'}</span>
              </div>
              <Mono>{batchJobs.map((j) => `/api/${j.kind}/jobs/${j.jobId}/result`).join('\n')}</Mono>
            </div>
          ) : null
        ) : jobDone ? <Mono>✓ RENDER COMPLETE — READY TO SHARE</Mono> : null}
      />
    </>
  );

  let deck;
  if (isBatch) {
    deck = (
      <>
        <DeckSection num={next()} title="BATCH SOURCE" badge={batch.length ? `${batch.length} ${batchKind === 'video' ? 'VIDEOS' : 'IMAGES'}` : 'NO PUBLISH'} badgeTone="muted">
          <p className="sx-studio-note">Render many videos or many images with the same settings and download the 4K masters. Batch renders are not published; use POST to share.</p>
          {batch.some((entry) => metaStereoDetected(entry.meta)) ? (
            <div className="sx-accent-block sx-warn" role="note">
              <div className="sx-accent-block-title">3D FILES ARE NOT SUPPORTED IN BATCH</div>
              <div className="sx-accent-block-body">
                <p>Some files look like 3D stereo. Batch extend renders them as flat 2D squares. Publish 3D files one at a time from POST.</p>
              </div>
            </div>
          ) : null}
          {batch.length ? (
            <div className="sx-studio-actions">
              <Button onClick={clearBatch} disabled={batchRendering}>CLEAR BATCH</Button>
            </div>
          ) : (
            <Mono>AWAITING SOURCE FILES…</Mono>
          )}
        </DeckSection>
        {batch.length ? renderExtendSections() : null}
      </>
    );
  } else {
    deck = (
      <>
        <DeckSection
          num={next()}
          title="SOURCE & PUBLISH PATH"
          badge={!staged ? 'AWAITING SOURCE' : stereo ? '3D · AS-IS' : isSlideshow ? 'AS-IS' : path === 'extend' ? 'EXTEND TO 1:1' : 'SHARE DIRECTLY'}
          badgeTone={(path === 'extend' && staged) || stereo ? 'accent' : 'muted'}
        >
          {staged && stereoChoice ? (
            <StereoChoice choice={stereoChoice} meta={staged} on={!!stereo} onToggle={onStereoToggle} disabled={postRendering} slideshow={isSlideshow} />
          ) : null}
          {!staged ? (
            <>
              <p className="sx-studio-note">Drop one video, or up to 10 images for a slideshow post, on the stage. PNG · JPG · WEBP · MP4 · MOV · AVI · WEBM. 3D side-by-side (2:1) and top-bottom (1:2) files are published as-is.</p>
              <Mono>AWAITING SOURCE FILE…</Mono>
            </>
          ) : stereo ? null : isSlideshow ? (
            <div className="sx-accent-block" role="note">
              <div className="sx-accent-block-title">MULTI-IMAGE POST — PUBLISHED AS-IS</div>
              <div className="sx-accent-block-body">
                <p>Slideshow posts skip the extender. Each image is shown center-cropped to 1:1 in the player. To extend an image, upload it on its own.</p>
              </div>
            </div>
          ) : isSquare ? (
            <>
              <div className="sx-accent-block" role="note">
                <div className="sx-accent-block-title">✓ ALREADY 1:1 — YOU CAN SKIP EXTENDING</div>
                <div className="sx-accent-block-body">
                  <p>Your media is already square. Share it directly, or extend anyway for AI outpainting and the 4K master.</p>
                </div>
              </div>
              <Segmented
                options={PATH_OPTS}
                value={path === 'skip' ? PATH_OPTS[0] : PATH_OPTS[1]}
                onChange={(v) => {
                  setPath(v === PATH_OPTS[0] ? 'skip' : 'extend');
                  setJob(null);
                  setJobDone(null);
                  setJobSettled(false);
                }}
                disabled={postRendering}
                ariaLabel="Publish path"
              />
            </>
          ) : (
            <div className="sx-accent-block sx-warn" role="note">
              <div className="sx-accent-block-title">1:1 REQUIRED — EXTEND TO CONTINUE</div>
              <div className="sx-accent-block-body">
                <p>This media is {staged.orientation}. Configure the extender pipeline below.</p>
              </div>
            </div>
          )}
        </DeckSection>
        {staged && path === 'extend' && !isSlideshow ? renderExtendSections() : null}
        {staged ? (
          <>
            <DetailsSection
              num={next()}
              title={title}
              setTitle={setTitle}
              caption={caption}
              setCaption={setCaption}
              tags={tags}
              setTags={setTags}
              tagDraft={tagDraft}
              setTagDraft={setTagDraft}
              captionTags={captionTags}
              effectiveTags={effectiveTags}
              addTag={addTag}
              location={location}
              setLocation={setLocation}
              tagError={tagError}
            />
            <ShareSection
              num={next()}
              user={user}
              title={title}
              path={path}
              jobDone={jobDone}
              shareDisabled={shareDisabled}
              publishing={publishing}
              onShare={share}
              published={published}
              onReset={reset}
              error={shareError}
            />
          </>
        ) : null}
      </>
    );
  }

  return (
    <div className="sx-upload-studio">
      <div className="sx-studio-banner">
        <div className="sx-studio-banner-title">
          <span className="sx-studio-dot sx-pulse" aria-hidden="true" />
          <h1>UPLOAD STUDIO</h1>
        </div>
        <Segmented
          options={STUDIO_MODES}
          value={isBatch ? STUDIO_MODES[1] : STUDIO_MODES[0]}
          onChange={(value) => setStudioMode(value === STUDIO_MODES[1] ? 'batch' : 'post')}
          disabledOptions={postRendering ? [STUDIO_MODES[1]] : batchRendering ? [STUDIO_MODES[0]] : []}
          ariaLabel="Studio mode"
        />
        <div className="sx-studio-banner-meta">PIPELINE: <b>{summary}</b></div>
      </div>

      {blocked.length ? (
        <BlockingBanner
          title="ENVIRONMENT NOT READY"
          lines={blocked.map((p) => `${p.label}: ${p.detail}. ${p.fix}`)}
        />
      ) : null}

      <div className="sx-studio-grid">
        <StudioStage
          layout={stageLayoutMode}
          entries={stageEntries}
          selectedKey={stageSelected}
          onSelect={isBatch ? setBatchSelected : setGalleryView}
          staging={isBatch ? batchStaging : staging}
          pickError={isBatch ? batchPickError : pickError}
          accept={ACCEPT}
          onFiles={isBatch ? onBatchFiles : onPostFiles}
          dropCaption={isBatch
            ? 'Drop several videos or several images — rendered with the same settings, not published'
            : 'Drop one video, or up to 10 images for a slideshow post'}
          extendPath={isBatch || path === 'extend'}
          stereo={isBatch ? null : stereo}
          upscaleOnly={cfg.upscaleOnly}
          outpaintActive={!cfg.upscaleOnly}
          trim={activeKind === 'video' ? { enabled: cfg.trimEnabled, start: cfg.trimStart, dur: cfg.trimDur } : null}
          onMoveGalleryItem={moveGalleryItem}
          onRemoveGalleryItem={removeGalleryItem}
          onRemoveBatchItem={removeBatchItem}
          locked={isBatch ? batchRendering : postRendering || publishing}
        />
        <div className="sx-studio-deck">{deck}</div>
      </div>
    </div>
  );
}
