import { NavLink } from 'react-router-dom';
import { AnimatedEchoLogo } from '../icons/AnimatedEchoLogo.jsx';

export default function Footer() {
  return (
    <footer className="sx-footer">
      <div className="sx-footer-inner">
        <NavLink to="/reels" className="sx-footer-brand" title="ECHO 4K Engine">
          <AnimatedEchoLogo className="sx-footer-logo" />
          <span>ECHO</span>
        </NavLink>
        <p className="sx-footer-legal">
          © {new Date().getFullYear()} ECHO Inc. · <NavLink to="/terms" className="sx-footer-link">TERMS</NavLink> · <NavLink to="/privacy" className="sx-footer-link">PRIVACY</NavLink>
        </p>
      </div>
    </footer>
  );
}
