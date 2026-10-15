import raw from './svg/like.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function LikeIcon({ className = 'sx-explore-stat-icon', filled = false, ...props }) {
  return <RawIcon src={raw} className={className} filled={filled} {...props} />;
}
