// Single home for every SVG icon. Artwork lives in svg/ (one file each);
// components are thin RawIcon wrappers over those files. Import from here:
//
//   import { IndustrialExploreIcon, LikeIcon } from '../icons/index.jsx';
//
// The reels player template `ui/assets/reels.html` has no inline SVGs left —
// the backend injects the same svg/ files via __ICON_*__ tokens at serve
// time (see _inject_icons in server/routers/reels.py).

export { RawIcon } from './RawIcon.jsx';

export { IndustrialImageIcon } from './IndustrialImageIcon.jsx';
export { IndustrialVideoIcon } from './IndustrialVideoIcon.jsx';
export { IndustrialCompareIcon } from './IndustrialCompareIcon.jsx';
export { IndustrialReelsIcon } from './IndustrialReelsIcon.jsx';
export { IndustrialExploreIcon } from './IndustrialExploreIcon.jsx';
export { EchoLogo } from './EchoLogo.jsx';
export { LocationIcon } from './LocationIcon.jsx';
export { LikeIcon } from './LikeIcon.jsx';
export { ViewIcon } from './ViewIcon.jsx';
export { CommentIcon } from './CommentIcon.jsx';
