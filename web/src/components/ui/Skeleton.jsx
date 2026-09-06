// Skeleton loading primitives — shimmer = the app is working.
// Idle "awaiting input" states keep the StudioLoading watermark instead.
//
// The sweep is a subtle surface-2 → surface-3 highlight travelling
// left-to-right (see .sx-skel in global.css). All presets mirror the
// dimensions of the content they stand in for so the swap causes no
// layout shift.

function SrOnly({ text }) {
  return <span className="sx-sr-only">{text}</span>;
}

export function Skeleton({ w = '100%', h = 14, radius = 0, style, label }) {
  return (
    <div
      className="sx-skel"
      role={label ? undefined : 'presentation'}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

export function SkeletonLines({ count = 3, gap = 8, lastWidth = '62%' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="sx-skel"
          style={{ width: i === count - 1 ? lastWidth : '100%', height: 12 }}
        />
      ))}
    </div>
  );
}

// Filter/control rail placeholder (Reels + Explore headers).
export function ControlRailSkeleton({ label = 'Loading controls' }) {
  return (
    <div className="sx-control-rail-stacked" role="status" aria-busy="true" aria-label={label}>
      <SrOnly text={`${label}…`} />
      <div className="sx-control-rail-row" aria-hidden="true">
        <div className="sx-control-group" style={{ flex: 1, flexWrap: 'wrap' }}>
          <div className="sx-skel" style={{ width: 180, height: 40 }} />
          <div className="sx-skel" style={{ width: 220, height: 40 }} />
          <div className="sx-skel" style={{ flex: 1, minWidth: 160, height: 40 }} />
          <div className="sx-skel" style={{ width: 140, height: 40 }} />
        </div>
      </div>
    </div>
  );
}

// Explore gallery placeholder. Tile count is fixed (12); the real
// .sx-explore-grid auto-fill columns handle responsiveness and the
// .sx-skel-grid-clip wrapper (viewport-capped, overflow hidden) clips
// whatever doesn't fit the screen — phones see ~2-3 tiles, desktops ~6-9.
export function ExploreGridSkeleton({ label = 'Loading reels' }) {
  return (
    <div className="sx-skel-grid-clip" role="status" aria-busy="true" aria-label={label}>
      <SrOnly text={`${label}…`} />
      <div className="sx-explore-grid" aria-hidden="true">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="sx-explore-tile sx-skel" />
        ))}
      </div>
    </div>
  );
}

// Reels/VR player placeholder — same square sizing as the live mount
// (#sxReelsRoot .reels-phone-frame: min(92vw, 84vh, 860px)).
export function ReelsPlayerSkeleton({ label = 'Loading player' }) {
  return (
    <div
      className="sx-skel-player"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <SrOnly text={`${label}…`} />
      <div className="sx-skel-player-frame sx-skel" aria-hidden="true" />
      <div className="sx-skel-player-rail" aria-hidden="true">
        <div className="sx-skel" style={{ width: 44, height: 44 }} />
        <div className="sx-skel" style={{ width: 44, height: 120 }} />
        <div className="sx-skel" style={{ width: 44, height: 44 }} />
      </div>
      <div className="sx-skel-player-meta" aria-hidden="true">
        <div className="sx-skel" style={{ width: 120, height: 14 }} />
        <div className="sx-skel" style={{ width: 'min(46vw, 320px)', height: 14 }} />
        <div className="sx-skel" style={{ width: 180, height: 12 }} />
      </div>
    </div>
  );
}

// Generic hero + content placeholder (route transitions, Compare).
export function SectionSkeleton({ label = 'Loading section', compact = false }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <SrOnly text={`${label}…`} />
      <div
        className="sx-skel"
        aria-hidden="true"
        style={{
          width: 'min(58vw, 420px)',
          height: compact ? 28 : 44,
          marginBottom: 'var(--sx-4)',
        }}
      />
      <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="sx-skel" style={{ width: '100%', height: compact ? 120 : 200 }} />
        <div className="sx-skel" style={{ width: '100%', height: 40 }} />
      </div>
    </div>
  );
}
