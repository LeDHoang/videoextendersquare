import { useNavigate } from 'react-router-dom';
import { Button, Segmented } from '../ui/controls.jsx';
import { Eyebrow, GatedReason } from '../ui/primitives.jsx';
import { useAuth } from '../../hooks/AuthContext.jsx';
import { useWallet } from '../../hooks/WalletContext.jsx';

const OPTIONS = ['ECHO CREDITS', 'MY FAL KEY'];

export default function CloudFundingPanel({ required, paymentSource, onChange, quoteState, byokOnly = false }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { wallet, catalog, falKey } = useWallet();
  if (!required) return <GatedReason>LOCAL PROCESSING · NO CREDITS REQUIRED</GatedReason>;
  const insufficient = Number(wallet?.available_credits || 0) < Number(quoteState.totalCredits || 0);

  const selected = paymentSource === 'byok' ? OPTIONS[1] : OPTIONS[0];
  return (
    <div className="sx-cost-panel">
      <Eyebrow>CLOUD PAYMENT SOURCE</Eyebrow>
      {user ? (
        <Segmented
          options={OPTIONS}
          value={selected}
          onChange={(value) => onChange(value === OPTIONS[1] ? 'byok' : 'credits')}
          disabled={byokOnly}
          ariaLabel="Cloud payment source"
        />
      ) : (
        <Button primary onClick={() => navigate('/login?next=' + encodeURIComponent(window.location.pathname))}>SIGN IN FOR CLOUD PROCESSING</Button>
      )}
      {paymentSource === 'credits' ? (
        <div className="sx-cost-body" style={{ marginTop: 10 }}>
          <div>• <b>Wallet:</b> {wallet?.available_credits ?? '—'} credits available</div>
          <div>• <b>Authoritative quote:</b> {quoteState.loading ? 'calculating…' : `${quoteState.totalCredits} credits`}</div>
          <div>• <b>Provider estimate:</b> ${quoteState.totalProviderUsd.toFixed(4)} USD across {quoteState.quotes.length} item(s)</div>
          {byokOnly ? <GatedReason>THE SELECTED CUSTOM / NON-DETERMINISTIC MODEL REQUIRES MY FAL KEY</GatedReason> : null}
          {!catalog?.credits_enabled ? <GatedReason>ECHO CREDITS ARE DISABLED IN THIS ENVIRONMENT</GatedReason> : null}
          {quoteState.error ? <GatedReason>{quoteState.error}</GatedReason> : null}
          {!quoteState.loading && quoteState.quotes.length > 0 && insufficient ? <GatedReason>INSUFFICIENT ECHO CREDITS — ADD CREDITS OR USE MY FAL KEY</GatedReason> : null}
        </div>
      ) : (
        <div className="sx-cost-body" style={{ marginTop: 10 }}>
          <div>• Charges go directly to your Fal account.</div>
          <div>• Saved key: <b>{falKey?.configured ? falKey.hint : 'NOT CONFIGURED'}</b></div>
          {!falKey?.configured ? <Button onClick={() => navigate('/wallet')}>ADD PERSONAL FAL KEY</Button> : null}
        </div>
      )}
    </div>
  );
}
