/*
 * Shared values and building blocks for the legal pages (Terms, Privacy).
 *
 * Values still in [BRACKETS] are unresolved legal decisions. Fill them here once, then have a lawyer
 * in your governing-law country review both pages before public launch (docs/to-beta.md, Privacy section).
 */
export const LEGAL = {
  company: '[COMPANY LEGAL NAME]',
  address: '[REGISTERED ADDRESS]',
  contactEmail: '[SUPPORT EMAIL]',
  privacyEmail: '[PRIVACY EMAIL]',
  copyrightEmail: '[COPYRIGHT EMAIL]',
  governingLaw: '[GOVERNING LAW]',
  disputeVenue: '[DISPUTE VENUE]',
  hostingRegion: 'the United States (our server and database, in Oregon) and the Asia-Pacific region (published photos and videos, and backups, in Cloudflare R2)',
  analyticsRetention: '[ACTIVITY RETENTION PERIOD]',
  mediaPurge: '[DELETED MEDIA PURGE PERIOD]',
  effectiveDate: '[EFFECTIVE DATE]',
  minimumAge: 13,
  refundDays: 14,
};

const isPlaceholder = (value) => typeof value === 'string' && value.startsWith('[');

// Renders a LEGAL value; unfilled ones are highlighted so a placeholder can't ship unnoticed.
export function V({ k }) {
  const value = LEGAL[k];
  return isPlaceholder(value) ? <mark className="sx-legal-todo">{value}</mark> : <>{value}</>;
}

export function Section({ id, title, children }) {
  return (
    <section className="sx-legal-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}
