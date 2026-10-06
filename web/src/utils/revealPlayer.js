// Where to scroll so the whole square player is on screen.
// `top` and `bottom` are viewport coordinates of the player frame (getBoundingClientRect), `headerBottom` is the
// bottom edge of the sticky top bar. Returns the window scrollY to go to, or null when nothing should move:
// the frame is already fully visible, or it sits above the fold's top edge (the reader scrolled past it).
// It only ever scrolls DOWN so it never fights a reader who is looking at something above the player.
export const REVEAL_MARGIN = 12;

export function revealScrollTarget({ top, bottom, viewportHeight, headerBottom = 0, scrollY = 0, margin = REVEAL_MARGIN }) {
  if (![top, bottom, viewportHeight, scrollY].every(Number.isFinite)) return null;
  if (bottom <= viewportHeight && top >= headerBottom) return null;
  const delta = top - (headerBottom + margin);
  if (delta <= 0) return null;
  return Math.round(scrollY + delta);
}
