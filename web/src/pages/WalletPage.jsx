import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { IndustrialCreditsIcon } from '../components/icons/index.jsx';
import FormField from '../components/ui/FormField.jsx';
import { SectionSkeleton } from '../components/ui/Skeleton.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useWallet } from '../hooks/WalletContext.jsx';
import { billingErrorMessage } from '../utils/billingErrors.js';

// Stripe Checkout is the only external navigation target in this app.
const CHECKOUT_URL_ALLOWLIST = /^https:\/\/(checkout\.stripe\.com|buy\.stripe\.com)(\/|$)/;

// Mirrors FalKeyRequest.fal_key (min 8 / max 500) in server/routers/billing.py.
const FAL_KEY_MIN = 8;
const FAL_KEY_MAX = 500;
const PAGE_SIZE = 25;

const PACK_NAMES = { starter: 'Starter', plus: 'Plus', creator: 'Creator' };

const PACK_BLURBS = {
  starter: 'Try cloud outpainting and upscaling on a few images or short clips.',
  plus: 'Steady production use, with bonus credits on top.',
  creator: 'Batch work and long clips. Best value per dollar.',
};

// Card purchases (and their chargebacks) are payments; every other entry is
// credits moving through use: cloud jobs, holds, refunds and reel rewards.
const PAYMENT_SOURCES = new Set(['purchase', 'dispute']);

const SOURCE_LABELS = {
  purchase: 'Credit purchase',
  generation: 'Cloud job',
  earned: 'Reel reward',
  refund: 'Refund',
  dispute: 'Payment dispute',
};

const TYPE_NOTES = {
  reserve: 'credits held',
  release: 'hold released',
};

