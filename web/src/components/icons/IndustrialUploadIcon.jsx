import raw from './svg/upload.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function IndustrialUploadIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
