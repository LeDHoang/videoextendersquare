import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Boom() {
  throw new Error('status.toUpperCase is not a function');
}

describe('ErrorBoundary', () => {
  it('shows a plain message and a reload button instead of the raw error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('SOMETHING WENT WRONG');
    expect(screen.getByRole('button', { name: 'RELOAD PAGE' })).toBeInTheDocument();
    expect(screen.queryByText(/toUpperCase/)).not.toBeInTheDocument();
  });
});
