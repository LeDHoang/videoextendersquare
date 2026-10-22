export default function StudioLoading({
  title = 'STUDIO',
  subtitle = 'AWAITING SEQUENCE INITIATION…',
  compact = false,
}) {
  // dvh tracks the mobile URL bar; vh is the fallback for older browsers.
  const supportsDvh =
    typeof CSS !== 'undefined' && CSS.supports && CSS.supports('min-height', '100dvh');
  const minHeight = compact ? '280px' : supportsDvh ? 'calc(100dvh - 180px)' : 'calc(100vh - 180px)';
  return (
    <div className="sx-studio-loading" style={{ minHeight }}>
      <div className="sx-studio-loading-grid" />
      <div className={`sx-studio-loading-title${compact ? ' sx-compact' : ''}`}>{title}</div>
      <div className="sx-studio-loading-sub">
        <span className="sx-loading-dot-pulse" />
        <span>{subtitle}</span>
      </div>
    </div>
  );
}
