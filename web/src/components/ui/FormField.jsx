import { cloneElement } from 'react';

/**
 * One form field: label (with optional meta on the right), the control, then an optional hint
 * and error. The label points at the control by `id`; the control is described by the hint
 * (`{id}-hint`) and the error (`{id}-error`), and is aria-invalid while there is an error.
 *
 * `children` is the control element, which gets those props, or a function that receives
 * them, for a control wrapped in other markup (an input with a SHOW button beside it).
 */
export default function FormField({ label, id, meta, hint, error, children }) {
  const describedBy = [hint ? id + '-hint' : '', error ? id + '-error' : ''].filter(Boolean).join(' ');
  const control = { id };
  if (describedBy) control['aria-describedby'] = describedBy;
  if (error) control['aria-invalid'] = true;
  return (
    <div className="sx-ps-field">
      <div className="sx-ps-field-head">
        <label className="sx-ps-label" htmlFor={id}>{label}</label>
        {meta ? <span className="sx-ps-meta">{meta}</span> : null}
      </div>
      {typeof children === 'function' ? children(control) : cloneElement(children, control)}
      {hint ? <div id={id + '-hint'} className="sx-ps-hint">{hint}</div> : null}
      {error ? <div id={id + '-error'} className="sx-ps-feedback sx-ps-feedback--err" role="alert">{error}</div> : null}
    </div>
  );
}
