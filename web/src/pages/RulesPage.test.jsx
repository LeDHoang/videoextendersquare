import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import RulesPage from './RulesPage.jsx';
import { LEGAL } from '../components/legal/LegalKit.jsx';

afterEach(cleanup);

const renderRules = () => render(<MemoryRouter><RulesPage /></MemoryRouter>);

describe('RulesPage', () => {
  it('renders the title and every numbered section in order', () => {
    renderRules();
    expect(screen.getByRole('heading', { level: 1, name: 'COMMUNITY RULES' })).toBeInTheDocument();
    const numbers = screen.getAllByRole('heading', { level: 2 }).map((h) => parseInt(h.textContent, 10));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it('lists every forbidden content category', () => {
    renderRules();
    for (const rule of [
      'Illegal content:',
      'Sexual content involving minors:',
      'Non-consensual content:',
      'Harassment:',
      'Copyright infringement:',
      'Spam:',
    ]) {
      expect(screen.getByText(rule)).toBeInTheDocument();
    }
  });

  it('explains moderation and how to appeal through the contact email', () => {
    renderRules();
    expect(screen.getByText(/we may remove it, limit features/)).toBeInTheDocument();
    const appeals = screen.getByRole('heading', { level: 2, name: /Appeals/ }).closest('section');
    expect(appeals).toHaveTextContent(LEGAL.contactEmail);
    expect(appeals).toHaveTextContent(LEGAL.copyrightEmail);
  });

  it('links to the Terms it summarises', () => {
    renderRules();
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
  });
});
