import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { AuthField, AuthLayout, AuthNotice, PasswordField, PasswordRules, StatusGlyph, SubmitButton } from '../components/auth/AuthKit.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { validateEmail, validateNewPassword } from '../utils/authForm.js';

const RESEND_SECONDS = 30;

const RAIL = {
  kicker: 'ACCOUNT RECOVERY',
  headline: ['LOCKED OUT?', 'BACK IN', 'A MINUTE.'],
  listLabel: 'Recovery steps',
  items: [
    { title: 'ENTER YOUR EMAIL', text: 'The address your account was created with.' },
    { title: 'OPEN THE LINK', text: 'It works once and expires after 30 minutes.' },
    { title: 'CHOOSE A NEW PASSWORD', text: 'Every signed-in device is signed out when you finish.' },
  ],
};

// view: 'request' | 'sent' | 'choose' | 'done' | 'invalid'
// ('done' lives in router history state, not component state: see ResetFlow.finish)
function stepFor(view) {
  return { request: 0, sent: 1, choose: 2, invalid: 2, done: 3 }[view];
}

function BackLink({ to = '/login', children = '← BACK TO SIGN IN' }) {
  return (
    <div className="sx-au-foot">
      <Link className="sx-au-link sx-au-link--quiet" to={to}>{children}</Link>
    </div>
  );
}

function RequestForm({ onSent, notice }) {
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  const problem = validateEmail(email);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setTouched(true);
    if (problem) {
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/api/auth/password-reset/request', { email: email.trim() });
      onSent({ email: email.trim(), message: result?.message || '', debugToken: result?.debug_token || '' });
    } catch (requestError) {
      setError(requestError.message || 'Could not send the reset link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {notice}
      <form className="sx-au-form" onSubmit={submit} noValidate>
        <AuthField
          label="EMAIL"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="email"
          placeholder="you@example.com"
          value={email}
          inputRef={input}
          onChange={(event) => { setEmail(event.target.value); if (error) setError(''); }}
          onBlur={() => setTouched(true)}
          error={touched ? problem : ''}
        />
        {error ? <AuthNotice tone="err">{error}</AuthNotice> : null}
        <SubmitButton busy={busy}>SEND RESET LINK</SubmitButton>
      </form>
      <BackLink />
    </>
  );
}

function SentView({ sent, onResend, onChangeEmail }) {
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);

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
      await onResend();
      setResent(true);
      setCooldown(RESEND_SECONDS);
    } catch (requestError) {
      setError(requestError.message || 'Could not resend the link.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="sx-au-state">
      <StatusGlyph kind="mail" />
      <p className="sx-au-state-lead">{sent.message || 'If that email belongs to an active account, a reset link has been sent.'}</p>
      <dl className="sx-au-facts">
        <div><dt>SENT TO</dt><dd>{sent.email}</dd></div>
        <div><dt>LINK VALID FOR</dt><dd>30 MINUTES · ONE USE</dd></div>
      </dl>
      {sent.debugToken ? (
        <AuthNotice tone="warn">
          DEVELOPMENT MODE · EMAIL IS NOT SENT.{' '}
          <Link className="sx-au-link" to={'/reset-password?token=' + encodeURIComponent(sent.debugToken)}>OPEN THE RESET LINK&nbsp;→</Link>
        </AuthNotice>
      ) : (
        <p className="sx-au-hint">Nothing in your inbox? Check spam, or confirm you used the email on your account.</p>
      )}
      {error ? <AuthNotice tone="err">{error}</AuthNotice> : null}
      {resent ? <AuthNotice tone="ok">A new link was requested. Older links no longer work.</AuthNotice> : null}
      <div className="sx-au-actions">
        <button type="button" className="sx-au-secondary" onClick={resend} disabled={cooldown > 0 || resending}>
          {resending ? 'SENDING…' : cooldown > 0 ? 'RESEND IN ' + cooldown + 'S' : 'RESEND LINK'}
        </button>
        <button type="button" className="sx-au-secondary sx-au-secondary--quiet" onClick={onChangeEmail}>USE A DIFFERENT EMAIL</button>
      </div>
      <BackLink />
    </div>
  );
}

