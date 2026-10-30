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
// The SSE job tracker is replaced by a button that completes the job. MAKE 3D
// jobs (job-3d…) finish with a side-by-side result, as the server's do.
vi.mock('../components/ui/JobRunner.jsx', () => ({
  default: ({ jobId, onDone, onSettled }) => (
    <button
      type="button"
      onClick={() => {
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
  const input = view.container.querySelector('.sx-studio-drop input[type=file]') || view.container.querySelector('.sx-studio-replace input');
  fireEvent.change(input, { target: { files: names.map(fileOf) } });
}

const radio = (group, name) => within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });
const renderButton = () => screen.getByRole('button', { name: /RENDER .*4K SQUARE|RETRY QUOTE & RENDER/ });

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
  mocks.get.mockResolvedValue({ inputs: [] });
  mocks.refresh.mockResolvedValue(undefined);
  globalThis.URL.createObjectURL = vi.fn((file) => `blob:${file.name}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UploadPage studio — video extender parity', () => {
  it('maps a portrait clip onto the square stage with its outpaint bands', async () => {
    renderPage();
    await pick(['portrait.mp4']);
    expect(await screen.findByText('ORIGINAL CLIP (1080×1920)')).toBeInTheDocument();
    expect(screen.getByText('PAD: 420px [L/R]')).toBeInTheDocument();
    expect(screen.getAllByText('+420px OUTPAINT')).toHaveLength(2);
    // The stage stays uncluttered: no zone names, telemetry box or spec grid.
    expect(screen.queryByText(/GENERATIVE ZONE/)).toBeNull();
    expect(screen.queryByText(/BOUNDARIES/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Media Specifications' })).toBeNull();
    expect(screen.getByText('12.5s EXCEEDS THE 10s THRESHOLD')).toBeInTheDocument();
    expect(screen.getByText('1:1 REQUIRED — EXTEND TO CONTINUE')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Stage playback' })).toBeInTheDocument();
    expect(view.container.querySelectorAll('.sx-studio-zone')).toHaveLength(2);
  });

  it('sends every video setting exactly as the Video page would', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-v1' });
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('ORIGINAL CLIP (1080×1920)');

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

    fireEvent.click(radio('Upscale Engine', 'FAL AI'));
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
      bytedanceTargetRes: '4k',
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
    await screen.findByText('ORIGINAL CLIP (1080×1920)');
    fireEvent.click(radio('Upscale Engine', 'FAL AI'));
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
    await screen.findByText('ORIGINAL CLIP (1080×1920)');
    expect(screen.getByLabelText('CAS Sharpening level')).toBeInTheDocument();
    fireEvent.click(radio('Upscale Engine', 'STUDIO'));
    expect(screen.getByText('STUDIO ENGINE UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('STUDIO ENGINE NOT INSTALLED — PLEASE SWITCH TO FAST OR FAL AI')).toBeInTheDocument();
    expect(screen.queryByLabelText('CAS Sharpening level')).toBeNull();
    expect(renderButton()).toBeDisabled();
  });

  it('gates STUDIO when the ffms2 source plugin does not load', async () => {
    mocks.probes = { ...ALL_PROBES, ffms2: { ok: false } };
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('ORIGINAL CLIP (1080×1920)');
    fireEvent.click(radio('Upscale Engine', 'STUDIO'));
    expect(screen.getByText('STUDIO ENGINE UNAVAILABLE')).toBeInTheDocument();
    expect(renderButton()).toBeDisabled();
  });

  it('disables CAS with a reason when the filter probe fails', async () => {
    mocks.probes = { ...ALL_PROBES, cas: { ok: false } };
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('ORIGINAL CLIP (1080×1920)');
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
    await screen.findByText('ORIGINAL CLIP (1080×1920)');
    fireEvent.click(radio('Upscale Engine', 'FAL AI'));
    expect(radio('FAL Upscale Model', /CUSTOM \(my-upscaler\)/)).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(radio('Cloud payment source', 'MY FAL KEY')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('THE SELECTED CUSTOM / NON-DETERMINISTIC MODEL REQUIRES MY FAL KEY')).toBeInTheDocument();
  });
});

describe('UploadPage studio — image extender parity', () => {
  it('offers only the image engines and switches to MY FAL KEY for non-credit models, then back', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-i1' });
    renderPage();
    await pick(['wide.png']);
    expect(await screen.findByText('ORIGINAL IMAGE (1600×900)')).toBeInTheDocument();
    expect(screen.getByText('PAD: 350px [T/B]')).toBeInTheDocument();
    const engines = within(screen.getByRole('radiogroup', { name: 'Upscale Engine' })).getAllByRole('radio').map((node) => node.textContent);
    expect(engines).toEqual(['FAST', 'FAL AI']);
    fireEvent.click(radio('Upscale Engine', 'FAL AI'));
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

    fireEvent.click(radio('FAL Model', /Clarity Upscaler/));
    await waitFor(() => expect(radio('Cloud payment source', 'ECHO CREDITS')).toHaveAttribute('aria-checked', 'true'));
  });

  it('keeps UPSCALE ONLY + FAST local and flags the stretch to 1:1', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-i2' });
    renderPage();
    await pick(['wide.png']);
    await screen.findByText('ORIGINAL IMAGE (1600×900)');
    fireEvent.click(radio('Pipeline Mode', 'UPSCALE ONLY'));
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
    await screen.findByText('ORIGINAL IMAGE (1600×900)');
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
    await screen.findByText('ORIGINAL CLIP (1080×1920)');
    fireEvent.change(screen.getByLabelText('OUTPAINT EXTENSION PROMPT'), { target: { value: 'video prompt' } });
    fireEvent.click(radio('Upscale Engine', 'STUDIO'));
    await pick(['wide.png']);
    await screen.findByText('ORIGINAL IMAGE (1600×900)');
    expect(screen.getByLabelText('OUTPAINT EXTENSION PROMPT')).toHaveValue(IMG_PROMPT_DEFAULT);
    expect(radio('Upscale Engine', 'FAST')).toHaveAttribute('aria-checked', 'true');
    await pick(['portrait.mp4']);
    await screen.findByText('ORIGINAL CLIP (1080×1920)');
    expect(screen.getByLabelText('OUTPAINT EXTENSION PROMPT')).toHaveValue('video prompt');
    expect(radio('Upscale Engine', 'STUDIO')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('UploadPage studio — post flows', () => {
  it('shares an already-square image directly', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'square' }, rel_path: 'uploads/square.png', media_url: '/media/uploads/square.png' });
    renderPage();
    await pick(['square.png']);
    expect(await screen.findByText('ALREADY 1:1')).toBeInTheDocument();
    expect(radio('Publish path', 'SHARE DIRECTLY')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('CORE ENGINE & PROMPT')).toBeNull();
    expect(screen.getByLabelText(/^TITLE/)).toHaveValue('square');
    fireEvent.click(screen.getByRole('button', { name: 'SHARE REEL TO UPLOADS' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [path, body] = mocks.post.mock.calls[0];
    expect(path).toBe('/api/uploads/publish');
    expect(body).toMatchObject({ kind: 'image', title: 'square', stage_id: 'st-square.png' });
    expect(body.job_id).toBeUndefined();
    expect(await screen.findByText('✓ SHARED — LIVE IN EXPLORE + REELS')).toBeInTheDocument();
  });

  it('extends a square image anyway, shows the result on the stage, then shares the render', async () => {
    mocks.form.mockResolvedValue({ job_id: 'job-sq' });
    mocks.post.mockResolvedValue({ meta: { title: 'square' }, rel_path: 'uploads/x.png', media_url: '/m' });
    renderPage();
    await pick(['square.png']);
    await screen.findByText('ALREADY 1:1');
    fireEvent.click(radio('Publish path', 'EXTEND ANYWAY'));
    expect(screen.getByText('RENDER THE 1:1 EXTEND FIRST')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'SHARE REEL TO UPLOADS' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'image', job_id: 'job-sq' });
    expect(mocks.post.mock.calls[0][1].stage_id).toBeUndefined();
  });

  it('builds a slideshow post: reorder, remove, publish the remaining order', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'a' }, rel_path: 'uploads/c.png', media_url: '/m' });
    renderPage();
    await pick(['a.png', 'b.png', 'c.png']);
    const strip = await screen.findByRole('list', { name: 'Images in post order' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('MULTI-IMAGE POST — PUBLISHED AS-IS')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move b.png later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(within(strip).getAllByRole('img').map((node) => node.getAttribute('alt'))).toEqual(['c.png', 'b.png']);
    fireEvent.click(screen.getByRole('button', { name: 'View b.png' }));
    expect(screen.getByRole('button', { name: 'View b.png' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'SHARE REEL TO UPLOADS' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'image', stage_id: 'st-c.png', extra_stage_ids: ['st-b.png'] });
  });

  it('refuses mixed or oversized picks and keeps the staged source', async () => {
    renderPage();
    await pick(['portrait.mp4']);
    await screen.findByText('ORIGINAL CLIP (1080×1920)');
    await pick(['a.png', 'portrait.mp4']);
    expect(await screen.findByText(/Use BATCH EXTEND to render several videos/)).toBeInTheDocument();
    await pick(Array.from({ length: 11 }, (_, i) => `img-${i}.png`));
    expect(await screen.findByText('An image post holds at most 10 images (you picked 11).')).toBeInTheDocument();
    await pick(['notes.txt']);
    expect(await screen.findByText(/Unsupported file type: notes\.txt/)).toBeInTheDocument();
    expect(screen.getByText('ORIGINAL CLIP (1080×1920)')).toBeInTheDocument();
  });
});

describe('UploadPage studio — batch extend', () => {
  it('renders every file with one configuration, continues past a failed submit, and never publishes', async () => {
    mocks.form
      .mockRejectedValueOnce(Object.assign(new Error('Stage expired for portrait'), { status: 400 }))
      .mockResolvedValueOnce({ job_id: 'job-b2' });
    renderPage();
    fireEvent.click(radio('Studio mode', 'BATCH EXTEND'));
    await pick(['square.png', 'portrait.mp4']);
    expect(await screen.findByText(/A batch is all videos or all images/)).toBeInTheDocument();
    await pick(['portrait.mp4', 'square.mp4']);
    const queue = await screen.findByRole('list', { name: 'Batch queue' });
    expect(within(queue).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('POST DETAILS')).toBeNull();
    expect(screen.queryByRole('button', { name: 'SHARE REEL TO UPLOADS' })).toBeNull();

    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(2));
    const first = formObject(mocks.form.mock.calls[0][1]);
    const second = formObject(mocks.form.mock.calls[1][1]);
    expect(mocks.form.mock.calls.map(([path]) => path)).toEqual(['/api/video/process', '/api/video/process']);
    expect(first).toMatchObject({ stage_id: 'st-portrait.mp4', payment_source: 'credits', quote_id: 'q-st-portrait.mp4' });
    // The square clip needs no cloud outpaint with the FAST engine.
    expect(second.stage_id).toBe('st-square.mp4');
    expect(second.payment_source).toBeUndefined();
    expect(await screen.findByText('Stage expired for portrait')).toBeInTheDocument();
    expect(within(queue).getByText('FAILED')).toBeInTheDocument();
    expect(within(queue).getByText('RENDERING')).toBeInTheDocument();
    expect(screen.getByText('/api/video/jobs/job-b2/result')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'FINISH job-b2' }));
    expect(await within(queue).findByText('✓ DONE')).toBeInTheDocument();
    expect(within(queue).getByRole('link', { name: 'Download 4K master of square.mp4' })).toHaveAttribute('href', '/api/jobs/job-b2/download');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('locks the other mode while a batch is rendering', async () => {
    mocks.form.mockResolvedValueOnce({ job_id: 'job-b3' }).mockResolvedValueOnce({ job_id: 'job-b4' });
    renderPage();
    fireEvent.click(radio('Studio mode', 'BATCH EXTEND'));
    await pick(['a.png', 'b.png']);
    await screen.findByRole('list', { name: 'Batch queue' });
    expect(renderButton()).toHaveTextContent('RENDER 2 IMAGE(S) 4K SQUARE');
    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(2));
    expect(radio('Studio mode', 'POST')).toBeDisabled();
    expect(screen.queryByText('REPLACE BATCH')).toBeNull();
  });
});

describe('UploadPage studio — 3D stereo posts', () => {
  it('auto-detects a side-by-side video and shares it as-is as 3D', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'sbs' }, rel_path: 'uploads/sbs.mp4', media_url: '/m' });
    renderPage();
    await pick(['sbs.mp4']);
    expect(await screen.findByText('3D SIDE-BY-SIDE DETECTED')).toBeInTheDocument();
    const toggle = screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/);
    expect(toggle).toBeChecked();
    // Left eye on the stage, no outpaint bands, no extender settings, no quote.
    expect(screen.getByText('LEFT EYE · 2D VIEW (1920×1920)')).toBeInTheDocument();
    expect(screen.getByText('EYE: 1920×1920 ×2')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.sx-studio-zone')).toHaveLength(0);
    expect(screen.queryByText('1:1 REQUIRED — EXTEND TO CONTINUE')).toBeNull();
    expect(screen.queryByText('CORE ENGINE & PROMPT')).toBeNull();
    expect(screen.getByText('3D SIDE-BY-SIDE · AS-IS · NO EXTEND')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'SHARE REEL TO UPLOADS' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'SHARE REEL TO UPLOADS' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ kind: 'image', stereo_layout: 'tb' });
  });

  it('keeps an undetected 2:1 frame on the extend path until 3D is switched on', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'screen21' }, rel_path: 'uploads/s.mp4', media_url: '/m' });
    renderPage();
    await pick(['screen21.mp4']);
    expect(await screen.findByText('2:1 FRAME — IS THIS 3D SIDE-BY-SIDE?')).toBeInTheDocument();
    const toggle = screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/);
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('1:1 REQUIRED — EXTEND TO CONTINUE')).toBeInTheDocument();
    expect(screen.getByText('CORE ENGINE & PROMPT')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/)).toBeChecked();
    expect(screen.queryByText('CORE ENGINE & PROMPT')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'SHARE REEL TO UPLOADS' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ stage_id: 'st-screen21.mp4', stereo_layout: 'sbs' });

    // Switching it back off returns to the extender.
    fireEvent.click(screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/));
    expect(screen.getByText('CORE ENGINE & PROMPT')).toBeInTheDocument();
  });

  it('offers no 3D choice for ordinary aspect ratios', async () => {
    renderPage();
    await pick(['wide.png']);
    await screen.findByText('1:1 REQUIRED — EXTEND TO CONTINUE');
    expect(screen.queryByLabelText(/STEREOSCOPIC 3D/)).toBeNull();
  });

  it('publishes a 3D slideshow only when every image shares the layout', async () => {
    mocks.post.mockResolvedValue({ meta: { title: 'eyes1' }, rel_path: 'uploads/e.png', media_url: '/m' });
    renderPage();
    await pick(['eyes1.png', 'eyes2.png']);
    expect(await screen.findByText('3D SIDE-BY-SIDE DETECTED')).toBeInTheDocument();
    // Strip thumbnails show the left eye, not the seam between both eyes.
    expect(screen.getByAltText('eyes2.png')).toHaveClass('sx-stereo-crop-sbs');
    fireEvent.click(screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/));
    expect(screen.getByAltText('eyes2.png')).not.toHaveClass('sx-stereo-crop-sbs');
    fireEvent.click(screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/));
    fireEvent.click(screen.getByRole('button', { name: 'SHARE REEL TO UPLOADS' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toMatchObject({
      stage_id: 'st-eyes1.png', extra_stage_ids: ['st-eyes2.png'], stereo_layout: 'sbs',
    });
    cleanup();
    vi.clearAllMocks();
    mocks.upload.mockImplementation(async (_path, file) => ({ ...META[file.name] }));
    renderPage();
    await pick(['eyes1.png', 'a.png']);
    await screen.findByText('MULTI-IMAGE POST — PUBLISHED AS-IS');
    expect(screen.queryByLabelText(/STEREOSCOPIC 3D/)).toBeNull();
  });

  it('does not carry a 3D choice across slideshow edits', async () => {
    renderPage();
    // Mixed set: no 3D switch. Removing the mono image leaves one detected
    // SBS file, which starts from its own detection.
    await pick(['eyes1.png', 'a.png']);
    await screen.findByText('MULTI-IMAGE POST — PUBLISHED AS-IS');
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(await screen.findByText('3D SIDE-BY-SIDE DETECTED')).toBeInTheDocument();
    expect(screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/)).toBeChecked();
    cleanup();
    vi.clearAllMocks();
    mocks.upload.mockImplementation(async (_path, file) => ({ ...META[file.name] }));
    // The user turned 3D off for the set: it stays off after a removal.
    renderPage();
    await pick(['eyes1.png', 'eyes2.png']);
    fireEvent.click(await screen.findByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/));
    expect(screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/)).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Remove eyes2.png' }));
    await waitFor(() => expect(screen.queryByAltText('eyes2.png')).toBeNull());
    expect(screen.getByLabelText(/STEREOSCOPIC 3D · SIDE-BY-SIDE/)).not.toBeChecked();
  });
});

describe('UploadPage studio — MAKE 3D', () => {
  // POST /api/stereo/convert answers a job; publish answers a post.
  const answer = (convertJobId) => mocks.post.mockImplementation(async (path) => (
    path === '/api/stereo/convert'
      ? { job_id: convertJobId, status: 'queued', kind: 'image', payment_source: 'local' }
      : { meta: { title: 'square' }, rel_path: 'uploads/x.jpg', media_url: '/m' }
  ));
  const make3d = () => screen.getByRole('button', { name: '▶ MAKE 3D' });
  const share = () => screen.getByRole('button', { name: 'SHARE REEL TO UPLOADS' });

  it('turns a square image into side-by-side 3D and shares that render', async () => {
    mocks.features = { stereo_convert: true };
    answer('job-3d-img');
    renderPage();
    await pick(['square.png']);
    await screen.findByText('ALREADY 1:1');
    expect(screen.queryByRole('button', { name: '▶ MAKE 3D' })).toBeNull();
    fireEvent.click(radio('Publish path', 'MAKE 3D'));
    expect(screen.getByText('MAKE 3D FIRST')).toBeInTheDocument();
    expect(screen.getByText('3D SIDE-BY-SIDE · MAKE 3D')).toBeInTheDocument();
    expect(screen.queryByText('CORE ENGINE & PROMPT')).toBeNull();
    expect(share()).toBeDisabled();

    fireEvent.click(make3d());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/stereo/convert', { kind: 'image', stage_id: 'st-square.png' }));
    // Running: the path is locked and nothing can be shared yet.
    expect(radio('Publish path', 'SHARE DIRECTLY')).toBeDisabled();
    expect(share()).toBeDisabled();
    expect(screen.queryByRole('button', { name: '▶ MAKE 3D' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'FINISH job-3d-img' }));
    const left = await screen.findByAltText('3D result for square.png (left eye)');
    expect(left).toHaveAttribute('src', '/api/jobs/job-3d-img/download');
    expect(left).toHaveClass('sx-stereo-sbs');
    expect(radio('Stage view', '3D')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('3D SIDE-BY-SIDE · LEFT EYE')).toBeInTheDocument();
    expect(screen.queryByText('MAKE 3D FIRST')).toBeNull();

    fireEvent.click(share());
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
    fireEvent.click(radio('Publish path', 'MAKE 3D'));
    fireEvent.click(make3d());
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-3d-vid' }));
    expect(await screen.findByText('3D SIDE-BY-SIDE · LEFT EYE')).toBeInTheDocument();
    expect(screen.getByText('3D H.264')).toBeInTheDocument();
    expect(screen.queryByText(/HEVC MASTER/)).toBeNull();
  });

  it('makes a finished extend render 3D and shares the 3D render', async () => {
    mocks.features = { stereo_convert: true };
    mocks.form.mockResolvedValue({ job_id: 'job-ext' });
    answer('job-3d-ext');
    renderPage();
    await pick(['square.png']);
    await screen.findByText('ALREADY 1:1');
    fireEvent.click(radio('Publish path', 'EXTEND ANYWAY'));
    fireEvent.click(renderButton());
    await waitFor(() => expect(mocks.form).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: '▶ MAKE 3D' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-ext' }));
    expect(await screen.findByAltText('Rendered square result for square.png')).toBeInTheDocument();

    fireEvent.click(make3d());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/stereo/convert', { kind: 'image', job_id: 'job-ext' }));
    expect(share()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'FINISH job-3d-ext' }));
    expect(await screen.findByAltText('3D result for square.png (left eye)')).toHaveAttribute('src', '/api/jobs/job-3d-ext/download');

    fireEvent.click(share());
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1]).toMatchObject({ kind: 'image', job_id: 'job-3d-ext', stereo_layout: 'sbs' });
  });

  it('shows why a start failed, and drops the 3D render when the path changes', async () => {
    mocks.features = { stereo_convert: true };
    answer('job-3d-img');
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('3D conversion is not installed on this server.'), { status: 503, code: 'STEREO_CONVERT_UNAVAILABLE' }));
    renderPage();
    await pick(['square.png']);
    await screen.findByText('ALREADY 1:1');
    fireEvent.click(radio('Publish path', 'MAKE 3D'));
    fireEvent.click(make3d());
    expect(await screen.findByText('MAKE 3D is not available on this server right now.')).toBeInTheDocument();
    expect(make3d()).toBeEnabled();
    expect(share()).toBeDisabled();

    fireEvent.click(make3d());
    fireEvent.click(await screen.findByRole('button', { name: 'FINISH job-3d-img' }));
    await screen.findByAltText('3D result for square.png (left eye)');
    expect(screen.queryByText('MAKE 3D is not available on this server right now.')).toBeNull();

    fireEvent.click(radio('Publish path', 'SHARE DIRECTLY'));
    expect(screen.getByAltText('square.png')).toBeInTheDocument();
    expect(radio('Stage view', 'EXTENDED')).toBeDisabled();
    fireEvent.click(share());
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
    expect(within(screen.getByRole('radiogroup', { name: 'Publish path' })).queryByRole('radio', { name: 'MAKE 3D' })).toBeNull();
  });
});
