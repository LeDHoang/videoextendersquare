import { AccentBlock, GatedReason } from '../ui/primitives.jsx';
import { Segmented, Button, ToggleRow } from '../ui/controls.jsx';
import CustomModelPanel from '../ui/CustomModelPanel.jsx';
import JobRunner from '../ui/JobRunner.jsx';
import CloudFundingPanel from '../billing/CloudFundingPanel.jsx';
import { MODES, MAX_LORAS } from './useExtendConfig.js';

// Right-hand settings deck of the Upload Studio: every extender option of the
// standalone Image/Video pages, grouped like a render cockpit.

export function DeckSection({ num, title, badge, badgeTone = 'accent', children, className = '' }) {
  const headId = `studio-deck-${num}`;
  return (
    <section className={`sx-studio-card ${className}`} aria-labelledby={headId}>
      <header className="sx-studio-card-head">
        <span className="sx-studio-card-num" aria-hidden="true">{String(num).padStart(2, '0')}</span>
        <h2 id={headId} className="sx-studio-card-title">{title}</h2>
        {badge ? <span className={`sx-studio-badge sx-${badgeTone}`}>{badge}</span> : null}
      </header>
      <div className="sx-studio-card-body">{children}</div>
    </section>
  );
}

export function DeckLabel({ children, htmlFor, value }) {
  return (
    <div className="sx-studio-label-row">
      {htmlFor ? <label className="sx-studio-label" htmlFor={htmlFor}>{children}</label> : <span className="sx-studio-label">{children}</span>}
      {value !== undefined ? <span className="sx-studio-label-value">{value}</span> : null}
    </div>
  );
}

const modelShort = (model) => (model || '').split('/').filter(Boolean).slice(-2).join('/');

// Selectable model tiles (a radiogroup, so they read like the Segmented
// control to assistive tech and tests).
export function ModelCards({ entries, value, onChange, ariaLabel }) {
  return (
    <div className="sx-studio-models" role="radiogroup" aria-label={ariaLabel}>
      {entries.map((entry) => {
        const selected = entry.label === value;
        const byok = entry.credit_enabled === false || entry.is_custom;
        return (
          <button
            type="button"
            key={entry.label}
            role="radio"
            aria-checked={selected}
            className={`sx-studio-model ${selected ? 'sx-selected' : ''}`}
            onClick={() => onChange(entry.label)}
          >
            <span className="sx-studio-model-name">{entry.label}</span>
            <span className="sx-studio-model-id">{entry.model ? modelShort(entry.model) : 'FAL AI'}</span>
            <span className={`sx-studio-model-tag ${byok ? 'sx-byok' : ''}`}>{byok ? 'MY FAL KEY' : 'CREDITS OK'}</span>
          </button>
        );
      })}
    </div>
  );
}

function Select({ id, value, onChange, options, label }) {
  return (
    <div className="sx-studio-field">
      <DeckLabel htmlFor={id}>{label}</DeckLabel>
      <select id={id} className="sx-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </div>
  );
}

