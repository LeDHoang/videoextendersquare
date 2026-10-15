import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { SectionSkeleton } from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';
import { useWallet } from '../hooks/WalletContext.jsx';
import { billingErrorMessage } from '../utils/billingErrors.js';

// Stripe Checkout is the only external navigation target in this app.
const CHECKOUT_URL_ALLOWLIST = /^https:\/\/(checkout\.stripe\.com|buy\.stripe\.com)(\/|$)/;

// Mirrors FalKeyRequest.fal_key (min 8 / max 500) in server/routers/billing.py.
const FAL_KEY_MIN = 8;
const FAL_KEY_MAX = 500;
const PAGE_SIZE = 25;

const PACK_BLURBS = {
  starter: 'Try cloud outpainting and upscaling on a handful of images or short clips.',
  plus: 'Steady production use, with bonus credits on top of the purchase.',
  creator: 'Batch work and long clips. The best value per dollar, with the largest bonus.',
};

const SOURCE_LABELS = {
  purchase: 'PURCHASE',
  generation: 'CLOUD JOB',
  earned: 'REEL REWARD',
  refund: 'REFUND',
  dispute: 'DISPUTE',
};

const TYPE_LABELS = {
  credit: 'CREDIT',
  debit: 'DEBIT',
  reserve: 'RESERVED',
  capture: 'CHARGED',
  release: 'RELEASED',
};

