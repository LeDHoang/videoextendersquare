import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Button, Field } from '../components/ui/controls.jsx';
import { Hero, Mono, Section } from '../components/ui/primitives.jsx';
import { SectionSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';

export default function ProfileSettingsPage() {
  const { user, loading, setUser } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ display_name: '', bio: '', website: '' });
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) setForm({ display_name: user.display_name || '', bio: user.bio || '', website: user.website || '' });
  }, [user]);

  if (loading) return <SectionSkeleton label="Loading account" />;
  if (!user) return <Navigate to={'/login?next=' + encodeURIComponent('/settings/profile')} replace />;

  const saveProfile = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.patch('/api/users/me', form);
      setUser(result.user);
      setMessage('PROFILE UPDATED');
    } catch (requestError) {
      setError(requestError.message || 'Could not update profile.');
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.upload('/api/users/me/avatar', file);
      setUser(result.user);
      setMessage('AVATAR UPDATED');
    } catch (requestError) {
      setError(requestError.message || 'Could not update avatar.');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  };

  const removeAvatar = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.delete('/api/users/me/avatar');
      setUser(result.user);
      setMessage('AVATAR REMOVED');
    } catch (requestError) {
      setError(requestError.message || 'Could not remove avatar.');
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api.patch('/api/auth/password', passwords);
      setPasswords({ current_password: '', new_password: '' });
      setMessage('PASSWORD UPDATED');
    } catch (requestError) {
      setError(requestError.message || 'Could not update password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Hero title="PROFILE SETTINGS" kicker={'SIGNED IN AS @' + user.username} />
      <Section num={1} title="Public Profile" active note="DISPLAY NAME · BIO · WEBSITE · AVATAR">
        <div className="sx-settings-grid">
          <div className="sx-settings-avatar">
            <span style={{ backgroundColor: user.avatar_color }}>
              {user.avatar_url ? <img src={user.avatar_url} alt="" /> : (user.display_name || user.username).slice(0, 2).toUpperCase()}
            </span>
            <label className="sx-upload-avatar">
              UPLOAD AVATAR
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadAvatar} disabled={busy} />
            </label>
            {user.avatar_url ? <Button onClick={removeAvatar} disabled={busy}>REMOVE</Button> : null}
          </div>
          <div className="sx-settings-fields">
            <Field label="USERNAME (LOCKED)">
              <input className="sx-input" value={user.username} disabled />
            </Field>
            <Field label="DISPLAY NAME">
              <input className="sx-input" maxLength={60} value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} />
            </Field>
            <Field label={'BIO (' + form.bio.length + '/150)'}>
              <textarea className="sx-textarea" maxLength={150} value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value })} />
            </Field>
            <Field label="WEBSITE">
              <input className="sx-input" type="url" placeholder="https://example.com" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} />
            </Field>
            <Button primary loading={busy} disabled={busy} onClick={saveProfile}>SAVE PROFILE</Button>
          </div>
        </div>
      </Section>

      <Section num={2} title="Password" active note="MINIMUM 10 CHARACTERS">
        <div className="sx-settings-fields">
          <Field label="CURRENT PASSWORD">
            <input className="sx-input" type="password" autoComplete="current-password" value={passwords.current_password} onChange={(event) => setPasswords({ ...passwords, current_password: event.target.value })} />
          </Field>
          <Field label="NEW PASSWORD">
            <input className="sx-input" type="password" minLength={10} autoComplete="new-password" value={passwords.new_password} onChange={(event) => setPasswords({ ...passwords, new_password: event.target.value })} />
          </Field>
          <Button disabled={busy || !passwords.current_password || passwords.new_password.length < 10} onClick={changePassword}>CHANGE PASSWORD</Button>
        </div>
      </Section>

      {message ? <Mono>✓ {message}</Mono> : null}
      {error ? <div className="sx-error-box" role="alert">{error}</div> : null}
      <Button onClick={() => navigate('/profile/' + user.username)}>← BACK TO PROFILE</Button>
    </div>
  );
}
