import raw from './svg/save.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function SaveIcon({ className = 'sx-explore-stat-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
