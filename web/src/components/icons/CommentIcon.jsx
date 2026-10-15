import raw from './svg/comment.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function CommentIcon({ className = 'sx-explore-stat-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
