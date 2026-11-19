import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UploadPage from './UploadPage.jsx';
import { appendProcessingParameters, imageBillingParameters, videoBillingParameters } from '../utils/cloudBilling.js';
import { IMG_PROMPT_DEFAULT, VID_NEG_DEFAULT, VID_PROMPT_DEFAULT } from '../components/upload/useExtendConfig.js';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  form: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
  quote: vi.fn(),
  estimate: vi.fn(),
  refresh: vi.fn(),
  probes: {},
  models: {},
  features: {},
  wallet: null,
}));

vi.mock('../api/client.js', () => ({
  api: {
    upload: (...args) => mocks.upload(...args),
    form: (...args) => mocks.form(...args),
    post: (...args) => mocks.post(...args),
    get: (...args) => mocks.get(...args),
  },
}));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', username: 'maker' } }) }));
vi.mock('../hooks/WalletContext.jsx', () => ({ useWallet: () => mocks.wallet }));
vi.mock('../hooks/HealthContext.jsx', () => ({ useHealthContext: () => ({ probes: mocks.probes }) }));
vi.mock('../hooks/ConfigContext.jsx', () => ({ useConfigContext: () => ({ config: { models: mocks.models, features: mocks.features } }) }));
// The job watcher is replaced by a button that completes the job. MAKE 3D
// jobs (job-3d…) finish with a side-by-side result, as the server's do.
vi.mock('../components/ui/JobRunner.jsx', () => ({ default: () => null, CancelJobButton: () => null }));
vi.mock('../components/upload/JobWatcher.jsx', () => ({
  default: ({ jobId, onDone, onSettled }) => (
    <button
      type="button"
      onClick={() => {
        if (jobId.includes('-fail')) {
          onSettled?.({ status: 'failed' });
          return;
        }
        onDone?.({
          download_url: `/api/jobs/${jobId}/download`,
          preview_url: null,
          ...(jobId.startsWith('job-3d') ? { stereo_layout: 'sbs' } : {}),
        });
        onSettled?.({ status: 'complete' });
      }}
    >
      FINISH {jobId}
    </button>
  ),
}));

// Node's own `localStorage` shadows jsdom's and is unusable without a flag, so give tests a real one.
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

const OK = { ok: true };
const ALL_PROBES = { ffmpeg: OK, ffprobe: OK, encoder: OK, cas: OK, vapoursynth: OK, ffms2: OK, znedi3: OK };

const MODELS = {
  outpaint_vid: 'fal-ai/ltx-2.3-quality/outpaint',
  upscale_vid: 'fal-ai/bytedance-upscaler/upscale/video',
  outpaint_img: 'fal-ai/image-apps-v2/outpaint',
  upscale_img: 'fal-ai/clarity-upscaler',
  video_outpaint_catalog: [
    { label: 'LTX 2.3 Quality', model: 'fal-ai/ltx-2.3-quality/outpaint', is_custom: false, credit_enabled: true },
    { label: 'LTX 2.3 Quality + LoRA', model: 'fal-ai/ltx-2.3-quality/outpaint/lora', is_custom: false, credit_enabled: true },
    { label: 'Luma Ray 3.2 Reframe', model: 'luma/agent/ray/v3.2/reframe', is_custom: false, credit_enabled: true },
    { label: 'Wan VACE 14B', model: 'fal-ai/wan-vace-14b/outpainting', is_custom: false, credit_enabled: true },
  ],
  video_upscale_catalog: [
    { label: 'Bytedance Upscaler', model: 'fal-ai/bytedance-upscaler/upscale/video', is_custom: false, credit_enabled: true },
    { label: 'SeedVR2 Video', model: 'fal-ai/seedvr/upscale/video', is_custom: false, credit_enabled: true },
  ],
  image_upscale_catalog: [
    { label: 'Clarity Upscaler', model: 'fal-ai/clarity-upscaler', is_custom: false, credit_enabled: true },
    { label: 'CCSR', model: 'fal-ai/ccsr', is_custom: false, credit_enabled: false },
    { label: 'AuraSR', model: 'fal-ai/aura-sr', is_custom: false, credit_enabled: false },
    { label: 'ESRGAN', model: 'fal-ai/esrgan', is_custom: false, credit_enabled: false },
  ],
  image_outpaint_catalog: [
    { label: 'Image Apps Outpaint', model: 'fal-ai/image-apps-v2/outpaint', is_custom: false, credit_enabled: true },
  ],
};

const meta = (name, width, height, extra = {}) => {
  const diffX = Math.max(0, height - width);
  const diffY = Math.max(0, width - height);
  return {
    stage_id: `st-${name}`,
    filename: name,
    width,
    height,
    orientation: width > height ? 'LANDSCAPE' : height > width ? 'PORTRAIT' : 'SQUARE',
    size_bytes: 1024 * 1024,
    padding: { top: Math.floor(diffY / 2), bottom: diffY - Math.floor(diffY / 2), left: Math.floor(diffX / 2), right: diffX - Math.floor(diffX / 2) },
    ...extra,
  };
};

const META = {
  'portrait.mp4': meta('portrait.mp4', 1080, 1920, { duration: 12.5 }),
  'square.mp4': meta('square.mp4', 480, 480, { duration: 2 }),
  'wide.png': meta('wide.png', 1600, 900),
  'square.png': meta('square.png', 512, 512),
  'sbs.mp4': meta('sbs.mp4', 3840, 1920, { duration: 4, stereo: { candidate: 'sbs', detected: true, method: 'content', score: 0.91 } }),
  'tb.png': meta('tb.png', 1024, 2048, { stereo: { candidate: 'tb', detected: true, method: 'metadata', score: null } }),
  'screen21.mp4': meta('screen21.mp4', 2160, 1080, { duration: 3, stereo: { candidate: 'sbs', detected: false, method: null, score: 0.12 } }),
  'eyes1.png': meta('eyes1.png', 800, 400, { stereo: { candidate: 'sbs', detected: true, method: 'content', score: 0.9 } }),
  'eyes2.png': meta('eyes2.png', 800, 400, { stereo: { candidate: 'sbs', detected: true, method: 'content', score: 0.88 } }),
  'a.png': meta('a.png', 400, 400),
  'b.png': meta('b.png', 400, 400),
  'c.png': meta('c.png', 400, 400),
  'tall.png': meta('tall.png', 900, 1600),
};

const fileOf = (name) => new File(['x'], name, { type: name.endsWith('.mp4') ? 'video/mp4' : 'image/png' });
const formObject = (fd) => Object.fromEntries([...fd.entries()]);
const expectedForm = (stageId, parameters, extra = {}) => ({
  stage_id: stageId,
  ...formObject(appendProcessingParameters(new FormData(), parameters)),
  ...extra,
});

let view;
function renderPage() {
  view = render(
    <MemoryRouter initialEntries={['/upload']}>
      <UploadPage />
    </MemoryRouter>,
  );
  return view;
}

async function pick(names) {
  const input = view.container.querySelector('.sx-media-add input');
  fireEvent.change(input, { target: { files: names.map(fileOf) } });
}

