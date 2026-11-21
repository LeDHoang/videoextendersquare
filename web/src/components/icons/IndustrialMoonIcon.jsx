import raw from './svg/moon.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialMoonIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
