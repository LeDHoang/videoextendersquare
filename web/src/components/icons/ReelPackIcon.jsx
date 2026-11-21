import raw from './svg/reel-pack.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function ReelPackIcon({ className = 'sx-explore-stat-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
