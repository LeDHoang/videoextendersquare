// Single manifest of every clip/still the video uses. Swap footage here.
// Files live in public/media (gitignored); `npm run media` and
// `npm run capture:web` regenerate them.
import { staticFile } from 'remotion';

const m = (p: string) => staticFile(`media/${p}`);

export const MEDIA = {
  // ECHO 4K square outputs (Pexels sources, interim; replace before public promo use).
  reelVan: m('reel-van.mp4'),
  reelVolley: m('reel-volley.mp4'),
  reelVolleySource: m('reel-volley-src.mp4'), // 720p original fed to the extender
  logo: m('logo.svg'),
  earth: m('earth.jpg'),
  controller: m('controller.png'),
  // Live web app captures (scripts/capture-web.mjs).
  web: {
    reelsPhone: m('web/reels-phone.mp4'),
    reelsDesktop: m('web/reels-desktop.mp4'),
    explore: m('web/explore.mp4'),
    extender: m('web/extender.mp4'),
    dome: m('web/dome.mp4'),
    earth: m('web/earth.mp4'),
    wallet: m('web/wallet.mp4'),
  },
  // Static UI shots (docs/images), fallback for the montage.
  ui: {
    packs: m('ui/reel_packs.png'),
    messages: m('ui/messages_chat.png'),
    compare: m('ui/compare_slider.png'),
    vrMode: m('ui/reels_vr_mode.png'),
  },
  // Quest headset captures (scripts/capture-quest.mjs), left-eye lens view 960x1080.
  quest: {
    dome: m('quest/dome.mp4'),
    earth: m('quest/earth.mp4'), // last ~2 s switch back to reels; trim
  },
  music: staticFile('audio/track.mp3'),
} as const;
