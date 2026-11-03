import { Link, useLocation } from 'react-router-dom';
import { Button } from '../components/ui/controls.jsx';
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
        <Button as={Link} to="/reels">GO TO REELS</Button>
        <Button as={Link} to="/explore">SEARCH EXPLORE</Button>
      </EmptyState>
    </div>
  );
}
