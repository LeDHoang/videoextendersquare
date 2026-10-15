import raw from './svg/location.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function LocationIcon({ className = 'sx-explore-stat-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
