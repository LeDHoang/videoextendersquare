import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';

export default function PasswordResetPage({ requestOnly = false }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const requesting = requestOnly || !token;
  const [email, setEmail] = useState('');
  const [passwords, setPasswords] = useState({ password: '', confirmation: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (requesting) {
        const result = await api.post('/api/auth/password-reset/request', { email });
        setMessage(result.debug_token
          ? 'DEVELOPMENT RESET TOKEN: ' + result.debug_token
          : result.message);
      } else {
        if (passwords.password !== passwords.confirmation) {
          setError('Passwords do not match.');
          return;
        }
        await api.post('/api/auth/password-reset/confirm', {
          token,
          new_password: passwords.password,
        });
        navigate('/login', { replace: true });
      }
    } catch (requestError) {
      setError(requestError.message || 'Could not reset password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sx-auth-shell">
      <section className="sx-auth-card">
        <div className="sx-auth-brand">ECHO ACCOUNT RECOVERY</div>
        <h1>{requesting ? 'RESET PASSWORD' : 'CHOOSE PASSWORD'}</h1>
        <p>{requesting ? 'Enter your account email and we will send a time-limited reset link.' : 'Choose a new password for your account.'}</p>
        <form onSubmit={submit} className="sx-auth-form">
          {requesting ? (
            <label>
              EMAIL
              <input className="sx-input" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
          ) : (
            <>
              <label>
                NEW PASSWORD
                <input className="sx-input" type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={passwords.password} onChange={(event) => setPasswords({ ...passwords, password: event.target.value })} />
              </label>
              <label>
                CONFIRM PASSWORD
                <input className="sx-input" type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={passwords.confirmation} onChange={(event) => setPasswords({ ...passwords, confirmation: event.target.value })} />
              </label>
            </>
          )}
          {message ? <div className="sx-success-box" role="status">{message}</div> : null}
          {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
          <button className="sx-auth-submit" type="submit" disabled={busy}>
            {busy ? 'WORKING…' : requesting ? 'SEND RESET LINK' : 'UPDATE PASSWORD'}
          </button>
        </form>
        <Link className="sx-auth-back" to="/login">← BACK TO SIGN IN</Link>
      </section>
    </div>
  );
}
