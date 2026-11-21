import raw from './svg/report.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function ReportIcon({ className = 'sx-explore-stat-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
