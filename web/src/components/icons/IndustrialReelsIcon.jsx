import raw from './svg/industrial-reels.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialReelsIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