const formatCredits = (value) => (value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—');
const formatUsd = (credits) => (credits !== null && credits !== undefined && Number.isFinite(Number(credits)) ? `$${(Number(credits) / 100).toFixed(2)}` : '—');
const signed = (value) => `${value > 0 ? '+' : ''}${value.toLocaleString()}`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function Section({ title, note, children, id }) {
  const titleId = useId();
  return (
    <section className="sx-cr-section" aria-labelledby={titleId} id={id}>
      <header className="sx-cr-section-head">
        <h2 id={titleId}>{title}</h2>
        {note ? <span className="sx-cr-section-note">{note}</span> : null}
      </header>
      {children}
    </section>
  );
}

function Feedback({ state }) {
  if (!state) return null;
  return state.ok
    ? <div className="sx-ps-feedback sx-ps-feedback--ok" role="status">✓ {state.text}</div>
    : <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">{state.text}</div>;
}

function TransactionRow({ row }) {
  const label = SOURCE_LABELS[row.source] || capitalize(String(row.source ?? 'unknown'));
  const note = TYPE_NOTES[row.type];
  const created = new Date(row.created_at);
  const validDate = !Number.isNaN(created.getTime());
  const deltaAvailable = Number(row.delta_available ?? 0);
  const deltaReserved = Number(row.delta_reserved ?? 0);
  const tone = deltaAvailable > 0 ? 'up' : deltaAvailable < 0 ? 'down' : 'flat';
  return (
    <li className="sx-cr-row">
      <div className="sx-cr-row-main">
        <span className="sx-cr-row-label">{label}{note ? <span className="sx-cr-row-note"> · {note}</span> : null}</span>
        <time className="sx-cr-row-when" dateTime={validDate ? created.toISOString() : undefined}>
          {validDate ? created.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable'}
        </time>
      </div>
      <div className={'sx-cr-row-delta sx-cr-row-delta--' + tone}>
        {signed(deltaAvailable)}
        {deltaReserved !== 0 ? <small>{signed(deltaReserved)} held</small> : null}
      </div>
      <div className="sx-cr-row-balance">
        <small>Balance</small>
        {formatCredits(row.balance_available)}
      </div>
    </li>
  );
}

/*
 * ECHO Credits wallet. Owner-only by construction: the route is wrapped in
 * <RequireAuth>, this page has no :username parameter, and every request is an
 * /api/billing or /api/account endpoint the server resolves from the session
 * cookie (writes also require the CSRF token). Balances are never granted
 * client-side — purchases are fulfilled by the Stripe webhook.
 */
export default function WalletPage() {
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();
  const { wallet, catalog, catalogStatus, falKey, refresh, saveFalKey, deleteFalKey } = useWallet();
  const [ledger, setLedger] = useState({ rows: [], status: 'loading', hasMore: false, loadingMore: false, loadError: false });
  const [historyView, setHistoryView] = useState('usage');
  const [keyValue, setKeyValue] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [purchaseStatus, setPurchaseStatus] = useState(null);
  const [keyStatus, setKeyStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const checkoutHandledRef = useRef(false);
  const mountedRef = useRef(true);
  const rowsRef = useRef([]);
  // Bumped on every first-page load so a slow older response (account switch,
  // refresh) can never overwrite newer data.
  const loadSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadTransactions = useCallback(async ({ append = false } = {}) => {
    const cursor = append ? rowsRef.current[rowsRef.current.length - 1]?.id : null;
    const seq = append ? loadSeqRef.current : ++loadSeqRef.current;
    if (append) setLedger((state) => ({ ...state, loadingMore: true, loadError: false }));
    try {
      const result = await api.get('/api/billing/transactions', { limit: PAGE_SIZE, before: cursor || undefined });
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      const next = Array.isArray(result?.transactions) ? result.transactions : [];
      rowsRef.current = append ? [...rowsRef.current, ...next] : next;
      setLedger({ rows: rowsRef.current, status: 'ready', hasMore: next.length >= PAGE_SIZE, loadingMore: false, loadError: false });
    } catch {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      if (append) setLedger((state) => ({ ...state, loadingMore: false, loadError: true }));
      else {
        rowsRef.current = [];
        setLedger({ rows: [], status: 'error', hasMore: false, loadingMore: false, loadError: false });
      }
    }
  }, []);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    rowsRef.current = [];
    setLedger({ rows: [], status: 'loading', hasMore: false, loadingMore: false, loadError: false });
    loadTransactions();
  }, [userId, loadTransactions]);

  useEffect(() => {
    // Run once per mount: the Stripe webhook fulfills asynchronously, so poll
    // the wallet a few times with backoff instead of a single refresh, then
    // strip the query param so a remount never re-fires this flow.
    if (checkoutHandledRef.current) return undefined;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('checkout');
    if (outcome !== 'success' && outcome !== 'cancelled') return undefined;
    checkoutHandledRef.current = true;
    params.delete('checkout');
    params.delete('session_id');
    const query = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
    if (outcome === 'cancelled') {
      setPurchaseStatus({ ok: false, text: 'Checkout cancelled — you were not charged.' });
      return undefined;
    }
    setPurchaseStatus({ ok: true, text: 'Payment received. Your credits appear as soon as Stripe confirms it.' });
    let attempts = 0;
    let cancelled = false;
    let timer = null;
    const poll = () => {
      if (cancelled) return;
      refresh({ silent: true })
        .catch(() => {})
        .finally(() => {
          if (cancelled) return;
          loadTransactions();
          attempts += 1;
          if (attempts < 4) timer = setTimeout(poll, attempts * 2500);
        });
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refresh, loadTransactions]);

  if (authLoading) return <SectionSkeleton label="Loading wallet" />;
  if (!user) return <Navigate to={'/login?next=' + encodeURIComponent('/wallet')} replace />;

  const available = wallet ? Number(wallet.available_credits) : null;
  const reserved = wallet ? Number(wallet.reserved_credits) : null;
  const packs = catalog?.packs || [];
  const stripeReady = Boolean(catalog?.stripe_enabled);
  const creditsReady = catalog ? catalog.credits_enabled !== false : true;
  const featuredId = packs.length >= 3 ? packs[1].id : null;
  const historyRows = ledger.rows.filter((row) => PAYMENT_SOURCES.has(row.source) === (historyView === 'payments'));

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh({ silent: true }), loadTransactions()]);
    } catch {
      // The wallet keeps its last good balance; the ledger shows its own error.
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  const checkout = async (packId) => {
    if (busy) return;
    setBusy(packId);
    setPurchaseStatus(null);
    try {
      const result = await api.post('/api/billing/checkout-session', { pack_id: packId });
      if (!CHECKOUT_URL_ALLOWLIST.test(String(result?.checkout_url || ''))) {
        throw new Error('Checkout is temporarily unavailable. Try again later.');
      }
      window.location.assign(result.checkout_url);
    } catch (error) {
      setPurchaseStatus({ ok: false, text: billingErrorMessage(error) });
      setBusy('');
    }
  };

  const trimmedKey = keyValue.trim();
  const keyTooShort = trimmedKey.length > 0 && trimmedKey.length < FAL_KEY_MIN;
  const keyValid = trimmedKey.length >= FAL_KEY_MIN && trimmedKey.length <= FAL_KEY_MAX;

  const saveKey = async (event) => {
    event?.preventDefault();
    // Re-check here: Enter in the field submits the form even while the
    // button is disabled.
    if (!keyValid || busy) return;
    setBusy('key');
    setKeyStatus(null);
    try {
      await saveFalKey(trimmedKey);
      setKeyValue('');
      setShowKey(false);
      toast('Personal fal key saved, encrypted.');
    } catch (error) {
      setKeyStatus({ ok: false, text: billingErrorMessage(error) });
    } finally {
      setBusy('');
    }
  };

  const removeKey = async () => {
    if (busy || !falKey?.configured) return;
    setBusy('key');
    setKeyStatus(null);
    try {
      await deleteFalKey();
      setKeyValue('');
      toast('Personal fal key removed.');
    } catch (error) {
      setKeyStatus({ ok: false, text: billingErrorMessage(error) });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="sx-ps sx-cr">
      <header className="sx-ps-head">
        <div>
          <h1 className="sx-cr-title"><span className="sx-cr-accent">ECHO</span> Credits</h1>
          <div className="sx-cr-kicker">Signed in as @{user.username} · only you can see and spend this wallet</div>
        </div>
        <div className="sx-cr-head-actions">
          <button type="button" className="sx-ps-btn sx-ps-btn--small" onClick={refreshAll} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <Link to={'/profile/' + user.username} className="sx-ps-btn sx-ps-btn--small sx-ps-btn--quiet">View profile</Link>
        </div>
      </header>

      <section className="sx-cr-hero" aria-label="Balance">
        <div className="sx-cr-hero-main">
          <div className="sx-cr-label">Your balance</div>
          {wallet ? (
            <>
              <div className="sx-cr-balance">
                <IndustrialCreditsIcon className="sx-cr-coin" />
                <span>{formatCredits(available)}</span>
                <small>credits</small>
              </div>
              <div className="sx-cr-hero-sub">
                ≈ {formatUsd(available)} of cloud work
                {reserved > 0 ? <> · <b>{formatCredits(reserved)}</b> held for a running job</> : null}
              </div>
            </>
          ) : <div className="sx-ps-hint" role="status">Loading your balance…</div>}
        </div>
        <div className="sx-cr-hero-side">
          {creditsReady ? <a href="#add-credits" className="sx-ps-btn sx-ps-btn--primary">Buy credits</a> : null}
          <a href="#fal-key" className={'sx-cr-keystate' + (falKey?.configured ? ' is-on' : '')}>
            {falKey?.configured ? '● Fal key active' : '○ No Fal key'}
          </a>
        </div>
        {wallet && available < 0 ? (
          <div className="sx-ps-feedback sx-ps-feedback--err sx-cr-hero-alert" role="alert">Negative balance: cloud jobs paid with credits are paused until you top up.</div>
        ) : null}
      </section>

      <Section title="Buy credits" note={creditsReady ? 'One-time purchase · credits never expire' : null} id="add-credits">
        {catalogStatus === 'failed' ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">Credit packs couldn't load. Reload the page to try again.</div> : null}
        {catalogStatus === 'loading' ? <div className="sx-ps-hint" role="status">Loading credit packs…</div> : null}
        {catalog && !creditsReady ? <p className="sx-cr-copy">Buying credits isn't available yet. You can still use free tools.</p> : null}
        {catalog && creditsReady && !stripeReady ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">Card checkout is turned off in this environment.</div> : null}
        {creditsReady && packs.length ? (
          <div className="sx-cr-packs">
            {packs.map((pack) => {
              const bonus = Math.max(0, Number(pack.credits) - Number(pack.amount_cents));
              const featured = pack.id === featuredId;
              const unavailable = !stripeReady || !pack.configured;
              const price = `$${(pack.amount_cents / 100).toFixed(2)}`;
              return (
                <article className={'sx-cr-pack' + (featured ? ' sx-cr-pack--featured' : '')} key={pack.id}>
                  <div className="sx-cr-pack-tag">{featured ? 'Most popular' : (PACK_NAMES[pack.id] || pack.label)}</div>
                  <div className="sx-cr-pack-credits"><b>{formatCredits(pack.credits)}</b> credits</div>
                  {bonus > 0 ? <div className="sx-cr-bonus">+{formatCredits(bonus)} bonus</div> : null}
                  <p className="sx-cr-pack-blurb">{PACK_BLURBS[pack.id] || 'One-time purchase. Credits never expire.'}</p>
                  <button
                    type="button"
                    className={'sx-ps-btn sx-ps-btn--block' + (featured ? ' sx-ps-btn--primary' : '')}
                    onClick={() => checkout(pack.id)}
                    disabled={unavailable || Boolean(busy)}
                    aria-label={`Buy ${formatCredits(pack.credits)} credits for ${price}`}
                  >
                    {busy === pack.id ? 'Opening checkout…' : price}
                  </button>
                  {stripeReady && !pack.configured ? <div className="sx-ps-hint">Not available yet</div> : null}
                </article>
              );
            })}
          </div>
        ) : null}
        {catalog && !packs.length ? <div className="sx-ps-hint">No credit packs are available right now.</div> : null}
        <p className="sx-cr-fine">1 credit = $0.01 of cloud work. Credits are non-transferable and have no cash value.</p>
        <div className="sx-cr-feedback"><Feedback state={purchaseStatus} /></div>
      </Section>

      <Section title="My Fal key" id="fal-key">
        <div className="sx-cr-keycard">
          <div className={'sx-cr-keystatus' + (falKey?.configured ? ' is-on' : '')}>
            {falKey?.configured
              ? <>● Active <b>{falKey.hint || 'saved'}</b></>
              : '○ Not set · jobs use your credits'}
          </div>
          <p className="sx-cr-copy">
            Run cloud jobs on your own Fal.ai account instead of spending credits. The key is stored encrypted and never shown again.
          </p>
        </div>
        <form className="sx-ps-form" onSubmit={saveKey}>
          <FormField
            label={falKey?.configured ? 'Replace key' : 'Fal.ai API key'}
            meta={'Min ' + FAL_KEY_MIN + ' characters'}
            id="wallet-fal-key"
            hint={keyTooShort ? 'Keys are at least ' + FAL_KEY_MIN + ' characters.' : null}
          >
            {(field) => (
              <div className="sx-ps-inline">
                <input
                  {...field}
                  className="sx-ps-input"
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={FAL_KEY_MAX}
                  placeholder="Paste your Fal.ai key"
                  value={keyValue}
                  onChange={(event) => setKeyValue(event.target.value)}
                  aria-invalid={keyTooShort}
                />
                <button type="button" className="sx-ps-btn" onClick={() => setShowKey((value) => !value)} aria-pressed={showKey}>{showKey ? 'Hide' : 'Show'}</button>
              </div>
            )}
          </FormField>
          <div className="sx-ps-actions">
            <button type="submit" className="sx-ps-btn sx-ps-btn--primary" disabled={!keyValid || Boolean(busy)}>
              {busy === 'key' ? 'Saving…' : 'Save key'}
            </button>
            {falKey?.configured ? (
              <button type="button" className="sx-ps-btn sx-ps-btn--quiet" disabled={Boolean(busy)} onClick={removeKey}>Remove key</button>
            ) : null}
          </div>
          <Feedback state={keyStatus} />
        </form>
      </Section>

      <Section title="History" note="Newest first" id="transactions">
        <div className="sx-cr-switch" role="group" aria-label="History view">
          <button type="button" aria-pressed={historyView === 'usage'} onClick={() => setHistoryView('usage')}>Usage</button>
          <button type="button" aria-pressed={historyView === 'payments'} onClick={() => setHistoryView('payments')}>Payments</button>
        </div>
        {ledger.status === 'loading' ? <div className="sx-ps-hint" role="status">Loading history…</div> : null}
        {ledger.status === 'error' ? (
          <div className="sx-cr-retry">
            <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">Couldn't load your history.</div>
            <button
              type="button"
              className="sx-ps-btn sx-ps-btn--small"
              onClick={() => { setLedger((state) => ({ ...state, status: 'loading' })); loadTransactions(); }}
            >
              Retry
            </button>
          </div>
        ) : null}
        {ledger.status === 'ready' && !historyRows.length ? (
          <div className="sx-ps-hint">
            {historyView === 'payments'
              ? 'No payments yet. Credit purchases will appear here.'
              : 'No usage yet. Cloud jobs and reel rewards will appear here.'}
            {ledger.hasMore ? ' Load more to see older entries.' : null}
          </div>
        ) : null}
        {historyRows.length ? (
          <ul className="sx-cr-ledger" aria-label={historyView === 'payments' ? 'Payments' : 'Credit usage'}>
            {historyRows.map((row, index) => <TransactionRow key={row.id ?? index} row={row} />)}
          </ul>
        ) : null}
        {ledger.loadError ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">Could not load more history.</div> : null}
        {ledger.hasMore ? (
          <div className="sx-cr-more">
            <button type="button" className="sx-ps-btn" disabled={ledger.loadingMore} onClick={() => loadTransactions({ append: true })}>
              {ledger.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
