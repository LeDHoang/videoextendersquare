import raw from './svg/settings.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialSettingsIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
