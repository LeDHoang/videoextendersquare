import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import FormField from './FormField.jsx';

afterEach(cleanup);

describe('FormField', () => {
  it('labels the control and shows the meta', () => {
    render(<FormField label="DISPLAY NAME" meta="60 MAX" id="f-name"><input /></FormField>);
    const input = screen.getByLabelText('DISPLAY NAME');
    expect(input).toHaveAttribute('id', 'f-name');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText('60 MAX')).toHaveClass('sx-ps-meta');
  });

  it('describes the control by its hint and error, and marks it invalid', () => {
    render(<FormField label="EMAIL" id="f-email" hint="We reply here." error="Enter an email."><input /></FormField>);
    const input = screen.getByLabelText('EMAIL');
    expect(input).toHaveAttribute('aria-describedby', 'f-email-hint f-email-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('We reply here. Enter an email.');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an email.');
  });

  it('passes the same props to a control wrapped in other markup', () => {
    render(
      <FormField label="KEY" id="f-key" hint="Keys are at least 8 characters.">
        {(field) => (
          <div className="wrap">
            <input {...field} />
            <button type="button">SHOW</button>
          </div>
        )}
      </FormField>,
    );
    const input = screen.getByLabelText('KEY');
    expect(input.parentElement).toHaveClass('wrap');
    expect(input).toHaveAccessibleDescription('Keys are at least 8 characters.');
  });
});