const radio = (group, name) => within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });
const renderButton = () => screen.getByRole('button', { name: /^(Make|Retry quote & make) .*square|^(Upscale|Retry quote & upscale)/ });
const postButton = () => screen.getByRole('button', { name: 'POST' });
const button = (name) => screen.getByRole('button', { name });
const MINE = { items: [], stages: [], retention: { stage_seconds: 6 * 3600, result_seconds: 30 * 86400 } };

beforeEach(() => {
  mocks.probes = { ...ALL_PROBES };
  mocks.models = MODELS;
  mocks.features = {};
  mocks.wallet = {
    wallet: { available_credits: 1000 },
    catalog: { credits_enabled: true },
    catalogStatus: 'ready',
    falKey: { configured: true, hint: '••••abcd' },
    refresh: mocks.refresh,
    quote: mocks.quote,
    estimate: mocks.estimate,
  };
  mocks.upload.mockImplementation(async (_path, file) => ({ ...META[file.name] }));
  mocks.quote.mockImplementation(async (_kind, stageId) => ({ stage_id: stageId, quote_id: `q-${stageId}`, credits: 3, provider_cost_usd: 0.03 }));
  mocks.estimate.mockImplementation(async (_kind, stageId) => ({ stage_id: stageId, quote_id: null, estimate: true, credits: 7, provider_cost_usd: 0.05 }));
  mocks.mine = MINE;
  mocks.get.mockImplementation(async (path) => (path === '/api/uploads/mine' ? mocks.mine : { inputs: [] }));
  vi.stubGlobal('localStorage', memoryStorage());
  mocks.refresh.mockResolvedValue(undefined);
  globalThis.URL.createObjectURL = vi.fn((file) => `blob:${file.name}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UploadPage — video extender parity', () => {
  it('maps a portrait clip onto the square stage with its outpaint bands', async () => {
    renderPage();
    await pick(['portrait.mp4']);
    expect(await screen.findByText('1080×1920 ➔ 2048×2048')).toBeInTheDocument();
    expect(screen.queryByText('PAD: 420px [L/R]')).toBeNull();
    expect(screen.getAllByText('+420px OUTPAINT')).toHaveLength(2);
    // The stage stays uncluttered: no zone names, telemetry box or spec grid.
    expect(screen.queryByText(/GENERATIVE ZONE/)).toBeNull();
    expect(screen.queryByText(/BOUNDARIES/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Media Specifications' })).toBeNull();
    expect(screen.getByText('12.5s EXCEEDS THE 10s THRESHOLD')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Stage playback' })).toBeInTheDocument();
    expect(document.querySelectorAll('.sx-studio-zone')).toHaveLength(2);
  });

  it('drops the cloud outpainting warning when the clip is only stretched', async () => {
    renderPage();
    await pick(['portrait.mp4']);
    expect(await screen.findByText('12.5s EXCEEDS THE 10s THRESHOLD')).toBeInTheDocument();
    fireEvent.click(radio('Video Pipeline Mode', 'Stretch to fit'));
    expect(screen.queryByText('12.5s EXCEEDS THE 10s THRESHOLD')).toBeNull();
  });

  it('sends every video setting exactly as the Video page would', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-v1' });
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');

    fireEvent.click(radio('Outpaint Model', /LTX 2\.3 Quality \+ LoRA/));
    const addLora = () => fireEvent.click(screen.getByRole('button', { name: '+ ADD LoRA' }));
    addLora();
    addLora();
    expect(screen.queryByRole('button', { name: '+ ADD LoRA' })).toBeNull();
    fireEvent.change(screen.getByLabelText('LoRA #1 URL'), { target: { value: ' https://x.test/a.safetensors ' } });
    fireEvent.change(screen.getByLabelText('LoRA #3 URL'), { target: { value: 'https://x.test/c.safetensors' } });
    fireEvent.click(screen.getByRole('button', { name: 'REMOVE LoRA #2' }));
    fireEvent.change(screen.getAllByLabelText('SCALE')[1], { target: { value: '0.75' } });
    fireEvent.change(screen.getAllByLabelText('TRANSFORMER')[1], { target: { value: 'low' } });

    fireEvent.change(screen.getByLabelText('OUTPAINT EXTENSION PROMPT'), { target: { value: 'neon city' } });
    fireEvent.change(screen.getByLabelText('NEGATIVE PROMPT FILTER'), { target: { value: 'blur' } });
    fireEvent.change(screen.getByLabelText('GUIDANCE SCALE (CFG)'), { target: { value: '3.5' } });
    fireEvent.change(screen.getByLabelText('OUTPUT RESOLUTION TIER'), { target: { value: '1080p' } });
    fireEvent.click(screen.getByLabelText('Preserve Audio Track'));
    fireEvent.click(screen.getByLabelText('Enable Prompt Expansion (LLM Enrich)'));

    fireEvent.click(radio('Upscale Engine', 'Cloud AI'));
    fireEvent.click(radio('FAL Upscale Model', /SeedVR2 Video/));
    fireEvent.change(screen.getByLabelText('UPSCALE FACTOR'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('TARGET RESOLUTION TIER'), { target: { value: '2160p' } });
    fireEvent.change(screen.getByLabelText('CAS Sharpening level'), { target: { value: '0.8' } });

    fireEvent.click(screen.getByLabelText('Enable 15s Video Trimming'));
    fireEvent.change(screen.getByLabelText(/START TIME \(s\) — MAX 11\.5/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('CLIP DURATION (s — MAX 15s)'), { target: { value: '6' } });
    expect(screen.getByText('2.0s ➔ 8.0s (6.0s TOTAL)')).toBeInTheDocument();

    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    const [path, fd] = mocks.form.mock.calls[0];
    expect(path).toBe('/api/video/process');
    expect(formObject(fd)).toEqual(expectedForm('st-portrait.mp4', videoBillingParameters({
      prompt: 'neon city',
      upscaleOnly: false,
      falPicked: true,
      studioPicked: false,
      sharpening: 0.8,
      outpaintModel: 'fal-ai/ltx-2.3-quality/outpaint/lora',
      upscaleModel: 'fal-ai/seedvr/upscale/video',
      ltxResolution: '1080p',
      ltxAudio: false,
      ltxGuidance: 3.5,
      ltxPromptExpansion: true,
      ltxNegativePrompt: 'blur',
      ltxLoras: [
        { path: 'https://x.test/a.safetensors', scale: 1, transformer: 'both' },
        { path: 'https://x.test/c.safetensors', scale: 0.75, transformer: 'low' },
      ],
      wanResolution: '720p',
      seedvrFactor: 3,
      seedvrTarget: '2160p',
      bytedanceTargetRes: '2k',
      bytedanceTargetFps: '30fps',
      bytedanceTier: 'fast',
      bytedancePreset: 'general',
      bytedanceFidelity: 'medium',
      trimEnabled: true,
      trimStart: 2,
      trimDuration: 6,
      customOutpaintArgs: {},
      customUpscaleArgs: {},
    }), { payment_source: 'credits', quote_id: 'q-st-portrait.mp4' }));
    expect(await screen.findByRole('button', { name: 'FINISH job-v1' })).toBeInTheDocument();
  });

  it('exposes the Bytedance settings and keeps the default LTX / FAST payload', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-v2' });
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    fireEvent.click(radio('Upscale Engine', 'Cloud AI'));
    const group = screen.getByRole('group', { name: 'Bytedance upscaler settings' });
    fireEvent.change(within(group).getByLabelText('TARGET RESOLUTION'), { target: { value: '2k' } });
    fireEvent.change(within(group).getByLabelText('TARGET FPS'), { target: { value: '60fps' } });
    fireEvent.change(within(group).getByLabelText('QUALITY TIER'), { target: { value: 'pro' } });
    fireEvent.change(within(group).getByLabelText('SCENARIO PRESET'), { target: { value: 'old_film' } });
    fireEvent.change(within(group).getByLabelText('FIDELITY INTENSITY'), { target: { value: 'high' } });
    expect(screen.queryByRole('group', { name: 'Custom LoRA stack' })).toBeNull();
    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    expect(formObject(mocks.form.mock.calls[0][1])).toEqual(expectedForm('st-portrait.mp4', videoBillingParameters({
      prompt: VID_PROMPT_DEFAULT,
      upscaleOnly: false,
      falPicked: true,
      studioPicked: false,
      sharpening: 0.5,
      outpaintModel: 'fal-ai/ltx-2.3-quality/outpaint',
      upscaleModel: 'fal-ai/bytedance-upscaler/upscale/video',
      ltxResolution: '720p',
      ltxAudio: true,
      ltxGuidance: 1,
      ltxPromptExpansion: false,
      ltxNegativePrompt: VID_NEG_DEFAULT,
      ltxLoras: [],
      seedvrFactor: 2,
      seedvrTarget: '1080p',
      bytedanceTargetRes: '2k',
      bytedanceTargetFps: '60fps',
      bytedanceTier: 'pro',
      bytedancePreset: 'old_film',
      bytedanceFidelity: 'high',
      trimEnabled: false,
      trimStart: 0,
      trimDuration: 15,
      customOutpaintArgs: {},
      customUpscaleArgs: {},
    }), { payment_source: 'credits', quote_id: 'q-st-portrait.mp4' }));
  });

  it('gates STUDIO when VapourSynth is missing and hides CAS for it', async () => {
    mocks.probes = { ...ALL_PROBES, vapoursynth: { ok: false } };
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    expect(screen.getByLabelText('CAS Sharpening level')).toBeInTheDocument();
    fireEvent.click(radio('Upscale Engine', 'Studio'));
    expect(screen.getByText('STUDIO ENGINE UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('STUDIO ENGINE NOT INSTALLED — PLEASE SWITCH TO FAST OR FAL AI')).toBeInTheDocument();
    expect(screen.queryByLabelText('CAS Sharpening level')).toBeNull();
    // Blocked with a reason: still focusable, and the reason is its description.
    expect(renderButton()).toHaveAttribute('aria-disabled', 'true');
    expect(renderButton()).not.toBeDisabled();
    expect(renderButton()).toHaveAccessibleDescription('STUDIO ENGINE NOT INSTALLED — PLEASE SWITCH TO FAST OR FAL AI');
  });

  it('names a missing tool without detail when production sends status only', async () => {
    mocks.probes = { ...ALL_PROBES, ffmpeg: { id: 'ffmpeg', label: 'ffmpeg', ok: false, severity: 'error' } };
    renderPage();
    await pick(['portrait.mp4']);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('ffmpeg is not available on this server.');
    expect(banner).not.toHaveTextContent('undefined');
  });

  it('gates STUDIO when the ffms2 source plugin does not load', async () => {
    mocks.probes = { ...ALL_PROBES, ffms2: { ok: false } };
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    fireEvent.click(radio('Upscale Engine', 'Studio'));
    expect(screen.getByText('STUDIO ENGINE UNAVAILABLE')).toBeInTheDocument();
    expect(renderButton()).toHaveAttribute('aria-disabled', 'true');
  });

  it('disables CAS with a reason when the filter probe fails', async () => {
    mocks.probes = { ...ALL_PROBES, cas: { ok: false } };
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    expect(screen.getByLabelText('CAS Sharpening level')).toBeDisabled();
    expect(screen.getByText('CAS FILTER UNAVAILABLE — SHARPENING WILL BE SKIPPED')).toBeInTheDocument();
  });

  it('preselects a sidebar CUSTOM upscale endpoint and forces MY FAL KEY for it', async () => {
    mocks.models = {
      ...MODELS,
      upscale_vid: 'me/my-upscaler',
      video_upscale_catalog: [
        ...MODELS.video_upscale_catalog,
        { label: 'CUSTOM (my-upscaler)', model: 'me/my-upscaler', is_custom: true, credit_enabled: false },
      ],
    };
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    fireEvent.click(radio('Upscale Engine', 'Cloud AI'));
    expect(radio('FAL Upscale Model', /CUSTOM \(my-upscaler\)/)).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(radio('Cloud payment source', 'MY FAL KEY')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('THE SELECTED CUSTOM / NON-DETERMINISTIC MODEL REQUIRES MY FAL KEY')).toBeInTheDocument();
  });

  it('hides options fal withdrew and falls back to the first one still offered', async () => {
    const withdrawn = (catalog, model, patch) => catalog.map((e) => (e.model === model ? { ...e, ...patch } : e));
    mocks.models = {
      ...MODELS,
      video_outpaint_catalog: withdrawn(MODELS.video_outpaint_catalog, 'fal-ai/ltx-2.3-quality/outpaint', { resolutions: { '480p': 480, '1080p': 1080 } }),
      video_upscale_catalog: withdrawn(MODELS.video_upscale_catalog, 'fal-ai/bytedance-upscaler/upscale/video', { base_rates_usd: { '1080p': '0.01', '4k': '0.04' } }),
    };
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    const values = (select) => within(select).getAllByRole('option').map((node) => node.value);
    const ltx = screen.getByLabelText('OUTPUT RESOLUTION TIER');
    expect(values(ltx)).toEqual(['1080p', '480p']);
    expect(ltx).toHaveValue('1080p');
    fireEvent.click(radio('Upscale Engine', 'Cloud AI'));
    const target = within(screen.getByRole('group', { name: 'Bytedance upscaler settings' })).getByLabelText('TARGET RESOLUTION');
    expect(values(target)).toEqual(['4k', '1080p']);
    expect(target).toHaveValue('4k');
  });
});

describe('UploadPage — image extender parity', () => {
  it('offers only the image engines and switches to MY FAL KEY for non-credit models, then back', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-i1' });
    renderPage();
    await pick(['wide.png']);
    expect(await screen.findByText('1600×900 ➔ 2048×2048')).toBeInTheDocument();
    expect(screen.queryByText('PAD: 350px [T/B]')).toBeNull();
    const engines = within(screen.getByRole('radiogroup', { name: 'Upscale Engine' })).getAllByRole('radio').map((node) => node.textContent.trim());
    expect(engines).toEqual(['Fast', 'Cloud AI']);
    fireEvent.click(radio('Upscale Engine', 'Cloud AI'));
    fireEvent.click(radio('FAL Model', /CCSR/));
    await waitFor(() => expect(radio('Cloud payment source', 'MY FAL KEY')).toHaveAttribute('aria-checked', 'true'));
    // A credit-supported model switches the payment back.
    fireEvent.click(radio('FAL Model', /Clarity Upscaler/));
    await waitFor(() => expect(radio('Cloud payment source', 'ECHO CREDITS')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(radio('FAL Model', /CCSR/));
    await waitFor(() => expect(radio('Cloud payment source', 'MY FAL KEY')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    const [path, fd] = mocks.form.mock.calls[0];
    expect(path).toBe('/api/image/process');
    expect(formObject(fd)).toEqual(expectedForm('st-wide.png', imageBillingParameters({
      prompt: IMG_PROMPT_DEFAULT,
      upscaleOnly: false,
      sharpening: 0.5,
      falPicked: true,
      upscaleModel: 'fal-ai/ccsr',
      outpaintModel: 'fal-ai/image-apps-v2/outpaint',
      customOutpaintArgs: {},
      customUpscaleArgs: {},
    }), { payment_source: 'byok' }));

  });

  it('keeps UPSCALE ONLY + FAST local and flags the stretch to 1:1', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-i2' });
    renderPage();
    await pick(['wide.png']);
    await screen.findByText('1600×900 ➔ 2048×2048');
    fireEvent.click(radio('Pipeline Mode', 'Stretch to fit'));
    expect(screen.getByText('UPSCALE ONLY · STRETCHED TO 1:1')).toBeInTheDocument();
    expect(screen.getByText('LOCAL PROCESSING · NO CREDITS REQUIRED')).toBeInTheDocument();
    expect(screen.queryByLabelText('OUTPAINT EXTENSION PROMPT')).toBeNull();
    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    expect(formObject(mocks.form.mock.calls[0][1])).toEqual(expectedForm('st-wide.png', imageBillingParameters({
      prompt: IMG_PROMPT_DEFAULT,
      upscaleOnly: true,
      sharpening: 0.5,
      falPicked: false,
      upscaleModel: 'fal-ai/clarity-upscaler',
      outpaintModel: 'fal-ai/image-apps-v2/outpaint',
      customOutpaintArgs: {},
      customUpscaleArgs: {},
    })));
  });

  it('shows the custom image outpaint panel when the sidebar sets one', async () => {
    mocks.models = { ...MODELS, outpaint_img: 'me/my-outpaint' };
    renderPage();
    await pick(['wide.png']);
    await screen.findByText('1600×900 ➔ 2048×2048');
    expect(screen.getAllByText(/CUSTOM OUTPAINT \(my-outpaint\)|CUSTOM \(my-outpaint\)/).length).toBeGreaterThan(0);
    await waitFor(() => expect(radio('Cloud payment source', 'MY FAL KEY')).toHaveAttribute('aria-checked', 'true'));
  });

  it('prices the render with estimates while ECHO credits are disabled, and renders with MY FAL KEY', async () => {
    mocks.wallet = { ...mocks.wallet, catalog: { credits_enabled: false } };
    mocks.form.mockResolvedValue({ job_id: 'job-est' });
    renderPage();
    await pick(['wide.png']);
    await waitFor(() => expect(mocks.estimate).toHaveBeenCalledWith('image', 'st-wide.png', expect.any(Object), expect.anything()));
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(await screen.findByText(/7 credits \(estimate only\)/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0500 USD across 1 item\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/ECHO CREDITS ARE DISABLED/)).toBeInTheDocument();

    fireEvent.click(radio('Cloud payment source', 'MY FAL KEY'));
    expect(await screen.findByText(/\$0\.0500 USD across 1 item\(s\)/)).toBeInTheDocument();
    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    const submitted = formObject(mocks.form.mock.calls[0][1]);
    expect(submitted.payment_source).toBe('byok');
    expect(submitted.quote_id).toBeUndefined();
  });

  it('keeps each kind\'s settings when another file is staged', async () => {
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    fireEvent.change(screen.getByLabelText('OUTPAINT EXTENSION PROMPT'), { target: { value: 'video prompt' } });
    fireEvent.click(radio('Upscale Engine', 'Studio'));
    await pick(['wide.png']);
    await screen.findByText('1600×900 ➔ 2048×2048');
    expect(screen.getByLabelText('OUTPAINT EXTENSION PROMPT')).toHaveValue(IMG_PROMPT_DEFAULT);
    expect(radio('Upscale Engine', 'Fast')).toHaveAttribute('aria-checked', 'true');
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    expect(screen.getByLabelText('OUTPAINT EXTENSION PROMPT')).toHaveValue('video prompt');
    expect(radio('Upscale Engine', 'Studio')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('UploadPage — posting', () => {
  it('posts an already-square image as it is', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'square' }, rel_path: 'uploads/square.png', media_url: '/media/uploads/square.png' });
    renderPage();
    await pick(['square.png']);
    expect(await screen.findByText('ALREADY 1:1')).toBeInTheDocument();
    // Nothing to make square: the dialog goes straight to the post form.
    expect(screen.queryByRole('radiogroup', { name: 'Upscale Engine' })).toBeNull();
    expect(screen.getByLabelText('TITLE')).toHaveValue('square');
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [path, body] = mocks.post.mock.calls[0];
    expect(path).toBe('/api/uploads/publish');
    expect(body).toMatchObject({ kind: 'image', title: 'square', stage_id: 'st-square.png' });
    expect(body.job_id).toBeUndefined();
    expect(await screen.findByText('✓ POSTED')).toBeInTheDocument();
    expect(button('▶ PLAY IN REELS')).toBeInTheDocument();
  });

  it('needs a title to post', async () => {
    renderPage();
    await pick(['square.png']);
    fireEvent.change(await screen.findByLabelText('TITLE'), { target: { value: ' ' } });
    expect(postButton()).toHaveAttribute('aria-disabled', 'true');
    expect(postButton()).toHaveAccessibleDescription('A TITLE IS NEEDED TO POST');
  });

  it('offers a square video to be kept as it is or upscaled, with the real output size', async () => {
    renderPage();
    await pick(['square.mp4']);
    await screen.findByText('ALREADY 1:1');
    expect(radio('Square file', 'Keep as is')).toHaveAttribute('aria-checked', 'true');
    // Kept as it is: no target size is promised.
    expect(screen.getByText('480×480')).toBeInTheDocument();
    fireEvent.click(radio('Square file', 'Upscale'));
    expect(screen.getByText('480×480 ➔ 2048×2048')).toBeInTheDocument();
    // Nothing to fill or stretch on a square file.
    expect(screen.queryByRole('radiogroup', { name: 'Video Pipeline Mode' })).toBeNull();
    // Unpicking the quality leaves nothing to do.
    fireEvent.click(radio('Upscale Engine', 'Fast'));
    expect(radio('Upscale Engine', 'Fast')).toHaveAttribute('aria-checked', 'false');
    expect(renderButton()).toHaveAttribute('aria-disabled', 'true');
    expect(renderButton()).toHaveAccessibleDescription('PICK A QUALITY TO UPSCALE, OR KEEP THE FILE AS IT IS');
    fireEvent.click(radio('Square file', 'Keep as is'));
    expect(screen.getByLabelText('TITLE')).toHaveValue('square');
  });

  it('makes a clip square with no upscale when the quality is unpicked', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-none' });
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('1080×1920 ➔ 2048×2048');
    fireEvent.click(radio('Upscale Engine', 'Fast'));
    expect(screen.getByText('1080×1920')).toBeInTheDocument();
    fireEvent.click(radio('Video Pipeline Mode', 'Stretch to fit'));
    expect(screen.getByText('1080×1920 ➔ 1920×1920')).toBeInTheDocument();
    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    expect(formObject(mocks.form.mock.calls[0][1])).toMatchObject({ upscale_engine: 'none', upscale_only: 'true' });
  });

  it('makes a square image square again, shows the result on the stage, then posts the result', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-sq' });
    mocks.post.mockResolvedValue({ meta: { title: 'square' }, rel_path: 'uploads/x.png', media_url: '/m' });
    renderPage();
    await pick(['square.png']);
    await screen.findByText('ALREADY 1:1');
    fireEvent.click(radio('Square file', 'Upscale'));
    expect(screen.getByText('LOCAL PROCESSING · NO CREDITS REQUIRED')).toBeInTheDocument();
    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    expect(formObject(mocks.form.mock.calls[0][1]).payment_source).toBeUndefined();
    expect(radio('Stage view', 'EXTENDED')).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-sq' }));
    expect(await screen.findByAltText('Rendered square result for square.png')).toHaveAttribute('src', '/api/jobs/job-sq/download');
    expect(radio('Stage view', 'EXTENDED')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radio('Stage view', 'ORIGINAL'));
    expect(screen.getByAltText('square.png')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download the 2K square' })).toHaveAttribute('href', '/api/jobs/job-sq/download');
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'image', job_id: 'job-sq' });
    expect(mocks.post.mock.calls[0][1].stage_id).toBeUndefined();
  });

  it('posts several images as one: reorder, remove, publish the remaining order', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'a' }, rel_path: 'uploads/c.png', media_url: '/m' });
    renderPage();
    await pick(['a.png', 'b.png', 'c.png']);
    // Several files stay on the shelf, checked.
    fireEvent.click(await screen.findByRole('button', { name: 'Post 3 as one' }));
    const strip = await screen.findByRole('list', { name: 'Images in post order' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(button('Move b.png later'));
    fireEvent.click(button('Remove a.png'));
    expect(within(strip).getAllByRole('img').map((node) => node.getAttribute('alt'))).toEqual(['c.png', 'b.png']);
    fireEvent.click(button('View b.png'));
    expect(button('View b.png')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'image', stage_id: 'st-c.png', extra_stage_ids: ['st-b.png'] });
  });

  it('posts a made-square image together with a square upload', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-wide' });
    mocks.post.mockResolvedValue({ meta: { title: 'a' }, rel_path: 'uploads/a.png', media_url: '/m' });
    renderPage();
    await pick(['a.png', 'wide.png']);
    fireEvent.click(await screen.findByRole('button', { name: /^Make square/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-wide' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select wide.png' }));
    fireEvent.click(button('Post 2 as one'));
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const body = mocks.post.mock.calls[0][1];
    expect(body).toMatchObject({ kind: 'image', stage_id: 'st-a.png', extra_items: [{ job_id: 'job-wide' }] });
    expect(body.extra_stage_ids).toBeUndefined();
  });

  it('refuses unsupported files, and says why a selection cannot be one post', async () => {
    renderPage();
    await pick(['notes.txt']);
    expect(await screen.findByText(/Unsupported file type: notes\.txt/)).toBeInTheDocument();
    expect(mocks.upload).not.toHaveBeenCalled();
    await pick(['a.png', 'square.mp4']);
    const mixed = await screen.findByRole('button', { name: 'Post 2 as one' });
    expect(mixed).toHaveAttribute('aria-disabled', 'true');
    expect(mixed).toHaveAccessibleDescription('A post holds one video. Only images can be posted together.');
    await pick(Array.from({ length: 11 }, (_, i) => `img-${i}.png`).map((name) => {
      META[name] = meta(name, 400, 400);
      return name;
    }));
    expect(await screen.findByRole('button', { name: 'Post 11 as one' })).toHaveAccessibleDescription('A post holds at most 10 images (you picked 11).');
  });

  it('discards a file from the shelf without opening it', async () => {
    renderPage();
    await pick(['a.png', 'wide.png']);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard wide.png' }));
    expect(screen.queryByRole('button', { name: 'Open wide.png' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Needs square/ })).toBeNull();
    expect(button('Open a.png')).toBeInTheDocument();
  });
});

describe('UploadPage — several files at once', () => {
  it('makes every checked file square with its own settings, continues past a failed start, and the results can be posted', async () => {
    mocks.form
      .mockRejectedValueOnce(Object.assign(new Error('Stage expired for wide'), { status: 400 }))
      .mockResolvedValueOnce({ job_id: 'job-b2' });
    mocks.post.mockResolvedValue({ meta: { title: 'portrait' }, rel_path: 'uploads/p.mp4', media_url: '/m' });
    renderPage();
    await pick(['wide.png', 'portrait.mp4', 'square.mp4']);
    const make = await screen.findByRole('button', { name: /^Make 2 square/ });
    // The square clip is already postable; it is not made square.
    expect(button('Open square.mp4').closest('li')).toHaveClass('sx-ready');
    await waitFor(() => expect(renderButton()).toHaveTextContent('Make 2 square · 6 credits'));
    fireEvent.click(make);
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(2));
    expect(mocks.form.mock.calls.map(([path]) => path)).toEqual(['/api/image/process', '/api/video/process']);
    expect(formObject(mocks.form.mock.calls[0][1])).toMatchObject({ stage_id: 'st-wide.png', payment_source: 'credits', quote_id: 'q-st-wide.png' });
    expect(formObject(mocks.form.mock.calls[1][1])).toMatchObject({ stage_id: 'st-portrait.mp4', payment_source: 'credits', quote_id: 'q-st-portrait.mp4' });
    expect(await screen.findByText('Stage expired for wide')).toBeInTheDocument();
    expect(button('Open wide.png').closest('li')).toHaveClass('sx-needs');
    expect(within(button('Open wide.png').closest('li')).getByRole('img', { name: 'Could not be made square. Try again.' })).toBeInTheDocument();
    expect(button('Open portrait.mp4').closest('li')).toHaveClass('sx-working');

    fireEvent.click(button('FINISH job-b2'));
    await waitFor(() => expect(button('Open portrait.mp4').closest('li')).toHaveClass('sx-ready'));
    fireEvent.click(button('Open portrait.mp4'));
    fireEvent.click(await screen.findByRole('button', { name: 'POST' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'video', job_id: 'job-b2' });
  });

  it('waits when the server is busy and starts the rest by itself when a job ends', async () => {
    mocks.form
      .mockResolvedValueOnce({ job_id: 'job-q1' })
      .mockRejectedValueOnce(Object.assign(new Error('You already have 2 jobs running.'), { status: 429, code: 'QUEUE_FULL', retryAfter: 60 }))
      .mockResolvedValueOnce({ job_id: 'job-q2' })
      .mockResolvedValueOnce({ job_id: 'job-q3' });
    renderPage();
    await pick(['wide.png', 'tall.png', 'portrait.mp4']);
    fireEvent.click(await screen.findByRole('button', { name: /^Make 3 square/ }));
    expect(await screen.findByText(/Waiting for a free slot/)).toBeInTheDocument();
    // The refused file and the one after it were not marked as failed, and stay checked.
    expect(mocks.form).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('img', { name: 'Could not be made square. Try again.' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select tall.png' })).toBeChecked();
    fireEvent.click(button('FINISH job-q1'));
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(4));
    expect(mocks.form.mock.calls.slice(2).map(([path, fd]) => [path, formObject(fd).stage_id])).toEqual([
      ['/api/image/process', 'st-tall.png'], ['/api/video/process', 'st-portrait.mp4'],
    ]);
    await waitFor(() => expect(screen.queryByText(/Waiting for a free slot/)).toBeNull());
  });

  it('acts on the checked files only, and offers both kinds in the options', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-one' });
    renderPage();
    await pick(['wide.png', 'tall.png', 'portrait.mp4']);
    await screen.findByRole('button', { name: /^Make 3 square/ });
    fireEvent.click(button('Options'));
    expect(radio('Options for', 'IMAGES')).toHaveAttribute('aria-checked', 'true');
    expect(within(screen.getByRole('radiogroup', { name: 'Upscale Engine' })).getAllByRole('radio')).toHaveLength(2);
    fireEvent.click(radio('Options for', 'VIDEOS'));
    expect(within(screen.getByRole('radiogroup', { name: 'Upscale Engine' })).getAllByRole('radio')).toHaveLength(3);
    fireEvent.click(button('Close'));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select tall.png' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select portrait.mp4' }));
    await waitFor(() => expect(renderButton()).toHaveTextContent('Make square · 3 credits'));
    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    expect(formObject(mocks.form.mock.calls[0][1]).stage_id).toBe('st-wide.png');
    expect(button('Open tall.png').closest('li')).toHaveClass('sx-needs');
  });
});

describe('UploadPage — gallery and saved results', () => {
  const row = (jobId, extra = {}) => ({
    job_id: jobId, kind: 'image', role: 'square', source_stage_id: null, source_job_id: null, filename: 'beach.png',
    status: 'ready', kept: true, post_id: null, created_at: '2026-11-10T10:00:00+00:00', updated_at: '2026-11-10T10:05:00+00:00',
    expires_at: new Date(Date.now() + 27 * 86400 * 1000 + 3600 * 1000).toISOString(),
    download_url: `/api/image/jobs/${jobId}/download`, media_url: `https://media.test/${jobId}.png`, thumb_url: `https://media.test/${jobId}-poster.jpg`, ...extra,
  });

  it('lists a result made on another device as ready, saved to the cloud, with its time left, and posts it', async () => {
    mocks.mine = { ...MINE, items: [row('job-far')] };
    mocks.post.mockResolvedValue({ meta: { title: 'beach' }, rel_path: 'uploads/b.png', media_url: '/m' });
    renderPage();
    const open = await screen.findByRole('button', { name: 'Open beach.png' });
    const tile = open.closest('li');
    expect(tile).toHaveClass('sx-ready');
    expect(within(tile).getByRole('img', { name: 'Saved to the cloud' })).toBeInTheDocument();
    expect(within(tile).getByRole('img', { name: '27 days left' })).toBeInTheDocument();
    expect(tile.querySelector('img')).toHaveAttribute('src', 'https://media.test/job-far-poster.jpg');
    fireEvent.click(open);
    expect(await screen.findByAltText('Rendered square result for beach.png')).toHaveAttribute('src', 'https://media.test/job-far.png');
    // No upload on this server to redo from.
    expect(screen.queryByRole('button', { name: 'Make square again' })).toBeNull();
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'image', title: 'beach', job_id: 'job-far' });
  });

  it('counts an upload down from 6 hours and marks a result that missed the cloud', async () => {
    mocks.mine = { ...MINE, items: [row('job-local', { kept: false, thumb_url: null, expires_at: new Date(Date.now() + 2 * 3600 * 1000 + 30000).toISOString() })] };
    renderPage();
    const unsaved = (await screen.findByRole('button', { name: 'Open beach.png' })).closest('li');
    expect(within(unsaved).getByRole('img', { name: 'Not saved to the cloud. Download it now.' })).toBeInTheDocument();
    expect(within(unsaved).getByRole('img', { name: '2 h 0 min left' })).toBeInTheDocument();
    await pick(['a.png', 'b.png']);
    const fresh = (await screen.findByRole('button', { name: 'Open a.png' })).closest('li');
    expect(within(fresh).getByRole('img', { name: /^5 h 59 min left|^6 h 0 min left/ })).toBeInTheDocument();
  });

  it('sorts the gallery by time added or by last action, and shows posted files without a countdown', async () => {
    mocks.mine = {
      ...MINE,
      items: [
        row('job-old', { filename: 'old.png', created_at: '2026-11-01T10:00:00+00:00', updated_at: '2026-11-12T10:00:00+00:00', post_id: 'post-1', kept: false }),
        row('job-new', { filename: 'new.png', created_at: '2026-11-05T10:00:00+00:00', updated_at: '2026-11-05T10:05:00+00:00' }),
      ],
    };
    renderPage();
    await screen.findByRole('button', { name: 'Open new.png' });
    fireEvent.click(screen.getByRole('tab', { name: 'Gallery' }));
    const names = () => within(screen.getByRole('list', { name: 'All media' })).getAllByRole('button', { name: /^Open / }).map((node) => node.getAttribute('aria-label'));
    expect(button('Sort by time added')).toHaveAttribute('aria-pressed', 'true');
    expect(names()).toEqual(['Open new.png', 'Open old.png']);
    fireEvent.click(button('Sort by last action'));
    expect(names()).toEqual(['Open old.png', 'Open new.png']);
    const posted = button('Open old.png').closest('li');
    expect(posted).toHaveClass('sx-posted');
    expect(within(posted).queryByRole('img', { name: /left$/ })).toBeNull();
    expect(within(posted).queryByRole('img', { name: /Not saved to the cloud/ })).toBeNull();
  });

  it('remembers an upload across a reload while the server still holds it, and drops it after', async () => {
    renderPage();
    await pick(['wide.png', 'tall.png']);
    await screen.findByRole('button', { name: 'Open wide.png' });
    cleanup();
    mocks.mine = { ...MINE, stages: [{ stage_id: 'st-wide.png', kind: 'image', filename: 'wide.png', staged_at: new Date().toISOString() }] };
    renderPage();
    expect(await screen.findByRole('button', { name: 'Open wide.png' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open tall.png' })).toBeNull());
  });
});

describe('UploadPage — 3D stereo posts', () => {
  it('auto-detects a side-by-side video and posts it as it is, in 3D', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'sbs' }, rel_path: 'uploads/sbs.mp4', media_url: '/m' });
    renderPage();
    await pick(['sbs.mp4']);
    expect(await screen.findByText('3D SIDE-BY-SIDE DETECTED')).toBeInTheDocument();
    expect(screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/)).toBeChecked();
    // Left eye on the stage, no outpaint bands, no options, no quote.
    expect(screen.getByText('LEFT EYE · 2D VIEW (1920×1920)')).toBeInTheDocument();
    expect(screen.getByText('EYE: 1920×1920 ×2')).toBeInTheDocument();
    expect(document.querySelectorAll('.sx-studio-zone')).toHaveLength(0);
    expect(screen.queryByRole('radiogroup', { name: 'Upscale Engine' })).toBeNull();
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'video', stage_id: 'st-sbs.mp4', stereo_layout: 'sbs' });
    expect(mocks.post.mock.calls[0][1].job_id).toBeUndefined();
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.estimate).not.toHaveBeenCalled();
  });

  it('labels a detected top-bottom image and sends its layout', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'tb' }, rel_path: 'uploads/tb.png', media_url: '/m' });
    renderPage();
    await pick(['tb.png']);
    expect(await screen.findByText('3D TOP-BOTTOM DETECTED')).toBeInTheDocument();
    expect(screen.getByText("Detected from the file's stereo metadata.")).toBeInTheDocument();
    expect(screen.getByLabelText(/STEREOSCOPIC 3D · TOP-BOTTOM/)).toBeChecked();
    expect(screen.getByAltText('tb.png (left eye)')).toHaveClass('sx-stereo-tb');
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'image', stereo_layout: 'tb' });
  });

  it('keeps an undetected 2:1 frame waiting to be made square until 3D is switched on', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'screen21' }, rel_path: 'uploads/s.mp4', media_url: '/m' });
    renderPage();
    await pick(['screen21.mp4']);
    expect(await screen.findByText('2:1 FRAME — IS THIS 3D SIDE-BY-SIDE?')).toBeInTheDocument();
    const toggle = () => screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/);
    expect(toggle()).not.toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'Upscale Engine' })).toBeInTheDocument();
    expect(button('Open screen21.mp4').closest('li')).toHaveClass('sx-needs');

    fireEvent.click(toggle());
    expect(toggle()).toBeChecked();
    expect(screen.queryByRole('radiogroup', { name: 'Upscale Engine' })).toBeNull();
    expect(button('Open screen21.mp4').closest('li')).toHaveClass('sx-ready');
    // Switching it back off returns to the options.
    fireEvent.click(toggle());
    expect(screen.getByRole('radiogroup', { name: 'Upscale Engine' })).toBeInTheDocument();
    fireEvent.click(toggle());
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ stage_id: 'st-screen21.mp4', stereo_layout: 'sbs' });
  });

  it('offers no 3D choice for ordinary aspect ratios', async () => {
    renderPage();
    await pick(['wide.png']);
    await screen.findByRole('radiogroup', { name: 'Upscale Engine' });
    expect(screen.queryByLabelText(/STEREOSCOPIC 3D/)).toBeNull();
  });

  it('posts 3D images together only when every image shares the layout', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'eyes1' }, rel_path: 'uploads/e.png', media_url: '/m' });
    renderPage();
    await pick(['eyes1.png', 'eyes2.png']);
    fireEvent.click(await screen.findByRole('button', { name: 'Post 2 as one' }));
    // Strip thumbnails show the left eye, not the seam between both eyes.
    expect(await screen.findByAltText('eyes2.png')).toHaveClass('sx-stereo-crop-sbs');
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({
      stage_id: 'st-eyes1.png', extra_stage_ids: ['st-eyes2.png'], stereo_layout: 'sbs',
    });
    cleanup();
    vi.stubGlobal('localStorage', memoryStorage());
    renderPage();
    await pick(['eyes1.png', 'a.png']);
    expect(await screen.findByRole('button', { name: 'Post 2 as one' })).toHaveAccessibleDescription('3D and flat images cannot share a post.');
  });
});

