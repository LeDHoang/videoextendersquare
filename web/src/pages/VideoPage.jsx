import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, SpecRow, Eyebrow, EmptyState, BlockingBanner, GatedReason, ResultHeader, Mono, AccentBlock } from '../components/ui/primitives.jsx';
import { Segmented, Button, Field, ToggleRow } from '../components/ui/controls.jsx';
import UploadZone from '../components/ui/UploadZone.jsx';
import JobRunner from '../components/ui/JobRunner.jsx';
import CustomModelPanel from '../components/ui/CustomModelPanel.jsx';
import { useHealthContext } from '../hooks/HealthContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';
import { useObjectUrl } from '../hooks/useObjectUrl.js';
import StudioLoading from '../components/ui/StudioLoading.jsx';
import CloudFundingPanel from '../components/billing/CloudFundingPanel.jsx';
import { useCreditQuotes } from '../hooks/useCreditQuotes.js';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useWallet } from '../hooks/WalletContext.jsx';
import { appendProcessingParameters, stagedItemNeedsCloud, videoBillingParameters } from '../utils/cloudBilling.js';

const MODES = ['OUTPAINT + UPSCALE', 'UPSCALE ONLY'];
const ENGINES = ['FAST', 'STUDIO', 'FAL AI'];
const CREDIT_OUTPAINT_MODELS = new Set([
  'fal-ai/ltx-2.3-quality/outpaint',
  'fal-ai/ltx-2.3-quality/outpaint/lora',
  'fal-ai/luma-dream-machine/ray-2-flash/reframe',
  'fal-ai/wan-vace-14b/outpainting',
]);
const CREDIT_UPSCALE_MODELS = new Set([
  'fal-ai/bytedance-upscaler/upscale/video',
  'fal-ai/seedvr/upscale/video',
]);

function fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function VideoPage() {
  const { user } = useAuth();
  const { wallet, catalog, falKey, refresh: refreshWallet } = useWallet();
  const health = useHealthContext();
  const cfg = useConfigContext();
  const probes = health?.probes || {};
  const blocked = ['ffmpeg', 'ffprobe', 'encoder']
    .filter((id) => probes[id] && !probes[id].ok)
    .map((id) => probes[id]);
  const studioOk = probes.vapoursynth?.ok && probes.znedi3?.ok;

  const models = cfg?.config?.models || {};
  const outpaintCatalog = models.video_outpaint_catalog || [];
  const upscaleCatalog = models.video_upscale_catalog || [];
  const outpaintOptions = outpaintCatalog.map((e) => e.label);
  const upscaleOptions = upscaleCatalog.map((e) => e.label);
  const defaultOutpaint = outpaintOptions[0] || 'LTX 2.3 Quality';
  const defaultUpscale = upscaleOptions[0] || 'Bytedance Upscaler';

  const [items, setItems] = useState([]);
  const [mode, setMode] = useState(MODES[0]);
  const [outpaintOpt, setOutpaintOpt] = useState(defaultOutpaint);
  const [prompt, setPrompt] = useState('Seamlessly extend the background environment, cool lighting, neutral color temperature, matching original white balance and color palette.');
  const [engine, setEngine] = useState('FAST');
  const [falUpscale, setFalUpscale] = useState(defaultUpscale);
  const [sharpening, setSharpening] = useState(0.5);
  const [ltxRes, setLtxRes] = useState('720p');
  const [ltxAudio, setLtxAudio] = useState(true);
  const [ltxGuidance, setLtxGuidance] = useState(1.0);
  const [ltxPromptExpansion, setLtxPromptExpansion] = useState(false);
  const [ltxNegativePrompt, setLtxNegativePrompt] = useState('yellow tint, sepia, warm cast, color distortion, discoloration, overexposure, oversaturated');
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
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outArgs, setOutArgs] = useState({ args: {}, ok: true, error: '' });
  const [upArgs, setUpArgs] = useState({ args: {}, ok: true, error: '' });
  const [paymentSource, setPaymentSource] = useState('credits');

  const upscaleOnly = mode === 'UPSCALE ONLY';
  const falPicked = engine === 'FAL AI';
  const studioPicked = engine === 'STUDIO';
  const outpaintEntry = outpaintCatalog.find((e) => e.label === outpaintOpt) || outpaintCatalog[0];
  const upscaleEntry = upscaleCatalog.find((e) => e.label === falUpscale) || upscaleCatalog[0];
  const outpaintModel = outpaintEntry?.model || models.outpaint_vid;
  const upscaleModel = upscaleEntry?.model || models.upscale_vid;

  // If the sidebar saved a custom endpoint, the catalog gains a CUSTOM(...)
  // entry after /api/config loads — preselect it once so the override actually
  // takes effect instead of silently staying on the stock default.
  const customInit = useRef(false);
  useEffect(() => {
    if (customInit.current || !outpaintCatalog.length || !upscaleCatalog.length) return;
    customInit.current = true;
    const oc = outpaintCatalog.find((e) => e.model === models.outpaint_vid);
    if (oc?.is_custom) setOutpaintOpt(oc.label);
    const uc = upscaleCatalog.find((e) => e.model === models.upscale_vid);
    if (uc?.is_custom) setFalUpscale(uc.label);
  }, [outpaintCatalog, upscaleCatalog, models]);

  const totalDur = useMemo(() => items.reduce((a, b) => a + (b.duration || 0), 0), [items]);
  const loraPicked = !upscaleOnly && (outpaintOpt.includes('LoRA') || (outpaintModel || '').includes('/lora'));
  const loraList = useMemo(
    () => loraPicked ? ltxLoras.map((lora) => ({ ...lora, path: (lora.path || '').trim() })).filter((lora) => lora.path) : [],
    [loraPicked, ltxLoras],
  );
  const parameters = useMemo(() => videoBillingParameters({
    prompt,
    upscaleOnly,
    falPicked,
    studioPicked,
    sharpening,
    outpaintModel,
    upscaleModel,
    ltxResolution: ltxRes,
    ltxAudio,
    ltxGuidance,
    ltxPromptExpansion,
    ltxNegativePrompt,
    ltxLoras: loraList,
    wanResolution: '720p',
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
  }), [prompt, upscaleOnly, falPicked, studioPicked, sharpening, outpaintModel, upscaleModel, ltxRes, ltxAudio, ltxGuidance, ltxPromptExpansion, ltxNegativePrompt, loraList, seedvrFactor, seedvrTarget, btdRes, btdFps, btdTier, btdPreset, btdFidelity, trimEnabled, trimStart, trimDur, outpaintEntry?.is_custom, outArgs.args, upscaleEntry?.is_custom, upArgs.args]);
  const quoteItems = useMemo(
    () => items.filter((item) => stagedItemNeedsCloud(item, parameters)).map((item) => ({ stage_id: item.stage_id })),
    [items, parameters],
  );
  const cloudRequired = quoteItems.length > 0;
  const needsOutpaintCloud = items.some((item) => !upscaleOnly && Number(item.width) !== Number(item.height));
  const outpaintCreditSupported = outpaintEntry?.credit_enabled ?? CREDIT_OUTPAINT_MODELS.has(outpaintModel);
  const upscaleCreditSupported = upscaleEntry?.credit_enabled ?? CREDIT_UPSCALE_MODELS.has(upscaleModel);
  const byokOnly = (needsOutpaintCloud && !outpaintCreditSupported) || (falPicked && !upscaleCreditSupported);
  const quoteState = useCreditQuotes({
    kind: 'video',
    items: quoteItems,
    parameters,
    enabled: cloudRequired && Boolean(user) && !byokOnly && Boolean(catalog?.credits_enabled),
  });
  const insufficientCredits = paymentSource === 'credits' && Number(wallet?.available_credits || 0) < quoteState.totalCredits;
  const fundingBlocked = cloudRequired && (
    !user ||
    (paymentSource === 'byok' && !falKey?.configured) ||
    (paymentSource === 'credits' && (
      byokOnly || !catalog?.credits_enabled || quoteState.loading || Boolean(quoteState.error) ||
      quoteState.quotes.length !== quoteItems.length || insufficientCredits
    ))
  );
  const disabled = blocked.length > 0 || fundingBlocked || (studioPicked && !studioOk) || busy;

  useEffect(() => {
    if (byokOnly) setPaymentSource('byok');
  }, [byokOnly]);

  const onFiles = async (files) => {
    setError('');
    setItems([]);
    setJobs([]);
    const staged = [];
    for (const f of files) {
      try {
        const meta = await api.upload('/api/video/upload', f);
        staged.push({ name: f.name, file: f, ...meta });
      } catch (e) {
        setError(`Could not read video ${f.name}: ${e.message}`);
      }
    }
    setItems(staged);
  };


  const render = async () => {
    setError('');
    if (!upscaleOnly && outpaintEntry?.is_custom && !outArgs.ok) {
      setError(`Outpaint custom args: ${outArgs.error}`);
      return;
    }
    if (falPicked && upscaleEntry?.is_custom && !upArgs.ok) {
      setError(`Upscale custom args: ${upArgs.error}`);
      return;
    }
    if (fundingBlocked) {
      setError('Choose an available cloud payment source and wait for a valid quote.');
      return;
    }
    setBusy(true);
    const jobList = [];
    try {
      const freshQuotes = paymentSource === 'credits' && cloudRequired ? await quoteState.refresh() : [];
      const quoteByStage = new Map(freshQuotes.map((quote) => [quote.stage_id, quote]));
      for (const item of items) {
        const itemNeedsCloud = stagedItemNeedsCloud(item, parameters);
        const fd = new FormData();
        fd.append('stage_id', item.stage_id);
        appendProcessingParameters(fd, parameters);
        if (itemNeedsCloud) {
          fd.append('payment_source', paymentSource);
          if (paymentSource === 'credits') {
            const quote = quoteByStage.get(item.stage_id);
            if (!quote?.quote_id) throw new Error(`A fresh quote is unavailable for ${item.name}.`);
            fd.append('quote_id', quote.quote_id);
          }
        }
        try {
          const res = await api.form('/api/video/process', fd);
          jobList.push({ jobId: res.job_id, name: item.name, kind: 'video' });
        } catch (submissionError) {
          setError(submissionError.message);
        }
      }
      setJobs(jobList);
      if (cloudRequired) await refreshWallet();
    } catch (requestError) {
      setError(requestError.message || 'Could not prepare cloud billing.');
    } finally {
      setBusy(false);
    }
  };

  const maxSourceDur = items.length ? Math.max(...items.map((i) => i.duration || 0)) : 60;
  const previewUrl = useObjectUrl(items.length === 1 ? items[0].file : null);

  return (
    <div>
      <Hero title="VIDEO EXTENDER" kicker="ECHO · 1:1 SQUARE · 3840×3840 · OUTPAINT + UPSCALE · HEVC MASTER" />

      {blocked.length ? (
        <BlockingBanner
          title="ENVIRONMENT NOT READY"
          lines={blocked.map((p) => `${p.label}: ${p.detail}. ${p.fix}`)}
        />
      ) : null}

      <Section num={1} title="Upload Video" active note="MP4 · MOV · AVI · WEBM (Single or Multiple)">
        <UploadZone
          accept=".mp4,.mov,.avi,.webm"
          onFiles={onFiles}
          caption="Supported formats: MP4 · MOV · AVI · WEBM (Single or Multi-batch)"
        />

        {items.length === 1 ? (
          <div style={{ marginTop: 'var(--sx-4)' }}>
            <SpecRow
              cells={[
                ['SOURCE', `${items[0].width}×${items[0].height}`, `${items[0].orientation} · ${fmtBytes(items[0].size_bytes)}`],
                ['DURATION', `${items[0].duration}s`, 'ORIGINAL CLIP'],
                ['TARGET', '3840×3840', '1:1 SQUARE MASTER'],
                ['OUTPAINT PAD', `L: ${items[0].padding.left}px  R: ${items[0].padding.right}px`, `T: ${items[0].padding.top}px  B: ${items[0].padding.bottom}px`],
              ]}
            />
            {items[0].duration > 10 ? (
              <AccentBlock
                tone="warn"
                title={`${items[0].duration}s EXCEEDS THE 10s THRESHOLD`}
                lines={['Cloud video outpainting is billed per second. Consider enabling the 15s Trimmer below to optimize costs.']}
              />
            ) : null}
            <div style={{ marginTop: 'var(--sx-3)' }}>
              <video className="sx-video" src={previewUrl} controls playsInline aria-label="Source video preview" />
            </div>
          </div>
        ) : items.length > 1 ? (
          <div style={{ marginTop: 'var(--sx-4)' }}>
            <SpecRow
              cells={[
                ['BATCH SIZE', `${items.length} VIDEOS`, fmtBytes(items.reduce((a, b) => a + b.size_bytes, 0))],
                ['TOTAL DURATION', `${totalDur.toFixed(1)}s`, `Avg ${(totalDur / items.length).toFixed(1)}s per clip`],
                ['TARGET RESOLUTION', '3840×3840 EACH', '1:1 SQUARE HEVC'],
                ['PARALLEL QUEUE', 'CPU MANAGED', 'AUTO-SCALED'],
              ]}
            />
          </div>
        ) : null}
      </Section>

      <Section num={2} title="Configure Parameters" active={items.length > 0}>
        {items.length === 0 ? (
          <StudioLoading title="EXTENDER" subtitle="AWAITING SOURCE VIDEO INITIATION…" compact />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-4)' }}>
            <div>
              <Eyebrow>PIPELINE MODE</Eyebrow>
              <Segmented options={MODES} value={mode} onChange={setMode} ariaLabel="Video Pipeline Mode" />
            </div>

            {!upscaleOnly ? (
              <>
                <div>
                  <Eyebrow>OUTPAINT MODEL</Eyebrow>
                  <Segmented options={outpaintOptions} value={outpaintOpt} onChange={setOutpaintOpt} ariaLabel="Outpaint Model" />
                </div>
                {outpaintEntry?.is_custom ? (
                  <CustomModelPanel model={outpaintEntry.model} kind="outpaint" entry={outpaintEntry} onArgs={setOutArgs} />
                ) : null}
                <Field label="OUTPAINT EXTENSION PROMPT">
                  <textarea
                    className="sx-textarea"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe the extended square background environment..."
                  />
                </Field>

                {outpaintOpt.includes('LTX') ? (
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

                {loraPicked ? (
                  <details className="sx-expander" open>
                    <summary>▸ CUSTOM LoRA STACK (MAX 3)</summary>
                    <div className="sx-expander-body sx-cols sx-cols-2">
                      <div style={{ gridColumn: '1 / -1', fontSize: '0.9rem', color: 'var(--sx-muted)', marginBottom: 'var(--sx-2)' }}>
                        Each LoRA must be a direct http(s) URL to a .safetensors file (max 3 GB each). Leave a path empty to skip that slot. Civitai: paste the plain https://civitai.com/api/download/models/&lt;versionId&gt; link (optionally with ?fileId=&lt;id&gt;) — the server auto-appends your CIVITAI_KEY, so never include your token yourself.
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
              <Segmented options={ENGINES} value={engine} onChange={setEngine} ariaLabel="Upscale Engine" />
            </div>

            {falPicked ? (
              <>
                <div>
                  <Eyebrow>FAL AI UPSCALE MODEL</Eyebrow>
                  <Segmented options={upscaleOptions} value={falUpscale} onChange={setFalUpscale} ariaLabel="FAL Upscale Model" />
                </div>
                {upscaleEntry?.is_custom ? (
                  <CustomModelPanel model={upscaleEntry.model} kind="upscale" entry={upscaleEntry} onArgs={setUpArgs} />
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

            {studioPicked && !studioOk ? (
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

            <CloudFundingPanel
              required={cloudRequired}
              paymentSource={paymentSource}
              onChange={setPaymentSource}
              quoteState={quoteState}
              byokOnly={byokOnly}
            />

            {blocked.length ? <GatedReason>{blocked[0].label} UNAVAILABLE — CHECK SYSTEM PROBES</GatedReason> : null}
            {!blocked.length && studioPicked && !studioOk ? (
              <GatedReason>STUDIO ENGINE NOT INSTALLED — PLEASE SWITCH TO FAST OR FAL AI</GatedReason>
            ) : null}

            <div style={{ marginTop: 'var(--sx-2)' }}>
              <Button primary disabled={disabled} loading={busy} onClick={render}>
                ▶ RENDER {items.length ? `${items.length} ` : ''}VIDEO(S) 4K SQUARE
              </Button>
            </div>

            {error ? (
              <div className="sx-error-box" role="alert">
                <div className="sx-error-title">EXECUTION ERROR</div>
                <div>{error}</div>
              </div>
            ) : null}
          </div>
        )}
      </Section>

      {jobs.length ? (
        <Section num={3} title="Render Output" active>
          {jobs.map((j) => (
            <JobRunner key={j.jobId} jobId={j.jobId} name={j.name} kind="video" onSettled={refreshWallet} />
          ))}
          <ResultHeader title="03 / RESULTS" meta={`${jobs.length} ITEM(S) PROCESSED · 3840×3840 · HEVC 4K MASTER`} />
          <Mono>
            {jobs.map((j) => `/api/video/jobs/${j.jobId}/result`).join('\n')}
          </Mono>
        </Section>
      ) : null}
    </div>
  );
}