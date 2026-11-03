import { Navigate, useLocation } from 'react-router-dom';
import { SectionSkeleton } from '../ui/Skeleton.jsx';
import { useAuth } from '../../hooks/AuthContext.jsx';

export default function RequireAuth({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <SectionSkeleton label="Checking account" />;
  if (!user) {
    const next = location.pathname + location.search;
    return <Navigate to={'/login?next=' + encodeURIComponent(next)} replace />;
  }
  if (adminOnly && user.role !== 'admin') return <Navigate to="/reels" replace />;
  return children;
}
