import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CustomModelPanel from './CustomModelPanel.jsx';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('../../api/client.js', () => ({ api: { get: (...args) => mocks.apiGet(...args) } }));

afterEach(cleanup);

it("drops the previous model's info when the next lookup fails", async () => {
  mocks.apiGet.mockResolvedValueOnce({ found: true, display_name: 'First Model', pricing: '$0.10 per second', inputs: [] });
  const { rerender } = render(<CustomModelPanel model="fal-ai/first" />);
  await screen.findByText(/First Model/);

  mocks.apiGet.mockRejectedValueOnce(new Error('HTTP 429'));
  rerender(<CustomModelPanel model="fal-ai/second" />);
  await screen.findByText(/HTTP 429/);
  await waitFor(() => expect(screen.queryByText(/First Model/)).toBeNull());
  expect(screen.queryByText(/\$0\.10 per second/)).toBeNull();
});
