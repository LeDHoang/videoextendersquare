import raw from './svg/echo-logo.svg?raw';
import { RawIcon } from './RawIcon.jsx';

export function EchoLogo({ className = 'sx-logo-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
