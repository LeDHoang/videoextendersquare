import { Link } from 'react-router-dom';
import { tokenizeRichText } from '../../utils/richText.js';

// Renders user text with styled #hashtags, @mentions and links. Everything is
// emitted as React elements (never innerHTML), and hrefs are http(s)-only.
export default function RichText({ text, className = '' }) {
  const parts = tokenizeRichText(text);
  return (
    <span className={'sx-rt ' + className}>
      {parts.map((part, index) => {
        if (part.type === 'tag') {
          return (
            <Link key={index} to={part.to} className="sx-rt-tag">
              <span aria-hidden="true">#</span>{part.text}
            </Link>
          );
        }
        if (part.type === 'mention') {
          return <Link key={index} to={part.to} className="sx-rt-mention">@{part.text}</Link>;
        }
        if (part.type === 'link') {
          return (
            <a key={index} href={part.href} className="sx-rt-link" target="_blank" rel="noopener noreferrer nofollow ugc">
              {part.text}<span aria-hidden="true"> ↗</span>
            </a>
          );
        }
        return part.text;
      })}
    </span>
  );
}
