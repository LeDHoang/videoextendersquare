import raw from './svg/industrial-image.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialImageIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
