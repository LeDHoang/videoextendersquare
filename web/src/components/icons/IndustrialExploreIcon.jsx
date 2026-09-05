import raw from './svg/compass.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialExploreIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
