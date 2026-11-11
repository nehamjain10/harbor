// Real-browser smoke test for markdown sanitizing (DOMPurify needs a real DOM, so the
// fast unit tests cannot cover it). Run with `npm run test:browser`; needs the
// Playwright Chromium build (set CHROMIUM_PATH to use another Chrome binary).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://harbor.test';

let browser;
let page;

before(async () => {
  const bundle = await esbuild.build({
    entryPoints: [path.join(root, 'src/lib/markdown.js')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'HarborMarkdown',
    target: 'es2022',
    logLevel: 'silent',
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  page = await browser.newPage();
  // Serve a blank page from a fixed origin so file links resolve like in the app.
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto(ORIGIN + '/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});

after(async () => {
  await browser?.close();
});

// Renders markdown, mounts the HTML, and gives any injected handler a chance to run.
async function render(markdown) {
  return page.evaluate(async (text) => {
    window.__pwned = undefined;
    const html = window.HarborMarkdown.renderMarkdown(text);
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.replaceChildren(host);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const links = [...host.querySelectorAll('a')].map((a) => ({
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
      className: a.className,
    }));
    return { html, links, pwned: window.__pwned };
  }, markdown);
}

test('strips event handlers from raw HTML images', async () => {
  const { html, pwned } = await render('before <img src="x" onerror="window.__pwned = 1"> after');
  assert.doesNotMatch(html, /onerror/i);
  assert.equal(pwned, undefined);
});

test('drops javascript: URLs from markdown and raw links', async () => {
  const { html, links, pwned } = await render('[md](javascript:window.__pwned=2) and <a href="javascript:window.__pwned=3">raw</a>');
  assert.doesNotMatch(html, /javascript:/i);
  for (const link of links) assert.ok(!link.href || !/^javascript:/i.test(link.href), JSON.stringify(link));
  assert.equal(pwned, undefined);
});

test('removes scripts, iframes, forms and inline styles', async () => {
  const { html, pwned } = await render(
    '<script>window.__pwned = 4</script><iframe src="/"></iframe><form><button>b</button></form><svg onload="window.__pwned = 5"></svg><p style="color:red">x</p>',
  );
  assert.doesNotMatch(html, /<script|<iframe|<form|<button|onload|style=/i);
  assert.equal(pwned, undefined);
});

test('keeps file links in the app and opens other links in a new tab', async () => {
  const { links } = await render('See [store.mjs](server/store.mjs:12) and [docs](https://example.com/docs).');
  assert.deepEqual(links[0], { href: '/__file/server%2Fstore.mjs#L12', target: null, rel: null, className: 'file-link' });
  assert.equal(links[1].href, 'https://example.com/docs');
  assert.equal(links[1].target, '_blank');
  assert.equal(links[1].rel, 'noopener noreferrer');
});

test('highlighted code fences keep their token spans and stay inert', async () => {
  const { html, pwned } = await render(
    '```js\nconst a = "</code><img src=x onerror=window.__pwned=1>"; // note\n```\n\n```\n<script>window.__pwned = 2</script>\n```',
  );
  assert.equal(pwned, undefined);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<span class="hljs-comment">\/\/ note<\/span>/);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;\/code&gt;&lt;img/);
});
