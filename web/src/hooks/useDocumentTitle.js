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
  '/wallet': 'Wallet',
  '/upload': 'Upload',
  '/moderation': 'Moderation',
  '/terms': 'Terms of Service',
  '/privacy': 'Privacy Policy',
  '/support': 'Support',
};

function decode(part) {
  try { return decodeURIComponent(part); } catch (_) { return part; }
}

// Page name for a pathname, or '' for the bare brand title.
export function routeTitle(pathname) {
  const path = (pathname || '/').replace(/\/+$/, '') || '/';
  if (STATIC_TITLES[path]) return STATIC_TITLES[path];
  const parts = path.split('/').filter(Boolean).map(decode);
  if (parts[0] === 'explore' && parts[1] === 'tag' && parts[2]) return `#${parts[2]}`;
  if (parts[0] === 'explore' && parts[1] === 'location' && parts[2]) return parts[2];
  if (parts[0] === 'profile' && parts[1]) return `@${parts[1]}`;
  if (parts[0] === 'packs' && parts[2] === 'edit') return 'Edit reel pack';
  if (parts[0] === 'packs' && parts[1]) return 'Reel pack';
  if (parts[0] === 'messages' && parts[1]) return 'Messages';
  return '';
}

// Sets "<title> · ECHO" while mounted; an empty title keeps the bare brand.
export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : BASE;
  }, [title]);
}
