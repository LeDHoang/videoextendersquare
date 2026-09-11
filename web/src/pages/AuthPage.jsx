import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../hooks/AuthContext.jsx';

function safeNext(value) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/reels';
}

async function replayPendingAction() {
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem('echo:pending-action') || 'null');
  } catch {
    pending = null;
  }
  try {
    sessionStorage.removeItem('echo:pending-action');
  } catch {
    // Storage can be unavailable in privacy modes; authentication still succeeds.
  }
  if (!pending?.kind || Date.now() - Number(pending.created_at || 0) > 10 * 60 * 1000) return;
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

export default function AuthPage({ mode = 'login' }) {
  const isRegister = mode === 'register';
  const { user, loading, login, register } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next') || location.state?.next);
  const [form, setForm] = useState({
    email: '',
    username: '',
    display_name: '',
    identifier: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && user) navigate(next, { replace: true });
  }, [loading, user, navigate, next]);

  const update = (key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (isRegister) {
        await register({
          email: form.email,
          username: form.username,
          display_name: form.display_name,
          password: form.password,
        });
      } else {
        await login({ identifier: form.identifier, password: form.password });
      }
      try {
        await replayPendingAction();
      } catch {
        // The account is authenticated even if the original interaction no longer exists.
      }
      navigate(next, { replace: true });
    } catch (requestError) {
      setError(requestError.message || 'Unable to continue.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sx-auth-shell">
      <section className="sx-auth-card" aria-labelledby="auth-title">
        <div className="sx-auth-brand">ECHO SOCIAL</div>
        <h1 id="auth-title">{isRegister ? 'CREATE PROFILE' : 'SIGN IN'}</h1>
        <p>
          {isRegister
            ? 'Publish images and reels, follow creators, and keep your interactions attached to your profile.'
            : 'Continue to your profile, Following feed, and saved posts.'}
        </p>

        <form onSubmit={submit} className="sx-auth-form">
          {isRegister ? (
            <>
              <label>
                EMAIL
                <input className="sx-input" type="email" required autoComplete="email" value={form.email} onChange={update('email')} />
              </label>
              <label>
                USERNAME
                <input className="sx-input" required minLength={3} maxLength={30} pattern="[a-z0-9_]+" autoComplete="username" value={form.username} onChange={update('username')} />
              </label>
              <label>
                DISPLAY NAME
                <input className="sx-input" maxLength={60} autoComplete="name" value={form.display_name} onChange={update('display_name')} />
              </label>
            </>
          ) : (
            <label>
              EMAIL OR USERNAME
              <input className="sx-input" required autoComplete="username" value={form.identifier} onChange={update('identifier')} />
            </label>
          )}
          <label>
            PASSWORD
            <input className="sx-input" type="password" required minLength={10} maxLength={128} autoComplete={isRegister ? 'new-password' : 'current-password'} value={form.password} onChange={update('password')} />
          </label>
          {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
          <button className="sx-auth-submit" type="submit" disabled={busy}>
            {busy ? 'WORKING…' : isRegister ? 'CREATE ACCOUNT' : 'SIGN IN'}
          </button>
        </form>
        {!isRegister ? <Link className="sx-auth-back" to="/forgot-password">FORGOT PASSWORD?</Link> : null}

        <div className="sx-auth-switch">
          {isRegister ? 'Already have an account? ' : 'New to ECHO? '}
          <Link to={(isRegister ? '/login' : '/signup') + '?next=' + encodeURIComponent(next)}>
            {isRegister ? 'Sign in' : 'Create one'}
          </Link>
        </div>
        <Link className="sx-auth-back" to={next}>← CONTINUE BROWSING</Link>
      </section>
    </div>
  );
}
