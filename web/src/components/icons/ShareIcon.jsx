import raw from './svg/share.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function ShareIcon({ className = 'sx-explore-stat-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
