import raw from './svg/industrial-video.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialVideoIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
