// Geometry for the ECHO "Echo Glass" mark: two chamfered triangles meeting at
// an eye, with echo triangles nested inside. Units are the 48x48 viewBox, y
// down. The static master is svg/echo-glass.svg; keep the two in sync.

export const INK = '#f2f3f5';
export const RED = '#ff3b1f';
export const DARK = '#08090a';

export const TOP = '9,4 39,4 43,8 24,25 5,8';
export const BOTTOM = '9,44 39,44 43,40 24,23 5,40';
export const LENS = '12,24 18,17.5 30,17.5 36,24 30,30.5 18,30.5';
export const IRIS = '24,17.5 30.5,24 24,30.5 17.5,24';
export const PUPIL = '24,21 27,24 24,27 21,24';

/** Nested echoes: scale about the centre, stroke width, opacity, gaze drift factor. */
export const ECHOES = [
  { k: 0.68, w: 1.8, o: 0.5, drift: 0.3 },
  { k: 0.44, w: 1.3, o: 0.28, drift: 0.55 },
];

/** How far the iris travels (user units) at full gaze, x and y. */
export const GAZE_AMP = [3.5, 1.5];

/** Below this rendered width the echoes drop out and the outline thickens. */
export const SMALL_PX = 24;
