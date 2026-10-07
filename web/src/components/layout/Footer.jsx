import { NavLink } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="sx-footer">
      <div className="sx-footer-inner">
        <NavLink to="/reels" className="sx-footer-brand" title="ECHO 4K Engine">
          <img src="/logo.svg" alt="" className="sx-footer-logo" />
          <span>ECHO</span>
        </NavLink>
        <p className="sx-footer-legal">© {new Date().getFullYear()} ECHO Inc.</p>
      </div>
    </footer>
  );
}
