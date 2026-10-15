export function profilePostUrl(post, profileUsername, tab) {
  const params = new URLSearchParams({
    folder: 'ALL FOLDERS',
    codec: 'all',
    sort: 'newest',
    play: post.path,
  });
  if (tab !== 'saved') params.set('author', profileUsername);
  return '/reels?' + params.toString();
}
