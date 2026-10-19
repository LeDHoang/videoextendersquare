// "SKIPPED" ledger beside the phone: every swipe throws away a whole world.
import type React from 'react';
import { C, F } from '../../theme';
import { ease, seg } from '../anim';
import { SWIPES } from '../director';
import { T } from '../timing';

const LINES = [
  { what: 'a whole ocean', t: '0.4s' },
  { what: 'a ringed planet', t: '0.3s' },
  { what: 'an entire nebula', t: '0.3s' },
  { what: 'the sky itself', t: '0.2s' },
];
const CPF = 1.5; // characters typed per frame
const STRIKE = 5;

export const Tally: React.FC<{ frame: number }> = ({ frame: f }) => {
  if (f < SWIPES[0] || f >= T.stop + 10) return null;
  const out = ease.inOutSine(seg(f, T.stop, T.stop + 10));
  return (
    <div style={{ position: 'absolute', left: 1236, top: 372, width: 620, opacity: 1 - out, fontFamily: F.mono }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          fontWeight: 700,
          fontSize: 17,
          letterSpacing: '0.32em',
          color: C.ink3,
          marginBottom: 18,
        }}
      >
        <span style={{ width: 9, height: 9, background: C.accent, display: 'inline-block' }} />
        SKIPPED
      </div>
      {LINES.map((line, i) => {
        const at = SWIPES[i];
        if (f < at) return null;
        const typedAt = at + line.what.length / CPF;
        const n = Math.floor((f - at) * CPF);
        const typed = n >= line.what.length;
        const strike = ease.outCubic(seg(f, typedAt, typedAt + STRIKE));
        return (
          <div key={line.what} style={{ fontSize: 30, lineHeight: '54px', whiteSpace: 'nowrap', color: C.ink }}>
            <span style={{ position: 'relative', color: strike > 0.5 ? C.ink2 : C.ink }}>
              {line.what.slice(0, n)}
              {typed ? null : <span style={{ color: C.accent }}>▍</span>}
              <span
                style={{
                  position: 'absolute',
                  left: -6,
                  top: '50%',
                  height: 3,
                  marginTop: -1,
                  width: `calc(${strike * 100}% + ${12 * strike}px)`,
                  background: C.accent,
                  boxShadow: `0 0 12px ${C.accentGlow}`,
                }}
              />
            </span>
            {strike > 0.6 ? <span style={{ color: C.ink3, whiteSpace: 'pre' }}>{`  ·  ${line.t}`}</span> : null}
          </div>
        );
      })}
    </div>
  );
};
