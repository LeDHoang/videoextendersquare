import raw from './svg/saved.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialSavedIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
