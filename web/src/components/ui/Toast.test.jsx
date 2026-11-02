import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_MS, ToastProvider, useToast } from './Toast.jsx';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Sender() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast('Link copied.')}>COPY</button>
      <button type="button" onClick={() => toast('Report submitted.')}>REPORT</button>
    </>
  );
}

describe('Toast', () => {
  it('announces each message in a live region that is always there, then leaves', () => {
    const { container } = render(<ToastProvider><Sender /></ToastProvider>);
    const region = container.querySelector('.sx-toasts');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'COPY' }));
    expect(screen.getByRole('status')).toHaveTextContent('Link copied.');
    expect(region).toContainElement(screen.getByRole('status'));

    act(() => vi.advanceTimersByTime(TOAST_MS));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('replaces the last message and restarts the timeout', () => {
    render(<ToastProvider><Sender /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'COPY' }));
    act(() => vi.advanceTimersByTime(TOAST_MS - 1000));
    fireEvent.click(screen.getByRole('button', { name: 'REPORT' }));
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(['Report submitted.']);
    act(() => vi.advanceTimersByTime(TOAST_MS - 1));
    expect(screen.getByRole('status')).toHaveTextContent('Report submitted.');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does nothing outside a provider', () => {
    render(<Sender />);
    fireEvent.click(screen.getByRole('button', { name: 'COPY' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
