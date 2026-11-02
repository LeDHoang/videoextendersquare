import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './controls.jsx';

afterEach(cleanup);

describe('Button', () => {
  it('shows why it is blocked, stays focusable and ignores clicks', () => {
    const onClick = vi.fn();
    render(
      <form onSubmit={onClick}>
        <Button type="submit" disabled disabledReasons={['TITLE IS REQUIRED', false, 'RENDER FIRST']} onClick={onClick}>SHARE</Button>
      </form>,
    );
    const button = screen.getByRole('button', { name: 'SHARE' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleDescription('TITLE IS REQUIRED RENDER FIRST');
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(['⚠TITLE IS REQUIRED', '⚠RENDER FIRST']);
  });

  it('is plainly disabled with no reasons, and busy while loading', () => {
    const { rerender } = render(<Button disabled disabledReasons={[false]}>RENDER</Button>);
    const button = screen.getByRole('button', { name: 'RENDER' });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<Button loading disabled disabledReasons={['QUOTE PENDING']}>RENDER</Button>);
    // Same element: a reason appearing does not remount the button.
    expect(screen.getByRole('button', { name: /RENDER/ })).toBe(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('works normally when nothing blocks it', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>GO</Button>);
    const button = screen.getByRole('button', { name: 'GO' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('takes its look from variant and size', () => {
    render(
      <>
        <Button>BACK</Button>
        <Button variant="primary">SAVE</Button>
        <Button variant="danger" size="sm">DELETE</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'BACK' })).toHaveClass('sx-btn', { exact: true });
    expect(screen.getByRole('button', { name: 'SAVE' })).toHaveClass('sx-btn sx-primary', { exact: true });
    expect(screen.getByRole('button', { name: 'DELETE' })).toHaveClass('sx-btn sx-danger sx-btn--sm', { exact: true });
  });

  it('renders a link with the same look', () => {
    render(<MemoryRouter><Button as={Link} to="/explore">BACK TO EXPLORE</Button></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'BACK TO EXPLORE' });
    expect(link).toHaveAttribute('href', '/explore');
    expect(link).toHaveClass('sx-btn');
    expect(link).not.toHaveAttribute('type');
  });
});
