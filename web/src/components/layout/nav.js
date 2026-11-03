import {
  IndustrialCompareIcon,
  IndustrialCreditsIcon,
  IndustrialExploreIcon,
  IndustrialImageIcon,
  IndustrialMessageIcon,
  IndustrialReelsIcon,
  IndustrialUploadIcon,
  IndustrialVideoIcon,
} from '../icons/index.jsx';

/**
 * The app's destinations, each with the one label every place uses for it: the header,
 * the sidebar (the drawer below 900px), the phone tab bar and the account menu. Each place
 * picks the ones it shows, in its own order. CSS sets the case (most draw them in capitals).
 */
export const NAV = {
  reels: { to: '/reels', label: 'Reels/VR', Icon: IndustrialReelsIcon },
  explore: { to: '/explore', label: 'Explore', Icon: IndustrialExploreIcon },
  upload: { to: '/upload', label: 'Upload', Icon: IndustrialUploadIcon },
  messages: { to: '/messages', label: 'Messages', Icon: IndustrialMessageIcon },
  credits: { to: '/wallet', label: 'Credits', Icon: IndustrialCreditsIcon }, // TEMP glyph — final art to follow
  image: { to: '/image', label: 'Image', Icon: IndustrialImageIcon, adminOnly: true },
  video: { to: '/video', label: 'Video', Icon: IndustrialVideoIcon, adminOnly: true },
  compare: { to: '/compare', label: 'Compare', Icon: IndustrialCompareIcon, adminOnly: true },
  settings: { to: '/settings/profile', label: 'Settings' },
  staff: { to: '/moderation', label: 'Staff' },
};

export const HEADER_NAV = [NAV.reels, NAV.explore];

export const SIDEBAR_NAV = [NAV.reels, NAV.explore, NAV.messages, NAV.credits, NAV.upload, NAV.image, NAV.video, NAV.compare];

export const BOTTOM_NAV = [NAV.reels, NAV.explore, NAV.upload, NAV.messages];

// The account menu: the user's own profile and saved reels, then settings, credits and, for staff, moderation.
export function accountNav(user) {
  const profile = '/profile/' + encodeURIComponent(user.username);
  return [
    { to: profile, label: 'Profile' },
    { to: profile + '?tab=saved', label: 'Saved' },
    NAV.settings,
    NAV.credits,
    ...(user.can_moderate ? [NAV.staff] : []),
  ];
}
