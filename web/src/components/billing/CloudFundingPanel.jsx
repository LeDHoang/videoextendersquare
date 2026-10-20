import { Link, useNavigate } from 'react-router-dom';
import { Button, Segmented } from '../ui/controls.jsx';
import { Eyebrow, GatedReason } from '../ui/primitives.jsx';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { useWallet } from '../../hooks/WalletContext.jsx';

const OPTIONS = ['ECHO CREDITS', 'MY FAL KEY'];

// Third-party processing disclosure. Shown with every cloud-mode panel, which each page renders
// directly above its render/submit button (ImagePage, VideoPage, ExtendDeck's ExecuteSection).
export function FalDisclosure() {
  return (
    <p className="sx-cost-disclosure" data-testid="fal-disclosure">
      Cloud processing sends the photos or videos you upload, and your job settings, to fal.ai, a
      third-party AI provider, to produce the result. See the <Link to="/privacy">Privacy Policy</Link>.
    </p>
  );
}

export default function CloudFundingPanel({ required, paymentSource, onChange, quoteState, byokOnly = false }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { wallet, catalog, catalogStatus, falKey } = useWallet();
  if (!required) return <GatedReason>LOCAL PROCESSING · NO CREDITS REQUIRED</GatedReason>;
  const totalCredits = Number(quoteState.totalCredits ?? 0);
  const totalProviderUsd = Number(quoteState.totalProviderUsd ?? 0);
  const quotes = quoteState.quotes ?? [];
  // Credits disabled: the numbers are estimates from the same pricing, shown
  // for information only (nothing can be charged in credits).
  const estimateOnly = Boolean(quoteState.estimate);
  const creditsOn = Boolean(catalog?.credits_enabled);
  const insufficient = Number(wallet?.available_credits || 0) < totalCredits;
  // Approximate: a stage whose provider output is not deterministic (e.g. Luma
  // feeding SeedVR) was priced with an assumed frame count.
  const approx = quoteState.approximate ? '≈ ' : '';
  const providerLine = `${approx}$${totalProviderUsd.toFixed(4)} USD across ${quotes.length} item(s)${approx ? ' (approximate)' : ''}`;

  const selected = paymentSource === 'byok' ? OPTIONS[1] : OPTIONS[0];
  return (
    <div className="sx-cost-panel">
      <Eyebrow>CLOUD PAYMENT SOURCE</Eyebrow>
      {byokOnly ? <GatedReason>THE SELECTED CUSTOM / NON-DETERMINISTIC MODEL REQUIRES MY FAL KEY</GatedReason> : null}
      {user ? (
        <Segmented
          options={OPTIONS}
          value={selected}
          onChange={(value) => onChange(value === OPTIONS[1] ? 'byok' : 'credits')}
          disabledOptions={byokOnly ? [OPTIONS[0]] : []}
          ariaLabel="Cloud payment source"
        />
      ) : (
        <Button primary onClick={() => navigate('/login?next=' + encodeURIComponent(window.location.pathname))}>SIGN IN FOR CLOUD PROCESSING</Button>
      )}
      {paymentSource === 'credits' && user ? (
        <div className="sx-cost-body" style={{ marginTop: 10 }}>
          <div>• <b>Wallet:</b> {wallet?.available_credits ?? '—'} credits available</div>
          <div>• <b>{estimateOnly ? 'Estimated cost' : 'Authoritative quote'}:</b> {quoteState.loading ? 'calculating…' : `${approx}${totalCredits} credits${estimateOnly ? ' (estimate only)' : ''}`}</div>
          <div>• <b>Provider estimate:</b> {quoteState.loading ? 'calculating…' : providerLine}</div>
          {catalog && !catalog.credits_enabled ? <GatedReason>ECHO CREDITS ARE DISABLED IN THIS ENVIRONMENT</GatedReason> : null}
          {!catalog && catalogStatus === 'loading' ? <GatedReason>LOADING CREDITS STATUS…</GatedReason> : null}
          {!catalog && catalogStatus === 'failed' ? <GatedReason>CREDITS STATUS UNAVAILABLE — RELOAD TO RETRY</GatedReason> : null}
          {quoteState.error ? <GatedReason>{quoteState.error}</GatedReason> : null}
          {creditsOn && !quoteState.loading && quotes.length > 0 && insufficient ? <GatedReason>INSUFFICIENT ECHO CREDITS — ADD CREDITS OR USE MY FAL KEY</GatedReason> : null}
        </div>
      ) : null}
      {paymentSource === 'byok' && user ? (
        <div className="sx-cost-body" style={{ marginTop: 10 }}>
          <div>• Charges go directly to your Fal account.</div>
          {quoteState.loading || quotes.length > 0 ? (
            <div>• <b>Provider estimate:</b> {quoteState.loading ? 'calculating…' : providerLine}</div>
          ) : null}
          {quoteState.error ? <div>• <b>Provider estimate:</b> unavailable — {quoteState.error}</div> : null}
          <div>• Saved key: <b>{falKey?.configured ? falKey.hint : 'NOT CONFIGURED'}</b></div>
          {!falKey?.configured ? <Button onClick={() => navigate('/wallet')}>ADD PERSONAL FAL KEY</Button> : null}
        </div>
      ) : null}
      <FalDisclosure />
    </div>
  );
}
