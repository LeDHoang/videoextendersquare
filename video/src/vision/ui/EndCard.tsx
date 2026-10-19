// End card: the galaxy of worlds collapses into the ECHO mark. It stays up
// while the stage and the music fade, so the last frame is the brand.
import type React from 'react';
import { C, CONTACT, F } from '../../theme';
import { ease, lerp, seg } from '../anim';
import { EchoGlassMark } from '../../components/EchoGlass';
import { END_CARD } from '../director';
import { Line, MONO, SERIF, words } from './Copy';

const AT = END_CARD;
const STAY: [number, number] = [1e6, 1e6 + 1];

export const EndCard: React.FC<{ frame: number }> = ({ frame: f }) => {
  if (f < AT) return null;
  // Wordmark tracks in from wide to tight; the negative margin cancels the
  // trailing letter-spacing so the row stays optically centred.
  const track = lerp(0.55, 0.12, ease.outCubic(seg(f, AT + 4, AT + 26)));
  const word = seg(f, AT + 4, AT + 12);
  return (
    <>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: seg(f, AT + 4, AT + 20),
          background: 'radial-gradient(ellipse 62% 52% at 50% 50%, rgba(0,0,0,0.62), rgba(0,0,0,0) 100%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: 1920,
          top: 468,
          transform: 'translateY(-50%)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 46,
        }}
      >
        <EchoGlassMark t={f - AT} size={168} />
        <div
          style={{
            fontFamily: F.brand,
            fontWeight: 900,
            fontSize: 156,
            lineHeight: 1,
            color: C.ink,
            letterSpacing: `${track}em`,
            marginRight: `${-track}em`,
            opacity: word,
            filter: word < 0.999 ? `blur(${(1 - word) * 16}px)` : undefined,
            textShadow: '0 0 40px rgba(0,0,0,0.5)',
          }}
        >
          ECHO
        </div>
      </div>
      <Line f={f} words={words('Every reel, a world.', AT + 16, 4)} exit={STAY} y={632} font={{ ...SERIF, fontSize: 80 }} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: 1920,
          top: 948,
          textAlign: 'center',
          ...MONO,
          fontWeight: 400,
          fontSize: 22,
          letterSpacing: '0.18em',
          color: C.ink2,
          whiteSpace: 'pre',
          opacity: seg(f, AT + 30, AT + 42),
        }}
      >
        {CONTACT}
      </div>
    </>
  );
};
