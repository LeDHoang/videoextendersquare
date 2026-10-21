import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SupportPage from './SupportPage.jsx';

const mocks = vi.hoisted(() => ({
  auth: { user: null },
  api: { post: vi.fn() },
}));

vi.mock('../api/client.js', () => ({ api: mocks.api }));
vi.mock('../hooks/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));

class FakeApiError extends Error {
  constructor(message, { code, field, status = 422 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = { code, message, field };
  }
}

const renderAt = (entry = '/support') => render(<MemoryRouter initialEntries={[entry]}><SupportPage /></MemoryRouter>);
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const send = () => fireEvent.click(screen.getByRole('button', { name: 'SEND REQUEST' }));

describe('SupportPage', () => {
  beforeEach(() => {
    mocks.auth.user = null;
    mocks.api.post.mockReset().mockResolvedValue({ id: 'req-123', status: 'open', report_id: null });
  });
  afterEach(cleanup);

  it('prefills the topic and link from the query string', () => {
    renderAt('/support?category=appeal&link=%2Fprofile%2Fsomeone');
    expect(screen.getByRole('heading', { level: 1, name: 'SUPPORT' })).toBeInTheDocument();
    expect(screen.getByLabelText('TOPIC')).toHaveValue('appeal');
    expect(screen.getByLabelText('LINK (OPTIONAL)')).toHaveValue('/profile/someone');
  });

  it('ignores an unknown category prefill', () => {
    renderAt('/support?category=nonsense');
    expect(screen.getByLabelText('TOPIC')).toHaveValue('other');
  });

  it('requires an email when signed out and does not submit without one', () => {
    renderAt('/support?category=appeal');
    type('DETAILS', 'Please review my suspension.');
    send();
    expect(mocks.api.post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('submits a signed-out appeal and shows the request id', async () => {
    renderAt('/support?category=appeal');
    type('EMAIL', 'me@example.com');
    type('SUBJECT', 'Suspended by mistake');
    type('DETAILS', 'Please review my suspension.');
    send();
    await waitFor(() => expect(screen.getByTestId('support-request-id')).toHaveTextContent('req-123'));
    expect(mocks.api.post).toHaveBeenCalledWith('/api/support', {
      category: 'appeal',
      email: 'me@example.com',
      subject: 'Suspended by mistake',
      body: 'Please review my suspension.',
      link: '',
      website: '',
    });
  });

  it('lets a signed-in user skip the email and report content by link', async () => {
    mocks.auth.user = { username: 'viewer' };
    renderAt('/support?category=report_content&link=%2Fpacks%2Fabc');
    expect(screen.getByLabelText('LINK TO THE CONTENT')).toHaveValue('/packs/abc');
    send();
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalled());
    const payload = mocks.api.post.mock.calls[0][1];
    expect(payload).toMatchObject({ category: 'report_content', link: '/packs/abc' });
    expect(payload).not.toHaveProperty('email');
  });

  it('shows a server field error next to the link', async () => {
    mocks.auth.user = { username: 'viewer' };
    mocks.api.post.mockRejectedValue(new FakeApiError('Paste a link to an existing post, Reel Pack or profile.', { field: 'link' }));
    renderAt('/support?category=report_content&link=%2Fpacks%2Fmissing');
    send();
    expect(await screen.findByText('Paste a link to an existing post, Reel Pack or profile.')).toBeInTheDocument();
  });

  it('keeps the honeypot field out of view and out of the tab order', () => {
    const { container } = renderAt();
    const trap = container.querySelector('.sx-support-trap');
    expect(trap).toHaveAttribute('aria-hidden', 'true');
    expect(trap.querySelector('input[name="website"]')).toHaveAttribute('tabindex', '-1');
  });
});
