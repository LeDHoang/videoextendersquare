import { NavLink } from 'react-router-dom';
import Emoji from '../ui/Emoji.jsx';

const LINKS = [
  { to: '/image', label: 'Image', glyph: '🖼' },
  { to: '/video', label: 'Video', glyph: '🎬' },
  { to: '/compare', label: 'Compare', glyph: '◐' },
  { to: '/reels', label: 'Reels / VR', glyph: '🥽' },
];

export default function Nav({ onSelect }) {
  return (
    <nav className="sx-nav" aria-label="Main Navigation">
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          onClick={onSelect}
          className={({ isActive }) => `sx-nav-link ${isActive ? 'sx-active' : ''}`}
        >
          <span className="sx-nav-icon">{l.glyph}</span>
          <Emoji text={l.label} />
        </NavLink>
      ))}
    </nav>
  );
}