import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { AuthCheckbox, AuthField, AuthLayout, AuthNotice, PasswordField, PasswordRules, SubmitButton } from '../components/auth/AuthKit.jsx';
import CheckEmailView from '../components/auth/CheckEmailView.jsx';
import Turnstile from '../components/auth/Turnstile.jsx';
import useBotCheck from '../components/auth/useBotCheck.js';
import { useAuth } from '../hooks/AuthContext.jsx';
import {
  DISPLAY_NAME_MAX,
  USERNAME_MAX,
  describePending,
  normalizeUsername,
  readPendingAction,
  safeNext,
  validateEmail,
  validateNewPassword,
  validateUsername,
} from '../utils/authForm.js';
import { replayPendingAction } from '../utils/replayPending.js';

const RAIL = {
  login: {
    kicker: 'MEMBER ACCESS',
    headline: ['PICK UP', 'WHERE YOU', 'LEFT OFF.'],
    listLabel: 'What you get back',
    items: [
      { title: 'FOLLOWING FEED', text: 'New reels and images from the creators you follow.' },
      { title: 'SAVED + LIKED', text: 'Everything you bookmarked, exactly where you left it.' },
      { title: 'MESSAGES + PACKS', text: 'Your conversations, reel packs and credits.' },
    ],
  },
  register: {
    kicker: 'NEW PROFILE',
    headline: ['MAKE YOUR', 'SIGNAL', 'HEARD.'],
    listLabel: 'What a profile unlocks',
    items: [
      { title: 'PUBLISH', text: 'Share images and spatial reels with the community.' },
      { title: 'CURATE', text: 'Group reels into packs people can follow and replay.' },
      { title: 'CONNECT', text: 'Follow creators, comment, and message them directly.' },
    ],
  },
};

const EMPTY_FORM = { email: '', username: '', display_name: '', identifier: '', password: '', accept_terms: false, website: '' };

function validate(mode, form) {
  const errors = {};
  if (mode === 'register') {
    const email = validateEmail(form.email);
    const username = validateUsername(form.username);
    const password = validateNewPassword(form.password);
    if (email) errors.email = email;
    if (username) errors.username = username;
    if (password) errors.password = password;
    if (!form.accept_terms) errors.accept_terms = 'Agree to the Terms of Service and Privacy Policy to create an account.';
  } else {
    if (!form.identifier.trim()) errors.identifier = 'Enter your email or username.';
    if (!form.password) errors.password = 'Enter your password.';
  }
  return errors;
}

