// Beat grid for the vision cut, measured from public/audio/vision.mp3
// (first 30 s of the founder's track): 96 BPM, first beat at 0.375 s.
// One beat = 18.75 frames, one bar = 75 frames (2.5 s); 30 s = 12 bars.
// Phrases start at 0.38 / 5.38 / 10.38 / 15.38 / 20.38 s and the bass drop
// lands at 21.63 s, after which claps hit every 1.25 s.
export const FPS = 30;
export const BPM = 96;
export const BEAT = (60 / BPM) * FPS; // 18.75 frames
export const BAR = BEAT * 4; // 75 frames
const PHASE = 0.375 * FPS; // first beat, frames

/** Frame of beat n (0-based, may be fractional), rounded to the nearest frame. */
export const beat = (n: number) => Math.round(PHASE + n * BEAT);

export const VISION_LENGTH = 900; // 30 s

// Section boundaries (frames), all on the beat grid.
export const T = {
  open: 0, //            inside a world, no UI
  reveal: beat(4), //    86: pull back, it was a reel on a phone
  swipe: beat(8), //     161: phrase B, the thumb starts swiping
  stop: beat(12), //     236: feed stops on one reel
  extend: beat(13), //   255: reel grows past its frame
  inside: beat(16), //   311: phrase C, full-bleed world, push in
  breath: beat(21), //   405: bass drops out, look around
  door: beat(24), //     461: phrase D, a reel-shaped door in the world
  through: beat(28), //  536: kick, fly through the door
  rush: beat(32), //     611: pre-drop rush
  drop: beat(34), //     649: bass drop, galaxy of worlds
  hit1: beat(35), //     667: clap
  hit2: beat(37), //     705
  hit3: beat(39), //     742
  end: beat(41), //      780: end card
  fade: beat(45), //     855: audio fades out
} as const;
