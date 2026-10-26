import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', '..', 'ui', 'assets', 'reels.html'), 'utf-8');

function block(name) {
  const match = html.match(new RegExp(`// <${name}>\\n([\\s\\S]*?)// </${name}>`));
  assert.ok(match, `${name} markers present`);
  return match[1];
}

// Runs the real vrImageSource from reels.html with fetch and
// createImageBitmap under the test's control.
function load({ fetchFails = false } = {}) {
  const fetched = [];
  const bitmaps = [];
  const context = {
    Error,
    fetch(url) {
      fetched.push(url);
      if (fetchFails) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: true, blob: () => Promise.resolve({ url }) });
    },
    createImageBitmap(blob) {
      const bitmap = { url: blob.url, closed: false, close() { this.closed = true; } };
      bitmaps.push(bitmap);
      return Promise.resolve(bitmap);
    },
  };
  vm.createContext(context);
  vm.runInContext(`${block('reels-vr-image-bitmap')}\nthis.vrImageSource = vrImageSource;`, context);
  return { vrImageSource: context.vrImageSource, fetched, bitmaps };
}

const image = (src) => ({ complete: true, naturalWidth: 1080, getAttribute: () => src });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an image slide reaches VR as an off-thread bitmap; the last frame holds meanwhile', async () => {
  const { vrImageSource, fetched } = load();
  const img = image('/media/a.png');
  const pending = vrImageSource(img);
  assert.equal(pending.element, img);
  assert.equal(pending.ready, false);
  await settle();
  const ready = vrImageSource(img);
  assert.equal(ready.ready, true);
  assert.equal(ready.element.url, '/media/a.png');
  assert.deepEqual(fetched, ['/media/a.png'], 'one fetch per slide, not per frame');
});

test('a slide change swaps the bitmap and frees the old one', async () => {
  const { vrImageSource, bitmaps } = load();
  vrImageSource(image('/media/a.png'));
  await settle();
  vrImageSource(image('/media/b.png'));
  assert.equal(bitmaps[0].closed, true);
  await settle();
  assert.equal(vrImageSource(image('/media/b.png')).element.url, '/media/b.png');
});

test('a bitmap that lands after the slide moved on is dropped', async () => {
  const { vrImageSource, bitmaps } = load();
  vrImageSource(image('/media/a.png'));
  vrImageSource(image('/media/b.png'));
  await settle();
  assert.equal(bitmaps.find((b) => b.url === '/media/a.png').closed, true);
  assert.equal(vrImageSource(image('/media/b.png')).element.url, '/media/b.png');
});

test('a failed fetch falls back to drawing the <img>', async () => {
  const { vrImageSource } = load({ fetchFails: true });
  const img = image('/media/a.png');
  vrImageSource(img);
  await settle();
  const source = vrImageSource(img);
  assert.equal(source.element, img);
  assert.equal(source.ready, true);
});
