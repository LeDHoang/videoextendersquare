import { useEffect } from 'react';

const BASE = 'ECHO';

const STATIC_TITLES = {
  '/image': 'Image',
  '/video': 'Video',
  '/compare': 'Compare',
  '/reels': 'Reels',
  '/reels/immersive-preview': 'Immersive preview',
  '/explore': 'Explore',
  '/login': 'Sign in',
  '/signup': 'Create account',
  '/forgot-password': 'Reset password',
  '/reset-password': 'Reset password',
  '/packs/new': 'Create reel pack',
  '/settings/profile': 'Profile settings',
  '/messages': 'Messages',
  '/wallet': 'Credits',
  '/upload': 'Upload',
  '/moderation': 'Moderation',
  '/terms': 'Terms of Service',
  '/privacy': 'Privacy Policy',
  '/support': 'Support',
  '/rules': 'Community rules',
  '/verify-email': 'Verify email',
};

function decode(part) {
  try { return decodeURIComponent(part); } catch (_) { return part; }
}

// Page name for a pathname, or '' for the bare brand title (only the root redirect).
export function routeTitle(pathname) {
  const path = (pathname || '/').replace(/\/+$/, '') || '/';
  if (STATIC_TITLES[path]) return STATIC_TITLES[path];
  const parts = path.split('/').filter(Boolean).map(decode);
  // Each route has an exact depth; a deeper path is the 404 page.
  const depth = parts.length;
  if (depth === 3 && parts[0] === 'explore' && parts[1] === 'tag') return `#${parts[2]}`;
  // The slug is not a name; LocationExplorePage sets the place name once it loads.
  if (depth === 3 && parts[0] === 'explore' && parts[1] === 'location') return 'Location';
  if (depth === 2 && parts[0] === 'profile') return `@${parts[1]}`;
  if (depth === 3 && parts[0] === 'packs' && parts[2] === 'edit') return 'Edit reel pack';
  if (depth === 2 && parts[0] === 'packs') return 'Reel pack';
  if (depth === 2 && parts[0] === 'messages') return 'Messages';
  // Every route in App.jsx is named above, so anything else is the catch-all 404 page.
  // NotFoundPage cannot set this itself: App's effect runs after its child's and would overwrite it.
  return path === '/' ? '' : 'Page not found';
}

// Sets "<title> · ECHO" while mounted; an empty title keeps the bare brand.
export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : BASE;
  }, [title]);
}