const formatCredits = (value) => (value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—');
const formatUsd = (credits) => (credits !== null && credits !== undefined && Number.isFinite(Number(credits)) ? `$${(Number(credits) / 100).toFixed(2)}` : '—');
const signed = (value) => `${value > 0 ? '+' : ''}${value.toLocaleString()}`;

function Panel({ title, note, children, id }) {
  const titleId = useId();
  return (
    <section className="sx-ps-panel" aria-labelledby={titleId} id={id}>
      <header className="sx-ps-panel-head">
        <h2 id={titleId}>{title}</h2>
        {note ? <span className="sx-ps-panel-note">{note}</span> : null}
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

function Tile({ label, value, sub, hint, tone }) {
  return (
    <div className={'sx-cr-tile' + (tone ? ' sx-cr-tile--' + tone : '')}>
      <div className="sx-cr-tile-label">{label}</div>
      <div className="sx-cr-tile-value">{value}<span>CREDITS</span></div>
      <div className="sx-cr-tile-foot">
        <span>{sub}</span>
        {hint ? <b>{hint}</b> : null}
      </div>
    </div>
  );
}

function TransactionRow({ row }) {
  const source = SOURCE_LABELS[row.source] || String(row.source ?? 'unknown').toUpperCase();
  const type = TYPE_LABELS[row.type] || String(row.type ?? 'entry').toUpperCase();
  const created = new Date(row.created_at);
  const validDate = !Number.isNaN(created.getTime());
  const deltaAvailable = Number(row.delta_available ?? 0);
  const deltaReserved = Number(row.delta_reserved ?? 0);
  const tone = deltaAvailable > 0 ? 'up' : deltaAvailable < 0 ? 'down' : 'flat';
  return (
    <li className="sx-cr-row">
      <div className="sx-cr-row-main">
        <span className="sx-cr-row-source">{source}</span>
        <span className="sx-cr-chip">{type}</span>
      </div>
      <time className="sx-cr-row-when" dateTime={validDate ? created.toISOString() : undefined}>{validDate ? created.toLocaleString() : 'Date unavailable'}</time>
      <div className={'sx-cr-row-delta sx-cr-row-delta--' + tone}>
        {signed(deltaAvailable)} CR
        {deltaReserved !== 0 ? <small>{signed(deltaReserved)} reserved</small> : null}
      </div>
      <div className="sx-cr-row-balance">BAL {formatCredits(row.balance_available)}</div>
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
  const { wallet, catalog, catalogStatus, falKey, refresh, saveFalKey, deleteFalKey } = useWallet();
  const [ledger, setLedger] = useState({ rows: [], status: 'loading', hasMore: false, loadingMore: false, loadError: false });
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
    setPurchaseStatus({ ok: true, text: 'PAYMENT RECEIVED — credits appear after Stripe confirms the webhook.' });
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
      setKeyStatus({ ok: true, text: 'PERSONAL FAL KEY SAVED ENCRYPTED' });
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
      setKeyStatus({ ok: true, text: 'PERSONAL FAL KEY REMOVED' });
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
          <h1 className="sx-ps-title"><span className="sx-cr-accent">ECHO</span> CREDITS</h1>
          <div className="sx-ps-kicker">SIGNED IN AS @{user.username} · ONLY YOU CAN SEE AND SPEND THIS WALLET</div>
        </div>
        <div className="sx-cr-head-actions">
          <button type="button" className="sx-xh-btn" onClick={refreshAll} disabled={refreshing}>
            <span className="sx-xh-btn-icon" aria-hidden="true">↻</span><span>{refreshing ? 'REFRESHING…' : 'REFRESH'}</span>
          </button>
          <Link to={'/profile/' + user.username} className="sx-xh-btn">
            <span className="sx-xh-btn-icon" aria-hidden="true">←</span><span>VIEW PROFILE</span>
          </Link>
        </div>
      </header>

      <section aria-label="Balance">
        <div className="sx-cr-deck">
          <Tile label="AVAILABLE" tone="accent" value={formatCredits(available)} sub="READY TO USE" hint={`${formatUsd(available)} USD`} />
          <Tile label="RESERVED" value={formatCredits(reserved)} sub="ACTIVE CLOUD JOBS" hint={reserved > 0 ? 'HELD' : 'NONE'} />
          <Tile label="PURCHASED" value={formatCredits(wallet?.lifetime_purchased)} sub="CARD PURCHASES" hint="LIFETIME" />
          <Tile label="EARNED" value={formatCredits(wallet?.lifetime_earned)} sub="REEL REWARDS" hint="ROYALTIES" />
          <Tile label="SPENT" value={formatCredits(wallet?.lifetime_spent)} sub="COMPLETED FAL STAGES" hint="LIFETIME" />
        </div>
        <p className="sx-cr-note">
          <span aria-hidden="true">ⓘ</span> 1 ECHO Credit represents $0.01 of service value. Credits never expire, are non-transferable, and have no cash value.
        </p>
        {wallet && available < 0 ? (
          <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">NEGATIVE BALANCE — platform-funded jobs are blocked until the balance is restored.</div>
        ) : null}
        {!wallet ? <div className="sx-ps-hint" role="status">Loading your balance…</div> : null}
      </section>

      <Panel title="ADD CREDITS" note="INSTANT ALLOCATION AFTER PAYMENT" id="add-credits">
        {catalogStatus === 'failed' ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">CREDIT PACKS UNAVAILABLE — RELOAD TO RETRY</div> : null}
        {catalogStatus === 'loading' ? <div className="sx-ps-hint" role="status">Loading credit packs…</div> : null}
        {catalog && !creditsReady ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">ECHO CREDITS ARE DISABLED IN THIS ENVIRONMENT</div> : null}
        {catalog && creditsReady && !stripeReady ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">STRIPE CHECKOUT IS DISABLED IN THIS ENVIRONMENT</div> : null}
        {packs.length ? (
          <div className="sx-cr-packs">
            {packs.map((pack) => {
              const bonus = Math.max(0, Number(pack.credits) - Number(pack.amount_cents));
              const featured = pack.id === featuredId;
              const unavailable = !stripeReady || !pack.configured || !creditsReady;
              const price = `$${(pack.amount_cents / 100).toFixed(2)}`;
              return (
                <article className={'sx-cr-pack' + (featured ? ' sx-cr-pack--featured' : '')} key={pack.id}>
                  <div className="sx-cr-pack-top">
                    <span className="sx-cr-pack-tag">{featured ? '★ MOST POPULAR' : String(pack.label).toUpperCase()}</span>
                    <span className="sx-cr-pack-credits">{formatCredits(pack.credits)} CREDITS</span>
                  </div>
                  <div className="sx-cr-pack-price">
                    {price}<span>{String(pack.currency || 'usd').toUpperCase()}</span>
                    {bonus > 0 ? <em className="sx-cr-bonus">+{formatCredits(bonus)} BONUS</em> : null}
                  </div>
                  <p className="sx-cr-pack-blurb">{PACK_BLURBS[pack.id] || 'One-time purchase. Credits never expire.'}</p>
                  <button
                    type="button"
                    className={'sx-ps-btn sx-ps-btn--block' + (featured ? ' sx-ps-btn--primary' : '')}
                    onClick={() => checkout(pack.id)}
                    disabled={unavailable || Boolean(busy)}
                    aria-label={`Buy ${formatCredits(pack.credits)} credits for ${price}`}
                  >
                    {busy === pack.id ? 'OPENING CHECKOUT…' : `BUY ${formatCredits(pack.credits)}`}
                  </button>
                  {stripeReady && creditsReady && !pack.configured ? <div className="sx-ps-hint">NOT CONFIGURED</div> : null}
                </article>
              );
            })}
          </div>
        ) : null}
        {catalog && !packs.length ? <div className="sx-ps-hint">No credit packs are available right now.</div> : null}
        <div className="sx-cr-feedback"><Feedback state={purchaseStatus} /></div>
      </Panel>

      <Panel title="MY FAL KEY" note="DIRECT COMPUTE BYPASS" id="fal-key">
        <p className="sx-cr-copy">
          Use your own Fal.ai account to bypass ECHO Credit charges and run custom models. The key is encrypted at rest and is never shown again after saving.
        </p>
        <div className="sx-ps-keycard">
          <div>
            <div className="sx-ps-meta">FAL.AI API KEY</div>
            <div className="sx-ps-keyvalue">
              {falKey?.configured ? <>ACTIVE KEY: <b>{falKey.hint || 'saved'}</b></> : 'NO PERSONAL KEY · USING CREDITS'}
            </div>
          </div>
          {falKey?.configured ? <span className="sx-ps-badge">[SAVED]</span> : null}
        </div>
        <form className="sx-ps-form" onSubmit={saveKey}>
          <div className="sx-ps-field">
            <div className="sx-ps-field-head">
              <label className="sx-ps-label" htmlFor="wallet-fal-key">{falKey?.configured ? 'REPLACE KEY' : 'PERSONAL FAL API KEY'}</label>
              <span className="sx-ps-meta">MIN {FAL_KEY_MIN} CHARACTERS</span>
            </div>
            <div className="sx-ps-inline">
              <input
                id="wallet-fal-key"
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
              <button type="button" className="sx-ps-btn" onClick={() => setShowKey((value) => !value)} aria-pressed={showKey}>{showKey ? 'HIDE' : 'SHOW'}</button>
            </div>
            {keyTooShort ? <div className="sx-ps-hint">Keys are at least {FAL_KEY_MIN} characters.</div> : null}
          </div>
          <div className="sx-ps-actions">
            <button type="submit" className="sx-ps-btn sx-ps-btn--primary" disabled={!keyValid || Boolean(busy)}>
              {busy === 'key' ? 'SAVING…' : 'SAVE ENCRYPTED KEY'}
            </button>
            <button type="button" className="sx-ps-btn sx-ps-btn--quiet" disabled={!falKey?.configured || Boolean(busy)} onClick={removeKey}>REMOVE KEY</button>
          </div>
          <Feedback state={keyStatus} />
        </form>
      </Panel>

      <Panel title="TRANSACTION HISTORY" note="RECENT ACTIVITY · NEWEST FIRST" id="transactions">
        {ledger.status === 'loading' ? <div className="sx-ps-hint" role="status">Loading transactions…</div> : null}
        {ledger.status === 'error' ? (
          <div className="sx-cr-retry">
            <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">COULD NOT LOAD TRANSACTIONS</div>
            <button
              type="button"
              className="sx-ps-btn sx-ps-btn--small"
              onClick={() => { setLedger((state) => ({ ...state, status: 'loading' })); loadTransactions(); }}
            >
              RETRY
            </button>
          </div>
        ) : null}
        {ledger.status === 'ready' && !ledger.rows.length ? <div className="sx-ps-hint">No credit transactions yet. Purchases, cloud jobs and reel rewards will appear here.</div> : null}
        {ledger.rows.length ? (
          <ul className="sx-cr-ledger" aria-label="Credit transactions">
            {ledger.rows.map((row, index) => <TransactionRow key={row.id ?? index} row={row} />)}
          </ul>
        ) : null}
        {ledger.loadError ? <div className="sx-ps-feedback sx-ps-feedback--err" role="alert">Could not load more transactions.</div> : null}
        {ledger.hasMore ? (
          <div className="sx-cr-more">
            <button type="button" className="sx-ps-btn" disabled={ledger.loadingMore} onClick={() => loadTransactions({ append: true })}>
              {ledger.loadingMore ? 'LOADING…' : 'LOAD MORE'}
            </button>
          </div>
        ) : null}
        {ledger.rows.length && !ledger.hasMore ? <div className="sx-ps-hint sx-cr-end">END OF LEDGER · {ledger.rows.length} {ledger.rows.length === 1 ? 'ENTRY' : 'ENTRIES'}</div> : null}
      </Panel>
    </div>
  );
}
