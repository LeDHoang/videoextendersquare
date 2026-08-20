import { useEffect, useRef, useState, useId } from 'react';
import Emoji from './Emoji.jsx';

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

export function Segmented({ options = [], value, onChange, disabled = false, ariaLabel }) {
  return (
    <div className="sx-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          type="button"
          key={opt}
          role="radio"
          aria-checked={opt === value}
          className={opt === value ? 'sx-selected' : ''}
          disabled={disabled}
          onClick={() => onChange(opt)}
        >
          <Emoji text={opt} />
        </button>
      ))}
    </div>
  );
}

export function Pills({ options = [], value, onChange }) {
  return (
    <div className="sx-pills" role="radiogroup">
      {options.map((opt) => (
        <button
          type="button"
          key={opt.label}
          role="radio"
          aria-checked={opt.value === value}
          className={`sx-pill ${opt.value === value ? 'sx-selected' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          <Emoji text={opt.label} />
        </button>
      ))}
    </div>
  );
}

export function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  loading = false,
  className = '',
  type = 'button',
  ...props
}) {
  return (
    <button
      type={type}
      className={`sx-btn ${primary ? 'sx-primary' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Spinner /> : null}
      <Emoji text={children} />
    </button>
  );
}

export function Field({ label, id, children, help }) {
  const generatedId = useId();
  const fieldId = id || generatedId;

  return (
    <div style={{ marginBottom: 'var(--sx-2)' }}>
      {label ? (
        <label className="sx-label" htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      {children}
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