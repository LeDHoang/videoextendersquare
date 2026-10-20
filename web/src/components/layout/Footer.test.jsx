import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import Footer from './Footer.jsx';

afterEach(cleanup);

const renderFooter = () => render(<MemoryRouter><Footer /></MemoryRouter>);

describe('Footer', () => {
  it('is the page contentinfo landmark with the company line and current year', () => {
    renderFooter();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByText(`© ${new Date().getFullYear()} ECHO Inc.`, { exact: false })).toBeInTheDocument();
  });

  it('links home through the brand and to the Terms, Privacy Policy and Community rules (the top bar already carries the navigation)', () => {
    renderFooter();
    expect(screen.queryByRole('navigation')).toBeNull();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(links[0]).toHaveAttribute('href', '/reels');
    expect(screen.getByRole('link', { name: 'TERMS' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'PRIVACY' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'RULES' })).toHaveAttribute('href', '/rules');
  });
});
