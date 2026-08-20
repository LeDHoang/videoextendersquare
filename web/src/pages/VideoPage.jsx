import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, SpecRow, Eyebrow, EmptyState, BlockingBanner, GatedReason, ResultHeader, Mono, AccentBlock } from '../components/ui/primitives.jsx';
import { Segmented, Button, Field, ToggleRow } from '../components/ui/controls.jsx';
import UploadZone from '../components/ui/UploadZone.jsx';
import JobRunner from '../components/ui/JobRunner.jsx';
import { useHealthContext } from '../hooks/HealthContext.jsx';
import { useConfigContext } from '../hooks/ConfigContext.jsx';
import { useObjectUrl } from '../hooks/useObjectUrl.js';

const MODES = ['OUTPAINT + UPSCALE', 'UPSCALE ONLY'];
const ENGINES = ['FAST', 'STUDIO', 'FAL AI'];

// The model options and pricing come from the backend's /api/config
// (core/models.py) — single source of truth shared with the worker. The
// sidebar's model-endpoint editor now actually changes what's submitted.

function fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function VideoPage() {
  const health = useHealthContext();
  const cfg = useConfigContext();
  const probes = health?.probes || {};
  const blocked = ['ffmpeg', 'ffprobe', 'encoder']
    .filter((id) => probes[id] && !probes[id].ok)
    .map((id) => probes[id]);
  const falOk = health?.fal_key?.ok ?? false;
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
  const [prompt, setPrompt] = useState('Seamlessly extend the background environment, high details, matching texture and lighting. Keep the origin video aethestic and lighting');
  const [engine, setEngine] = useState('FAST');
  const [falUpscale, setFalUpscale] = useState(defaultUpscale);
  const [sharpening, setSharpening] = useState(0.5);
  const [ltxRes, setLtxRes] = useState('720p');
  const [ltxAudio, setLtxAudio] = useState(true);
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

  const upscaleOnly = mode === 'UPSCALE ONLY';
  const falPicked = engine === 'FAL AI';
  const studioPicked = engine === 'STUDIO';
  const needsKey = !upscaleOnly || falPicked;
  const disabled = blocked.length > 0 || (needsKey && !falOk) || (studioPicked && !studioOk) || busy;
  const outpaintEntry = outpaintCatalog.find((e) => e.label === outpaintOpt) || outpaintCatalog[0];
  const upscaleEntry = upscaleCatalog.find((e) => e.label === falUpscale) || upscaleCatalog[0];
  const outpaintModel = outpaintEntry?.model || models.outpaint_vid;
  const upscaleModel = upscaleEntry?.model || models.upscale_vid;

  const totalDur = useMemo(() => items.reduce((a, b) => a + (b.duration || 0), 0), [items]);
  const effDur = trimEnabled ? Math.min(items.length ? Math.max(...items.map((i) => i.duration)) : 15, trimDur) : totalDur;

  const cost = useMemo(() => {
    const out = { label: 'None (Upscale Only)', value: 0 };
    const up = { label: `Local (${engine} Engine — $0.00)`, value: 0 };
    const resWidth = { '480p': 480, '720p': 720, '1080p': 1080 }[ltxRes] || 720;
    const frames = effDur > 0 ? Math.round(effDur * 24) : 121;
    if (!upscaleOnly && outpaintEntry) {
      if (outpaintEntry.pricing_kind === 'per_mp') {
        out.label = `${outpaintEntry.label} (${ltxRes}) (~$${outpaintEntry.price.toFixed(4)}/MP)`;
        out.value = ((resWidth * resWidth * frames) / 1e6) * outpaintEntry.price;
      } else {
        const rate = outpaintEntry.price || 0.06;
        out.label = `${outpaintEntry.label} ($${rate.toFixed(2)}/s)`;
        out.value = effDur * rate;
      }
    }
    if (falPicked && upscaleEntry) {
      if (upscaleEntry.pricing_kind === 'per_mp') {
        const w = { '720p': 720, '1080p': 1080, '2160p': 2160 }[seedvrTarget] || 1080;
        up.label = `${upscaleEntry.label} (${seedvrTarget}) ($${upscaleEntry.price.toFixed(3)}/MP)`;
        up.value = ((w * w * frames) / 1e6) * upscaleEntry.price;
      } else if (upscaleEntry.model && upscaleEntry.model.includes('bytedance')) {
        const base = upscaleEntry.base_rates?.[btdRes] ?? 0.0288;
        const rate = base * (upscaleEntry.fps_multiplier?.[btdFps] ?? 1) * (upscaleEntry.tier_multiplier?.[btdTier] ?? 1);
        up.label = `Bytedance (${btdRes}, ${btdFps}, ${btdTier}) ($${rate.toFixed(4)}/s)`;
        up.value = effDur * rate;
      } else {
        const rate = upscaleEntry.price || 0.003;
        up.label = `${upscaleEntry.label} ($${rate.toFixed(3)}/s)`;
        up.value = effDur * rate;
      }
    }
    return { out, up, total: out.value + up.value };
  }, [upscaleOnly, outpaintEntry, effDur, ltxRes, falPicked, upscaleEntry, btdRes, btdFps, btdTier, seedvrTarget, engine]);

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
    setBusy(true);
    const jobList = [];
    for (const item of items) {
      const fd = new FormData();
      const kv = {
        stage_id: item.stage_id,
        prompt: upscaleOnly ? '' : prompt,
        upscale_only: String(upscaleOnly),
        upscale_engine: falPicked ? 'fal' : studioPicked ? 'studio' : 'fast',
        sharpening: String(sharpening),
        outpaint_model: upscaleOnly ? 'fal-ai/ltx-2.3-quality/outpaint' : outpaintModel,
        upscale_model: upscaleModel,
        ltx_resolution: ltxRes,
        ltx_audio: String(ltxAudio),
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
      };
      for (const [k, v] of Object.entries(kv)) fd.append(k, v);
      try {
        const res = await api.form('/api/video/process', fd);
        jobList.push({ jobId: res.job_id, name: item.name, kind: 'video' });
      } catch (e) {
        setError(e.message);
      }
    }
    setJobs(jobList);
    setBusy(false);
  };

  const maxSourceDur = items.length ? Math.max(...items.map((i) => i.duration)) : 60;
  const previewUrl = useObjectUrl(items.length === 1 ? items[0].file : null);

  return (
    <div>
      <Hero title="Square Extender 4K" kicker="VIDEO · 1:1 · 3840×3840 · OUTPAINT + UPSCALE" />

      {blocked.length ? (
        <BlockingBanner title="ENVIRONMENT NOT READY" lines={blocked.map((p) => `${p.label}: ${p.detail}. ${p.fix}`)} />
      ) : null}

      <Section num={1} title="Upload" active note="MP4 · MOV · AVI · WEBM (Single or Multiple)">
        <UploadZone accept=".mp4,.mov,.avi,.webm" onFiles={onFiles} caption="MP4 · MOV · AVI · WEBM — single or multiple" />
        {items.length === 1 ? (
          <>
            <SpecRow
              cells={[
                ['SOURCE', `${items[0].width}×${items[0].height}`, `${items[0].orientation} · ${fmtBytes(items[0].size_bytes)}`],
                ['DURATION', `${items[0].duration}s`, ''],
                ['TARGET', '3840×3840', '1:1 SQUARE'],
                ['PAD', `L ${items[0].padding.left}  R ${items[0].padding.right}`, `T ${items[0].padding.top}  B ${items[0].padding.bottom}`],
              ]}
            />
            {items[0].duration > 10 ? (
              <AccentBlock
                tone="warn"
                title={`${items[0].duration}s EXCEEDS THE 10s THRESHOLD`}
                lines={['Cloud outpainting is billed per second and the video model throttles long clips, so render time grows faster than duration.']}
              />
            ) : null}
            <video className="sx-video" src={previewUrl} controls playsInline />
          </>
        ) : items.length > 1 ? (
          <SpecRow
            cells={[
              ['BATCH', `${items.length} VIDEOS`, fmtBytes(items.reduce((a, b) => a + b.size_bytes, 0))],
              ['TOTAL DUR', `${totalDur.toFixed(1)}s`, `Avg ${(totalDur / items.length).toFixed(1)}s`],
              ['TARGET', '3840×3840 EACH', '1:1 SQUARE'],
              ['PARALLEL', 'AUTO-QUEUED', 'RESOURCES'],
            ]}
          />
        ) : null}
      </Section>

      <Section num={2} title="Configure" active={items.length > 0}>
        {items.length === 0 ? (
          <EmptyState title="AWAITING SOURCE" text="Drop one or more videos above to unlock the pipeline settings." />
        ) : (
          <>
            <Eyebrow>MODE</Eyebrow>
            <Segmented options={MODES} value={mode} onChange={setMode} />

            {!upscaleOnly ? (
              <>
                <Eyebrow>OUTPAINT MODEL</Eyebrow>
                <Segmented options={outpaintOptions} value={outpaintOpt} onChange={setOutpaintOpt} />
                <Eyebrow>PROMPT</Eyebrow>
                <textarea className="sx-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                {outpaintOpt.includes('LTX') ? (
                  <details className="sx-expander">
                    <summary>▸ LTX 2.3 OUTPAINT SETTINGS</summary>
                    <div className="sx-expander-body sx-cols sx-cols-2">
                      <Field label="OUTPUT RESOLUTION TIER">
                        <select className="sx-select" value={ltxRes} onChange={(e) => setLtxRes(e.target.value)}>
                          {['720p', '1080p', '480p'].map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </Field>
                      <ToggleRow label="Include Audio Track" checked={ltxAudio} onChange={setLtxAudio} />
                    </div>
                  </details>
                ) : null}
              </>
            ) : null}

            <Eyebrow>UPSCALE ENGINE</Eyebrow>
            <Segmented options={ENGINES} value={engine} onChange={setEngine} />

            {falPicked ? (
              <>
                <Eyebrow>FAL AI UPSCALE MODEL</Eyebrow>
                <Segmented options={upscaleOptions} value={falUpscale} onChange={setFalUpscale} />
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
                title="STUDIO UNAVAILABLE"
                lines={[
                  'This machine is missing VapourSynth + the znedi3 plugin, so the znedi3 neural upscale cannot run.',
                  'FAST uses Lanczos4 + CAS via FFmpeg and works now.',
                ]}
                code={['pip install vapoursynth', '+ vsznedi3 plugin']}
              />
            ) : null}

            {!studioPicked ? (
              <>
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
              </>
            ) : null}

            <Eyebrow>TRIM INPUT VIDEO (MAX 15 SECONDS)</Eyebrow>
            <ToggleRow label="Enable 15s Trimming" checked={trimEnabled} onChange={setTrimEnabled} />
            {trimEnabled ? (
              <div className="sx-cols sx-cols-2">
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
                <Field label="CLIP LENGTH (MAX 15s)">
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

            <div className="sx-cost-panel">
              <div className="sx-cost-head">
                <span className="sx-cost-title">💰 ESTIMATED CLOUD BILLING BREAKDOWN</span>
                <span className="sx-cost-total">EST. TOTAL: ~${cost.total.toFixed(4)} USD</span>
              </div>
              <div className="sx-cost-body">
                <div>• <b>Batch Scope:</b> {items.length} video(s) ({effDur.toFixed(1)}s total duration)</div>
                <div>• <b>Clip Trimming:</b> {trimEnabled ? `YES (${trimDur}s clip max)` : 'NO (Full video)'}</div>
                <div>• <b>Outpaint Stage:</b> ~${cost.out.value.toFixed(4)} USD ({cost.out.label})</div>
                <div>• <b>Upscale Stage:</b> ~${cost.up.value.toFixed(4)} USD ({cost.up.label})</div>
              </div>
            </div>

            {blocked.length ? <GatedReason>{blocked[0].label} UNAVAILABLE — SEE SYSTEM</GatedReason> : null}
            {!blocked.length && studioPicked && !studioOk ? <GatedReason>STUDIO ENGINE NOT INSTALLED — SWITCH TO FAST OR FAL AI</GatedReason> : null}
            {!blocked.length && needsKey && !falOk ? <GatedReason>FAL KEY REQUIRED FOR OUTPAINTING / FAL AI UPSCALE</GatedReason> : null}

            <div style={{ marginTop: 16 }}>
              <Button primary disabled={disabled} onClick={render}>
                ▶ RENDER {items.length || ''} VIDEO(S) 4K SQUARE
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
            <JobRunner key={j.jobId} jobId={j.jobId} name={j.name} kind="video" />
          ))}
          <ResultHeader title="03 / RESULT" meta={`${jobs.length} ITEM(S) PROCESSED · 3840×3840 · HEVC MP4`} />
          <Mono>
            {jobs.map((j) => `/api/video/jobs/${j.jobId}/download`).join('\n')}
          </Mono>
        </Section>
      ) : null}
    </div>
  );
}