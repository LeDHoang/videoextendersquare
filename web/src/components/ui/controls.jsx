import { Children, cloneElement, isValidElement, useEffect, useRef, useState, useId } from 'react';
import Emoji from './Emoji.jsx';
import { GatedReason } from './primitives.jsx';
import { onRovingKeyDown, tabStop } from './roving.js';

// Accessible Combobox Dropdown — WAI-ARIA compliant with full keyboard navigation:
// ArrowDown / ArrowUp to move, Enter to select, Escape to close, Home / End.
export function Dropdown({ label, value, options = [], onChange, placeholder = '— SELECT —', id }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef(null);
  const listRef = useRef(null);
  const generatedId = useId();
  const dropdownId = id || generatedId;
  const listboxId = `${dropdownId}-listbox`;

  const selectedIndex = options.findIndex((o) => o.value === value);

  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      return undefined;
    }

    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);

    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, selectedIndex]);

  const handleKeyDown = (e) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (activeIndex >= 0 && options[activeIndex]) {
          onChange(options[activeIndex].value);
          setOpen(false);
        }
        break;
      case 'Escape':
        // Handled: an enclosing Dialog must not close too.
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const current = options.find((o) => o.value === value);

  return (
    <div className={`sx-dropdown ${open ? 'open' : ''}`} ref={ref}>
      {label ? (
        <label id={`${dropdownId}-label`} className="sx-label" htmlFor={dropdownId}>
          {label}
        </label>
      ) : null}
      <button
        type="button"
        id={dropdownId}
        className="sx-dropdown-head"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={label ? `${dropdownId}-label` : undefined}
      >
        <span className="sx-dropdown-value">{current ? current.label : placeholder}</span>
        <span className="sx-dropdown-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div
          id={listboxId}
          className="sx-dropdown-panel"
          role="listbox"
          ref={listRef}
          aria-labelledby={label ? `${dropdownId}-label` : undefined}
          tabIndex={-1}
        >
          {options.map((o, idx) => {
            const isSelected = o.value === value;
            const isFocused = idx === activeIndex;
            return (
              <button
                type="button"
                key={o.value}
                id={`${dropdownId}-opt-${idx}`}
                role="option"
                aria-selected={isSelected}
                className={`sx-dropdown-item ${isSelected ? 'sx-selected' : ''} ${isFocused ? 'sx-focused' : ''}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <span className="sx-dropdown-label" title={o.label}>
                  <Emoji text={o.label} />
                </span>
                {o.tag ? <span className="sx-dropdown-tag">{o.tag}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function Segmented({ options = [], value, onChange, disabled = false, disabledOptions = [], ariaLabel }) {
  const stop = tabStop(options.map((opt) => opt === value), options.map((opt) => disabled || disabledOptions.includes(opt)));
  return (
    <div className="sx-seg" role="radiogroup" aria-label={ariaLabel} onKeyDown={onRovingKeyDown}>
      {options.map((opt, index) => (
        <button
          type="button"
          key={opt}
          role="radio"
          aria-checked={opt === value}
          tabIndex={index === stop ? 0 : -1}
          className={opt === value ? 'sx-selected' : ''}
          disabled={disabled || disabledOptions.includes(opt)}
          onClick={() => onChange(opt)}
        >
          <Emoji text={opt} />
        </button>
      ))}
    </div>
  );
}

// Choice chips: a row of filters where exactly one is on (`.sx-pill`). Not a Button: a chip
// shows a state, so it keeps its own small mono look.
export function Pills({ options = [], value, onChange, ariaLabel }) {
  const stop = tabStop(options.map((opt) => opt.value === value));
  return (
    <div className="sx-pills" role="radiogroup" aria-label={ariaLabel} onKeyDown={onRovingKeyDown}>
      {options.map((opt, index) => (
        <button
          type="button"
          key={opt.label}
          role="radio"
          aria-checked={opt.value === value}
          tabIndex={index === stop ? 0 : -1}
          className={`sx-pill ${opt.value === value ? 'sx-selected' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          <Emoji text={opt.label} />
        </button>
      ))}
    </div>
  );
}

// Tabs switch what the page below shows. `tabs` is [{ value, label }]; a label can hold
// markup such as an unread count. `className` keeps each list's own look.
export function Tabs({ tabs = [], value, onChange, ariaLabel, className = '' }) {
  const stop = tabStop(tabs.map((tab) => tab.value === value));
  return (
    <div className={className || undefined} role="tablist" aria-label={ariaLabel} onKeyDown={onRovingKeyDown}>
      {tabs.map((tab, index) => (
        <button
          type="button"
          key={tab.value}
          role="tab"
          aria-selected={tab.value === value}
          tabIndex={index === stop ? 0 : -1}
          className={tab.value === value ? 'sx-active' : ''}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// `variant` is 'secondary' (outline), 'primary' (accent, full width) or 'danger'. `size` is
// 'sm' (34px), 'md' (38px) or 'lg' (44px); without one the variant sets it (primary is 44px).
// `as` renders another element, e.g. a Link, with the same look.
// `disabledReasons` lists why the button is blocked (falsy entries are skipped). They show above
// the button and describe it; a disabled button that has reasons stays focusable
// (aria-disabled) so keyboard and screen-reader users can reach it and hear why.
export function Button({
  children,
  onClick,
  as: Component = 'button',
  variant = 'secondary',
  size,
  disabled = false,
  loading = false,
  disabledReasons,
  className = '',
  type = 'button',
  ...props
}) {
  const reasonId = useId();
  const reasons = (disabledReasons || []).filter(Boolean);
  const explained = disabled && !loading && reasons.length > 0;
  const classes = ['sx-btn', variant !== 'secondary' && `sx-${variant}`, size && `sx-btn--${size}`, className];
  // The reasons sit in their own slot before the button, so adding or removing one never
  // remounts the button (a focused button keeps focus).
  return (
    <>
      {reasons.map((reason, index) => <GatedReason key={index} id={reasonId + index}>{reason}</GatedReason>)}
      <Component
        {...(Component === 'button' ? { type, disabled: (disabled || loading) && !explained } : null)}
        className={classes.filter(Boolean).join(' ')}
        onClick={explained ? (event) => event.preventDefault() : onClick}
        aria-disabled={explained || undefined}
        aria-busy={loading || undefined}
        aria-describedby={reasons.length ? reasons.map((_, index) => reasonId + index).join(' ') : undefined}
        {...props}
      >
        {loading ? <Spinner /> : null}
        <Emoji text={children} />
      </Component>
    </>
  );
}

const BINDABLE_TAGS = new Set(['input', 'textarea', 'select']);

export function Field({ label, id, children, help, className = '', style }) {
  const generatedId = useId();
  const only = Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  const bindable =
    isValidElement(only) && (BINDABLE_TAGS.has(only.type) || only.type === Dropdown);
  const fieldId = id || (bindable && only.props.id) || generatedId;
  const control =
    bindable && !only.props.id ? cloneElement(only, { id: fieldId }) : children;

  return (
    <div className={className || undefined} style={{ marginBottom: 'var(--sx-2)', ...style }}>
      {label ? (
        <label className="sx-label" htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      {control}
      {help ? <div className="sx-monospace-sm" style={{ marginTop: 2 }}>{help}</div> : null}
    </div>
  );
}

export function ToggleRow({ label, checked, onChange, help, id }) {
  const generatedId = useId();
  const toggleId = id || generatedId;

  return (
    <div className="sx-toggle-row">
      <input
        type="checkbox"
        id={toggleId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={toggleId} title={help}>
        <Emoji text={label} />
      </label>
    </div>
  );
}

export function Spinner() {
  return <span className="sx-spinner" aria-label="Loading..." role="status" />;
}