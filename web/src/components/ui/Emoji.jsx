// Renders inline label content as-is.
//
// This used to pipe `text` through the `twemoji` package + a
// dangerouslySetInnerHTML span. Every call site in this app passes plain
// ASCII/unicode glyphs (labels like "Image", "COMPLETE", "↓ DOWNLOAD
// MASTER") — none of that is emoji-presentation text, so twemoji never
// matched anything and the dependency + innerHTML injection did nothing
// except cost bundle weight and an XSS-shaped surface for server-derived
// strings (filenames) that flow through here elsewhere in the app.
//
// It also silently broke multi-child call sites: `String(children)` on a
// React children array comma-joins it, e.g. the RENDER button used to read
// "▶ RENDER ,3, VIDEO(S) 4K SQUARE". Rendering children directly fixes that.
export default function Emoji({ text, className }) {
  return <span className={className}>{text}</span>;
}
