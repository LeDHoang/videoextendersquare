import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreditQuotes } from './useCreditQuotes.js';

const mocks = vi.hoisted(() => ({
  quote: vi.fn(),
  estimate: vi.fn(),
  catalog: { credits_enabled: false },
}));

vi.mock('./WalletContext.jsx', () => ({
  useWallet: () => ({ quote: mocks.quote, estimate: mocks.estimate, catalog: mocks.catalog }),
}));

const ITEMS = [{ stage_id: 'st-1' }];
const BASE = { prompt: 'a', sharpening: 0.5, upscale_engine: 'fal', upscale_model: 'fal-ai/seedvr/upscale/video' };

async function settle(ms = 300) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('useCreditQuotes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.catalog = { credits_enabled: false };
    mocks.estimate.mockImplementation(async (_kind, stageId) => ({ stage_id: stageId, quote_id: null, credits: 4, provider_cost_usd: '0.03' }));
    mocks.quote.mockImplementation(async (_kind, stageId) => ({ stage_id: stageId, quote_id: `q-${stageId}`, credits: 4, provider_cost_usd: '0.03' }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('estimates while credits are disabled and quotes once they are enabled', async () => {
    const { result, rerender } = renderHook((props) => useCreditQuotes(props), {
      initialProps: { kind: 'video', items: ITEMS, parameters: BASE, enabled: true },
    });
    await settle();
    expect(mocks.estimate).toHaveBeenCalledTimes(1);
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(result.current.estimate).toBe(true);
    expect(result.current.totalCredits).toBe(4);

    mocks.catalog = { credits_enabled: true };
    rerender({ kind: 'video', items: ITEMS, parameters: { ...BASE }, enabled: true });
    await settle();
    expect(mocks.quote).toHaveBeenCalledTimes(1);
    expect(result.current.estimate).toBe(false);
  });

  it('does not re-price for price-neutral edits but does for priced ones, always sending the latest parameters', async () => {
    const { result, rerender } = renderHook((props) => useCreditQuotes(props), {
      initialProps: { kind: 'video', items: ITEMS, parameters: BASE, enabled: true },
    });
    await settle();
    expect(mocks.estimate).toHaveBeenCalledTimes(1);

    // Callers rebuild the item list on every change: same ids must not re-price.
    rerender({ kind: 'video', items: [{ stage_id: 'st-1' }], parameters: { ...BASE, prompt: 'ab', sharpening: 0.7, ltx_guidance: 4 }, enabled: true });
    await settle();
    expect(mocks.estimate).toHaveBeenCalledTimes(1);

    const priced = { ...BASE, prompt: 'abc', seedvr_target: '2160p' };
    rerender({ kind: 'video', items: ITEMS, parameters: priced, enabled: true });
    await settle();
    expect(mocks.estimate).toHaveBeenCalledTimes(2);
    expect(mocks.estimate.mock.calls[1][2]).toEqual(priced);

    // An explicit refresh (render submit) uses the newest parameters too.
    const typed = { ...priced, prompt: 'abcd' };
    rerender({ kind: 'video', items: ITEMS, parameters: typed, enabled: true });
    await act(async () => { await result.current.refresh(); });
    expect(mocks.estimate.mock.calls.at(-1)[2]).toEqual(typed);
  });

  it('retries by itself after a rate limit', async () => {
    mocks.estimate.mockRejectedValueOnce(Object.assign(new Error('slow down'), { status: 429 }));
    const { result } = renderHook((props) => useCreditQuotes(props), {
      initialProps: { kind: 'video', items: ITEMS, parameters: BASE, enabled: true },
    });
    await settle();
    expect(result.current.error).toMatch(/Too many requests/);
    expect(result.current.quotes).toEqual([]);

    await settle(5000);
    expect(mocks.estimate).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('');
    expect(result.current.totalCredits).toBe(4);
  });

  it('flags approximate estimates', async () => {
    mocks.estimate.mockResolvedValueOnce({ stage_id: 'st-1', quote_id: null, credits: 9, provider_cost_usd: '0.06', approximate: true });
    const { result } = renderHook((props) => useCreditQuotes(props), {
      initialProps: { kind: 'video', items: ITEMS, parameters: BASE, enabled: true },
    });
    await settle();
    expect(result.current.approximate).toBe(true);
  });
});
