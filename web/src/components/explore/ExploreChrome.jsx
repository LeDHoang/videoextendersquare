import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Emoji from '../ui/Emoji.jsx';

/*
 * Shared "Explore chrome" — the header, telemetry strip, chip row and toolbar
 * used by the Explore, Tag and Location pages so they stay visually identical.
 */

const DENSITY_KEY = 'sx.explore.density';

export function useGridDensity() {
  const [density, setDensityState] = useState(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) === 'stack' ? 'stack' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const setDensity = useCallback((next) => {
    setDensityState(next);
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
  }, []);
  return [density, setDensity];
}

export function gridClassName(density) {
  return density === 'stack' ? 'sx-explore-grid sx-explore-grid--stack' : 'sx-explore-grid';
}

export function ExploreHeader({ prefix, title, kicker, actions }) {
  return (
    <header className="sx-xh">
      <div className="sx-xh-row">
        <div className="sx-xh-titleblock">
          <h1 className={'sx-xh-title' + (String(title).length > 14 ? ' sx-xh-title--long' : '')}>
            {prefix ? <span className="sx-xh-prefix" aria-hidden="true">{prefix}</span> : null}
            <Emoji text={title} />
          </h1>
          {kicker ? <div className="sx-xh-kicker"><Emoji text={kicker} /></div> : null}
        </div>
        {actions ? <div className="sx-xh-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function HeaderButton({ primary = false, icon, children, ...props }) {
  return (
    <button type="button" className={'sx-xh-btn' + (primary ? ' sx-xh-btn--primary' : '')} {...props}>
      {icon ? <span className="sx-xh-btn-icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}

export function StatStrip({ stats }) {
  return (
    <div className="sx-xh-stats" role="group" aria-label="Summary statistics">
      {stats.map(({ label, value, accent }) => (
        <div className="sx-xh-stat" key={label}>
          <div className="sx-xh-stat-label">{label}</div>
          <div className={'sx-xh-stat-value' + (accent ? ' sx-xh-stat-value--accent' : '')}>{value}</div>
        </div>
      ))}
    </div>
  );
}

/* chips: [{ key, to, label, count, hint, prefix? }] — a chip's own prefix overrides the row default.
   Chips that don't fully fit the available width are hidden (never half-clipped);
   the row re-measures whenever it is resized. */
export function ChipRow({ label, chips, prefix = '#' }) {
  const listRef = useRef(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const fit = () => {
      const items = Array.from(list.children);
      items.forEach((item) => { item.hidden = false; });
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
      const available = list.clientWidth;
      let used = 0;
      let full = false;
      items.forEach((item, index) => {
        used += item.offsetWidth + (index ? gap : 0);
        if (full || used > available) {
          full = true;
          item.hidden = true;
        }
      });
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(list);
    return () => observer.disconnect();
  }, [chips]);

  if (!chips.length) return null;
  return (
    <div className="sx-xh-chips">
      <span className="sx-xh-chips-label">{label}</span>
      <div className="sx-xh-chips-list" ref={listRef}>
        {chips.map((chip) => (
          <Link key={chip.key} to={chip.to} className="sx-xh-chip" title={chip.hint || undefined}>
            {(chip.prefix ?? prefix) ? (
              <span className="sx-xh-chip-prefix" aria-hidden="true">{chip.prefix ?? prefix}</span>
            ) : null}
            <span className="sx-xh-chip-name">{chip.label}</span>
            {chip.count != null ? <span className="sx-xh-chip-count">{chip.count}</span> : null}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function Toolbar({ children, filters }) {
  return (
    <section className="sx-xh-toolbar">
      <div className="sx-xh-toolbar-row">{children}</div>
      {filters ? <div className="sx-xh-toolbar-row sx-xh-toolbar-filters">{filters}</div> : null}
    </section>
  );
}

/* tabs: [{ label, value, count }] */
export function TabGroup({ tabs, value, onChange, ariaLabel }) {
  return (
    <div className="sx-xh-tabs" role="radiogroup" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.value}
          role="radio"
          aria-checked={tab.value === value}
          className={'sx-xh-tab' + (tab.value === value ? ' sx-xh-tab--on' : '')}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}{tab.count != null ? ' (' + tab.count + ')' : ''}
        </button>
      ))}
    </div>
  );
}

export function Segmented({ label, options, value, onChange, ariaLabel }) {
  return (
    <div className="sx-xh-ctl">
      {label ? <span className="sx-xh-ctl-label">{label}</span> : null}
      <div className="sx-xh-seg" role="radiogroup" aria-label={ariaLabel || label}>
        {options.map((opt) => (
          <button
            type="button"
            key={opt.value}
            role="radio"
            aria-checked={opt.value === value}
            className={'sx-xh-seg-btn' + (opt.value === value ? ' sx-xh-seg-btn--on' : '')}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DensityToggle({ value, onChange }) {
  return (
    <div className="sx-xh-ctl sx-xh-density">
      <span className="sx-xh-ctl-label">GRID:</span>
      <button
        type="button"
        className={'sx-xh-icon-btn' + (value === 'grid' ? ' sx-xh-icon-btn--on' : '')}
        aria-pressed={value === 'grid'}
        title="Compact square grid"
        aria-label="Compact square grid"
        onClick={() => onChange('grid')}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
          <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
          <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
          <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
        </svg>
      </button>
      <button
        type="button"
        className={'sx-xh-icon-btn' + (value === 'stack' ? ' sx-xh-icon-btn--on' : '')}
        aria-pressed={value === 'stack'}
        title="Large tiles"
        aria-label="Large tiles"
        onClick={() => onChange('stack')}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
          <path d="M1.5 5h13" />
        </svg>
      </button>
    </div>
  );
}
