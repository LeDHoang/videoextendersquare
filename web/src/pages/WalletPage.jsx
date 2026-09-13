import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Hero, Section, SpecRow, Eyebrow, GatedReason } from '../components/ui/primitives.jsx';
import { Button, Field } from '../components/ui/controls.jsx';
import { useWallet } from '../hooks/WalletContext.jsx';

export default function WalletPage() {
  const { wallet, catalog, falKey, refresh, saveFalKey, deleteFalKey } = useWallet();
  const [transactions, setTransactions] = useState([]);
  const [keyValue, setKeyValue] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const loadTransactions = () => api.get('/api/billing/transactions').then((r) => setTransactions(r.transactions || []));
  useEffect(() => { loadTransactions().catch(() => {}); }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') {
      setMessage('PAYMENT RECEIVED — credits appear after Stripe confirms the webhook.');
      refresh().catch(() => {});
      loadTransactions().catch(() => {});
    }
  }, [refresh]);

  const checkout = async (packId) => {
    setBusy(packId);
    setMessage('');
    try {
      const result = await api.post('/api/billing/checkout-session', { pack_id: packId });
      window.location.assign(result.checkout_url);
    } catch (error) {
      setMessage(error.message);
      setBusy('');
    }
  };

  const saveKey = async () => {
    setBusy('key');
    setMessage('');
    try {
      await saveFalKey(keyValue);
      setKeyValue('');
      setMessage('PERSONAL FAL KEY SAVED ENCRYPTED');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  };

  const removeKey = async () => {
    setBusy('key');
    try {
      await deleteFalKey();
      setMessage('PERSONAL FAL KEY REMOVED');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <Hero title="ECHO CREDITS" kicker="WALLET · CLOUD OUTPAINTING · PURCHASED + EARNED CREDITS" />
      <Section num={1} title="Balance" active>
        <SpecRow cells={[
          ['AVAILABLE', `${wallet?.available_credits ?? '—'} CREDITS`, 'READY TO USE'],
          ['RESERVED', `${wallet?.reserved_credits ?? '—'} CREDITS`, 'ACTIVE CLOUD JOBS'],
          ['EARNED', `${wallet?.lifetime_earned ?? '—'} CREDITS`, 'REEL REWARDS'],
          ['SPENT', `${wallet?.lifetime_spent ?? '—'} CREDITS`, 'COMPLETED FAL STAGES'],
        ]} />
        <p className="sx-body">1 ECHO Credit represents $0.01 of service value. Credits never expire, are non-transferable, and have no cash value.</p>
        {wallet && wallet.available_credits < 0 ? <GatedReason>NEGATIVE BALANCE — platform-funded jobs are blocked until the balance is restored.</GatedReason> : null}
      </Section>

      <Section num={2} title="Add Credits" active>
        <div className="sx-cols sx-cols-3">
          {(catalog?.packs || []).map((pack) => (
            <div className="sx-cost-panel" key={pack.id}>
              <Eyebrow>{pack.label}</Eyebrow>
              <div className="sx-stat-value">${(pack.amount_cents / 100).toFixed(2)}</div>
              <Button primary onClick={() => checkout(pack.id)} loading={busy === pack.id} disabled={!catalog?.stripe_enabled || !pack.configured}>
                BUY {pack.credits}
              </Button>
            </div>
          ))}
        </div>
        {!catalog?.stripe_enabled ? <GatedReason>STRIPE CHECKOUT IS DISABLED IN THIS ENVIRONMENT</GatedReason> : null}
      </Section>

      <Section num={3} title="My Fal Key" active>
        <p className="sx-body">Use your own Fal account for custom models or bypass ECHO Credit charging. The key is encrypted at rest and is never displayed again.</p>
        <Field label={falKey.configured ? `SAVED KEY · ${falKey.hint}` : 'PERSONAL FAL API KEY'}>
          <input className="sx-input" type={showKey ? 'text' : 'password'} value={keyValue} onChange={(e) => setKeyValue(e.target.value)} autoComplete="off" />
        </Field>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={() => setShowKey((value) => !value)}>{showKey ? 'HIDE' : 'SHOW'}</Button>
          <Button primary onClick={saveKey} loading={busy === 'key'} disabled={!keyValue.trim()}>SAVE ENCRYPTED KEY</Button>
          <Button onClick={removeKey} disabled={!falKey.configured || busy === 'key'}>REMOVE KEY</Button>
        </div>
        {message ? <div className="sx-monospace-sm" style={{ marginTop: 10 }}>{message}</div> : null}
      </Section>

      <Section num={4} title="Transaction History" active>
        {transactions.length ? transactions.map((row) => (
          <div className="sx-cost-panel" key={row.id} style={{ marginBottom: 8 }}>
            <div className="sx-cost-head">
              <span>{row.source.toUpperCase()} · {row.type.toUpperCase()}</span>
              <strong>{row.delta_available > 0 ? '+' : ''}{row.delta_available} available / {row.delta_reserved > 0 ? '+' : ''}{row.delta_reserved} reserved</strong>
            </div>
            <small>{new Date(row.created_at).toLocaleString()} · balance {row.balance_available}</small>
          </div>
        )) : <p className="sx-body">No credit transactions yet.</p>}
      </Section>
    </div>
  );
}
