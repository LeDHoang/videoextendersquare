import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, NavLink } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IconButton from './IconButton.jsx';

afterEach(cleanup);

describe('IconButton', () => {
  it('is a type="button" named by its label, which is also the tooltip', () => {
    const onClick = vi.fn();
    render(<IconButton label="Open Search" onClick={onClick}><svg aria-hidden="true" /></IconButton>);
    const button = screen.getByRole('button', { name: 'Open Search' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('title', 'Open Search');
    expect(button).toHaveClass('sx-icon-button', 'sx-icon-button--outline');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate title, the variant and extra classes', () => {
    render(<IconButton label="Close" title="Close dialog" variant="plain" className="sx-x" data-dialog-close>×</IconButton>);
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button).toHaveAttribute('title', 'Close dialog');
    expect(button).toHaveClass('sx-icon-button--plain', 'sx-x');
    expect(button).toHaveAttribute('data-dialog-close');
  });

  it('renders a link with the same look through `as`', () => {
    render(
      <MemoryRouter initialEntries={['/upload']}>
        <IconButton as={NavLink} to="/upload" variant="primary" label="Upload"><svg aria-hidden="true" /></IconButton>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Upload' });
    expect(link).toHaveAttribute('href', '/upload');
    expect(link).not.toHaveAttribute('type');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveClass('sx-icon-button', 'sx-icon-button--primary');
  });
});
