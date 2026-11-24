import { AccentBlock, GatedReason } from '../ui/primitives.jsx';
import { ToggleRow } from '../ui/controls.jsx';
import CustomModelPanel from '../ui/CustomModelPanel.jsx';
import { onRovingKeyDown, tabStop } from '../ui/roving.js';
import CloudFundingPanel from '../billing/CloudFundingPanel.jsx';
import { CheckIcon, CloudIcon, CubeIcon, NoneIcon, SendIcon, SquareIcon } from '../icons/index.jsx';
import { MODES, MAX_LORAS } from './useExtendConfig.js';
import { LTX25_ANCHORS } from '../../utils/modelOptions.js';
import { TARGET_ASPECTS } from '../../utils/aspect.js';

// How a file is made: every extender setting of the standalone Image and Video
// pages, in the order a person decides them, plus the shape. It binds to the
// same config object (useExtendConfig), so the /process form does not change.

// Original first: the file as it came, then Extend (Fill with AI) to a shape.
const MODE_ORDER = [MODES[1], MODES[0]];
const MODE_CARDS = {
  [MODES[0]]: { name: 'Extend', hint: 'New picture is painted out to 1:1, 16:9 or 9:16', Icon: SquareIcon },
  [MODES[1]]: { name: 'Original', hint: 'Nothing is added; the file keeps its shape', Icon: CheckIcon },
};
// A plain frame in the shape, centred in the 24×24 icon box.
const shapeIcon = (width, height) => function ShapeIcon() {
  return (
    <svg className="sx-media-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x={(24 - width) / 2} y={(24 - height) / 2} width={width} height={height} />
    </svg>
  );
};
const SHAPE_CARDS = {
  '1:1': { name: '1:1', hint: 'Square', Icon: shapeIcon(15, 15) },
  '16:9': { name: '16:9', hint: 'Wide', Icon: shapeIcon(20, 11.25) },
  '9:16': { name: '9:16', hint: 'Tall', Icon: shapeIcon(11.25, 20) },
};
// '' is no upscale: the file keeps its own resolution.
const ENGINE_CARDS = {
  '': { name: 'No upscale', hint: 'Keeps its own resolution', Icon: NoneIcon },
  FAST: { name: 'Fast', hint: 'On this server, no credits', Icon: SendIcon },
  STUDIO: { name: 'Studio', hint: 'Slower, cleaner detail', Icon: CubeIcon },
  'FAL AI': { name: 'Cloud AI', hint: 'Best detail, uses credits', Icon: CloudIcon },
};

export function Step({ title, children }) {
  return (
    <section className="sx-media-step">
      <h3 className="sx-media-step-title">{title}</h3>
      {children}
    </section>
  );
}

function Label({ children, htmlFor, value }) {
  return (
    <div className="sx-studio-label-row">
      {htmlFor ? <label className="sx-studio-label" htmlFor={htmlFor}>{children}</label> : <span className="sx-studio-label">{children}</span>}
      {value !== undefined ? <span className="sx-studio-label-value">{value}</span> : null}
    </div>
  );
}

