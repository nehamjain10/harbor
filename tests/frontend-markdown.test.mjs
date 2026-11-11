// DOMPurify needs a real browser DOM (it is a no-op under linkedom), so these tests
// cover our own parts: the marked renderer and the link decoration hook. Sanitizing
// is exercised in the browser during staging checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createMarkdownRenderer, decorateLink } from '../src/lib/markdown.js';
import { localImagePath, localImageUrl } from '../src/lib/localImage.js';

const ORIGIN = 'https://workbench.example:18544';

const render = createMarkdownRenderer({ origin: ORIGIN, sanitize: (html) => html });
const parse = (html) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;

test('file links are rewritten to /__file/ hrefs that read back as files', () => {
  const doc = parse(render('See [runner](server/runner.mjs:40), [abs](/repo/a.py#L3) and [web](https://example.com).'));
  const [file, abs, web] = doc.querySelectorAll('a');
  assert.equal(file.getAttribute('href'), '/__file/server%2Frunner.mjs#L40');
  assert.equal(abs.getAttribute('href'), '/__file/%2Frepo%2Fa.py#L3');
  assert.equal(web.getAttribute('href'), 'https://example.com');
});

test('local image paths render without a src, for Markdown.jsx to point at the server', () => {
  const doc = parse(render('![plot](/tmp/x/my%20plot.png) ![rel](out/a.png "A") ![web](https://example.com/a.png) ![d](data:image/png;base64,AA==) ![f](file:///tmp/b.png)'));
  const [abs, rel, web, data, file] = doc.querySelectorAll('img');
  assert.equal(abs.getAttribute('src'), null);
  assert.equal(abs.getAttribute('data-local-src'), '/tmp/x/my plot.png');
  assert.equal(abs.getAttribute('alt'), 'plot');
  assert.equal(rel.getAttribute('data-local-src'), 'out/a.png');
  assert.equal(rel.getAttribute('title'), 'A');
  assert.equal(web.getAttribute('src'), 'https://example.com/a.png');
  assert.equal(web.getAttribute('data-local-src'), null);
  assert.equal(data.getAttribute('src'), 'data:image/png;base64,AA==');
  assert.equal(file.getAttribute('data-local-src'), '/tmp/b.png');
});

test('localImageUrl carries the session only when given', () => {
  assert.equal(localImageUrl('/tmp/a b.png'), '/api/local-image?path=%2Ftmp%2Fa+b.png');
  assert.equal(localImageUrl('a.png', 's1'), '/api/local-image?path=a.png&session=s1');
  assert.equal(localImagePath('/api/uploads/x'), null);
  assert.equal(localImagePath('//cdn.example/a.png'), null);
});

test('decorateLink tags file links and makes other links open in a new tab', () => {
  const doc = parse('<a href="/__file/server%2Frunner.mjs#L40" target="_blank">f</a><a href="https://example.com">w</a><a>none</a>');
  const [file, web, none] = doc.querySelectorAll('a');
  for (const a of [file, web, none]) decorateLink(a, ORIGIN);
  assert.equal(file.getAttribute('data-file-path'), 'server/runner.mjs');
  assert.equal(file.getAttribute('data-file-line'), '40');
  assert.equal(file.getAttribute('class'), 'file-link');
  assert.equal(file.getAttribute('target'), null);
  assert.equal(file.getAttribute('title'), 'Open server/runner.mjs at line 40');
  assert.equal(web.getAttribute('target'), '_blank');
  assert.equal(web.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(none.getAttribute('target'), null);
});

test('code blocks are wrapped with their language and escaped', () => {
  const doc = parse(render('```js\nconst a = "<b>";\n```\n\n```\nplain\n```'));
  const [block, plain] = doc.querySelectorAll('.code-block');
  assert.equal(block.getAttribute('data-lang'), 'js');
  assert.equal(block.querySelector('code').getAttribute('class'), 'language-js hljs');
  assert.equal(block.querySelector('code').textContent.trim(), 'const a = "<b>";');
  // Highlighted: only hljs spans are added.
  assert.equal(block.querySelector('.hljs-keyword').textContent, 'const');
  assert.equal(doc.querySelector('b'), null);
  assert.equal(plain.getAttribute('data-lang'), null);
  assert.equal(plain.querySelector('code').textContent.trim(), 'plain');
});

test('unknown fence languages stay plain and escaped', () => {
  const doc = parse(render('```cobol\n<script>x</script>\n```'));
  const block = doc.querySelector('.code-block');
  assert.equal(block.getAttribute('data-lang'), 'cobol');
  assert.equal(block.querySelector('script'), null);
  assert.equal(block.querySelector('code').textContent.trim(), '<script>x</script>');
  assert.equal(block.querySelector('span'), null);
});

test('without a usable DOM the renderer escapes instead of passing HTML through', () => {
  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  const unsafe = createMarkdownRenderer({ window, origin: ORIGIN });
  const out = unsafe('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'));
});

const mathOf = (markdown) =>
  [...parse(render(markdown)).querySelectorAll('.math')].map((node) => ({
    tag: node.tagName.toLowerCase(),
    display: node.classList.contains('math-display'),
    tex: node.getAttribute('data-tex'),
    text: node.textContent,
  }));

test('inline and display math become placeholders holding the TeX', () => {
  assert.deepEqual(mathOf('Euler: $e^{i\\pi} + 1 = 0$ and \\(a_1 * b_2\\).'), [
    { tag: 'span', display: false, tex: 'e^{i\\pi} + 1 = 0', text: '$e^{i\\pi} + 1 = 0$' },
    { tag: 'span', display: false, tex: 'a_1 * b_2', text: '\\(a_1 * b_2\\)' },
  ]);
  assert.deepEqual(mathOf('Before\n\n$$\n\\sum_{i=1}^n x_i\n\n= y\n$$\n\nafter \\[x^2\\] end'), [
    { tag: 'div', display: true, tex: '\\sum_{i=1}^n x_i\n\n= y', text: '$$\n\\sum_{i=1}^n x_i\n\n= y\n$$' },
    { tag: 'span', display: true, tex: 'x^2', text: '\\[x^2\\]' },
  ]);
  // Underscores and stars inside math are not emphasis.
  assert.equal(parse(render('$a_1 + b_2 = c_3$')).querySelector('em'), null);
});

test('prices, escaped dollars, code and unclosed math stay text', () => {
  for (const text of ['It costs $5 and $10.', 'Between $5-$10 a month', 'Pay \\$3 or \\$4', 'Use `$x$` here', 'Still typing $\\frac{a}{', '$ x $ has spaces']) {
    assert.deepEqual(mathOf(text), [], text);
  }
  assert.match(render('Use `$x$` here'), /<code>\$x\$<\/code>/);
});

test('math source is escaped in the placeholder', () => {
  const html = render('$a<b>"c"$');
  assert.doesNotMatch(html, /<b>/);
  assert.deepEqual(mathOf('$a<b>"c"$'), [{ tag: 'span', display: false, tex: 'a<b>"c"', text: '$a<b>"c"$' }]);
});

test('display math with blank lines stays one streaming block', async () => {
  const { splitBlocks } = await import('../src/lib/markdown.js');
  assert.deepEqual(splitBlocks('Intro\n\n$$\na\n\nb\n$$\n\nDone'), ['Intro\n\n', '$$\na\n\nb\n$$\n\n', 'Done']);
});
