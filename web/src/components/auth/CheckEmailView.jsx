import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthNotice, StatusGlyph } from './AuthKit.jsx';

export const RESEND_SECONDS = 30;

// "Check your email" screen shown after sign-up (and from the sign-in hint). `onResend`
// resolves with `{debug_token?}`; the cooldown mirrors the password-reset screen.
export default function CheckEmailView({ email, debugToken, onResend, onChangeEmail }) {
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);
  const [token, setToken] = useState(debugToken || '');

  const counting = cooldown > 0;
  useEffect(() => {
    if (!counting) return undefined;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  const resend = async () => {
    if (resending || cooldown > 0) return;
    setResending(true);
    setError('');
    setResent(false);
    try {
      const result = await onResend();
      if (result?.debug_token) setToken(result.debug_token);
      setResent(true);
      setCooldown(RESEND_SECONDS);
    } catch (requestError) {
      setError(requestError?.message || 'Could not resend the email.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="sx-au-state">
      <StatusGlyph kind="mail" />
      <p className="sx-au-state-lead">
        We sent a verification link to your email. Your account is created once you open it.
      </p>
      <dl className="sx-au-facts">
        <div><dt>SENT TO</dt><dd>{email}</dd></div>
        <div><dt>LINK VALID FOR</dt><dd>24 HOURS · ONE USE</dd></div>
      </dl>
      {token ? (
        <AuthNotice tone="warn">
          DEVELOPMENT MODE · EMAIL IS NOT SENT.{' '}
          <Link className="sx-au-link" to={'/verify-email?token=' + encodeURIComponent(token)}>OPEN THE VERIFICATION LINK&nbsp;→</Link>
        </AuthNotice>
      ) : (
        <p className="sx-au-hint">Nothing in your inbox? Check spam, or resend the link.</p>
      )}
      {error ? <AuthNotice tone="err">{error}</AuthNotice> : null}
      {resent ? <AuthNotice tone="ok">If that address is waiting for verification, a new link was sent. Older links no longer work.</AuthNotice> : null}
      <div className="sx-au-actions">
        <button type="button" className="sx-au-secondary" onClick={resend} disabled={cooldown > 0 || resending}>
          {resending ? 'SENDING…' : cooldown > 0 ? 'RESEND IN ' + cooldown + 'S' : 'RESEND EMAIL'}
        </button>
        {onChangeEmail ? (
          <button type="button" className="sx-au-secondary sx-au-secondary--quiet" onClick={onChangeEmail}>USE A DIFFERENT EMAIL</button>
        ) : null}
      </div>
      <div className="sx-au-foot">
        <Link className="sx-au-link sx-au-link--quiet" to="/login">← BACK TO SIGN IN</Link>
      </div>
    </div>
  );
}
