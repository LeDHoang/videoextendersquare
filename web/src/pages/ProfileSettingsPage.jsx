import { useEffect, useId, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { PasswordMeter } from '../components/auth/AuthKit.jsx';
import RichText from '../components/ui/RichText.jsx';
import { SectionSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useWallet } from '../hooks/WalletContext.jsx';
import { PASSWORD_MAX, PASSWORD_MIN } from '../utils/authForm.js';
import { hardRedirect } from '../utils/hardRedirect.js';
import { tokenizeRichText } from '../utils/richText.js';

const BIO_MAX = 150;

const AVATAR_ERRORS = {
  AVATAR_TOO_LARGE: 'That image is over 5 MB. Export or compress it under 5 MB and retry.',
  AVATAR_DIMENSIONS_TOO_LARGE: 'That image has too many pixels. Shrink it (e.g. 2048 px wide) and retry.',
  INVALID_AVATAR: 'That file is not a readable PNG, JPEG, or WebP image. iPhone HEIC photos must be exported as JPG/PNG first.',
};

const BLOCK_ERRORS = {
  SELF_BLOCK: 'You cannot restrict your own account.',
  USER_NOT_FOUND: 'No active profile has that handle.',
};

function Panel({ title, note, tone, status, children, id }) {
  const titleId = useId();
  return (
    <section className={'sx-ps-panel' + (tone ? ' sx-ps-panel--' + tone : '')} aria-labelledby={titleId} id={id}>
      <header className="sx-ps-panel-head">
        <h2 id={titleId}>{title}</h2>
        {status ? <span className={'sx-ps-panel-note sx-ps-panel-note--' + (status.tone || 'muted')}>{status.text}</span> : null}
        {!status && note ? <span className="sx-ps-panel-note">{note}</span> : null}
      </header>
      {children}
    </section>
  );
}

function FieldRow({ label, meta, htmlFor, children }) {
  return (
    <div className="sx-ps-field">
      <div className="sx-ps-field-head">
        <label className="sx-ps-label" htmlFor={htmlFor}>{label}</label>
        {meta ? <span className="sx-ps-meta">{meta}</span> : null}
      </div>
      {children}
    </div>
  );
}

// Password input with a SHOW/HIDE toggle; `name` makes the toggle's label specific ("Show new password").
function PasswordInput({ name, ...inputProps }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="sx-ps-inline">
      <input className="sx-ps-input" type={shown ? 'text' : 'password'} {...inputProps} />
      <button
        type="button"
        className="sx-ps-btn sx-ps-btn--small sx-ps-btn--quiet"
        aria-pressed={shown}
        aria-label={(shown ? 'Hide ' : 'Show ') + name}
        onClick={() => setShown((value) => !value)}
      >
        {shown ? 'HIDE' : 'SHOW'}
      </button>
    </div>
  );
}

function Feedback({ state }) {
  if (!state) return null;
  return state.ok
    ? <div className="sx-ps-feedback sx-ps-feedback--ok" role="status">✓ {state.text}</div>
    : <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">{state.text}</div>;
}

function Check({ pass, children, advisory = false }) {
  return (
    <li className={'sx-ps-check' + (pass ? ' sx-ps-check--pass' : '')}>
      <span aria-hidden="true">{pass ? '✓' : '○'}</span>
      <span>{children}{advisory ? <em> · RECOMMENDED</em> : null}</span>
    </li>
  );
}

/*
 * Account settings. Owner-only by construction: the route is wrapped in
 * <RequireAuth>, this page has no :username parameter, and every request below
 * is a /me endpoint that the server resolves from the session cookie (writes
 * additionally require the CSRF token). There is no way to point it at
 * another account.
 */
