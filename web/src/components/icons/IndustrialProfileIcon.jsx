import raw from './svg/profile.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialProfileIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
