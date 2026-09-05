import raw from './svg/view.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function ViewIcon({ className = 'sx-explore-stat-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
