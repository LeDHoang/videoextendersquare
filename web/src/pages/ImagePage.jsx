import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, SpecRow, Eyebrow, EmptyState, BlockingBanner, GatedReason, ResultHeader, Mono } from '../components/ui/primitives.jsx';
import { Segmented, Button, Field } from '../components/ui/controls.jsx';
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
import { appendProcessingParameters, imageBillingParameters, stagedItemNeedsCloud } from '../utils/cloudBilling.js';

const MODES = ['OUTPAINT + UPSCALE', 'UPSCALE ONLY'];
const ENGINES = ['FAST', 'FAL AI'];
// Fallback while /api/config loads — the live catalog (stock + CUSTOM) comes
// from the backend's core/models.py so sidebar overrides actually take effect.
const FALLBACK_FAL_MODELS = ['Clarity Upscaler', 'CCSR', 'AuraSR', 'ESRGAN'];
const FALLBACK_FAL_MODEL_IDS = {
  'Clarity Upscaler': 'fal-ai/clarity-upscaler',
  CCSR: 'fal-ai/ccsr',
  AuraSR: 'fal-ai/aura-sr',
  ESRGAN: 'fal-ai/esrgan',
};
const STOCK_OUTPAINT_IMG = 'fal-ai/image-apps-v2/outpaint';