export default function AuthPage({ mode = 'login' }) {
  const isRegister = mode === 'register';
  const { user, loading, login, register } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next') || location.state?.next);
  const [form, setForm] = useState(EMPTY_FORM);
  const [touched, setTouched] = useState({});
  const [serverErrors, setServerErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  // Sign-in shows the bot check only once the server asks for one (after repeated failures).
  const [botWanted, setBotWanted] = useState(false);
  const bot = useBotCheck(isRegister ? 'signup' : 'login', isRegister || botWanted);
  const [unverifiedHint, setUnverifiedHint] = useState(false);
  const [suspendedHint, setSuspendedHint] = useState(false);
  const fields = useRef({});
  const previousMode = useRef(mode);

  const pendingLabel = useMemo(() => describePending(readPendingAction()), []);
  const errors = useMemo(() => validate(mode, form), [mode, form]);
  const shownError = (name) => serverErrors[name] || (touched[name] ? errors[name] : '');
  const focusField = (name) => fields.current[name]?.focus();

  useEffect(() => {
    if (!loading && user) navigate(next, { replace: true });
  }, [loading, user, navigate, next]);

  // Switching between sign in and create account keeps this component mounted; start clean.
  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    setForm(EMPTY_FORM);
    setTouched({});
    setServerErrors({});
    setError('');
    setSent(null);
    setUnverifiedHint(false);
    focusField(isRegister ? 'email' : 'identifier');
  }, [mode, isRegister]);

  const update = (key, transform = (value) => value) => (event) => {
    const value = transform(event.target.value);
    setForm((current) => ({ ...current, [key]: value }));
    setServerErrors((current) => (current[key] ? { ...current, [key]: '' } : current));
    if (error) setError('');
  };
  const blur = (key) => () => setTouched((current) => ({ ...current, [key]: true }));
  const bind = (key) => ({
    value: form[key],
    onChange: update(key, key === 'username' ? normalizeUsername : undefined),
    onBlur: blur(key),
    error: shownError(key),
    inputRef: (node) => { fields.current[key] = node; },
  });

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const names = isRegister ? ['email', 'username', 'password', 'accept_terms'] : ['identifier', 'password'];
    setTouched((current) => ({ ...current, ...Object.fromEntries(names.map((name) => [name, true])) }));
    const firstInvalid = names.find((name) => errors[name]);
    if (firstInvalid) {
      focusField(firstInvalid);
      return;
    }
    if (bot.needsToken) {
      setError(isRegister ? 'Complete the bot check before creating your account.' : 'Complete the bot check before signing in.');
      return;
    }
    const turnstileToken = bot.consume();
    setBusy(true);
    setError('');
    setUnverifiedHint(false);
    setSuspendedHint(false);
    try {
      if (isRegister) {
        const payload = {
          email: form.email.trim(),
          username: form.username,
          display_name: form.display_name.trim(),
          password: form.password,
          accept_terms: form.accept_terms,
          website: form.website,
        };
        if (turnstileToken) payload.turnstile_token = turnstileToken;
        const result = await register(payload);
        // No session yet: the account is created when the emailed link is opened.
        setSent({ email: payload.email, debugToken: result?.debug_token || '' });
        return;
      } else {
        const credentials = { identifier: form.identifier.trim(), password: form.password };
        if (turnstileToken) credentials.turnstile_token = turnstileToken;
        await login(credentials);
      }
      try {
        await replayPendingAction();
      } catch {
        // The account is authenticated even if the original interaction no longer exists.
      }
      navigate(next, { replace: true });
    } catch (requestError) {
      const field = requestError?.detail?.field;
      const message = requestError?.message || 'Unable to continue.';
      if (isRegister && ['email', 'username', 'password', 'accept_terms'].includes(field)) {
        setServerErrors((current) => ({ ...current, [field]: message }));
        focusField(field);
      } else if (!isRegister && requestError?.code === 'BOT_CHECK_FAILED' && !botWanted) {
        setBotWanted(true);
        setError('Too many failed sign-ins. Complete the bot check, then sign in.');
      } else {
        setError(message);
        if (requestError?.code === 'ACCOUNT_SUSPENDED') setSuspendedHint(true);
        if (requestError?.code === 'INVALID_CREDENTIALS') {
          setUnverifiedHint(true);
          setForm((current) => ({ ...current, password: '' }));
          // The alert already explains it; don't also nag that the emptied field is required.
          setTouched((current) => ({ ...current, password: false }));
          focusField('password');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const resendVerification = async (email, turnstileToken) => (
    api.post('/api/auth/resend-verification', turnstileToken ? { email, turnstile_token: turnstileToken } : { email })
  );

  const resendFromLogin = async () => {
    const identifier = form.identifier.trim();
    if (!identifier.includes('@')) {
      setError('Enter the email you signed up with, then ask for a new verification link.');
      focusField('identifier');
      return;
    }
    if (bot.needsToken) {
      setError('Complete the bot check before resending the link.');
      return;
    }
    const turnstileToken = bot.consume();
    setBusy(true);
    try {
      const result = await resendVerification(identifier, turnstileToken);
      setSent({ email: identifier, debugToken: result?.debug_token || '' });
    } catch (requestError) {
      if (requestError?.code === 'BOT_CHECK_FAILED' && !botWanted) {
        setBotWanted(true);
        setError('Complete the bot check before resending the link.');
        return;
      }
      setError(requestError?.message || 'Could not resend the email.');
    } finally {
      setBusy(false);
    }
  };

  const withNext = (path) => path + '?next=' + encodeURIComponent(next);
  const tabs = [
    { to: withNext('/login'), label: 'SIGN IN', active: !isRegister },
    { to: withNext('/signup'), label: 'CREATE ACCOUNT', active: isRegister },
  ];

  return (
    <AuthLayout
      rail={RAIL[isRegister ? 'register' : 'login']}
      tabs={tabs}
      title={sent ? 'CHECK YOUR EMAIL' : isRegister ? 'CREATE PROFILE' : 'SIGN IN'}
      intro={sent ? null : isRegister
        ? 'Publish images and reels, follow creators, and keep your interactions attached to your profile.'
        : 'Continue to your profile, Following feed, and saved posts.'}
    >
      {sent ? (
        <CheckEmailView
          email={sent.email}
          debugToken={sent.debugToken}
          onResend={(turnstileToken) => resendVerification(sent.email, turnstileToken)}
          onChangeEmail={() => { setSent(null); setError(''); }}
        />
      ) : (
      <>
      {pendingLabel ? (
        <AuthNotice tone="info">ONCE YOU&apos;RE {isRegister ? 'SET UP' : 'SIGNED IN'}, WE&apos;LL {pendingLabel}.</AuthNotice>
      ) : null}

      <form onSubmit={submit} className="sx-au-form" noValidate>
        {isRegister ? (
          <>
            <AuthField
              label="EMAIL"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="email"
              placeholder="you@example.com"
              {...bind('email')}
            />
            <AuthField
              label="USERNAME"
              prefix="@"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={USERNAME_MAX}
              placeholder="your_handle"
              hint="3–30 characters · a–z, 0–9, underscore"
              suffix={<span className="sx-au-count" aria-hidden="true">{form.username.length}/{USERNAME_MAX}</span>}
              {...bind('username')}
            />
            <AuthField
              label="DISPLAY NAME"
              aside={<span className="sx-au-optional">OPTIONAL</span>}
              autoComplete="name"
              maxLength={DISPLAY_NAME_MAX}
              placeholder={form.username || 'Defaults to your username'}
              value={form.display_name}
              onChange={update('display_name')}
            />
            <PasswordField label="PASSWORD" autoComplete="new-password" {...bind('password')} />
            <PasswordRules password={form.password} />
            <div className="sx-au-hp" aria-hidden="true">
              <label>
                Website
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.website}
                  onChange={update('website')}
                />
              </label>
            </div>
            <AuthCheckbox
              checked={form.accept_terms}
              onChange={(event) => {
                const { checked } = event.target;
                setForm((current) => ({ ...current, accept_terms: checked }));
                setTouched((current) => ({ ...current, accept_terms: true }));
                setServerErrors((current) => (current.accept_terms ? { ...current, accept_terms: '' } : current));
              }}
              error={shownError('accept_terms')}
              inputRef={(node) => { fields.current.accept_terms = node; }}
            >
              I agree to the{' '}
              <Link className="sx-au-link" to="/terms" target="_blank" rel="noopener">Terms of Service</Link>
              {' '}and{' '}
              <Link className="sx-au-link" to="/privacy" target="_blank" rel="noopener">Privacy Policy</Link>.
            </AuthCheckbox>
          </>
        ) : (
          <>
            <AuthField
              label="EMAIL OR USERNAME"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              {...bind('identifier')}
            />
            <PasswordField
              label="PASSWORD"
              autoComplete="current-password"
              aside={<Link className="sx-au-link" to="/forgot-password">FORGOT PASSWORD?</Link>}
              {...bind('password')}
            />
          </>
        )}
        <Turnstile
          {...bot.widget}
          // Only a bot-check prompt goes away with a new token; the widget re-issues one after every attempt.
          onToken={(token) => { bot.widget.onToken(token); if (token && /bot check|verify you are human/i.test(error)) setError(''); }}
        />
        {error ? <AuthNotice tone="err">{error}</AuthNotice> : null}
        {!isRegister && unverifiedHint ? (
          <p className="sx-au-hint">
            Signed up but never opened the verification email?{' '}
            <button type="button" className="sx-au-link sx-au-linkbtn" onClick={resendFromLogin} disabled={busy}>Resend the link</button>
          </p>
        ) : null}
        {!isRegister && suspendedHint ? (
          <p className="sx-au-hint">
            Think this was a mistake?{' '}
            <Link className="sx-au-link" to="/support?category=appeal">Appeal on the Support page</Link>
          </p>
        ) : null}
        <SubmitButton busy={busy}>{isRegister ? 'CREATE ACCOUNT' : 'SIGN IN'}</SubmitButton>
      </form>

      <div className="sx-au-foot">
        <span>
          {isRegister ? 'Already have an account? ' : 'New to ECHO? '}
          <Link className="sx-au-link" to={withNext(isRegister ? '/login' : '/signup')}>
            {isRegister ? 'Sign in' : 'Create one'}
          </Link>
        </span>
        <Link className="sx-au-link sx-au-link--quiet" to={next}>← CONTINUE BROWSING</Link>
      </div>
      </>
      )}
    </AuthLayout>
  );
}
