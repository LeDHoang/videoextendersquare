import { Link, useLocation } from 'react-router-dom';
import { EmptyState } from '../components/ui/primitives.jsx';

// Unknown URLs used to redirect to /reels without a word; say what happened and offer a way on.
export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="sx-wide-page">
      <EmptyState
        title="PAGE NOT FOUND"
        text="There is nothing at this address. The link may be old or mistyped."
        hint={pathname}
      >
        <Link className="sx-btn" to="/reels">GO TO REELS</Link>
        <Link className="sx-btn" to="/explore">SEARCH EXPLORE</Link>
      </EmptyState>
    </div>
  );
}
