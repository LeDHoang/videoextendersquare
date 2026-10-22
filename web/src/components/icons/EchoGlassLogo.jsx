import raw from './svg/echo-glass.svg?raw';
import { RawIcon } from './RawIcon.jsx';

// Static "Echo Glass" mark; AnimatedEchoLogo is the live version.
export function EchoGlassLogo({ className = 'sx-logo-svg', ...props }) {
  return <RawIcon src={raw} className={className} {...props} />;
}
