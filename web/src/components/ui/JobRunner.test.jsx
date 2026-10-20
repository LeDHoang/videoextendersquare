import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JobRunner from './JobRunner.jsx';

const mocks = vi.hoisted(() => ({ apiPost: vi.fn(), sse: { job: null, error: null } }));

vi.mock('../../api/client.js', () => ({ api: { post: (...args) => mocks.apiPost(...args) } }));
vi.mock('../../hooks/useSSE.js', () => ({
  TERMINAL_STATUSES: new Set(['complete', 'failed', 'cancelled']),
  useSSE: () => mocks.sse,
}));

const running = { status: 'running', progress: 40, stage: 'outpaint' };
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

beforeEach(() => {
  mocks.apiPost.mockReset();
  mocks.sse = { job: running, error: null };
});
afterEach(cleanup);

describe('JobRunner cancel', () => {
  it('POSTs to the kind-specific cancel endpoint and shows the request was sent', async () => {
    mocks.apiPost.mockResolvedValue({ status: 'cancelling' });
    render(<JobRunner jobId="job/1" name="clip.mp4" kind="video" />);
    fireEvent.click(screen.getByRole('button', { name: /CANCEL JOB/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'CANCEL REQUESTED' })).toBeDisabled());
    expect(mocks.apiPost).toHaveBeenCalledWith('/api/video/jobs/job%2F1/cancel');
    expect(screen.getByText(/Stops before the next stage/)).toBeInTheDocument();
  });

  it('hides the button when the server has no cancel endpoint (404/405)', async () => {
    for (const status of [404, 405]) {
      mocks.apiPost.mockRejectedValueOnce(httpError(status));
      render(<JobRunner jobId="j" name="a.png" kind="image" />);
      fireEvent.click(screen.getByRole('button', { name: /CANCEL JOB/ }));
      await waitFor(() => expect(screen.queryByRole('button', { name: /CANCEL/ })).toBeNull());
      expect(mocks.apiPost).toHaveBeenLastCalledWith('/api/image/jobs/j/cancel');
      cleanup();
    }
  });

  it('explains a 409 for a job that already finished', async () => {
    mocks.apiPost.mockRejectedValue(httpError(409));
    render(<JobRunner jobId="j" name="a.png" kind="image" />);
    fireEvent.click(screen.getByRole('button', { name: /CANCEL JOB/ }));
    expect(await screen.findByText('This job already finished.')).toBeInTheDocument();
  });

  it('renders the cancelled terminal state and settles once', () => {
    const onSettled = vi.fn();
    mocks.sse = { job: { status: 'cancelled' }, error: null };
    const { rerender } = render(<JobRunner jobId="j" name="a.png" kind="image" onSettled={onSettled} />);
    expect(screen.getByText('CANCELLED')).toBeInTheDocument();
    expect(screen.getByText(/Any ECHO Credits reserved for it are released/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CANCEL/ })).toBeNull();
    rerender(<JobRunner jobId="j" name="a.png" kind="image" onSettled={onSettled} />);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ status: 'cancelled' });
  });
});
