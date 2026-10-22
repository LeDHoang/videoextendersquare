import { api } from '../api/client.js';
import { PENDING_ACTION_KEY, readPendingAction } from './authForm.js';

// Re-run the like/save/follow/comment a signed-out visitor attempted, once they are signed in.
export async function replayPendingAction() {
  const pending = readPendingAction();
  try {
    sessionStorage.removeItem(PENDING_ACTION_KEY);
  } catch {
    // Storage can be unavailable in privacy modes; authentication still succeeds.
  }
  if (!pending) return;
  if (pending.kind === 'like' && pending.post_id) {
    await api.put('/api/posts/' + encodeURIComponent(pending.post_id) + '/like');
  } else if (pending.kind === 'save' && pending.post_id) {
    await api.put('/api/posts/' + encodeURIComponent(pending.post_id) + '/save');
  } else if (pending.kind === 'follow' && pending.username) {
    await api.put('/api/users/' + encodeURIComponent(pending.username) + '/follow');
  } else if (pending.kind === 'comment' && pending.post_id && pending.text) {
    await api.post('/api/posts/' + encodeURIComponent(pending.post_id) + '/comments', {
      text: pending.text,
      timestamp: pending.timestamp ?? null,
    });
  } else if (pending.kind === 'comment-like' && pending.comment_id) {
    await api.put('/api/comments/' + encodeURIComponent(pending.comment_id) + '/like');
  }
}
