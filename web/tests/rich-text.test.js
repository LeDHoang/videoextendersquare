import test from 'node:test';
import assert from 'node:assert/strict';
import { tagSlug, tokenizeRichText } from '../src/utils/richText.js';

const kinds = (text) => tokenizeRichText(text).map((p) => p.type + ':' + p.text);

test('hashtags on separate lines each become tag tokens', () => {
  assert.deepEqual(kinds('asdasdasdas\n#test\n#test'), [
    'text:asdasdasdas\n', 'tag:test', 'text:\n', 'tag:test',
  ]);
});

test('tag links use the same slug rules as the server', () => {
  assert.equal(tagSlug('#LTX2.3'), 'ltx2-3');
  assert.equal(tagSlug('#lyric_video'), 'lyric-video');
  const [tag] = tokenizeRichText('#4KOutpaint');
  assert.equal(tag.to, '/explore/tag/4koutpaint');
});

test('mentions link to lower-cased profiles and need a boundary', () => {
  assert.deepEqual(kinds('Co-founder @VoidMatrix.'), ['text:Co-founder ', 'mention:VoidMatrix', 'text:.']);
  assert.equal(tokenizeRichText('@VoidMatrix')[0].to, '/profile/voidmatrix');
  assert.deepEqual(kinds('mail me@example'), ['text:mail me@example']);
});

test('links: http(s), www and domain/path become link tokens without trailing punctuation', () => {
  const parts = tokenizeRichText('see https://github.com/echodev, www.example.com and linktr.ee/echodev.');
  const links = parts.filter((p) => p.type === 'link');
  assert.deepEqual(links.map((p) => p.href), [
    'https://github.com/echodev', 'https://www.example.com', 'https://linktr.ee/echodev',
  ]);
  assert.deepEqual(links.map((p) => p.text), ['github.com/echodev', 'example.com', 'linktr.ee/echodev']);
});

test('non-http schemes and plain words are never linkified', () => {
  assert.deepEqual(kinds('javascript:alert(1) e.g. foo'), ['text:javascript:alert(1) e.g. foo']);
  assert.ok(!tokenizeRichText('data:text/html,<b>x</b>').some((p) => p.type === 'link'));
});

test('hashtag inside a url or word is not a tag', () => {
  assert.ok(!tokenizeRichText('https://x.com/a#frag').some((p) => p.type === 'tag'));
  assert.deepEqual(kinds('abc#nope'), ['text:abc#nope']);
});

test('bare domains like test.com are linkified, including with paths and ports', () => {
  const links = (text) => tokenizeRichText(text).filter((p) => p.type === 'link');
  assert.deepEqual(links('visit test.com today').map((p) => p.href), ['https://test.com']);
  assert.deepEqual(links('visit test.com today').map((p) => p.text), ['test.com']);
  assert.deepEqual(links('go to my-site.dev/about?x=1.').map((p) => p.href), ['https://my-site.dev/about?x=1']);
  assert.deepEqual(links('shop.example.co.uk, ok').map((p) => p.href), ['https://shop.example.co.uk']);
  assert.deepEqual(links('local test.com:8080/x').map((p) => p.href), ['https://test.com:8080/x']);
});

test('bare-domain detection avoids emails, files and look-alike words', () => {
  const none = (text) => assert.ok(!tokenizeRichText(text).some((p) => p.type === 'link'), text);
  none('write me@test.com');
  none('Built with Node.js and e.g. react');
  none('see notes.txt and main.py');
  none('test.community rocks');
  none('v1.2 released');
});
