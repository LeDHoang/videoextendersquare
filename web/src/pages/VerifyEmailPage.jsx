import { useEffect, useRef, useState } from 'react';
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

// The link in the email lands here. The token is single use, so the POST must run once even
// though React may mount effects twice in development.
export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState(token ? 'working' : 'invalid');
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api
      .post('/api/auth/verify-email', { token })
      .then(async (result) => {
        setState('done');
        // Replay before the user changes: a new user id remounts the app shell, and the
        // token in this URL is single use, so the page must already be on its way out.
        try {
          await replayPendingAction();
        } catch {
          // The account is verified even if the original interaction no longer exists.
        }
        navigate(safeNext('/reels'), { replace: true });
        setUser(result.user);
      })
      .catch(() => setState('invalid'));
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
