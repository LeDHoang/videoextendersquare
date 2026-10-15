import raw from './svg/industrial-compare.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialCompareIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
