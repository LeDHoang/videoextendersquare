export function IndustrialImageIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} {...props}>
      <path d="M3 3H21V21H3V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="bevel" />
      <path d="M3 16L8 11L13 16M11 14L16 9L21 14" stroke="var(--sx-accent, #ff3b1f)" strokeWidth="1.5" strokeLinejoin="bevel" />
      <circle cx="16" cy="7" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function IndustrialVideoIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} {...props}>
      <path d="M21 5L19 3H5L3 5V19L5 21H19L21 19V5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="bevel" />
      <path d="M3 7H21M3 11H21M3 15H21" stroke="currentColor" strokeWidth="1" opacity="0.3" />
      <path d="M10 9L15 12L10 15V9Z" fill="var(--sx-accent, #ff3b1f)" />
      <path d="M7 3L5 5M11 3L9 5M15 3L13 5M19 3L17 5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function IndustrialCompareIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} {...props}>
      <path d="M3 5L5 3H19L21 5V19L19 21H5L3 19V5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="bevel" />
      <path d="M12 3V21" stroke="var(--sx-accent, #ff3b1f)" strokeWidth="1.5" />
      <path d="M7 10L9 12L7 14M17 10L15 12L17 14" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="bevel" />
    </svg>
  );
}

export function IndustrialReelsIcon({ className = 'sx-sidebar-icon-svg', ...props }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} {...props}>
      <path d="M3 8L5 6H19L21 8V16L19 18H5L3 16V8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="bevel" />
      <path d="M7 10H9V14H7V10ZM15 10H17V14H15V10Z" fill="var(--sx-accent, #ff3b1f)" />
      <path d="M10 18L12 16L14 18" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="bevel" />
    </svg>
  );
}
