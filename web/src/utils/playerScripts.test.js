import { describe, expect, it } from 'vitest';
import { runScripts } from './playerScripts.js';

// A fake document whose <script src> elements "load" when the test says so.
function fakeDom() {
  const ran = [];
  const pending = [];
  const preloaded = [];
  const doc = {
    createElement: (tag) => ({ tag }),
  };
  const mount = {
    appendChild(script) {
      if (script.tag === 'link') preloaded.push(script.href);
      else if (script.src) pending.push(script);
      else ran.push(script.textContent);
    },
  };
  const load = (ok = true) => {
    const script = pending.shift();
    ran.push(script.src);
    if (ok) script.onload();
    else script.onerror();
  };
  return { doc, mount, ran, pending, preloaded, load };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runScripts', () => {
  it('runs inline and src scripts in order, waiting for each src to load', async () => {
    const { doc, mount, ran, pending, load } = fakeDom();
    const done = runScripts(mount, ['a', { src: '/three.js' }, { src: '/vr.js' }, 'init'], () => false, doc);
    await tick();
    expect(ran).toEqual(['a']);
    expect(pending).toHaveLength(1);
    load();
    await tick();
    expect(ran).toEqual(['a', '/three.js']);
    load();
    await done;
    expect(ran).toEqual(['a', '/three.js', '/vr.js', 'init']);
  });

  it('preloads every eager src script at once, before the first one has loaded', async () => {
    const { doc, mount, preloaded, pending } = fakeDom();
    runScripts(mount, ['a', { src: '/three.js' }, { src: '/img.js', lazy: true }, { src: '/vr.js' }, 'init'], () => false, doc);
    await tick();
    expect(preloaded).toEqual(['/three.js', '/vr.js']);
    expect(pending).toHaveLength(1);
  });

  it('loads a lazy script only after the rest has run and lazyAfter has settled', async () => {
    const { doc, mount, ran, pending, load } = fakeDom();
    let firstFrame;
    const lazyAfter = new Promise((resolve) => { firstFrame = resolve; });
    const done = runScripts(mount, [{ src: '/img.js', lazy: true }, { src: '/three.js' }, 'init'], () => false, doc, lazyAfter);
    await tick();
    expect(pending.map((s) => s.src)).toEqual(['/three.js']);
    load();
    await done;
    expect(ran).toEqual(['/three.js', 'init']);
    expect(pending).toHaveLength(0);
    firstFrame();
    await tick();
    expect(pending.map((s) => s.src)).toEqual(['/img.js']);
  });

  it('stops before the next script once cancelled', async () => {
    const { doc, mount, ran, load } = fakeDom();
    let cancelled = false;
    const done = runScripts(mount, [{ src: '/three.js' }, 'init'], () => cancelled, doc);
    await tick();
    cancelled = true;
    load();
    await done;
    expect(ran).toEqual(['/three.js']);
  });

  it('rejects and skips the rest when a script fails to load', async () => {
    const { doc, mount, ran, load } = fakeDom();
    const done = runScripts(mount, [{ src: '/three.js' }, 'init'], () => false, doc);
    await tick();
    load(false);
    await expect(done).rejects.toThrow('/three.js');
    expect(ran).toEqual(['/three.js']);
  });
});