describe('UploadPage — MAKE 3D', () => {
  // POST /api/stereo/convert answers a job; publish answers a post.
  const answer = (convertJobId) => mocks.post.mockImplementation(async (path) => (
    path === '/api/stereo/convert'
      ? { job_id: convertJobId, status: 'queued', kind: 'image', payment_source: 'local' }
      : { meta: { title: 'square' }, rel_path: 'uploads/x.jpg', media_url: '/m' }
  ));
  const make3d = () => screen.getByRole('button', { name: 'Make 3D' });

  it('turns a square image into side-by-side 3D and posts that render', async () => {
    mocks.features = { stereo_convert: true };
    answer('job-3d-img');
    renderPage();
    await pick(['square.png']);
    await screen.findByText('ALREADY 1:1');
    fireEvent.click(make3d());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/stereo/convert', { kind: 'image', stage_id: 'st-square.png' }));
    // Running: nothing can be posted yet, and it cannot be started twice.
    await waitFor(() => expect(postButton()).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Make 3D' })).toBeNull();

    fireEvent.click(button('FINISH job-3d-img'));
    const left = await screen.findByAltText('3D result for square.png (left eye)');
    expect(left).toHaveAttribute('src', '/api/jobs/job-3d-img/download');
    expect(left).toHaveClass('sx-stereo-sbs');
    expect(radio('Stage view', '3D')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('3D SIDE-BY-SIDE · LEFT EYE')).toBeInTheDocument();
    expect(within(button('Open square.png').closest('li')).getByRole('img', { name: '3D' })).toBeInTheDocument();

    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    const [path, body] = mocks.post.mock.calls[1];
    expect(path).toBe('/api/uploads/publish');
    expect(body).toMatchObject({ kind: 'image', job_id: 'job-3d-img', stereo_layout: 'sbs' });
    expect(body.stage_id).toBeUndefined();
  });

  it('labels a 3D video result as H.264, not as an HEVC master', async () => {
    mocks.features = { stereo_convert: true };
    answer('job-3d-vid');
    renderPage();
    await pick(['square.mp4']);
    await screen.findByText('ALREADY 1:1');
    fireEvent.click(make3d());
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-3d-vid' }));
    expect(await screen.findByText('3D SIDE-BY-SIDE · LEFT EYE')).toBeInTheDocument();
    expect(screen.getByText('3D H.264')).toBeInTheDocument();
    expect(screen.queryByText(/HEVC MASTER/)).toBeNull();
  });

  it('makes a finished square result 3D and posts the 3D render', async () => {
    mocks.features = { stereo_convert: true };
    mocks.form.mockResolvedValue({ job_id: 'job-ext' });
    answer('job-3d-ext');
    renderPage();
    await pick(['wide.png']);
    fireEvent.click(await screen.findByRole('button', { name: /^Make square/ }));
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Make 3D' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-ext' }));
    expect(await screen.findByAltText('Rendered square result for wide.png')).toBeInTheDocument();

    fireEvent.click(make3d());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/stereo/convert', { kind: 'image', job_id: 'job-ext' }));
    await waitFor(() => expect(postButton()).toBeDisabled());
    fireEvent.click(button('FINISH job-3d-ext'));
    expect(await screen.findByAltText('3D result for wide.png (left eye)')).toHaveAttribute('src', '/api/jobs/job-3d-ext/download');

    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1]).toMatchObject({ kind: 'image', job_id: 'job-3d-ext', stereo_layout: 'sbs' });
  });

  it('shows why a start failed, and posts the flat file again once the 3D render is removed', async () => {
    mocks.features = { stereo_convert: true };
    answer('job-3d-img');
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('3D conversion is not installed on this server.'), { status: 503, code: 'STEREO_CONVERT_UNAVAILABLE' }));
    renderPage();
    await pick(['square.png']);
    await screen.findByText('ALREADY 1:1');
    fireEvent.click(make3d());
    expect(await screen.findByText('MAKE 3D is not available on this server right now.')).toBeInTheDocument();
    expect(make3d()).toBeEnabled();

    fireEvent.click(make3d());
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-3d-img' }));
    await screen.findByAltText('3D result for square.png (left eye)');
    expect(screen.queryByText('MAKE 3D is not available on this server right now.')).toBeNull();

    fireEvent.click(button('Remove 3D'));
    expect(screen.getByAltText('square.png')).toBeInTheDocument();
    expect(radio('Stage view', 'EXTENDED')).toBeDisabled();
    fireEvent.click(postButton());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(3));
    const body = mocks.post.mock.calls[2][1];
    expect(body).toMatchObject({ kind: 'image', stage_id: 'st-square.png' });
    expect(body.job_id).toBeUndefined();
    expect(body.stereo_layout).toBeUndefined();
  });

  it('is not offered when the server cannot convert', async () => {
    renderPage();
    await pick(['square.png']);
    await screen.findByText('ALREADY 1:1');
    expect(screen.queryByRole('button', { name: 'Make 3D' })).toBeNull();
  });
});

