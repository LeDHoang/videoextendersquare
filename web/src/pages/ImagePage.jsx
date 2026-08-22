import { useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, SpecRow, Eyebrow, EmptyState, BlockingBanner, GatedReason, ResultHeader, Mono } from '../components/ui/primitives.jsx';
import { Segmented, Button, Field } from '../components/ui/controls.jsx';
import UploadZone from '../components/ui/UploadZone.jsx';
import JobRunner from '../components/ui/JobRunner.jsx';
import { useHealthContext } from '../hooks/HealthContext.jsx';
import { useObjectUrl } from '../hooks/useObjectUrl.js';
import StudioLoading from '../components/ui/StudioLoading.jsx';

const MODES = ['OUTPAINT + UPSCALE', 'UPSCALE ONLY'];
const ENGINES = ['FAST', 'FAL AI'];
const FAL_MODELS = ['Clarity Upscaler', 'CCSR', 'AuraSR', 'ESRGAN'];
const FAL_MODEL_IDS = {
  'Clarity Upscaler': 'fal-ai/clarity-upscaler',
  CCSR: 'fal-ai/ccsr',
  AuraSR: 'fal-ai/aura-sr',
  ESRGAN: 'fal-ai/esrgan',
};

export default function ImagePage() {
  const health = useHealthContext();
  const probes = health?.probes || {};
  const blocked = ['ffmpeg', 'ffprobe'].filter((id) => probes[id] && !probes[id].ok).map((id) => probes[id]);
  const falOk = health?.fal_key?.ok ?? false;

  const [items, setItems] = useState([]);
  const [mode, setMode] = useState(MODES[0]);
  const [prompt, setPrompt] = useState('Seamlessly extend the background environment, high details, matching texture and lighting.');
  const [engine, setEngine] = useState('FAST');
  const [falModel, setFalModel] = useState('Clarity Upscaler');
  const [sharpening, setSharpening] = useState(0.5);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upscaleOnly = mode === 'UPSCALE ONLY';
  const falPicked = engine === 'FAL AI';
  const needsKey = !upscaleOnly || falPicked;
  const disabled = blocked.length > 0 || (needsKey && !falOk) || busy;
  const previewUrl = useObjectUrl(items.length === 1 ? items[0].file : null);

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
    setBusy(true);
    const jobList = [];
    for (const item of items) {
      const fd = new FormData();
      fd.append('stage_id', item.stage_id);
      fd.append('prompt', upscaleOnly ? '' : prompt);
      fd.append('upscale_only', String(upscaleOnly));
      fd.append('sharpening', String(sharpening));
      fd.append('upscale_engine', falPicked ? 'fal' : 'fast');
      fd.append('upscale_model', FAL_MODEL_IDS[falModel]);
      try {
        const res = await api.form('/api/image/process', fd);
        jobList.push({ jobId: res.job_id, name: item.name, kind: 'image' });
      } catch (e) {
        setError(e.message);
      }
    }
    setJobs(jobList);
    setBusy(false);
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
              <Field label="OUTPAINT EXTENSION PROMPT">
                <textarea
                  className="sx-textarea"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe the environment to generate on left/right borders..."
                />
              </Field>
            ) : null}

            <div>
              <Eyebrow>UPSCALE ENGINE</Eyebrow>
              <Segmented options={ENGINES} value={engine} onChange={setEngine} ariaLabel="Upscale Engine" />
            </div>

            {falPicked ? (
              <div>
                <Eyebrow>FAL AI UPSCALE MODEL</Eyebrow>
                <Segmented options={FAL_MODELS} value={falModel} onChange={setFalModel} ariaLabel="FAL Model" />
              </div>
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

            {blocked.length ? <GatedReason>{blocked[0].label} UNAVAILABLE — CHECK SYSTEM PROBES</GatedReason> : null}
            {!blocked.length && needsKey && !falOk ? (
              <GatedReason>FAL API KEY REQUIRED FOR OUTPAINTING / CLOUD UPSCALE</GatedReason>
            ) : null}

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
            <JobRunner key={j.jobId} jobId={j.jobId} name={j.name} kind="image" />
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