import raw from './svg/sun.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialSunIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
