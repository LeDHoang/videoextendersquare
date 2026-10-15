import { useEffect, useMemo, useRef, useState } from 'react';
import { useCreditQuotes } from '../../hooks/useCreditQuotes.js';
import { stagedItemNeedsCloud } from '../../utils/cloudBilling.js';

// Cloud funding for a render of `items` (staged upload metadata) with one
// kind's settings. Same rules as ImagePage/VideoPage: quote only the items
// that need the cloud (estimates only while credits are disabled), BYOK-only models force MY FAL KEY (and switch back to
// credits once a credit-supported model is picked again), and a stale quote
// never hard-blocks because the render re-fetches fresh quotes first.
export function useRenderFunding({ kind, items, config, user, wallet, catalog, falKey }) {
  const [paymentSource, setPaymentSource] = useState('credits');
  const autoByokRef = useRef(false);
  const parameters = config.parameters;

  const quoteItems = useMemo(
    () => items.filter((item) => stagedItemNeedsCloud(item, parameters)).map((item) => ({ stage_id: item.stage_id })),
    [items, parameters],
  );
  const cloudRequired = quoteItems.length > 0;
  const byokOnly = config.byokOnlyFor(items);
  const quoteState = useCreditQuotes({
    kind: kind || 'image',
    items: quoteItems,
    parameters,
    enabled: cloudRequired && Boolean(user) && !byokOnly,
  });
  const insufficientCredits = paymentSource === 'credits' && Number(wallet?.available_credits || 0) < quoteState.totalCredits;
  const quoteStale = cloudRequired && paymentSource === 'credits' && !byokOnly && Boolean(catalog?.credits_enabled) && (
    quoteState.loading || Boolean(quoteState.error) || quoteState.quotes.length !== quoteItems.length
  );
  const fundingBlocked = cloudRequired && (
    !user ||
    (paymentSource === 'byok' && !falKey?.configured) ||
    (paymentSource === 'credits' && (
      byokOnly || !catalog?.credits_enabled || insufficientCredits
    ))
  );

  useEffect(() => {
    if (byokOnly) {
      if (paymentSource !== 'byok') {
        autoByokRef.current = true;
        setPaymentSource('byok');
      }
    } else if (autoByokRef.current) {
      // The switch to BYOK was automatic: restore credits now that a
      // credit-supported model is selected again. An explicit user choice
      // of BYOK is left untouched.
      autoByokRef.current = false;
      setPaymentSource('credits');
    }
  }, [byokOnly, paymentSource]);

  return {
    paymentSource,
    setPaymentSource,
    quoteItems,
    cloudRequired,
    byokOnly,
    quoteState,
    quoteStale,
    fundingBlocked,
    needsCloud: (item) => stagedItemNeedsCloud(item, parameters),
  };
}
