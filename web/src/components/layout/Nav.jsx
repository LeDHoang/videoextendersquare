import { NavLink } from 'react-router-dom';
import {
  IndustrialImageIcon,
  IndustrialVideoIcon,
  IndustrialCompareIcon,
  IndustrialReelsIcon,
} from '../ui/StitchIcons.jsx';

const LINKS = [
  { to: '/reels', label: 'Reels / VR', Icon: IndustrialReelsIcon },
  { to: '/image', label: 'Image', Icon: IndustrialImageIcon },
  { to: '/video', label: 'Video', Icon: IndustrialVideoIcon },
  { to: '/compare', label: 'Compare', Icon: IndustrialCompareIcon },
];

export default function Nav({ onSelect }) {
  return (
    <nav className="sx-nav" aria-label="Main Navigation">
      {LINKS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onSelect}
          className={({ isActive }) => `sx-nav-link ${isActive ? 'sx-active' : ''}`}
        >
          <Icon className="sx-sidebar-icon-svg" style={{ width: 18, height: 18 }} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}