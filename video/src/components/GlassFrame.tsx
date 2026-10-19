import { C, F } from '../theme';

// App-style framed panel with corner ticks, for live UI captures.
export const GlassFrame = ({
  children, width, height, label, style,
}: { children: React.ReactNode; width: number; height: number; label?: string; style?: React.CSSProperties }) => {
  const tick = (pos: React.CSSProperties) => (
    <div style={{ position: 'absolute', width: 26, height: 26, borderColor: C.accent, borderStyle: 'solid', borderWidth: 0, ...pos }} />
  );
  return (
    <div style={{ position: 'absolute', width, height, ...style }}>
      <div
        style={{
          position: 'absolute', inset: 0, overflow: 'hidden', background: C.surface,
          border: `1px solid ${C.ruleStrong}`, boxShadow: `0 40px 120px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04)`,
        }}
      >
        {children}
      </div>
      {tick({ left: -10, top: -10, borderLeftWidth: 3, borderTopWidth: 3 })}
      {tick({ right: -10, top: -10, borderRightWidth: 3, borderTopWidth: 3 })}
      {tick({ left: -10, bottom: -10, borderLeftWidth: 3, borderBottomWidth: 3 })}
      {tick({ right: -10, bottom: -10, borderRightWidth: 3, borderBottomWidth: 3 })}
      {label && (
        <div style={{ position: 'absolute', left: 0, top: -44, display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 10, height: 10, background: C.accent, boxShadow: `0 0 12px ${C.accent}` }} />
          <span style={{ fontFamily: F.mono, fontSize: 18, letterSpacing: '0.16em', color: C.ink2 }}>{label}</span>
        </div>
      )}
    </div>
  );
};
