import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import TermsPage from './TermsPage.jsx';
import { LEGAL } from '../components/legal/LegalKit.jsx';

afterEach(cleanup);

const renderTerms = () => render(<MemoryRouter><TermsPage /></MemoryRouter>);

describe('TermsPage', () => {
  it('renders the title and every numbered section in order', () => {
    renderTerms();
    expect(screen.getByRole('heading', { level: 1, name: 'TERMS OF SERVICE' })).toBeInTheDocument();
    const numbers = screen.getAllByRole('heading', { level: 2 }).map((h) => parseInt(h.textContent, 10));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it('states the credit facts the billing code enforces', () => {
    renderTerms();
    expect(screen.getByText(/1 credit represents US\$0\.01/)).toBeInTheDocument();
    expect(screen.getByText(/US\$5 for 500 credits, US\$10 for 1,050 credits, and US\$25 for 2,750 credits/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`within ${LEGAL.refundDays} days of a purchase`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`at least ${LEGAL.minimumAge} years old`))).toBeInTheDocument();
  });

  it('says a deleted account\'s messages are hidden but kept for moderation', () => {
    renderTerms();
    expect(screen.getByText(/Messages you sent are hidden from the people you\s+talked with and kept for moderation and safety\./)).toBeInTheDocument();
  });

  it('links to the Privacy Policy it incorporates', () => {
    renderTerms();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
  });

  it('highlights unfilled legal values instead of rendering them as plain text', () => {
    renderTerms();
    const unfilled = Object.values(LEGAL).filter((v) => typeof v === 'string' && v.startsWith('['));
    for (const value of unfilled) {
      // Not every LEGAL value appears on this page (some are Privacy-only).
      for (const node of screen.queryAllByText(value)) expect(node.tagName).toBe('MARK');
    }
  });
});
