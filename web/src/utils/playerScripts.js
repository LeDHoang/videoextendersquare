// Runs the player's scripts in order. Inline ones (strings) run on append;
// vendored ones ({ src }, long-cached by the browser) are awaited so every
// later script sees their globals, as it did when all of them were inline.
// Every vendored script is preloaded up front, so they download in parallel
// and only their execution is serial. A `lazy` one is left out of the chain
// and loaded once the rest has run and `lazyAfter` has settled: nothing reads
// it at start-up, so it should not take bandwidth from the first video.
// Stops between scripts once `cancelled()` turns true.
export function runScripts(mount, scripts, cancelled, doc = document, lazyAfter = Promise.resolve()) {
  const eager = scripts.filter((entry) => typeof entry === 'string' || !entry.lazy);
  const lazy = scripts.filter((entry) => typeof entry !== 'string' && entry.lazy);
  eager.forEach((entry) => {
    if (typeof entry === 'string') return;
    const link = doc.createElement('link');
    link.rel = 'preload';
    link.as = 'script';
    link.href = entry.src;
    mount.appendChild(link);
  });
  const ran = eager.reduce(
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
  ran
    .then(() => lazyAfter)
    .then(() => {
      lazy.forEach((entry) => {
        if (cancelled()) return;
        const script = doc.createElement('script');
        script.src = entry.src;
        mount.appendChild(script);
      });
    })
    .catch(() => {});
  return ran;
}
