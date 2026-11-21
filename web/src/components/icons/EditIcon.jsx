import raw from './svg/edit.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function EditIcon({ className = 'sx-explore-stat-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
