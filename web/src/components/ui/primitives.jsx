import Emoji from './Emoji.jsx';

export function Hero({ title, kicker, children }) {
  return (
    <header style={{ marginBottom: 'var(--sx-6)' }}>
      <h1 className="sx-hero">
        <Emoji text={title} />
      </h1>
      {kicker ? (
        <div className="sx-eyebrow" style={{ color: 'var(--sx-ink-3)', marginTop: 'var(--sx-2)', marginBottom: children ? 'var(--sx-3)' : 0 }}>
          <Emoji text={kicker} />
        </div>
      ) : null}
      {children}
    </header>
  );
}

export function Eyebrow({ children }) {
  return (
    <div className="sx-eyebrow">
      <Emoji text={children} />
    </div>
  );
}

export function Rule({ weight = 'hair' }) {
  const cls = weight === 'heavy' ? 'sx-rule sx-heavy' : weight === 'accent' ? 'sx-rule sx-accent' : 'sx-rule';
  return <hr className={cls} />;
}

export function Section({ num, title, active = true, note, children, id }) {
  const sectionId = id || `section-${num}`;
  const headerId = `${sectionId}-header`;

  return (
    <section id={sectionId} aria-labelledby={headerId} style={{ marginBottom: 'var(--sx-7)' }}>
      <div className="sx-step-head">
        <span
          className={`sx-step-numeral ${active ? '' : 'sx-inactive'}`}
          aria-hidden="true"
        >
          {String(num).padStart(2, '0')}
        </span>
        <h2 id={headerId} className={`sx-display ${active ? '' : 'sx-inactive'}`}>
          <Emoji text={title} />
        </h2>
        {note ? (
          <span className="sx-eyebrow sx-step-note">
            <Emoji text={note} />
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function SpecRow({ cells = [] }) {
  return (
    <div className="sx-stat-row" role="region" aria-label="Media Specifications">
      {cells.map(([label, value, sub]) => (
        <div className="sx-stat-cell" key={label}>
          <div className="sx-stat-label">{label}</div>
          <div className="sx-stat-value">{value}</div>
          {sub ? <div className="sx-eyebrow" style={{ margin: '2px 0 0 0' }}>{sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function AccentBlock({ title, lines = [], tone = 'accent', code = [] }) {
  const toneClass = tone === 'warn' ? 'sx-warn' : tone === 'danger' ? 'sx-danger' : '';
  return (
    <div className={`sx-accent-block ${toneClass}`} role="note">
      <div className="sx-accent-block-title">{title}</div>
      <div className="sx-accent-block-body">
        {lines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
        {code.map((c, i) => (
          <div className="sx-mono" key={i}>
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, text, hint = '' }) {
  return (
    <div className="sx-empty-state">
      <div className="sx-empty-state-title">{title}</div>
      <p className="sx-empty-state-body">{text}</p>
      {hint ? <div className="sx-mono" style={{ color: 'var(--sx-ink-3)', marginTop: 8 }}>{hint}</div> : null}
    </div>
  );
}

export function BlockingBanner({ title, lines = [] }) {
  return (
    <div className="sx-blocking-banner" role="alert">
      <div className="sx-blocking-banner-title">{title}</div>
      <div className="sx-blocking-banner-body">
        {lines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
      </div>
    </div>
  );
}

export function ResultHeader({ title, meta }) {
  return (
    <div style={{ marginTop: 'var(--sx-6)', marginBottom: 'var(--sx-4)' }}>
      <div className="sx-result-hero-header">
        <span className="sx-result-hero-title">{title}</span>
        <span className="sx-result-hero-meta">{meta}</span>
      </div>
      <Rule weight="accent" />
    </div>
  );
}

export function GatedReason({ children }) {
  return (
    <div className="sx-gated-reason" role="status">
      <span>⚠</span>
      <span>{children}</span>
    </div>
  );
}

export function HealthDot({ ok, severity, label, detail }) {
  const cls = ok ? 'sx-ok' : severity === 'block' ? 'sx-block' : 'sx-degrade';
  const glyph = ok ? '■' : severity === 'block' ? '●' : '▲';
  return (
    <div className="sx-health-row">
      <span className={`sx-health-glyph ${cls}`} aria-hidden="true">
        {glyph}
      </span>
      <span className="sx-health-label">{label}</span>
      <span className="sx-health-detail" title={detail}>
        {detail}
      </span>
    </div>
  );
}

export function Mono({ children }) {
  return <div className="sx-mono">{children}</div>;
}