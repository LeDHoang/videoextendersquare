// Renders canonical artwork from svg/ so every icon has exactly one source
// file. className lands on the <svg> itself (existing CSS targets it);
// the wrapper span is display:contents so layout is unaffected. `filled`
// adds .sx-icon-filled for state variants (e.g. liked hearts via #edge).
export function RawIcon({ src, className = '', filled = false, ...props }) {
  const cls = `${className}${filled ? ' sx-icon-filled' : ''}`.trim();
  const html = src.replace('<svg', `<svg class="${cls}" aria-hidden="true"`);
  return (
    <span
      style={{ display: 'contents' }}
      dangerouslySetInnerHTML={{ __html: html }}
      {...props}
    />
  );
}