export default function ProfileSettingsPage() {
  const { user, loading, setUser } = useAuth();
  const { falKey, saveFalKey, deleteFalKey } = useWallet();
  const navigate = useNavigate();
  const avatarInputRef = useRef(null);
  const [form, setForm] = useState({ display_name: '', bio: '', website: '' });
  const [busy, setBusy] = useState('');
  const [profileStatus, setProfileStatus] = useState(null);
  const [avatarStatus, setAvatarStatus] = useState(null);
  const [keyValue, setKeyValue] = useState('');
  const [keyStatus, setKeyStatus] = useState(null);
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });
  const [passwordStatus, setPasswordStatus] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [blockHandle, setBlockHandle] = useState('');
  const [blockStatus, setBlockStatus] = useState(null);
  const [blockedOpen, setBlockedOpen] = useState(true);
  const [deleteForm, setDeleteForm] = useState({ current_password: '', confirmation: '' });
  const [deleteStatus, setDeleteStatus] = useState(null);

  useEffect(() => {
    if (user) setForm({ display_name: user.display_name || '', bio: user.bio || '', website: user.website || '' });
  }, [user]);

  useEffect(() => {
    if (!user) return;
    api.get('/api/users/me/blocked')
      .then((result) => setBlocked(result.users || []))
      .catch(() => setBlocked([]));
  }, [user?.id]);

  if (loading) return <SectionSkeleton label="Loading account" />;
  if (!user) return <Navigate to={'/login?next=' + encodeURIComponent('/settings/profile')} replace />;

  const dirty = form.display_name !== (user.display_name || '')
    || form.bio !== (user.bio || '')
    || form.website !== (user.website || '');
  const initials = (user.display_name || user.username).slice(0, 2).toUpperCase();
  const hasRichBio = tokenizeRichText(form.bio).some((part) => part.type !== 'text');

  const run = async (name, work) => {
    setBusy(name);
    try {
      await work();
    } finally {
      setBusy('');
    }
  };

  const saveProfile = (event) => {
    event.preventDefault();
    return run('profile', async () => {
      setProfileStatus(null);
      try {
        const result = await api.patch('/api/users/me', form);
        setUser(result.user);
        setProfileStatus({ ok: true, text: 'PROFILE UPDATED' });
      } catch (requestError) {
        // A rejected save changes nothing, so the reason (e.g. an invalid
        // website) is shown right beside the button.
        setProfileStatus({ ok: false, text: requestError.message || 'Could not update profile.' });
      }
    });
  };

  const resetProfile = () => {
    setForm({ display_name: user.display_name || '', bio: user.bio || '', website: user.website || '' });
    setProfileStatus(null);
  };

  const uploadAvatar = async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setAvatarStatus(null);
    if (file.size > 5 * 1024 * 1024) {
      setAvatarStatus({ ok: false, text: 'That image is ' + (file.size / 1048576).toFixed(1) + ' MB — avatars must be 5 MB or smaller.' });
      input.value = '';
      return;
    }
    if (file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setAvatarStatus({ ok: false, text: 'That file is "' + file.type + '" — avatars must be PNG, JPEG, or WebP. iPhone HEIC photos must be exported as JPG/PNG first.' });
      input.value = '';
      return;
    }
    await run('avatar', async () => {
      try {
        const result = await api.upload('/api/users/me/avatar', file);
        setUser(result.user);
        setAvatarStatus({ ok: true, text: 'AVATAR UPDATED' });
      } catch (requestError) {
        setAvatarStatus({ ok: false, text: AVATAR_ERRORS[requestError.code] || requestError.message || 'Could not update avatar.' });
      }
    });
    input.value = '';
  };

  const removeAvatar = () => run('avatar', async () => {
    setAvatarStatus(null);
    try {
      const result = await api.delete('/api/users/me/avatar');
      setUser(result.user);
      setAvatarStatus({ ok: true, text: 'AVATAR REMOVED' });
    } catch (requestError) {
      setAvatarStatus({ ok: false, text: requestError.message || 'Could not remove avatar.' });
    }
  });

  const submitKey = (event) => {
    event.preventDefault();
    if (keyValue.trim().length < 8) return undefined;
    return run('key', async () => {
      setKeyStatus(null);
      try {
        await saveFalKey(keyValue.trim());
        setKeyValue('');
        setKeyStatus({ ok: true, text: 'KEY SAVED' });
      } catch (requestError) {
        setKeyStatus({ ok: false, text: requestError.message || 'Could not save the key.' });
      }
    });
  };

  const removeKey = () => run('key', async () => {
    setKeyStatus(null);
    try {
      await deleteFalKey();
      setKeyStatus({ ok: true, text: 'KEY REMOVED' });
    } catch (requestError) {
      setKeyStatus({ ok: false, text: requestError.message || 'Could not remove the key.' });
    }
  });

  const newPassword = passwords.new_password;
  const passwordRules = {
    length: newPassword.length >= PASSWORD_MIN && newPassword.length <= PASSWORD_MAX,
    different: newPassword.length > 0 && newPassword !== passwords.current_password,
    mixed: /\d/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword),
  };
  const canChangePassword = Boolean(passwords.current_password) && passwordRules.length && passwordRules.different;

  const changePassword = (event) => {
    event.preventDefault();
    if (!canChangePassword) return undefined;
    return run('password', async () => {
      setPasswordStatus(null);
      try {
        await api.patch('/api/auth/password', passwords);
        setPasswords({ current_password: '', new_password: '' });
        setPasswordStatus({ ok: true, text: 'PASSWORD UPDATED · OTHER DEVICES SIGNED OUT' });
      } catch (requestError) {
        setPasswordStatus({ ok: false, text: requestError.message || 'Could not update password.' });
      }
    });
  };

  const addBlock = (event) => {
    event.preventDefault();
    const handle = blockHandle.trim().replace(/^@+/, '');
    if (!handle) return undefined;
    return run('block', async () => {
      setBlockStatus(null);
      try {
        await api.put('/api/users/' + encodeURIComponent(handle) + '/block');
        const result = await api.get('/api/users/me/blocked');
        setBlocked(result.users || []);
        // Keep anything the user already started typing for the next handle.
        setBlockHandle((current) => (current.trim().replace(/^@+/, '') === handle ? '' : current));
        setBlockedOpen(true);
        setBlockStatus({ ok: true, text: '@' + handle + ' RESTRICTED' });
      } catch (requestError) {
        setBlockStatus({ ok: false, text: BLOCK_ERRORS[requestError.code] || requestError.message || 'Could not restrict this account.' });
      }
    });
  };

  const unblockUser = (username) => run('block', async () => {
    setBlockStatus(null);
    try {
      await api.delete('/api/users/' + encodeURIComponent(username) + '/block');
      setBlocked((current) => (current || []).filter((person) => person.username !== username));
      setBlockStatus({ ok: true, text: '@' + username + ' UNBLOCKED' });
    } catch (requestError) {
      setBlockStatus({ ok: false, text: requestError.message || 'Could not unblock this user.' });
    }
  });

  const confirmationMatches = deleteForm.confirmation.trim().replace(/^@/, '').toLowerCase() === user.username.toLowerCase();
  const deleteAccount = (event) => {
    event.preventDefault();
    // Enter inside a field submits the form even while the button is disabled,
    // so the guards are re-checked here.
    if (!deleteForm.current_password || !confirmationMatches) return undefined;
    return run('delete', async () => {
      setDeleteStatus(null);
      try {
        // The API's own confirmation token is fixed; the typed handle below is
        // the user-facing safeguard.
        await api.delete('/api/users/me', { current_password: deleteForm.current_password, confirmation: 'DELETE' });
        // A full reload, not a client-side navigate: clearing the user would let
        // the route's RequireAuth guard win and bounce to the login screen, and
        // a reload also drops every bit of the deleted account's cached state.
        hardRedirect('/reels');
      } catch (requestError) {
        setDeleteStatus({ ok: false, text: requestError.message || 'Could not delete account.' });
      }
    });
  };

  const blockedCount = blocked?.length ?? 0;

  return (
    <div className="sx-ps">
      <header className="sx-ps-head">
        <div>
          <h1 className="sx-ps-title">PROFILE SETTINGS</h1>
          <div className="sx-ps-kicker">SIGNED IN AS @{user.username} · ONLY YOU CAN SEE AND CHANGE THIS PAGE</div>
        </div>
        <button type="button" className="sx-xh-btn" onClick={() => navigate('/profile/' + user.username)}>
          <span className="sx-xh-btn-icon" aria-hidden="true">←</span><span>VIEW PROFILE</span>
        </button>
      </header>

      <div className="sx-ps-grid">
        <div className="sx-ps-col">
          <Panel title="PUBLIC PROFILE" note="DISPLAY · BIO · AVATAR">
            <div className="sx-ps-avatar">
              <div className="sx-ps-avatar-dock">
                <span className="sx-ps-avatar-disc" style={user.avatar_url ? undefined : { backgroundColor: user.avatar_color }}>
                  {user.avatar_url ? <img src={user.avatar_url} alt="" /> : initials}
                </span>
              </div>
              <div className="sx-ps-avatar-body">
                <div className="sx-ps-avatar-name">@{user.username}</div>
                <p className="sx-ps-hint">PNG, JPEG or WebP · up to 5 MB · cropped square to 512 px.</p>
                <div className="sx-ps-actions">
                  <button type="button" className="sx-ps-btn" disabled={busy === 'avatar'} onClick={() => avatarInputRef.current?.click()}>
                    {busy === 'avatar' ? 'WORKING…' : user.avatar_url ? 'REPLACE AVATAR' : 'UPLOAD AVATAR'}
                  </button>
                  {user.avatar_url ? (
                    <button type="button" className="sx-ps-btn sx-ps-btn--quiet" disabled={busy === 'avatar'} onClick={removeAvatar}>REMOVE</button>
                  ) : null}
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={uploadAvatar}
                  disabled={busy === 'avatar'}
                  className="sx-ps-file"
                  aria-label="Choose avatar image"
                />
                <Feedback state={avatarStatus} />
              </div>
            </div>

            <form className="sx-ps-form" onSubmit={saveProfile} noValidate>
              <FieldRow label="USERNAME" meta="[IMMUTABLE HANDLE]" htmlFor="ps-username">
                <div className="sx-ps-locked">
                  <input id="ps-username" className="sx-ps-input" value={user.username} readOnly aria-readonly="true" />
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </FieldRow>
              <FieldRow label="DISPLAY NAME" htmlFor="ps-display-name">
                <input id="ps-display-name" className="sx-ps-input" maxLength={60} value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} />
              </FieldRow>
              <FieldRow label="CREATOR BIO" meta={form.bio.length + ' / ' + BIO_MAX + ' CHARS'} htmlFor="ps-bio">
                <textarea id="ps-bio" className="sx-ps-input sx-ps-textarea" rows={3} maxLength={BIO_MAX} value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value })} />
                {hasRichBio ? (
                  <div className="sx-pf-bio-preview" aria-label="Bio preview">
                    <span>PREVIEW</span>
                    <p className="sx-pf-bio"><RichText text={form.bio} /></p>
                  </div>
                ) : (
                  <p className="sx-ps-hint">Tip: #tags, @mentions and links like example.com are styled on your profile.</p>
                )}
              </FieldRow>
              <FieldRow label="WEBSITE / PORTFOLIO" htmlFor="ps-website">
                <input id="ps-website" className="sx-ps-input" type="text" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="example.com or https://example.com" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} />
              </FieldRow>
              <div className="sx-ps-submit">
                <button type="submit" className="sx-ps-btn sx-ps-btn--primary" disabled={busy === 'profile' || !dirty}>
                  <span>{busy === 'profile' ? 'SAVING…' : 'UPDATE PROFILE'}</span><span aria-hidden="true">→</span>
                </button>
                {dirty ? <button type="button" className="sx-ps-btn sx-ps-btn--quiet" onClick={resetProfile}>DISCARD CHANGES</button> : null}
              </div>
              {dirty && !profileStatus ? <p className="sx-ps-hint sx-ps-unsaved">UNSAVED CHANGES</p> : null}
              <Feedback state={profileStatus} />
            </form>
          </Panel>

          <Panel
            title="API KEY"
            note="FAL.AI · BRING YOUR OWN"
            status={falKey?.configured ? { tone: 'ok', text: 'SAVED' } : { tone: 'muted', text: 'NOT SET' }}
          >
            <div className="sx-ps-keycard">
              <div>
                <div className="sx-ps-meta">FAL.AI API KEY</div>
                <div className="sx-ps-keyvalue">
                  {falKey?.configured ? <>ACTIVE KEY: <b>{falKey.hint || 'saved'}</b></> : 'NO PERSONAL KEY · USING CREDITS'}
                </div>
              </div>
              {falKey?.configured ? <span className="sx-ps-badge">[SAVED]</span> : null}
            </div>
            <form className="sx-ps-form" onSubmit={submitKey}>
              <FieldRow label={falKey?.configured ? 'REPLACE KEY' : 'PERSONAL FAL API KEY'} htmlFor="ps-fal-key">
                <input id="ps-fal-key" className="sx-ps-input" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your Fal.ai key" value={keyValue} onChange={(event) => setKeyValue(event.target.value)} />
              </FieldRow>
              <p className="sx-ps-hint">Stored encrypted and bound to your account. It is never shown again, only its last four characters.</p>
              <div className="sx-ps-actions">
                <button type="submit" className="sx-ps-btn" disabled={busy === 'key' || keyValue.trim().length < 8}>SAVE KEY</button>
                <button type="button" className="sx-ps-btn sx-ps-btn--quiet" disabled={busy === 'key' || !falKey?.configured} onClick={removeKey}>REMOVE KEY</button>
              </div>
              <Feedback state={keyStatus} />
            </form>
          </Panel>
        </div>

        <div className="sx-ps-col">
          <Panel title="PASSWORD MANAGEMENT" note={'MIN ' + PASSWORD_MIN + ' CHARACTERS'}>
            <form className="sx-ps-form" onSubmit={changePassword}>
              <FieldRow label="CURRENT PASSWORD" htmlFor="ps-current-password">
                <PasswordInput name="current password" id="ps-current-password" autoComplete="current-password" placeholder="••••••••••••" value={passwords.current_password} onChange={(event) => setPasswords({ ...passwords, current_password: event.target.value })} />
              </FieldRow>
              <FieldRow label="NEW PASSWORD" htmlFor="ps-new-password">
                <PasswordInput name="new password" id="ps-new-password" autoComplete="new-password" maxLength={PASSWORD_MAX} placeholder="••••••••••••" value={newPassword} onChange={(event) => setPasswords({ ...passwords, new_password: event.target.value })} />
              </FieldRow>
              <PasswordMeter password={newPassword} />
              <ul className="sx-ps-checks" aria-label="Password requirements">
                <Check pass={passwordRules.length}>{PASSWORD_MIN}–{PASSWORD_MAX} CHARACTERS</Check>
                <Check pass={passwordRules.different}>DIFFERENT FROM CURRENT</Check>
                <Check pass={passwordRules.mixed} advisory>NUMBER &amp; SYMBOL</Check>
              </ul>
              <button type="submit" className="sx-ps-btn sx-ps-btn--block" disabled={busy === 'password' || !canChangePassword}>
                {busy === 'password' ? 'UPDATING…' : 'UPDATE PASSWORD'}
              </button>
              <Feedback state={passwordStatus} />
            </form>
          </Panel>

          <Panel title="BLOCKED ACCOUNTS" note="RESTRICTED PROFILES">
            <form className="sx-ps-form" onSubmit={addBlock}>
              <FieldRow label="RESTRICT A HANDLE" meta={'[' + blockedCount + ' RESTRICTED]'} htmlFor="ps-block-handle">
                <div className="sx-ps-inline">
                  <input id="ps-block-handle" className="sx-ps-input" autoCapitalize="none" spellCheck={false} placeholder="@handle to restrict…" value={blockHandle} onChange={(event) => setBlockHandle(event.target.value)} />
                  <button type="submit" className="sx-ps-btn" disabled={busy === 'block' || !blockHandle.trim().replace(/^@+/, '')}>RESTRICT</button>
                </div>
              </FieldRow>
              <Feedback state={blockStatus} />
            </form>
            <div className="sx-ps-list">
              <div className="sx-ps-list-head">
                <span><strong>BLOCKED HANDLES</strong><em>[{blockedCount}]</em></span>
                <button type="button" className="sx-ps-btn sx-ps-btn--small" aria-expanded={blockedOpen} onClick={() => setBlockedOpen((open) => !open)}>
                  {blockedOpen ? 'COLLAPSE LIST [−]' : 'EXPAND LIST [+]'}
                </button>
              </div>
              {blockedOpen ? (
                blocked === null ? <div className="sx-ps-list-empty">LOADING…</div> : blocked.length ? (
                  <ul className="sx-ps-rows">
                    {blocked.map((person) => (
                      <li key={person.id} className="sx-ps-row">
                        <span><strong>@{person.username}</strong>{person.display_name ? <small>{person.display_name}</small> : null}</span>
                        <button type="button" className="sx-ps-btn sx-ps-btn--small" disabled={busy === 'block'} onClick={() => unblockUser(person.username)}>UNBLOCK</button>
                      </li>
                    ))}
                  </ul>
                ) : <div className="sx-ps-list-empty">NO BLOCKED PROFILES</div>
              ) : null}
            </div>
          </Panel>

          {user.can_moderate ? (
            <Panel title="MODERATION" note="BETA SAFETY QUEUE">
              <button type="button" className="sx-ps-btn" onClick={() => navigate('/moderation')}>OPEN MODERATION QUEUE</button>
            </Panel>
          ) : null}

          <Panel title="DELETE ACCOUNT" tone="danger" status={{ tone: 'danger', text: 'IRREVERSIBLE' }}>
            <form className="sx-ps-form" onSubmit={deleteAccount}>
              <p className="sx-ps-hint">
                Permanently closes your account, hides all of your posts and comments, and removes your saved Fal.ai key. This cannot be undone.
              </p>
              <FieldRow label="CURRENT PASSWORD" htmlFor="ps-delete-password">
                <input id="ps-delete-password" className="sx-ps-input" type="password" autoComplete="current-password" value={deleteForm.current_password} onChange={(event) => setDeleteForm({ ...deleteForm, current_password: event.target.value })} />
              </FieldRow>
              <FieldRow label={'TYPE "' + user.username + '" TO AUTHORIZE'} htmlFor="ps-delete-confirm">
                <input id="ps-delete-confirm" className="sx-ps-input sx-ps-input--danger" autoCapitalize="none" spellCheck={false} placeholder={user.username} value={deleteForm.confirmation} onChange={(event) => setDeleteForm({ ...deleteForm, confirmation: event.target.value })} />
              </FieldRow>
              <button type="submit" className="sx-ps-btn sx-ps-btn--danger sx-ps-btn--block" disabled={busy === 'delete' || !deleteForm.current_password || !confirmationMatches}>
                {busy === 'delete' ? 'DELETING…' : 'TERMINATE PROFILE & PURGE DATA'}
              </button>
              <Feedback state={deleteStatus} />
            </form>
          </Panel>
        </div>
      </div>

      <footer className="sx-ps-foot">
        <button type="button" className="sx-ps-link" onClick={() => navigate('/reels')}>← RETURN TO REELS</button>
      </footer>
    </div>
  );
}
