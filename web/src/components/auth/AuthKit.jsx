import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { PASSWORD_MAX, PASSWORD_MIN, passwordChecks, passwordStrength } from '../../utils/authForm.js';

/*
 * Building blocks shared by sign-in, sign-up and password recovery.
 * AuthLayout is the split "console": a context rail on the left (brand, headline,
 * what-happens-next list) and the working panel on the right. Below 860px the rail
 * collapses to a slim brand strip so the form is the first thing on a phone.
 */

export function AuthLayout({ rail, tabs, title, intro, step, children }) {
  const titleId = useId();
  return (
    <div className="sx-au-shell">
      <div className="sx-au">
        <aside className="sx-au-rail">
          <Link to="/reels" className="sx-au-mark" aria-label="ECHO home">
            <img src="/logo.svg" alt="" width="34" height="34" />
            <span>ECHO</span>
          </Link>
          <p className="sx-au-kicker">{rail.kicker}</p>
          <p className="sx-au-headline" aria-hidden="true">
            {rail.headline.map((line, index) => (
              <span key={line} className={index === rail.headline.length - 1 ? 'sx-au-headline-hot' : ''}>{line}</span>
            ))}
          </p>
          <ol className="sx-au-steps" aria-label={rail.listLabel}>
            {rail.items.map((item, index) => {
              const state = rail.activeIndex === undefined ? '' : index < rail.activeIndex ? ' is-done' : index === rail.activeIndex ? ' is-active' : '';
              return (
                <li key={item.title} className={'sx-au-step' + state} aria-current={state === ' is-active' ? 'step' : undefined}>
                  <span className="sx-au-step-no" aria-hidden="true">{state === ' is-done' ? '✓' : String(index + 1).padStart(2, '0')}</span>
                  <span className="sx-au-step-body">
                    <b>{item.title}</b>
                    <span>{item.text}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </aside>

        <section className="sx-au-panel" aria-labelledby={titleId}>
          {tabs ? (
            <nav className="sx-au-tabs" aria-label="Account access">
              {tabs.map((tab) => (
                <Link key={tab.to} to={tab.to} className={'sx-au-tab' + (tab.active ? ' is-active' : '')} aria-current={tab.active ? 'page' : undefined}>
                  {tab.label}
                </Link>
              ))}
            </nav>
          ) : null}
          <header className="sx-au-head">
            {step ? <span className="sx-au-step-label">{step}</span> : null}
            <h1 id={titleId}>{title}</h1>
            {intro ? <p>{intro}</p> : null}
          </header>
          {children}
        </section>
      </div>
    </div>
  );
}

export function AuthNotice({ tone = 'info', children, ...rest }) {
  const role = tone === 'err' ? 'alert' : tone === 'ok' ? 'status' : undefined;
  return (
    <div className={'sx-au-notice sx-au-notice--' + tone} role={role} {...rest}>
      {children}
    </div>
  );
}

export function StatusGlyph({ kind }) {
  const paths = {
    mail: <><rect x="3" y="5" width="18" height="14" /><path d="M3 6l9 7 9-7" /></>,
    check: <path d="M4 12.5l5 5L20 6.5" />,
    alert: <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></>,
  };
  return (
    <span className={'sx-au-glyph sx-au-glyph--' + kind} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="miter" strokeLinecap="square">
        {paths[kind]}
      </svg>
    </span>
  );
}

/*
 * One labelled input. Errors and hints are tied to the control with aria-describedby,
 * and aria-invalid flips as soon as an error is present so assistive tech announces it.
 * `prefix`/`suffix` render inside the bordered control; `aside` is drawn beside the label.
 */
export function AuthField({ label, hint, error, aside, prefix, suffix, inputRef, className = '', ...inputProps }) {
  const id = useId();
  const messageId = id + '-msg';
  const message = error || hint;
  return (
    <div className="sx-au-field">
      <label htmlFor={id}>{label}</label>
      <div className={'sx-au-control' + (error ? ' has-error' : '')}>
        {prefix ? <span className="sx-au-prefix" aria-hidden="true">{prefix}</span> : null}
        <input
          id={id}
          ref={inputRef}
          className={'sx-au-input ' + className}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={message ? messageId : undefined}
          {...inputProps}
        />
        {suffix}
      </div>
      {message ? (
        <p id={messageId} className={'sx-au-msg' + (error ? ' sx-au-msg--err' : '')}>{message}</p>
      ) : null}
      {/* Last in the DOM so Tab runs input → show/hide → aside; CSS draws it beside the label. */}
      {aside ? <div className="sx-au-aside">{aside}</div> : null}
    </div>
  );
}

// Password input with a show/hide toggle and a caps-lock warning (the usual cause of "wrong password").
export function PasswordField({ onKeyUp, onKeyDown, onBlur, hint, ...props }) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const track = (event) => setCaps(Boolean(event.getModifierState?.('CapsLock')));
  return (
    <>
      <AuthField
        {...props}
        hint={caps && !props.error ? undefined : hint}
        type={shown ? 'text' : 'password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(event) => { track(event); onKeyDown?.(event); }}
        onKeyUp={(event) => { track(event); onKeyUp?.(event); }}
        onBlur={(event) => { setCaps(false); onBlur?.(event); }}
        suffix={(
          <button
            type="button"
            className="sx-au-toggle"
            aria-pressed={shown}
            aria-label={shown ? 'Hide password' : 'Show password'}
            onClick={() => setShown((value) => !value)}
          >
            {shown ? 'HIDE' : 'SHOW'}
          </button>
        )}
      />
      {caps && !props.error ? <p className="sx-au-msg sx-au-msg--warn" role="status">CAPS LOCK IS ON</p> : null}
    </>
  );
}

// The three-segment strength bar on its own; also used by the Settings password panel.
export function PasswordMeter({ password }) {
  const { score, label } = passwordStrength(password);
  return (
    <div className="sx-au-meter" data-score={score} role="img" aria-label={label ? 'Password strength: ' + label : 'Password strength: not started'}>
      <i /><i /><i />
      <span>{label || 'STRENGTH'}</span>
    </div>
  );
}

export function PasswordRules({ password }) {
  const checks = passwordChecks(password);
  const rows = [
    [checks.length, PASSWORD_MIN + '–' + PASSWORD_MAX + ' CHARACTERS', false],
    [checks.long, '14+ CHARACTERS', true],
    [checks.mixed, 'NUMBER & SYMBOL', true],
  ];
  return (
    <div className="sx-au-rules">
      <PasswordMeter password={password} />
      <ul className="sx-au-checks" aria-label="Password requirements">
        {rows.map(([pass, text, advisory]) => (
          <li key={text} className={'sx-au-check' + (pass ? ' is-pass' : '')}>
            <span aria-hidden="true">{pass ? '✓' : '○'}</span>
            <span>{text}{advisory ? <em> · RECOMMENDED</em> : null}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SubmitButton({ busy, busyLabel = 'WORKING…', children, ...rest }) {
  return (
    <button className="sx-au-submit" type="submit" disabled={busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <><span className="sx-au-spin" aria-hidden="true" />{busyLabel}</> : children}
    </button>
  );
}
