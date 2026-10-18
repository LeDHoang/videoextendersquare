import raw from './svg/vr-headset.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function VrIcon({ className = 'sx-btn-icon', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
