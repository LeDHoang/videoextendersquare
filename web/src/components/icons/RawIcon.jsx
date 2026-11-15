import { useMemo } from 'react';

// Renders canonical artwork from svg/ so every icon has exactly one source
// file. className lands on the <svg> itself (existing CSS targets it);
// the wrapper span is display:contents so layout is unaffected. `filled`
// adds .sx-icon-filled for state variants (e.g. liked hearts via #edge).
//
// The __html object is memoised: React 19 rewrites innerHTML whenever that
// object changes, so a fresh one per render tore out and re-inserted every
// icon's <svg> on each parent re-render (e.g. the 8s health poll), which
// flickered icons and reset their state.
export function RawIcon({ src, className = '', filled = false, ...props }) {
  const cls = `${className}${filled ? ' sx-icon-filled' : ''}`.trim();
  const markup = useMemo(
    () => ({ __html: src.replace('<svg', `<svg class="${cls}" aria-hidden="true"`) }),
    [src, cls],
  );
  return (
    <span
      style={{ display: 'contents' }}
      dangerouslySetInnerHTML={markup}
      {...props}
    />
  );
}