function NumberField({ id, label, value, onChange, min, max, step }) {
  return (
    <div className="sx-studio-field">
      <DeckLabel htmlFor={id}>{label}</DeckLabel>
      <input id={id} className="sx-input" type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function CasSlider({ cfg, probes }) {
  return (
    <div className="sx-studio-inset">
      <DeckLabel value={`${Math.round(cfg.sharpening * 100)}%`}>CONTRAST ADAPTIVE SHARPENING (CAS)</DeckLabel>
      <input
        type="range"
        className="sx-studio-range"
        min={0}
        max={1}
        step={0.05}
        value={cfg.sharpening}
        disabled={!probes.cas?.ok}
        onChange={(e) => cfg.setSharpening(Number(e.target.value))}
        aria-label="CAS Sharpening level"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={cfg.sharpening}
      />
      {!probes.cas?.ok ? <GatedReason>CAS FILTER UNAVAILABLE — SHARPENING WILL BE SKIPPED</GatedReason> : null}
    </div>
  );
}

function LoraStack({ cfg }) {
  return (
    <div className="sx-studio-lora" role="group" aria-label="Custom LoRA stack">
      <DeckLabel value={`${cfg.ltxLoras.length} / ${MAX_LORAS}`}>CUSTOM LoRA STACK (MAX {MAX_LORAS})</DeckLabel>
      <p className="sx-studio-note">
        Each LoRA must be a direct http(s) URL to a .safetensors file (max 3 GB each). Leave a path empty to skip that slot. Civitai: paste the plain https://civitai.com/api/download/models/&lt;versionId&gt; link (optionally with ?fileId=&lt;id&gt;) — the server auto-appends your CIVITAI_KEY, so never include your token yourself.
      </p>
      {cfg.ltxLoras.map((lora, i) => (
        <div key={i} className="sx-studio-lora-slot">
          <div className="sx-studio-lora-head">
            <span>LoRA #{i + 1} — SAFETENSORS URL</span>
            {i > 0 ? (
              <button type="button" className="sx-link-danger" onClick={() => cfg.removeLora(i)}>REMOVE LoRA #{i + 1}</button>
            ) : <span className="sx-studio-dim">MAX 3 GB</span>}
          </div>
          <input
            className="sx-input"
            type="url"
            aria-label={`LoRA #${i + 1} URL`}
            placeholder="https://example.com/path/to/lora.safetensors"
            value={lora.path}
            onChange={(e) => cfg.updateLora(i, { path: e.target.value })}
          />
          <div className="sx-studio-grid-2">
            <NumberField id={`lora-scale-${i}`} label="SCALE" min={0} max={2} step={0.05} value={lora.scale} onChange={(scale) => cfg.updateLora(i, { scale })} />
            <Select id={`lora-transformer-${i}`} label="TRANSFORMER" value={lora.transformer} onChange={(transformer) => cfg.updateLora(i, { transformer })} options={['both', 'high', 'low']} />
          </div>
        </div>
      ))}
      {cfg.ltxLoras.length < MAX_LORAS ? (
        <button type="button" className="sx-link" onClick={cfg.addLora}>+ ADD LoRA</button>
      ) : null}
    </div>
  );
}

export function CoreEngineSection({ cfg, num }) {
  const isVideo = cfg.kind === 'video';
  return (
    <DeckSection num={num} title="CORE ENGINE & PROMPT" badge="STAGE 1">
      <div className="sx-studio-field">
        <DeckLabel>PIPELINE EXECUTION MODE</DeckLabel>
        <Segmented options={MODES} value={cfg.mode} onChange={cfg.setMode} ariaLabel={isVideo ? 'Video Pipeline Mode' : 'Pipeline Mode'} />
      </div>
      {cfg.upscaleOnly ? (
        <GatedReason>UPSCALE ONLY — NO OUTPAINT. NON-SQUARE SOURCES ARE STRETCHED TO 1:1.</GatedReason>
      ) : (
        <>
          {isVideo && cfg.outpaintCatalog.length ? (
            <div className="sx-studio-field">
              <DeckLabel>OUTPAINT GENERATION MODEL</DeckLabel>
              <ModelCards entries={cfg.outpaintCatalog} value={cfg.outpaintOpt} onChange={cfg.setOutpaintOpt} ariaLabel="Outpaint Model" />
            </div>
          ) : null}
          {!isVideo ? (
            <div className="sx-studio-field">
              <DeckLabel>OUTPAINT GENERATION MODEL</DeckLabel>
              <div className="sx-studio-models">
                <div className="sx-studio-model sx-selected sx-static">
                  <span className="sx-studio-model-name">{cfg.outpaintLabel}</span>
                  <span className="sx-studio-model-id">{modelShort(cfg.outpaintModel)}</span>
                  <span className={`sx-studio-model-tag ${cfg.outpaintCustom ? 'sx-byok' : ''}`}>{cfg.outpaintCustom ? 'MY FAL KEY' : 'SET IN SIDEBAR'}</span>
                </div>
              </div>
            </div>
          ) : null}
          {isVideo && cfg.outpaintEntry?.is_custom ? (
            <CustomModelPanel model={cfg.outpaintEntry.model} kind="outpaint" entry={cfg.outpaintEntry} onArgs={cfg.setOutArgs} />
          ) : null}
          {!isVideo && cfg.outpaintCustom ? (
            <CustomModelPanel
              model={cfg.outpaintModel}
              kind="image_outpaint"
              onArgs={cfg.setOutArgs}
              entry={{
                label: `CUSTOM OUTPAINT (${cfg.outpaintShort})`,
                requirements: 'A saved personal Fal key is required; the source image is uploaded by the pipeline.',
                cost_note: 'No estimate stored — pull live pricing via MODEL INFO below before rendering.',
                expects: 'Sends {image_url, prompt}; expand_* arguments are applied only to the stock Image Apps outpaint model. Check MODEL INFO for the live schema.',
              }}
            />
          ) : null}
          <div className="sx-studio-field">
            <DeckLabel htmlFor="studio-prompt">OUTPAINT EXTENSION PROMPT</DeckLabel>
            <textarea
              id="studio-prompt"
              className="sx-textarea"
              rows={3}
              value={cfg.prompt}
              onChange={(e) => cfg.setPrompt(e.target.value)}
              placeholder={isVideo ? 'Describe the extended square background environment...' : 'Describe the environment to generate on left/right borders...'}
            />
          </div>
          {isVideo && cfg.ltxPicked ? (
            <div className="sx-studio-field">
              <DeckLabel htmlFor="studio-negative">NEGATIVE PROMPT FILTER</DeckLabel>
              <input
                id="studio-negative"
                className="sx-input"
                type="text"
                value={cfg.ltxNegativePrompt}
                onChange={(e) => cfg.setLtxNegativePrompt(e.target.value)}
                placeholder="yellow tint, sepia, warm cast, color distortion, discoloration, overexposure, oversaturated"
              />
            </div>
          ) : null}
        </>
      )}
    </DeckSection>
  );
}

export function AdvancedSection({ cfg, num }) {
  return (
    <DeckSection num={num} title="ADVANCED INFERENCE & LoRA" badge="TUNING" badgeTone="muted">
      {cfg.ltxPicked ? (
        <>
          <div className="sx-studio-grid-2">
            <div className="sx-studio-field">
              <DeckLabel htmlFor="studio-cfg" value={cfg.ltxGuidance.toFixed(1)}>GUIDANCE SCALE (CFG)</DeckLabel>
              <div className="sx-studio-range-row">
                <input
                  type="range"
                  className="sx-studio-range"
                  min={1.0}
                  max={20.0}
                  step={0.1}
                  value={cfg.ltxGuidance}
                  onChange={(e) => cfg.setLtxGuidance(Number(e.target.value))}
                  aria-label="Guidance scale slider"
                />
                <input
                  id="studio-cfg"
                  className="sx-input sx-studio-range-num"
                  type="number"
                  min={1.0}
                  max={20.0}
                  step={0.1}
                  value={cfg.ltxGuidance}
                  onChange={(e) => cfg.setLtxGuidance(Number(e.target.value))}
                />
              </div>
            </div>
            <Select id="studio-ltx-res" label="OUTPUT RESOLUTION TIER" value={cfg.ltxRes} onChange={cfg.setLtxRes} options={['720p', '1080p', '480p']} />
          </div>
          <div className="sx-studio-grid-2 sx-studio-toggles">
            <ToggleRow label="Preserve Audio Track" checked={cfg.ltxAudio} onChange={cfg.setLtxAudio} />
            <ToggleRow label="Enable Prompt Expansion (LLM Enrich)" checked={cfg.ltxPromptExpansion} onChange={cfg.setLtxPromptExpansion} />
          </div>
        </>
      ) : null}
      {cfg.loraPicked ? <LoraStack cfg={cfg} /> : null}
    </DeckSection>
  );
}

export function UpscaleSection({ cfg, num, probes, studioOk, maxSourceDur }) {
  const isVideo = cfg.kind === 'video';
  const trimEnd = Math.min(maxSourceDur, Number(cfg.trimStart || 0) + Number(cfg.trimDur || 0));
  return (
    <DeckSection num={num} title="4K UPSCALE & NEURAL POLISH" badge="3840×3840" badgeTone="ok">
      <div className="sx-studio-field">
        <DeckLabel>UPSCALER BACKEND</DeckLabel>
        <Segmented options={cfg.engines} value={cfg.engine} onChange={cfg.setEngine} ariaLabel="Upscale Engine" />
      </div>

      {cfg.falPicked && !isVideo ? (
        <>
          <div className="sx-studio-field">
            <DeckLabel>FAL AI UPSCALE MODEL</DeckLabel>
            <ModelCards
              entries={cfg.upscaleOptions.map((label) => cfg.upscaleCatalog.find((entry) => entry.label === label) || { label, credit_enabled: label === 'Clarity Upscaler' })}
              value={cfg.falModel}
              onChange={cfg.setFalModel}
              ariaLabel="FAL Model"
            />
          </div>
          {cfg.upscaleEntry?.is_custom ? (
            <CustomModelPanel model={cfg.upscaleEntry.model} kind="image_upscale" entry={cfg.upscaleEntry} onArgs={cfg.setUpArgs} />
          ) : null}
        </>
      ) : null}

      {cfg.falPicked && isVideo ? (
        <>
          {cfg.upscaleCatalog.length ? (
            <div className="sx-studio-field">
              <DeckLabel>FAL AI UPSCALE MODEL</DeckLabel>
              <ModelCards entries={cfg.upscaleCatalog} value={cfg.falUpscale} onChange={cfg.setFalUpscale} ariaLabel="FAL Upscale Model" />
            </div>
          ) : null}
          {cfg.upscaleEntry?.is_custom ? (
            <CustomModelPanel model={cfg.upscaleEntry.model} kind="upscale" entry={cfg.upscaleEntry} onArgs={cfg.setUpArgs} />
          ) : null}
          {cfg.falUpscale.includes('Bytedance') ? (
            <div className="sx-studio-grid-3" role="group" aria-label="Bytedance upscaler settings">
              <Select id="studio-btd-res" label="TARGET RESOLUTION" value={cfg.btdRes} onChange={cfg.setBtdRes} options={['4k', '2k', '1080p']} />
              <Select id="studio-btd-fps" label="TARGET FPS" value={cfg.btdFps} onChange={cfg.setBtdFps} options={['30fps', '60fps']} />
              <Select id="studio-btd-tier" label="QUALITY TIER" value={cfg.btdTier} onChange={cfg.setBtdTier} options={['fast', 'standard', 'pro']} />
              <Select id="studio-btd-preset" label="SCENARIO PRESET" value={cfg.btdPreset} onChange={cfg.setBtdPreset} options={['general', 'ugc', 'short_series', 'aigc', 'old_film']} />
              <Select id="studio-btd-fidelity" label="FIDELITY INTENSITY" value={cfg.btdFidelity} onChange={cfg.setBtdFidelity} options={['medium', 'high']} />
            </div>
          ) : null}
          {cfg.falUpscale.includes('SeedVR') ? (
            <div className="sx-studio-grid-2" role="group" aria-label="SeedVR2 upscale settings">
              <NumberField id="studio-seedvr-factor" label="UPSCALE FACTOR" min={1} max={4} step={0.5} value={cfg.seedvrFactor} onChange={cfg.setSeedvrFactor} />
              <Select id="studio-seedvr-target" label="TARGET RESOLUTION TIER" value={cfg.seedvrTarget} onChange={cfg.setSeedvrTarget} options={['1080p', '2160p', '1440p', '720p']} />
            </div>
          ) : null}
        </>
      ) : null}

      {isVideo && cfg.studioPicked && !studioOk ? (
        <AccentBlock
          title="STUDIO ENGINE UNAVAILABLE"
          tone="warn"
          lines={[
            'This system is missing VapourSynth, the ffms2 source plugin or the znedi3 plugin, so the neural STUDIO upscale engine cannot execute.',
            'FAST engine uses Lanczos4 + CAS and is fully operational.',
          ]}
          code={['pip install vapoursynth', '+ ffms2 + vsznedi3 plugins']}
        />
      ) : null}

      {!cfg.studioPicked ? <CasSlider cfg={cfg} probes={probes} /> : null}

      {isVideo ? (
        <div className="sx-studio-field">
          <DeckLabel>CLIP TRIMMING (MAX 15 SECONDS)</DeckLabel>
          <ToggleRow label="Enable 15s Video Trimming" checked={cfg.trimEnabled} onChange={cfg.setTrimEnabled} />
          {cfg.trimEnabled ? (
            <div className="sx-studio-grid-2">
              <NumberField
                id="studio-trim-start"
                label={`START TIME (s) — MAX ${Math.max(0, maxSourceDur - 1).toFixed(1)}`}
                min={0}
                max={Math.max(0, maxSourceDur - 1)}
                step={0.5}
                value={cfg.trimStart}
                onChange={cfg.setTrimStart}
              />
              <NumberField id="studio-trim-dur" label="CLIP DURATION (s — MAX 15s)" min={1} max={15} step={0.5} value={cfg.trimDur} onChange={cfg.setTrimDur} />
            </div>
          ) : null}
          <div className="sx-studio-readout">
            {cfg.trimEnabled
              ? <span>RANGE: <b>{Number(cfg.trimStart || 0).toFixed(1)}s ➔ {trimEnd.toFixed(1)}s ({Math.max(0, trimEnd - Number(cfg.trimStart || 0)).toFixed(1)}s TOTAL)</b></span>
              : <span>RANGE: <b>0.0s ➔ {Number(maxSourceDur || 0).toFixed(1)}s</b></span>}
            <span className="sx-studio-accent">{cfg.trimEnabled ? 'TRIMMED' : 'FULL CLIP'}</span>
          </div>
        </div>
      ) : null}
    </DeckSection>
  );
}

export function ExecuteSection({
  num,
  cfg,
  funding,
  blocked,
  studioOk,
  disabled,
  busy,
  label,
  onRender,
  error,
  jobs,
  onJobDone,
  onJobSettled,
  footer,
}) {
  return (
    <DeckSection num={num} title="COMPUTE QUOTA & EXECUTE" badge={disabled ? 'BLOCKED' : 'READY TO DISPATCH'} badgeTone={disabled ? 'muted' : 'accent'} className="sx-studio-execute">
      <CloudFundingPanel
        required={funding.cloudRequired}
        paymentSource={funding.paymentSource}
        onChange={funding.setPaymentSource}
        quoteState={funding.quoteState}
        byokOnly={funding.byokOnly}
      />
      {blocked.length ? <GatedReason>{blocked[0].label} UNAVAILABLE — CHECK SYSTEM PROBES</GatedReason> : null}
      {!blocked.length && cfg.kind === 'video' && cfg.studioPicked && !studioOk ? (
        <GatedReason>STUDIO ENGINE NOT INSTALLED — PLEASE SWITCH TO FAST OR FAL AI</GatedReason>
      ) : null}
      <Button primary className="sx-studio-render" disabled={disabled} loading={busy} onClick={onRender}>
        {funding.quoteStale ? '↻ RETRY QUOTE & RENDER' : label}
      </Button>
      {error ? (
        <div className="sx-error-box" role="alert">
          <div className="sx-error-title">EXECUTION ERROR</div>
          <div>{error}</div>
        </div>
      ) : null}
      {jobs.map((job) => (
        <JobRunner
          key={job.jobId}
          jobId={job.jobId}
          name={job.name}
          kind={job.kind}
          showMedia={false}
          onDone={(result) => onJobDone?.(job, result)}
          onSettled={(state) => onJobSettled?.(job, state)}
        />
      ))}
      {footer}
    </DeckSection>
  );
}
