import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../hooks/AuthContext.jsx';
import { validateEmail } from '../utils/authForm.js';

/*
 * Public support inbox (POST /api/support). Works signed out on purpose: suspended accounts
 * cannot sign in and still need to appeal. Prefills come from ?category= and ?link=.
 */
export const SUPPORT_CATEGORIES = [
  { value: 'appeal', label: 'Appeal a moderation decision' },
  { value: 'report_content', label: 'Report a post, Reel Pack or profile' },
  { value: 'copyright', label: 'Copyright complaint' },
  { value: 'privacy', label: 'Privacy or data request' },
  { value: 'account', label: 'Account help' },
  { value: 'bug', label: 'Bug report' },
  { value: 'other', label: 'Something else' },
];
const SUBJECT_MAX = 120;
const BODY_MAX = 4000;
const LINK_MAX = 500;

function Field({ label, htmlFor, meta, children }) {
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

export default function SupportPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const initialCategory = SUPPORT_CATEGORIES.some((item) => item.value === searchParams.get('category'))
    ? searchParams.get('category')
    : 'other';
  const [form, setForm] = useState({
    category: initialCategory,
    email: '',
    subject: '',
    body: '',
    link: (searchParams.get('link') || '').slice(0, LINK_MAX),
    website: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState({});
  const [sentId, setSentId] = useState('');

  const isReport = form.category === 'report_content';
  const set = (name) => (event) => {
    setForm((current) => ({ ...current, [name]: event.target.value }));
    setFieldError((current) => ({ ...current, [name]: '' }));
    if (error) setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const problems = {};
    if (!user) {
      const emailProblem = validateEmail(form.email);
      if (emailProblem) problems.email = emailProblem;
    }
    if (isReport && !form.link.trim()) problems.link = 'Paste the link to the content.';
    if (!isReport && !form.body.trim()) problems.body = 'Describe what you need help with.';
    if (Object.keys(problems).length) {
      setFieldError(problems);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = {
        category: form.category,
        subject: form.subject.trim(),
        body: form.body.trim(),
        link: form.link.trim(),
        website: form.website,
      };
      if (form.email.trim()) payload.email = form.email.trim();
      const result = await api.post('/api/support', payload);
      setSentId(result?.id || '');
    } catch (requestError) {
      const field = requestError.detail?.field;
      if (field && ['email', 'body', 'link'].includes(field)) setFieldError({ [field]: requestError.message });
      else setError(requestError.message || 'Could not send your request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="sx-legal sx-support">
      <header className="sx-ps-head">
        <div>
          <h1 className="sx-ps-title">SUPPORT</h1>
          <div className="sx-ps-kicker">APPEALS · REPORTS · ACCOUNT HELP</div>
        </div>
      </header>

      {sentId ? (
        <section className="sx-legal-section" aria-live="polite">
          <h2>Request received</h2>
          <p>Our team reads every request. Keep this reference in case you need to follow up:</p>
          <p className="sx-support-ref"><code data-testid="support-request-id">{sentId}</code></p>
          <p>We reply to the email address you gave{user ? ' or to your account' : ''}. No automatic receipt is sent.</p>
          <p><Link to="/reels">Back to ECHO</Link></p>
        </section>
      ) : (
        <form className="sx-ps-form sx-legal-section" onSubmit={submit} noValidate>
          <p>
            Suspended accounts can file an appeal here without signing in. Read the{' '}
            <Link to="/rules">community rules</Link> first if you are unsure why content was removed.
          </p>
          <Field label="TOPIC" htmlFor="support-category">
            <select id="support-category" className="sx-ps-input" value={form.category} onChange={set('category')}>
              {SUPPORT_CATEGORIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
          <Field label="EMAIL" htmlFor="support-email" meta={user ? 'OPTIONAL · SIGNED IN AS @' + user.username : 'REQUIRED · WE REPLY HERE'}>
            <input
              id="support-email"
              className="sx-ps-input"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={set('email')}
              aria-invalid={fieldError.email ? true : undefined}
            />
            {fieldError.email ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">{fieldError.email}</div> : null}
          </Field>
          <Field label={isReport ? 'LINK TO THE CONTENT' : 'LINK (OPTIONAL)'} htmlFor="support-link" meta={isReport ? '/reels?post=… · /packs/… · /profile/…' : null}>
            <input
              id="support-link"
              className="sx-ps-input"
              type="text"
              maxLength={LINK_MAX}
              value={form.link}
              onChange={set('link')}
              aria-invalid={fieldError.link ? true : undefined}
            />
            {fieldError.link ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">{fieldError.link}</div> : null}
          </Field>
          <Field label="SUBJECT" htmlFor="support-subject" meta={form.subject.length + ' / ' + SUBJECT_MAX}>
            <input id="support-subject" className="sx-ps-input" type="text" maxLength={SUBJECT_MAX} value={form.subject} onChange={set('subject')} />
          </Field>
          <Field label="DETAILS" htmlFor="support-body" meta={form.body.length + ' / ' + BODY_MAX}>
            <textarea
              id="support-body"
              className="sx-ps-input sx-ps-textarea"
              rows={7}
              maxLength={BODY_MAX}
              value={form.body}
              onChange={set('body')}
              placeholder={form.category === 'appeal' ? 'Your username, what was removed or limited, and why you think it was a mistake.' : ''}
              aria-invalid={fieldError.body ? true : undefined}
            />
            {fieldError.body ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">{fieldError.body}</div> : null}
          </Field>
          {/* Honeypot: off-screen and hidden from assistive tech; only bots fill it. */}
          <div className="sx-support-trap" aria-hidden="true">
            <label htmlFor="support-website">Website</label>
            <input id="support-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
          </div>
          {error ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">{error}</div> : null}
          <div className="sx-ps-actions">
            <button type="submit" className="sx-ps-btn sx-ps-btn--primary" disabled={busy}>{busy ? 'SENDING…' : 'SEND REQUEST'}</button>
          </div>
        </form>
      )}
    </article>
  );
}
