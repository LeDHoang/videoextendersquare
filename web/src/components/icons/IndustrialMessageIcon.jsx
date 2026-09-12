import raw from './svg/message.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialMessageIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
