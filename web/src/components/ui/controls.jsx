import { useEffect, useRef, useState } from 'react';
import Emoji from './Emoji.jsx';

// Collapsible dropdown — opens/closes on click, closes on outside click /
// Escape / selection. Options: [{value, label, tag?}].
export function Dropdown({ label, value, options, onChange, placeholder = '— SELECT —' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className={`sx-dropdown ${open ? 'open' : ''}`} ref={ref}>
      {label ? <div className="sx-label">{label}</div> : null}
      <button type="button" className="sx-dropdown-head" onClick={() => setOpen((o) => !o)}>
        <span className="sx-dropdown-value">{current ? current.label : placeholder}</span>
        <span className="sx-dropdown-caret">▾</span>
      </button>
      {open ? (
        <div className="sx-dropdown-panel">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={`sx-dropdown-item ${o.value === value ? 'sx-selected' : ''}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="sx-dropdown-label" title={o.label}>
                <Emoji text={o.label} />
              </span>
              {o.tag ? <span className="sx-dropdown-tag">{o.tag}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Segmented({ options, value, onChange, disabled = false }) {
  return (
    <div className="sx-seg">
      {options.map((opt) => (
        <button
          type="button"
          key={opt}
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

export function Pills({ options, value, onChange }) {
  return (
    <div className="sx-pills">
      {options.map((opt) => (
        <button
          type="button"
          key={opt.label}
          className={`sx-pill ${opt.value === value ? 'sx-selected' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          <Emoji text={opt.label} />
        </button>
      ))}
    </div>
  );
}

export function Button({ children, onClick, primary = false, disabled = false, className = '' }) {
  return (
    <button
      type="button"
      className={`sx-btn ${primary ? 'sx-primary' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      <Emoji text={children} />
    </button>
  );
}

export function Field({ label, children }) {
  return (
    <div>
      <label className="sx-label">{label}</label>
      {children}
    </div>
  );
}

export function ToggleRow({ label, checked, onChange, help }) {
  return (
    <div className="sx-toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label title={help}>
        <Emoji text={label} />
      </label>
    </div>
  );
}

export function Spinner() {
  return <span className="sx-spinner" />;
}