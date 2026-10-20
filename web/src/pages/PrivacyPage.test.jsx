import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import PrivacyPage from './PrivacyPage.jsx';
import { LEGAL } from '../components/legal/LegalKit.jsx';

afterEach(cleanup);

const renderPrivacy = () => render(<MemoryRouter><PrivacyPage /></MemoryRouter>);

describe('PrivacyPage', () => {
  it('renders the title and every numbered section in order', () => {
    renderPrivacy();
    expect(screen.getByRole('heading', { level: 1, name: 'PRIVACY POLICY' })).toBeInTheDocument();
    const numbers = screen.getAllByRole('heading', { level: 2 }).map((h) => parseInt(h.textContent, 10));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it('states the retention and cookie facts the server enforces', () => {
    renderPrivacy();
    // SX_SESSION_DAYS default, anonymous viewer cookie max_age, rate-limit pruning (server/social/auth.py).
    expect(screen.getByText(/It lasts up to 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/It lasts 1 year/)).toBeInTheDocument();
    expect(screen.getByText('2 days.')).toBeInTheDocument();
    expect(screen.getByText(/we never receive or store them/)).toBeInTheDocument();
    expect(screen.getByText(/not end-to-end/)).toBeInTheDocument();
  });

  it('discloses that published originals keep their photo metadata', () => {
    renderPrivacy();
    expect(screen.getByText(/this metadata can be visible to people who download it/)).toBeInTheDocument();
  });

  it('links to the Terms and highlights unfilled legal values', () => {
    renderPrivacy();
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
    const unfilled = Object.values(LEGAL).filter((v) => typeof v === 'string' && v.startsWith('['));
    for (const value of unfilled) {
      for (const node of screen.queryAllByText(value)) expect(node.tagName).toBe('MARK');
    }
    expect(screen.getAllByText(LEGAL.privacyEmail).length).toBeGreaterThan(0);
  });
});
