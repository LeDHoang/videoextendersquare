import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { AuthLayout, StatusGlyph } from '../components/auth/AuthKit.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { safeNext } from '../utils/authForm.js';
import { replayPendingAction } from '../utils/replayPending.js';

const RAIL = {
  kicker: 'EMAIL VERIFICATION',
  headline: ['ONE LINK', 'AWAY FROM', 'YOUR PROFILE.'],
  listLabel: 'Verification steps',
  items: [
    { title: 'SIGN UP', text: 'Pick a username and password.' },
    { title: 'OPEN THE LINK', text: 'It works once and expires after 24 hours.' },
    { title: 'YOU ARE IN', text: 'Your account is created and you are signed in.' },
  ],
};

// Token -> { status, post, ready, handled }. The token is single use, and this page can mount
// more than once for one link: React runs effects twice in development, and setUser below
// remounts the app shell (AppShell keys MessagingProvider on the user id) while the page is
// still on /verify-email, because React Router commits navigation as a transition after the
// urgent user update. A ref dies with the component; this map lives as long as the module, so
// every mount shares one POST and one pending-action replay.
const verifications = new Map();

function verifyOnce(token) {
  let entry = verifications.get(token);
  if (entry) return entry;
  entry = { status: 'working', handled: false };
  entry.post = api.post('/api/auth/verify-email', { token }).then(
    (result) => {
      entry.status = 'done';
      return result.user;
    },
    (error) => {
      entry.status = 'invalid';
      throw error;
    },
  );
  entry.ready = entry.post.then(async (user) => {
    try {
      await replayPendingAction();
    } catch {
      // The account is verified even if the original interaction no longer exists.
    }
    return user;
  });
  // Mounts attach their own handlers; this only keeps a rejection from going unhandled.
  entry.ready.catch(() => {});
  verifications.set(token, entry);
  return entry;
}

// The link in the email lands here.
export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState(() => (token ? verifications.get(token)?.status || 'working' : 'invalid'));

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    const entry = verifyOnce(token);
    entry.post.then(
      () => active && setState('done'),
      () => active && setState('invalid'),
    );
    entry.ready.then(
      (user) => {
        // Only the first live mount signs in; a remount after that finds the token handled.
        if (!active || entry.handled) return;
        entry.handled = true;
        // Navigate before the user changes: the new user id remounts the app shell, so the page
        // must already be on its way out, and the mount that replaces it does nothing above.
        navigate(safeNext('/reels'), { replace: true });
        setUser(user);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [token, setUser, navigate]);

  return (
    <AuthLayout
      rail={{ ...RAIL, activeIndex: state === 'invalid' ? 1 : 2 }}
      title={state === 'invalid' ? 'LINK EXPIRED' : state === 'done' ? 'EMAIL VERIFIED' : 'VERIFYING…'}
    >
      {state === 'invalid' ? (
        <div className="sx-au-state">
          <StatusGlyph kind="alert" />
          <p className="sx-au-state-lead">This verification link is invalid, already used or expired. Sign in to request a new one, or create the account again.</p>
          <div className="sx-au-actions">
            <Link className="sx-au-submit sx-au-submit--link" to="/login">SIGN IN</Link>
            <Link className="sx-au-secondary" to="/signup">CREATE ACCOUNT</Link>
          </div>
        </div>
      ) : (
        <div className="sx-au-state" role="status">
          <StatusGlyph kind={state === 'done' ? 'check' : 'mail'} />
          <p className="sx-au-state-lead">{state === 'done' ? 'Your email is verified. Taking you in…' : 'Confirming your email…'}</p>
        </div>
      )}
    </AuthLayout>
  );
}
