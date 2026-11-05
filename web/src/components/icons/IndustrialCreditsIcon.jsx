import raw from './svg/credits.svg?raw';
import { RawIcon } from './RawIcon.jsx';

// ECHO Credits nav glyph: octagon coin with the 3×3 grid path.
export function IndustrialCreditsIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
