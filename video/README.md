# ECHO intro video (Remotion)

Investor/accelerator intro: `EchoIntro30` (30 s) and `EchoIntro60` (48 s extended cut), 1920×1080 @ 30 fps.
Scene lengths live in `src/timing.ts` (bar-aligned to the 160 BPM track); every clip path lives in `src/media.ts`.

`EchoVision30` (30 s) is the vision-led cut: no product UI or footage, every world is a procedural
WebGL2 shader (`src/vision/gl/`). `src/vision/director.ts` maps each frame to the stage, phone and
headset state; the beat grid (96 BPM) lives in `src/vision/timing.ts`. `VisionLab` is a dev-only
composition that renders a raw stage from props (`scripts/lab-stills.mjs`).

## Setup

```bash
cd video && npm install
npm run media                     # ffmpeg proxies + stills -> public/media (gitignored)
```

Live captures (dev stack running: Vite :5173 + FastAPI :8000):

```bash
CAPTURE_HEADED=1 node scripts/capture-web.mjs        # web app clips -> public/media/web
node scripts/capture-quest.mjs                       # Quest on adb -> public/media/quest
```

`capture-quest.mjs` keeps the headset awake while recording and restores its power settings after.

Vision cut score (`public/audio/vision.mp3`, not committed): `npm run media` cuts the first 30 s of
`VR Tiktok/Media/testaudiotrack.mp3` (the founder's own track).

Music (`public/audio/track.mp3`, not committed): download "Cyborg Ninja" from the URL in
`public/audio/track.LICENSE.md`. It is CC BY 4.0, so the end card carries the credit; also put it in any video description.

## Preview and render

```bash
npm run studio                    # or preview_start "remotion"
npm run render:30                 # -> ../reports/video/echo-intro-30s.mp4
npm run render:60                 # -> ../reports/video/echo-intro-60s.mp4
npm run render:vision             # -> ../reports/video/echo-vision-30s.mp4
npm run share:vision              # ~24 MB email copy -> echo-vision-30s-share.mp4
npm run stills:vision -- 40,245 1 # key frames (ssaa 1) -> ../reports/video/vision/
```

The studio previews GL at half resolution (`ssaa` is capped at 0.5 there). Renders use the `ssaa` prop, which defaults to 2 (2x supersampled GL); `render:vision` also takes PNG frames so the grain and dark gradients are not JPEG-compressed twice.

Interim footage: the Pexels-sourced ECHO outputs and dev-DB UI are placeholders. Swap them in `src/media.ts` before public promo use.