function ChooseForm({ token, onDone, onInvalid }) {
  const [values, setValues] = useState({ password: '', confirmation: '' });
  const [touched, setTouched] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [serverError, setServerError] = useState('');
  const fields = useRef({});

  const errors = {};
  const passwordProblem = validateNewPassword(values.password);
  if (passwordProblem) errors.password = passwordProblem;
  if (!values.confirmation) errors.confirmation = 'Type the new password again.';
  else if (values.confirmation !== values.password) errors.confirmation = 'Passwords do not match.';
  const shown = (name) => (name === 'password' && serverError) || (touched[name] ? errors[name] : '');
  const matches = values.confirmation !== '' && values.confirmation === values.password && !passwordProblem;

  const set = (name) => (event) => {
    setValues((current) => ({ ...current, [name]: event.target.value }));
    if (name === 'password') setServerError('');
    if (error) setError('');
  };
  const blur = (name) => () => setTouched((current) => ({ ...current, [name]: true }));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setTouched({ password: true, confirmation: true });
    const firstInvalid = ['password', 'confirmation'].find((name) => errors[name]);
    if (firstInvalid) {
      fields.current[firstInvalid]?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/password-reset/confirm', { token, new_password: values.password });
      onDone();
    } catch (requestError) {
      if (requestError.code === 'INVALID_RESET_TOKEN') {
        onInvalid();
      } else if (requestError.detail?.field === 'password') {
        setServerError(requestError.message);
        fields.current.password?.focus();
      } else {
        setError(requestError.message || 'Could not reset password.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="sx-au-form" onSubmit={submit} noValidate>
        <PasswordField
          label="NEW PASSWORD"
          autoComplete="new-password"
          value={values.password}
          onChange={set('password')}
          onBlur={blur('password')}
          error={shown('password')}
          inputRef={(node) => { fields.current.password = node; }}
        />
        <PasswordRules password={values.password} />
        <PasswordField
          label="CONFIRM PASSWORD"
          autoComplete="new-password"
          value={values.confirmation}
          onChange={set('confirmation')}
          onBlur={blur('confirmation')}
          error={shown('confirmation')}
          hint={matches ? '✓ PASSWORDS MATCH' : undefined}
          inputRef={(node) => { fields.current.confirmation = node; }}
        />
        {error ? <AuthNotice tone="err">{error}</AuthNotice> : null}
        <SubmitButton busy={busy}>UPDATE PASSWORD</SubmitButton>
      </form>
      <BackLink />
    </>
  );
}

function ResetFlow({ requestOnly, token, updated }) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const choosing = !requestOnly && Boolean(token);
  const [phase, setPhase] = useState('form'); // 'form' | 'sent' | 'invalid'
  const [sent, setSent] = useState(null);

  const view = updated ? 'done' : phase === 'form' ? (choosing ? 'choose' : 'request') : phase;

  // A confirmed reset revokes every session server-side, including this browser's own, so
  // re-read /me to stop the header showing a signed-in account. That flips the user and the
  // app shell remounts this whole page (AppShell keys on the user id), which would throw away
  // component state. The result therefore goes into history state, which survives the remount,
  // and the one-time token leaves the URL at the same time.
  const finish = () => {
    navigate('/reset-password', { replace: true, state: { passwordUpdated: true } });
    refresh?.();
  };

  const resend = () => api.post('/api/auth/password-reset/request', { email: sent.email }).then((result) => {
    setSent((current) => ({ ...current, message: result?.message || current.message, debugToken: result?.debug_token || current.debugToken }));
  });

  let title = 'RESET PASSWORD';
  let intro = 'Enter your account email and we will send a time-limited reset link.';
  let body;
  if (view === 'sent') {
    title = 'CHECK YOUR INBOX';
    intro = null;
    body = <SentView sent={sent} onResend={resend} onChangeEmail={() => { setSent(null); setPhase('form'); }} />;
  } else if (view === 'choose') {
    title = 'CHOOSE PASSWORD';
    intro = 'Choose a new password for your account. You will be signed out everywhere else.';
    body = <ChooseForm token={token} onDone={finish} onInvalid={() => setPhase('invalid')} />;
  } else if (view === 'done') {
    title = 'PASSWORD UPDATED';
    intro = null;
    body = (
      <div className="sx-au-state">
        <StatusGlyph kind="check" />
        <p className="sx-au-state-lead">Your password was changed and every session was signed out, including this one. Sign in with the new password.</p>
        <div className="sx-au-actions">
          <Link className="sx-au-submit sx-au-submit--link" to="/login">SIGN IN</Link>
        </div>
      </div>
    );
  } else if (view === 'invalid') {
    title = 'LINK EXPIRED';
    intro = null;
    body = (
      <div className="sx-au-state">
        <StatusGlyph kind="alert" />
        <p className="sx-au-state-lead">This password reset link is invalid or expired. Links work once and last 30 minutes.</p>
        <div className="sx-au-actions">
          <Link className="sx-au-submit sx-au-submit--link" to="/forgot-password">REQUEST A NEW LINK</Link>
        </div>
        <BackLink />
      </div>
    );
  } else {
    body = (
      <RequestForm
        onSent={(result) => { setSent(result); setPhase('sent'); }}
        notice={!requestOnly ? <AuthNotice tone="warn">THAT LINK IS MISSING ITS RESET TOKEN. REQUEST A FRESH ONE BELOW.</AuthNotice> : null}
      />
    );
  }

  const step = stepFor(view);
  return (
    <AuthLayout
      rail={{ ...RAIL, activeIndex: step }}
      title={title}
      intro={intro}
      step={view === 'done' || view === 'invalid' ? null : 'STEP ' + (step + 1) + ' OF 3'}
    >
      {body}
    </AuthLayout>
  );
}

// Keyed on the route + token so moving between /reset-password and /forgot-password
// (for example from the "link expired" screen) always starts a fresh flow.
export default function PasswordResetPage({ requestOnly = false }) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const token = searchParams.get('token') || '';
  const updated = !requestOnly && Boolean(location.state?.passwordUpdated);
  const key = (requestOnly ? 'request:' : 'reset:') + token + (updated ? ':updated' : '');
  return <ResetFlow key={key} requestOnly={requestOnly} token={token} updated={updated} />;
}
