import { useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, SpecRow, Eyebrow, EmptyState, BlockingBanner, GatedReason, ResultHeader, Mono } from '../components/ui/primitives.jsx';
import { Segmented, Button, Field } from '../components/ui/controls.jsx';
import UploadZone from '../components/ui/UploadZone.jsx';
import JobRunner from '../components/ui/JobRunner.jsx';
import { useHealth } from '../hooks/useHealth.js';

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
  const health = useHealth();
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
      <Hero title="Square Extender 4K" kicker="1:1 · 3840×3840 · OUTPAINT + UPSCALE" />

      {blocked.length ? (
        <BlockingBanner title="ENVIRONMENT NOT READY" lines={blocked.map((p) => `${p.label}: ${p.detail}. ${p.fix}`)} />
      ) : null}

      <Section num={1} title="Upload" active note="PNG · JPG · WEBP (Single or Multiple)">
        <UploadZone
          accept=".png,.jpg,.jpeg,.webp"
          onFiles={onFiles}
          caption="PNG · JPG · WEBP — single or multiple"
        />
        {items.length === 1 ? (
          <>
            <SpecRow
              cells={[
                ['SOURCE', `${items[0].width}×${items[0].height}`, `${items[0].orientation} · ${(items[0].size_bytes / 1024).toFixed(1)} KB`],
                ['TARGET', '3840×3840', '1:1 SQUARE'],
                ['PAD', `L ${items[0].padding.left}  R ${items[0].padding.right}`, `T ${items[0].padding.top}  B ${items[0].padding.bottom}`],
              ]}
            />
            <img className="sx-img" style={{ maxHeight: 300 }} src={URL.createObjectURL(items[0].file)} alt={items[0].name} />
          </>
        ) : items.length > 1 ? (
          <SpecRow
            cells={[
              ['BATCH', `${items.length} IMAGES`, `${items.reduce((a, b) => a + b.size_bytes, 0)} bytes`],
              ['TARGET', '3840×3840 EACH', '1:1 SQUARE'],
              ['PARALLEL', 'AUTO-SCALED', 'CPU QUEUE'],
            ]}
          />
        ) : null}
      </Section>

      <Section num={2} title="Configure" active={items.length > 0}>
        {items.length === 0 ? (
          <EmptyState title="AWAITING SOURCE" text="Drop one or more images above to unlock the pipeline settings." />
        ) : (
          <>
            <Eyebrow>MODE</Eyebrow>
            <Segmented options={MODES} value={mode} onChange={setMode} />

            {!upscaleOnly ? (
              <>
                <Eyebrow>PROMPT</Eyebrow>
                <textarea className="sx-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              </>
            ) : null}

            <Eyebrow>UPSCALE ENGINE</Eyebrow>
            <Segmented options={ENGINES} value={engine} onChange={setEngine} />

            {falPicked ? (
              <>
                <Eyebrow>FAL AI UPSCALE MODEL</Eyebrow>
                <Segmented options={FAL_MODELS} value={falModel} onChange={setFalModel} />
              </>
            ) : null}

            <Eyebrow>SHARPEN (CAS)</Eyebrow>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={sharpening}
              disabled={!probes.cas?.ok}
              onChange={(e) => setSharpening(Number(e.target.value))}
            />
            <div className="sx-body">{(sharpening * 100).toFixed(0)}%</div>
            {!probes.cas?.ok ? <GatedReason>CAS FILTER UNAVAILABLE — SHARPENING SKIPPED</GatedReason> : null}

            {blocked.length ? <GatedReason>{blocked[0].label} UNAVAILABLE — SEE SYSTEM</GatedReason> : null}
            {!blocked.length && needsKey && !falOk ? <GatedReason>FAL KEY REQUIRED FOR OUTPAINTING / FAL AI UPSCALE</GatedReason> : null}

            <div style={{ marginTop: 16 }}>
              <Button primary disabled={disabled} onClick={render}>
                ▶ RENDER {items.length || ''} IMAGE(S) 4K SQUARE
              </Button>
            </div>
            {error ? (
              <div className="sx-error-box">
                <div className="sx-error-title">ERROR</div>
                <div>{error}</div>
              </div>
            ) : null}
          </>
        )}
      </Section>

      {jobs.length ? (
        <Section num={3} title="Result" active>
          {jobs.map((j) => (
            <JobRunner key={j.jobId} jobId={j.jobId} name={j.name} kind="image" />
          ))}
          {hasJobs ? (
            <>
              <ResultHeader title="03 / RESULT" meta={`${jobs.length} ITEM(S) PROCESSED · 3840×3840 · PNG`} />
              <Mono>
                {jobs.map((j) => `/api/image/jobs/${j.jobId}/download`).join('\n')}
              </Mono>
            </>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}