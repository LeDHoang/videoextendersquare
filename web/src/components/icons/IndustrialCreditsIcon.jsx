import raw from './svg/credits.svg?raw';
import { RawIcon } from './RawIcon.jsx';

// TEMP placeholder for the Credits nav glyph — final art to follow.
export function IndustrialCreditsIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
