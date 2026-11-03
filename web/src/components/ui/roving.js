// Roving focus for radio groups and tab lists (the WAI-ARIA radio group and tabs patterns).
// Tab enters the group once, on the selected item; arrow keys, Home and End move to the
// next enabled item and select it. Put `onRovingKeyDown` on the group and give each item
// `tabIndex={index === stop ? 0 : -1}`, where `stop = tabStop(...)`.

const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function onRovingKeyDown(event) {
  const items = [...event.currentTarget.querySelectorAll('[role="radio"], [role="tab"]')].filter(
    (item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true',
  );
  const index = items.indexOf(event.target);
  if (index < 0) return;
  let next;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key in STEP) next = (index + STEP[event.key] + items.length) % items.length;
  else return;
  event.preventDefault();
  items[next].focus();
  if (next !== index) items[next].click();
}

// The item Tab reaches: the selected one, else the first enabled one.
export function tabStop(selected, disabled = []) {
  const index = selected.indexOf(true);
  return index >= 0 ? index : Math.max(0, disabled.indexOf(false));
}
