import raw from './svg/logout.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialLogoutIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
