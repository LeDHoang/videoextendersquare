import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { AuthCheckbox, AuthField, AuthLayout, AuthNotice, PasswordField, PasswordRules, SubmitButton } from '../components/auth/AuthKit.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import {
  DISPLAY_NAME_MAX,
  PENDING_ACTION_KEY,
  USERNAME_MAX,
  describePending,
  normalizeUsername,
  readPendingAction,
  safeNext,
  validateEmail,
  validateNewPassword,
  validateUsername,
} from '../utils/authForm.js';

async function replayPendingAction() {
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

const EMPTY_FORM = { email: '', username: '', display_name: '', identifier: '', password: '', accept_terms: false };

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
    setBusy(true);
    setError('');
    try {
      if (isRegister) {
        await register({
          email: form.email.trim(),
          username: form.username,
          display_name: form.display_name.trim(),
          password: form.password,
          accept_terms: form.accept_terms,
        });
      } else {
        await login({ identifier: form.identifier.trim(), password: form.password });
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
      } else {
        setError(message);
        if (requestError?.code === 'INVALID_CREDENTIALS') {
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

  const withNext = (path) => path + '?next=' + encodeURIComponent(next);
  const tabs = [
    { to: withNext('/login'), label: 'SIGN IN', active: !isRegister },
    { to: withNext('/signup'), label: 'CREATE ACCOUNT', active: isRegister },
  ];

  return (
    <AuthLayout
      rail={RAIL[isRegister ? 'register' : 'login']}
      tabs={tabs}
      title={isRegister ? 'CREATE PROFILE' : 'SIGN IN'}
      intro={isRegister
        ? 'Publish images and reels, follow creators, and keep your interactions attached to your profile.'
        : 'Continue to your profile, Following feed, and saved posts.'}
    >
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
        {error ? <AuthNotice tone="err">{error}</AuthNotice> : null}
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
    </AuthLayout>
  );
}
