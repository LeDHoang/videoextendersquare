// Runs the player's scripts in order. Inline ones (strings) run on append;
// vendored ones ({ src }, long-cached by the browser) are awaited so every
// later script sees their globals, as it did when all of them were inline.
// Stops between scripts once `cancelled()` turns true.
export function runScripts(mount, scripts, cancelled, doc = document) {
  return scripts.reduce(
    (ready, entry) =>
      ready.then(() => {
        if (cancelled()) return undefined;
        const script = doc.createElement('script');
        if (typeof entry === 'string') {
          script.textContent = entry;
          mount.appendChild(script);
          return undefined;
        }
        return new Promise((resolve, reject) => {
          script.onload = () => resolve();
          script.onerror = () => reject(new Error(`Player script failed to load: ${entry.src}`));
          script.src = entry.src;
          mount.appendChild(script);
        });
      }),
    Promise.resolve(),
  );
}