describe('UploadPage — depth version for VR', () => {
  // Each depth job is named after its source; a source named in failOn fails.
  let failOn;
  const answer = () => mocks.post.mockImplementation(async (path, body) => (
    path === '/api/stereo/convert'
      ? { job_id: `job-sp-${body.stage_id || body.job_id}${failOn === (body.stage_id || body.job_id) ? '-fail' : ''}`, status: 'queued' }
      : { meta: { title: 'x' }, rel_path: 'uploads/x.jpg', media_url: '/m' }
  ));
  const convertCalls = () => mocks.post.mock.calls.filter(([path]) => path === '/api/stereo/convert');
  const publishBody = () => mocks.post.mock.calls.find(([path]) => path === '/api/uploads/publish')?.[1];

  beforeEach(() => {
    failOn = null;
    mocks.features = { spatial_default: true, stereo_convert: true };
    answer();
  });

  it('makes the depth version on its own and publishes it beside the 2D file', async () => {
    renderPage();
    await pick(['square.png']);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/stereo/convert', { kind: 'image', depth_pack: true, stage_id: 'st-square.png' }));
    expect(screen.getByRole('checkbox', { name: 'Add depth for VR' })).toBeChecked();
    expect(postButton()).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-sp-st-square.png' }));
    await waitFor(() => expect(postButton()).toBeEnabled());
    fireEvent.click(postButton());
    await waitFor(() => expect(publishBody()).toMatchObject({ stage_id: 'st-square.png', spatial_job_ids: ['job-sp-st-square.png'] }));
  });

  it('publishes 2D only when the depth job fails', async () => {
    failOn = 'st-square.mp4';
    renderPage();
    await pick(['square.mp4']);
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-sp-st-square.mp4-fail' }));
    expect(await screen.findByText('DEPTH VERSION FAILED — THE POST IS 2D ONLY')).toBeInTheDocument();
    fireEvent.click(postButton());
    await waitFor(() => expect(publishBody()).toBeDefined());
    expect(publishBody().spatial_job_ids).toBeUndefined();
  });

  it('publishes 2D only when switched off', async () => {
    renderPage();
    await pick(['square.png']);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Add depth for VR' }));
    expect(postButton()).toBeEnabled();
    fireEvent.click(postButton());
    await waitFor(() => expect(publishBody()).toBeDefined());
    expect(publishBody().spatial_job_ids).toBeUndefined();
  });

  it('starts nothing for files that are only on the shelf', async () => {
    renderPage();
    await pick(['a.png', 'b.png']);
    await screen.findByRole('button', { name: 'Open a.png' });
    expect(convertCalls()).toHaveLength(0);
  });

  it('runs one slide at a time and keeps finished slides through a removal', async () => {
    renderPage();
    await pick(['a.png', 'b.png', 'c.png']);
    fireEvent.click(await screen.findByRole('button', { name: 'Post 3 as one' }));
    await waitFor(() => expect(convertCalls()).toHaveLength(1));
    expect(convertCalls()[0][1]).toEqual({ kind: 'image', depth_pack: true, stage_id: 'st-a.png' });
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-sp-st-a.png' }));
    await waitFor(() => expect(convertCalls()).toHaveLength(2));
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-sp-st-b.png' }));
    await waitFor(() => expect(convertCalls()).toHaveLength(3));
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-sp-st-c.png' }));
    fireEvent.click(button('Remove b.png'));
    await waitFor(() => expect(postButton()).toBeEnabled());
    fireEvent.click(postButton());
    await waitFor(() => expect(publishBody()).toBeDefined());
    expect(publishBody()).toMatchObject({ extra_stage_ids: ['st-c.png'], spatial_job_ids: ['job-sp-st-a.png', 'job-sp-st-c.png'] });
    expect(convertCalls()).toHaveLength(3);
  });

  it('waits for the square result and converts that result', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-ext' });
    renderPage();
    await pick(['wide.png']);
    fireEvent.click(await screen.findByRole('button', { name: /^Make square/ }));
    expect(convertCalls()).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-ext' }));
    await waitFor(() => expect(convertCalls()).toHaveLength(1));
    expect(convertCalls()[0][1]).toEqual({ kind: 'image', depth_pack: true, job_id: 'job-ext' });
  });

  it('is not made for as-is stereo posts', async () => {
    renderPage();
    await pick(['eyes1.png']);
    await screen.findByLabelText(/STEREOSCOPIC 3D/);
    expect(screen.queryByRole('checkbox', { name: 'Add depth for VR' })).toBeNull();
    expect(convertCalls()).toHaveLength(0);
  });
});
