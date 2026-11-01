/**
 * A button whose only content is an icon or glyph. `label` is required: it is the
 * accessible name and, unless `title` says otherwise, the tooltip.
 *
 * Variants: 'outline' (black fill, strong rule), 'primary' (accent fill) and 'plain'
 * (no fill or border, for controls that keep their own look, such as dialog close buttons).
 * The box is 44px; where CSS makes it smaller, an ::after layer keeps the hit area at 44px.
 * `as` renders another element, e.g. a NavLink, with the same look.
 */
export default function IconButton({ label, title, as: Component = 'button', variant = 'outline', className = '', children, ...props }) {
  return (
    <Component
      {...(Component === 'button' ? { type: 'button' } : null)}
      {...props}
      className={'sx-icon-button sx-icon-button--' + variant + (className ? ' ' + className : '')}
      aria-label={label}
      title={title ?? label}
    >
      {children}
    </Component>
  );
}
