// Scene durations (frames @30 fps) per cut. Single source for both compositions.
// Cuts land on bar lines of the music track (Cyborg Ninja, 160 BPM):
// one bar = 4 beats = 1.5 s = 45 frames, one beat = 11.25 frames.
export const FPS = 30;
export const BAR = 45;
export const BEAT = BAR / 4;

export type SceneId =
  | 'hook' | 'shift' | 'extend' | 'stepInside' | 'stereo'
  | 'world' | 'proof' | 'creators' | 'end';

export type Cut = { id: string; scenes: { id: SceneId; dur: number }[] };

export const CUT_30: Cut = {
  id: 'EchoIntro30',
  scenes: [
    { id: 'hook', dur: 2 * BAR },
    { id: 'shift', dur: 2 * BAR },
    { id: 'extend', dur: 3 * BAR },
    { id: 'stepInside', dur: 3 * BAR },
    { id: 'stereo', dur: 2 * BAR },
    { id: 'world', dur: 3 * BAR },
    { id: 'proof', dur: 3 * BAR },
    { id: 'end', dur: 2 * BAR },
  ],
};

// Extended cut: longer holds on the product beats plus a creator-economy beat.
export const CUT_60: Cut = {
  id: 'EchoIntro60',
  scenes: [
    { id: 'hook', dur: 3 * BAR },
    { id: 'shift', dur: 2 * BAR },
    { id: 'extend', dur: 4 * BAR },
    { id: 'stepInside', dur: 5 * BAR },
    { id: 'stereo', dur: 3 * BAR },
    { id: 'world', dur: 4 * BAR },
    { id: 'proof', dur: 5 * BAR },
    { id: 'creators', dur: 3 * BAR },
    { id: 'end', dur: 3 * BAR },
  ],
};

export const cutLength = (cut: Cut) => cut.scenes.reduce((n, s) => n + s.dur, 0);
