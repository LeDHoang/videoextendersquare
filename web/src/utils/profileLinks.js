export function profilePostUrl(post, profileUsername, tab) {
  const params = new URLSearchParams({
    folder: 'ALL FOLDERS',
    codec: 'all',
    sort: 'newest',
  });
  // A play= link opens a private post only for its creator; post=<id> opens it for anyone with the link.
  if (post.visibility === 'private') params.set('post', post.id);
  else params.set('play', post.path);
  if (tab !== 'saved') params.set('author', profileUsername);
  return '/reels?' + params.toString();
}
