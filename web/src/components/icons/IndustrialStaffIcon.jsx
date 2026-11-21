import raw from './svg/staff.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialStaffIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
