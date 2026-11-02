import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Pills, Segmented, Tabs } from './controls.jsx';

afterEach(cleanup);

function Group({ kind, initial }) {
  const [value, setValue] = useState(initial);
  if (kind === 'tabs') {
    const tabs = ['POSTS', 'PACKS', 'SAVED'].map((label) => ({ value: label.toLowerCase(), label }));
    return <Tabs tabs={tabs} value={value} onChange={setValue} ariaLabel="Profile sections" />;
  }
  if (kind === 'pills') {
    const options = ['ALL', 'H264', 'HEVC'].map((label) => ({ value: label.toLowerCase(), label }));
    return <Pills options={options} value={value} onChange={setValue} ariaLabel="Format" />;
  }
  return <Segmented options={['DAY', 'WEEK', 'MONTH']} disabledOptions={['WEEK']} value={value} onChange={setValue} ariaLabel="Range" />;
}

const tabStops = (role) => screen.getAllByRole(role).filter((item) => item.tabIndex === 0);

describe('roving focus', () => {
  it('lets Tab reach only the selected tab, and arrows, Home and End select', () => {
    render(<Group kind="tabs" initial="packs" />);
    const [posts, packs, saved] = screen.getAllByRole('tab');
    expect(tabStops('tab')).toEqual([packs]);
    expect(packs).toHaveAttribute('aria-selected', 'true');

    packs.focus();
    fireEvent.keyDown(packs, { key: 'ArrowRight' });
    expect(saved).toHaveFocus();
    expect(saved).toHaveAttribute('aria-selected', 'true');
    expect(tabStops('tab')).toEqual([saved]);

    fireEvent.keyDown(saved, { key: 'ArrowRight' });
    expect(posts).toHaveFocus();
    fireEvent.keyDown(posts, { key: 'End' });
    expect(saved).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(saved, { key: 'Home' });
    expect(posts).toHaveAttribute('aria-selected', 'true');
  });

  it('moves through chips the same way, and ignores other keys', () => {
    render(<Group kind="pills" initial="all" />);
    const [all, h264] = screen.getAllByRole('radio');
    expect(tabStops('radio')).toEqual([all]);
    all.focus();
    fireEvent.keyDown(all, { key: 'Enter' });
    expect(all).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(all, { key: 'ArrowDown' });
    expect(h264).toHaveFocus();
    expect(h264).toHaveAttribute('aria-checked', 'true');
  });

  it('skips disabled options', () => {
    render(<Group kind="segmented" initial="DAY" />);
    const [day, , month] = screen.getAllByRole('radio');
    day.focus();
    fireEvent.keyDown(day, { key: 'ArrowRight' });
    expect(month).toHaveFocus();
    expect(month).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(month, { key: 'ArrowLeft' });
    expect(day).toHaveFocus();
  });

  it('puts the tab stop on the first enabled option when none is selected', () => {
    render(<Segmented options={['A', 'B']} disabledOptions={['A']} value="" onChange={() => {}} ariaLabel="Pick" />);
    expect(tabStops('radio').map((item) => item.textContent)).toEqual(['B']);
  });
});
