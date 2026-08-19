import twemoji from 'twemoji';
import { useMemo } from 'react';

// Renders text with Twemoji SVG images instead of stock/system emoji.
export default function Emoji({ text, className }) {
  const html = useMemo(
    () =>
      twemoji.parse(String(text ?? ''), {
        folder: 'svg',
        ext: '.svg',
        className: 'emoji',
      }),
    [text],
  );
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}