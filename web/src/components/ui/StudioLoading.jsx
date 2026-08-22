export default function StudioLoading({
  title = 'STUDIO',
  subtitle = 'AWAITING SEQUENCE INITIATION…',
  compact = false,
}) {
  return (
    <div
      className="sx-studio-loading"
      style={{
        minHeight: compact ? '280px' : 'calc(100vh - 180px)',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Background Dotted Matrix Grid */}
      <div
        className="sx-studio-loading-grid"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.25,
          pointerEvents: 'none',
          backgroundImage: 'radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.18) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />

      {/* Hero Watermark Text */}
      <div
        style={{
          fontFamily: 'Archivo Black, Archivo, sans-serif',
          fontSize: compact ? 'clamp(2.5rem, 7vw, 4rem)' : 'clamp(4rem, 12vw, 6.5rem)',
          lineHeight: 1,
          letterSpacing: '-0.03em',
          color: 'var(--sx-ink)',
          opacity: 0.08,
          textTransform: 'uppercase',
          userSelect: 'none',
          marginBottom: 'var(--sx-3)',
        }}
      >
        {title}
      </div>

      {/* Subtitle & Breathing Red Indicator */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--sx-2)',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: '0.8125rem',
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--sx-ink-2)',
          background: 'rgba(16, 18, 20, 0.85)',
          padding: '6px 16px',
          border: '1px solid var(--sx-rule-strong)',
          zIndex: 2,
        }}
      >
        <span
          className="sx-loading-dot-pulse"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--sx-accent)',
            boxShadow: '0 0 10px var(--sx-accent-glow)',
            display: 'inline-block',
          }}
        />
        <span>{subtitle}</span>
      </div>
    </div>
  );
}
