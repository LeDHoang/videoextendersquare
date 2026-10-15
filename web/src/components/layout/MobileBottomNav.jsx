import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { useMessaging } from '../../hooks/MessagingContext.jsx';
import {
  IndustrialReelsIcon,
  IndustrialExploreIcon,
  IndustrialUploadIcon,
  IndustrialMessageIcon,
} from '../icons/index.jsx';

// Same destinations and glyphs as the sidebar's nav grid; the account slot shows the user's avatar.
const ITEMS = [
  { to: '/reels', label: 'Reels', Icon: IndustrialReelsIcon },
  { to: '/explore', label: 'Explore', Icon: IndustrialExploreIcon },
  { to: '/upload', label: 'Upload', Icon: IndustrialUploadIcon },
  { to: '/messages', label: 'Messages', Icon: IndustrialMessageIcon, badge: true },
];

function Avatar({ user }) {
  const label = (user?.display_name || user?.username || '?').trim();
  return (
    <span className="sx-bottom-nav-avatar" style={{ backgroundColor: user?.avatar_color || 'var(--sx-accent)' }}>
      {user?.avatar_url ? <img src={user.avatar_url} alt="" /> : label.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Bottom tab bar for the phone-width fullscreen player (the site header is hidden there). */
export default function MobileBottomNav() {
  const { user } = useAuth();
  const messaging = useMessaging();
  const location = useLocation();
  const unread = messaging?.unread?.total || 0;

  // The player shortens itself by this much and drops its own bottom safe-area padding (see reels.html).
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--sx-bottom-nav', 'calc(56px + env(safe-area-inset-bottom, 0px))');
    root.style.setProperty('--sx-fs-safe-bottom', '0px');
    return () => {
      root.style.removeProperty('--sx-bottom-nav');
      root.style.removeProperty('--sx-fs-safe-bottom');
    };
  }, []);

  const profilePath = user ? '/profile/' + encodeURIComponent(user.username) : null;
  const signInPath = '/login?next=' + encodeURIComponent(location.pathname + location.search);

  return (
    <nav className="sx-bottom-nav" aria-label="Main navigation">
      {ITEMS.map(({ to, label, Icon, badge }) => {
        // A playing Reel Pack belongs to Explore, so that tab stays lit while it plays.
        const inPack = to === '/explore' && location.pathname.startsWith('/packs/');
        return (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => 'sx-bottom-nav-item' + (isActive || inPack ? ' sx-active' : '')}
          aria-current={inPack ? 'page' : undefined}
          aria-label={badge && unread ? `${label}, ${unread} unread` : label}
        >
          <span className="sx-bottom-nav-icon">
            <Icon className="sx-bottom-nav-svg" />
            {badge && unread ? <span className="sx-bottom-nav-badge">{unread > 99 ? '99+' : unread}</span> : null}
          </span>
        </NavLink>
        );
      })}
      <NavLink
        to={profilePath || signInPath}
        end={false}
        className={({ isActive }) => 'sx-bottom-nav-item' + (user && isActive ? ' sx-active' : '')}
        aria-label={user ? 'Profile' : 'Sign in'}
      >
        <span className="sx-bottom-nav-icon">
          {user ? (
            <Avatar user={user} />
          ) : (
            <span className="sx-bottom-nav-avatar sx-bottom-nav-avatar--guest" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5" />
              </svg>
            </span>
          )}
        </span>
      </NavLink>
    </nav>
  );
}