export default function ImagePage() {
  const { user } = useAuth();
  const { wallet, catalog, falKey, refresh: refreshWallet } = useWallet();
  const health = useHealthContext();
  const cfg = useConfigContext();
  const probes = health?.probes || {};
  const blocked = ['ffmpeg', 'ffprobe'].filter((id) => probes[id] && !probes[id].ok).map((id) => probes[id]);

  const models = cfg?.config?.models || {};
  const outpaintCatalog = models.image_outpaint_catalog || [];
  const upscaleCatalog = models.image_upscale_catalog || [];
  const upscaleOptions = upscaleCatalog.length
    ? upscaleCatalog.map((e) => e.label)
    : FALLBACK_FAL_MODELS;

  const [items, setItems] = useState([]);
  const [mode, setMode] = useState(MODES[0]);
  const [prompt, setPrompt] = useState('Seamlessly extend the background environment, high details, matching texture and lighting.');
  const [engine, setEngine] = useState('FAST');
  const [falModel, setFalModel] = useState('Clarity Upscaler');
  const [sharpening, setSharpening] = useState(0.5);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imgOutArgs, setImgOutArgs] = useState({ args: {}, ok: true, error: '' });
  const [imgUpArgs, setImgUpArgs] = useState({ args: {}, ok: true, error: '' });
  const [paymentSource, setPaymentSource] = useState('credits');

  const upscaleOnly = mode === 'UPSCALE ONLY';
  const falPicked = engine === 'FAL AI';
  const previewUrl = useObjectUrl(items.length === 1 ? items[0].file : null);

  const upscaleEntry = upscaleCatalog.find((e) => e.label === falModel) || null;
  const upscaleModel = upscaleEntry?.model || FALLBACK_FAL_MODEL_IDS[falModel] || models.upscale_img;
  const outpaintModel = models.outpaint_img || STOCK_OUTPAINT_IMG;
  const outpaintEntry = outpaintCatalog.find((entry) => entry.model === outpaintModel) || null;
  const outpaintCustom = outpaintModel !== STOCK_OUTPAINT_IMG;
  const outpaintShort = (outpaintModel || '').split('/').filter(Boolean).pop() || 'custom';

  const parameters = useMemo(() => imageBillingParameters({
    prompt,
    upscaleOnly,
    sharpening,
    falPicked,
    upscaleModel,
    outpaintModel,
    customOutpaintArgs: outpaintCustom ? imgOutArgs.args : {},
    customUpscaleArgs: upscaleEntry?.is_custom ? imgUpArgs.args : {},
  }), [prompt, upscaleOnly, sharpening, falPicked, upscaleModel, outpaintModel, outpaintCustom, imgOutArgs.args, upscaleEntry?.is_custom, imgUpArgs.args]);
  const quoteItems = useMemo(
    () => items.filter((item) => stagedItemNeedsCloud(item, parameters)).map((item) => ({ stage_id: item.stage_id })),
    [items, parameters],
  );
  const cloudRequired = quoteItems.length > 0;
  const needsOutpaintCloud = items.some((item) => !upscaleOnly && Number(item.width) !== Number(item.height));
  const outpaintCreditSupported = outpaintEntry?.credit_enabled ?? !outpaintCustom;
  const upscaleCreditSupported = upscaleEntry?.credit_enabled ?? upscaleModel === 'fal-ai/clarity-upscaler';
  const byokOnly = (needsOutpaintCloud && !outpaintCreditSupported) || (falPicked && !upscaleCreditSupported);
  const quoteState = useCreditQuotes({
    kind: 'image',
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
  const disabled = blocked.length > 0 || fundingBlocked || busy;

  useEffect(() => {
    if (byokOnly) setPaymentSource('byok');
  }, [byokOnly]);

  // Preselect the sidebar's CUSTOM(...) override once the catalog arrives.
  const customInit = useRef(false);
  useEffect(() => {
    if (customInit.current || !upscaleCatalog.length) return;
    customInit.current = true;
    const match = upscaleCatalog.find((e) => e.model === models.upscale_img);
    if (match?.is_custom) setFalModel(match.label);
  }, [upscaleCatalog, models]);

  const onFiles = async (files) => {
    setError('');
    setItems([]);
    setJobs([]);
    const staged = [];
    for (const f of files) {
      try {
        const meta = await api.upload('/api/image/upload', f);
        staged.push({ name: f.name, file: f, ...meta });
      } catch (e) {
        setError(`Could not read image ${f.name}: ${e.message}`);
      }
    }
    setItems(staged);
  };

  const render = async () => {
    setError('');
    if (!upscaleOnly && outpaintCustom && !imgOutArgs.ok) {
      setError(`Outpaint custom args: ${imgOutArgs.error}`);
      return;
    }
    if (falPicked && upscaleEntry?.is_custom && !imgUpArgs.ok) {
      setError(`Upscale custom args: ${imgUpArgs.error}`);
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
          const res = await api.form('/api/image/process', fd);
          jobList.push({ jobId: res.job_id, name: item.name, kind: 'image' });
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

  const hasJobs = jobs.length > 0;

  return (
    <div>
      <Hero title="IMAGE EXTENDER" kicker="ECHO · 1:1 SQUARE · 3840×3840 · OUTPAINT + UPSCALE PIPELINE" />

      {blocked.length ? (
        <BlockingBanner
          title="ENVIRONMENT NOT READY"
          lines={blocked.map((p) => `${p.label}: ${p.detail}. ${p.fix}`)}
        />
      ) : null}

      <Section num={1} title="Upload Source" active note="PNG · JPG · WEBP (Single or Multiple)">
        <UploadZone
          accept=".png,.jpg,.jpeg,.webp"
          onFiles={onFiles}
          caption="Supported formats: PNG · JPG · WEBP (Single or Multi-batch)"
        />

        {items.length === 1 ? (
          <div style={{ marginTop: 'var(--sx-4)' }}>
            <SpecRow
              cells={[
                ['SOURCE', `${items[0].width}×${items[0].height}`, `${items[0].orientation} · ${(items[0].size_bytes / 1024).toFixed(1)} KB`],
                ['TARGET', '3840×3840', '1:1 SQUARE MASTER'],
                ['OUTPAINT PAD', `L: ${items[0].padding.left}px  R: ${items[0].padding.right}px`, `T: ${items[0].padding.top}px  B: ${items[0].padding.bottom}px`],
              ]}
            />
            <div style={{ marginTop: 'var(--sx-3)' }}>
              <img
                className="sx-img"
                style={{ maxHeight: 320, objectFit: 'contain' }}
                src={previewUrl}
                alt={items[0].name}
              />
            </div>
          </div>
        ) : items.length > 1 ? (
          <div style={{ marginTop: 'var(--sx-4)' }}>
            <SpecRow
              cells={[
                ['BATCH SIZE', `${items.length} IMAGES`, `${(items.reduce((a, b) => a + b.size_bytes, 0) / 1024).toFixed(1)} KB TOTAL`],
                ['TARGET RESOLUTION', '3840×3840 EACH', '1:1 SQUARE'],
                ['PROCESSING', 'CPU CONCURRENT', 'AUTO-SCALED QUEUE'],
              ]}
            />
          </div>
        ) : null}
      </Section>

      <Section num={2} title="Configure Pipeline" active={items.length > 0}>
        {items.length === 0 ? (
          <StudioLoading title="STUDIO" subtitle="AWAITING SOURCE IMAGE INITIATION…" compact />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sx-4)' }}>
            <div>
              <Eyebrow>PIPELINE MODE</Eyebrow>
              <Segmented options={MODES} value={mode} onChange={setMode} ariaLabel="Pipeline Mode" />
            </div>

            {!upscaleOnly ? (
              <>
                <Field label="OUTPAINT EXTENSION PROMPT">
                  <textarea
                    className="sx-textarea"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe the environment to generate on left/right borders..."
                  />
                </Field>
                {outpaintCustom ? (
                  <CustomModelPanel
                    model={outpaintModel}
                    kind="image_outpaint"
                    onArgs={setImgOutArgs}
                    entry={{
                      label: `CUSTOM OUTPAINT (${outpaintShort})`,
                      requirements:
                        'A saved personal Fal key is required; the source image is uploaded by the pipeline.',
                      cost_note: 'No estimate stored — pull live pricing via MODEL INFO below before rendering.',
                      expects:
                        "Sends {image_url, prompt}; expand_* arguments are applied only to the stock Image Apps outpaint model. Check MODEL INFO for the live schema.",
                    }}
                  />
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
                  <Segmented options={upscaleOptions} value={falModel} onChange={setFalModel} ariaLabel="FAL Model" />
                </div>
                {upscaleEntry?.is_custom ? (
                  <CustomModelPanel model={upscaleEntry.model} kind="image_upscale" entry={upscaleEntry} onArgs={setImgUpArgs} />
                ) : null}
              </>
            ) : null}

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

            <CloudFundingPanel
              required={cloudRequired}
              paymentSource={paymentSource}
              onChange={setPaymentSource}
              quoteState={quoteState}
              byokOnly={byokOnly}
            />

            {blocked.length ? <GatedReason>{blocked[0].label} UNAVAILABLE — CHECK SYSTEM PROBES</GatedReason> : null}

            <div style={{ marginTop: 'var(--sx-2)' }}>
              <Button primary disabled={disabled} loading={busy} onClick={render}>
                ▶ RENDER {items.length ? `${items.length} ` : ''}IMAGE(S) 4K SQUARE
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
            <JobRunner key={j.jobId} jobId={j.jobId} name={j.name} kind="image" onSettled={refreshWallet} />
          ))}
          {hasJobs ? (
            <>
              <ResultHeader title="03 / RESULTS" meta={`${jobs.length} ITEM(S) PROCESSED · 3840×3840 · PNG MASTER`} />
              <Mono>
                {jobs.map((j) => `/api/image/jobs/${j.jobId}/result`).join('\n')}
              </Mono>
            </>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}