// Large picture choices (a radiogroup). `cards` maps each option to its name, hint and icon.
function ChoiceCards({ options, cards, value, onChange, ariaLabel }) {
  const stop = tabStop(options.map((option) => option === value));
  return (
    <div className="sx-media-choices" role="radiogroup" aria-label={ariaLabel} onKeyDown={onRovingKeyDown}>
      {options.map((option, index) => {
        const { name, hint, Icon } = cards[option];
        return (
          <button
            type="button"
            key={option}
            role="radio"
            aria-checked={option === value}
            tabIndex={index === stop ? 0 : -1}
            className={`sx-media-choice ${option === value ? 'sx-selected' : ''}`}
            title={hint}
            onClick={() => {
              if (option !== value) onChange(option);
            }}
          >
            <Icon />
            <span className="sx-media-choice-name">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

// Original or Extend (cfg.mode); `originalOnly` leaves Extend out (a 180°/360° video).
export function ModeChoice({ value, onChange, isVideo, originalOnly = false }) {
  return <ChoiceCards options={originalOnly ? [MODES[1]] : MODE_ORDER} cards={MODE_CARDS} value={value} onChange={onChange} ariaLabel={isVideo ? 'Video Pipeline Mode' : 'Pipeline Mode'} />;
}

// No upscale, then the kind's engines (cfg.engine; '' is no upscale).
export function QualityChoice({ engines, value, onChange }) {
  return <ChoiceCards options={['', ...engines]} cards={ENGINE_CARDS} value={value} onChange={onChange} ariaLabel="Upscale Engine" />;
}

const modelShort = (model) => (model || '').split('/').filter(Boolean).slice(-2).join('/');

// Selectable model tiles (a radiogroup).
function ModelCards({ entries, value, onChange, ariaLabel }) {
  const stop = tabStop(entries.map((entry) => entry.label === value));
  return (
    <div className="sx-studio-models" role="radiogroup" aria-label={ariaLabel} onKeyDown={onRovingKeyDown}>
      {entries.map((entry, index) => {
        const selected = entry.label === value;
        const byok = entry.credit_enabled === false || entry.is_custom;
        return (
          <button
            type="button"
            key={entry.label}
            role="radio"
            aria-checked={selected}
            tabIndex={index === stop ? 0 : -1}
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
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className="sx-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </div>
  );
}

function NumberField({ id, label, value, onChange, min, max, step }) {
  return (
    <div className="sx-studio-field">
      <Label htmlFor={id}>{label}</Label>
      <input id={id} className="sx-input" type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function LoraStack({ cfg }) {
  return (
    <div className="sx-studio-lora" role="group" aria-label="Custom LoRA stack">
      <Label value={`${cfg.ltxLoras.length} / ${MAX_LORAS}`}>CUSTOM LoRA STACK (MAX {MAX_LORAS})</Label>
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

// `allMatch`: every file already has the picked shape, so there is nothing to fill.
// `shape`: the shape shown as picked: the person's pick, else the one all the
// files would be made in (null when they differ).
// `onPick(mode, engine)`: set in the file dialog, which shows Original / Extend
// above the panel; the panel then leaves the mode out and routes picks there.
export default function OptionsPanel({ cfg, funding, probes, studioOk, allMatch, shape, onPick }) {
  const isVideo = cfg.kind === 'video';
  const outpaint = !cfg.upscaleOnly && !allMatch;
  const ltx = isVideo && outpaint && cfg.ltxPicked;
  const minimax = isVideo && outpaint && cfg.minimaxPicked;
  const ltx25 = isVideo && outpaint && cfg.ltx25Picked;
  const bytedance = isVideo && cfg.falPicked && cfg.falUpscale.includes('Bytedance');
  const seedvr = isVideo && cfg.falPicked && cfg.falUpscale.includes('SeedVR');
  return (
    <div className="sx-media-options">
      {onPick && cfg.upscaleOnly ? null : (
        <Step title={onPick ? 'Shape' : 'How'}>
          {onPick ? null : <ModeChoice value={cfg.mode} onChange={cfg.setMode} isVideo={isVideo} />}
          {cfg.upscaleOnly ? null : (
            <ChoiceCards options={TARGET_ASPECTS} cards={SHAPE_CARDS} value={shape} onChange={cfg.setShape} ariaLabel={isVideo ? 'Video Shape' : 'Shape'} />
          )}
        </Step>
      )}

      <Step title="Quality">
        <QualityChoice engines={cfg.engines} value={cfg.engine} onChange={onPick ? (engine) => onPick(cfg.mode, engine) : cfg.setEngine} />
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
      </Step>

      {(outpaint && (isVideo ? cfg.outpaintCatalog.length > 0 || cfg.outpaintEntry?.is_custom : cfg.outpaintCustom)) || cfg.falPicked ? (
        <Step title="Model">
          {outpaint && isVideo && cfg.outpaintCatalog.length ? (
            <div className="sx-studio-field">
              <Label>Fills the new space</Label>
              <ModelCards entries={cfg.outpaintCatalog} value={cfg.outpaintOpt} onChange={cfg.setOutpaintOpt} ariaLabel="Outpaint Model" />
            </div>
          ) : null}
          {outpaint && isVideo && cfg.outpaintEntry?.is_custom ? (
            <CustomModelPanel model={cfg.outpaintEntry.model} kind="outpaint" entry={cfg.outpaintEntry} onArgs={cfg.setOutArgs} aspect={shape} />
          ) : null}
          {outpaint && !isVideo && cfg.outpaintCustom ? (
            <CustomModelPanel
              model={cfg.outpaintModel}
              kind="image_outpaint"
              onArgs={cfg.setOutArgs}
              aspect={shape}
              entry={{
                label: `CUSTOM OUTPAINT (${cfg.outpaintShort})`,
                requirements: 'A saved personal Fal key is required; the source image is uploaded by the pipeline.',
                cost_note: 'No estimate stored — pull live pricing via MODEL INFO below before rendering.',
                expects: 'Sends {image_url, prompt}; expand_* arguments are applied only to the stock Image Apps outpaint model. Check MODEL INFO for the live schema.',
              }}
            />
          ) : null}
          {cfg.falPicked && !isVideo ? (
            <div className="sx-studio-field">
              <Label>Sharpens to 2K</Label>
              <ModelCards
                entries={cfg.upscaleOptions.map((label) => cfg.upscaleCatalog.find((entry) => entry.label === label) || { label, credit_enabled: label === 'Clarity Upscaler' })}
                value={cfg.falModel}
                onChange={cfg.setFalModel}
                ariaLabel="FAL Model"
              />
            </div>
          ) : null}
          {cfg.falPicked && isVideo && cfg.upscaleCatalog.length ? (
            <div className="sx-studio-field">
              <Label>Sharpens to 2K</Label>
              <ModelCards entries={cfg.upscaleCatalog} value={cfg.falUpscale} onChange={cfg.setFalUpscale} ariaLabel="FAL Upscale Model" />
            </div>
          ) : null}
          {cfg.falPicked && cfg.upscaleEntry?.is_custom ? (
            <CustomModelPanel model={cfg.upscaleEntry.model} kind={isVideo ? 'upscale' : 'image_upscale'} entry={cfg.upscaleEntry} onArgs={cfg.setUpArgs} />
          ) : null}
        </Step>
      ) : null}

      {outpaint && !ltx25 ? (
        <Step title="Describe the fill">
          <textarea
            id="studio-prompt"
            className="sx-textarea"
            rows={3}
            aria-label="OUTPAINT EXTENSION PROMPT"
            value={cfg.prompt}
            onChange={(e) => cfg.setPrompt(e.target.value)}
            placeholder={isVideo ? 'Describe the background to paint around the video...' : 'Describe the background to paint around the picture...'}
          />
        </Step>
      ) : null}


      <details className="sx-media-fine">
        <summary>Fine tuning</summary>
        {ltx ? (
          <>
            <div className="sx-studio-field">
              <Label htmlFor="studio-negative">NEGATIVE PROMPT FILTER</Label>
              <input
                id="studio-negative"
                className="sx-input"
                type="text"
                value={cfg.ltxNegativePrompt}
                onChange={(e) => cfg.setLtxNegativePrompt(e.target.value)}
                placeholder="yellow tint, sepia, warm cast, color distortion, discoloration, overexposure, oversaturated"
              />
            </div>
            <div className="sx-studio-grid-2">
              <div className="sx-studio-field">
                <Label htmlFor="studio-cfg" value={cfg.ltxGuidance.toFixed(1)}>GUIDANCE SCALE (CFG)</Label>
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
              <Select id="studio-ltx-res" label="OUTPUT RESOLUTION TIER" value={cfg.ltxRes} onChange={cfg.setLtxRes} options={cfg.videoOptions.ltxRes} />
            </div>
            <div className="sx-studio-grid-2 sx-studio-toggles">
              <ToggleRow label="Preserve Audio Track" checked={cfg.ltxAudio} onChange={cfg.setLtxAudio} />
              <ToggleRow label="Enable Prompt Expansion (LLM Enrich)" checked={cfg.ltxPromptExpansion} onChange={cfg.setLtxPromptExpansion} />
            </div>
          </>
        ) : null}
        {isVideo && outpaint && cfg.loraPicked ? <LoraStack cfg={cfg} /> : null}
        {minimax ? (
          <div className="sx-studio-grid-2" role="group" aria-label="MiniMax H3 Max settings">
            <Select id="studio-minimax-res" label="OUTPUT RESOLUTION" value={cfg.minimaxRes} onChange={cfg.setMinimaxRes} options={cfg.minimaxResOptions} />
            <div className="sx-studio-field">
              <Label htmlFor="studio-minimax-seed">SEED (EMPTY = RANDOM)</Label>
              <input
                id="studio-minimax-seed"
                className="sx-input"
                type="text"
                inputMode="numeric"
                value={cfg.minimaxSeed}
                onChange={(e) => cfg.setMinimaxSeed(e.target.value.replace(/\D/g, ''))}
                placeholder="random"
              />
            </div>
          </div>
        ) : null}
        {ltx25 ? (
          <div className="sx-studio-grid-2" role="group" aria-label="LTX 2.5 Reframe settings">
            <Select id="studio-ltx25-res" label="OUTPUT RESOLUTION" value={cfg.ltx25Res} onChange={cfg.setLtx25Res} options={cfg.ltx25ResOptions} />
            <Select id="studio-ltx25-anchor" label="KEEP SOURCE AT" value={cfg.ltx25Anchor} onChange={cfg.setLtx25Anchor} options={LTX25_ANCHORS} />
          </div>
        ) : null}
        {bytedance ? (
          <div className="sx-studio-grid-3" role="group" aria-label="Bytedance upscaler settings">
            <Select id="studio-btd-res" label="TARGET RESOLUTION" value={cfg.btdRes} onChange={cfg.setBtdRes} options={cfg.videoOptions.btdRes} />
            <Select id="studio-btd-fps" label="TARGET FPS" value={cfg.btdFps} onChange={cfg.setBtdFps} options={cfg.videoOptions.btdFps} />
            <Select id="studio-btd-tier" label="QUALITY TIER" value={cfg.btdTier} onChange={cfg.setBtdTier} options={cfg.videoOptions.btdTier} />
            <Select id="studio-btd-preset" label="SCENARIO PRESET" value={cfg.btdPreset} onChange={cfg.setBtdPreset} options={['general', 'ugc', 'short_series', 'aigc', 'old_film']} />
            <Select id="studio-btd-fidelity" label="FIDELITY INTENSITY" value={cfg.btdFidelity} onChange={cfg.setBtdFidelity} options={['medium', 'high']} />
          </div>
        ) : null}
        {seedvr ? (
          <div className="sx-studio-grid-2" role="group" aria-label="SeedVR2 upscale settings">
            <NumberField id="studio-seedvr-factor" label="UPSCALE FACTOR" min={1} max={4} step={0.5} value={cfg.seedvrFactor} onChange={cfg.setSeedvrFactor} />
            <Select id="studio-seedvr-target" label="TARGET RESOLUTION TIER" value={cfg.seedvrTarget} onChange={cfg.setSeedvrTarget} options={cfg.videoOptions.seedvrTarget} />
          </div>
        ) : null}
        {!cfg.studioPicked ? (
          <div className="sx-studio-inset">
            <Label value={`${Math.round(cfg.sharpening * 100)}%`}>SHARPENING</Label>
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
        ) : null}
      </details>

      <Step title="Pay with">
        <CloudFundingPanel
          required={funding.cloudRequired}
          paymentSource={funding.paymentSource}
          onChange={funding.setPaymentSource}
          quoteState={funding.quoteState}
          byokOnly={funding.byokOnly}
        />
      </Step>
    </div>
  );
}
