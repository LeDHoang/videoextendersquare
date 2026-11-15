import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletProvider, useWallet } from './WalletContext.jsx';

vi.mock('../api/client.js', () => ({
  api: { get: vi.fn(async () => ({ available_credits: 5 })) },
}));

vi.mock('./AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'usr-1' } }),
}));

function Probe() {
  const { lastAward } = useWallet();
  return <div data-testid="award">{lastAward ? `${lastAward.amount}:${lastAward.jackpot}` : 'none'}</div>;
}

describe('WalletContext reel awards', () => {
  afterEach(() => cleanup());

  it('records the amount and jackpot tier from the reels player message', async () => {
    render(<WalletProvider><Probe /></WalletProvider>);
    expect(screen.getByTestId('award').textContent).toBe('none');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'echo:credits-awarded', credits_awarded_amount: 50, jackpot: 'mega' },
      }));
    });
    await waitFor(() => expect(screen.getByTestId('award').textContent).toBe('50:mega'));
  });

  it('ignores award messages from other origins', () => {
    render(<WalletProvider><Probe /></WalletProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: 'echo:credits-awarded', credits_awarded_amount: 50, jackpot: 'mega' },
      }));
    });
    expect(screen.getByTestId('award').textContent).toBe('none');
  });
});
