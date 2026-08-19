import { NavLink } from 'react-router-dom';
import Emoji from '../ui/Emoji.jsx';

const LINKS = [
  { to: '/image', label: 'Image' },
  { to: '/video', label: 'Video' },
  { to: '/compare', label: 'Compare' },
  { to: '/reels', label: 'Reels' },
];

export default function Nav() {
  return (
    <nav className="sx-nav">
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          className={({ isActive }) => `sx-nav-link ${isActive ? 'sx-active' : ''}`}
        >
          <Emoji text={l.label} />
        </NavLink>
      ))}
    </nav>
  );
}