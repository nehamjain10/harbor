// Real-browser test for math: markdown placeholders survive DOMPurify, and KaTeX
// (loaded on demand from the built public/dist/katex/) typesets them. Run with
// `npm run test:browser` after `npm run build`. MATH_SCREENSHOT=<file> saves a
// picture of the rendered sample.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://harbor.test';
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

let browser;
let page;

before(async () => {
  const bundle = await esbuild.build({
    stdin: {
      contents: "export { renderMarkdown } from './src/lib/markdown.js'; export { typesetMath } from './src/lib/typeset.js';",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'HarborMath',
    target: 'es2022',
    logLevel: 'silent',
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (!pathname.startsWith('/dist/katex/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    const file = path.join(root, 'public', pathname);
    const body = await fs.readFile(file).catch(() => null);
    return body ? route.fulfill({ contentType: TYPES[path.extname(file)], body }) : route.fulfill({ status: 404 });
  });
  await page.goto(ORIGIN + '/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});

after(async () => {
  await browser?.close();
});

const SAMPLE = [
  'The roots of $ax^2 + bx + c = 0$ are',
  '',
  '$$',
  'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  '$$',
  '',
  'and the loss is \\(\\mathcal{L} = \\sum_{i=1}^{n} \\lVert y_i - \\hat y_i \\rVert_2^2\\). It costs $5 and $10.',
  '',
  'Bad TeX: $\\frac{a}{$ and $\\notacommand$.',
].join('\n');

test('math is sanitized-safe and typeset by KaTeX once it loads', async () => {
  const result = await page.evaluate(async (text) => {
    const host = document.createElement('div');
    host.className = 'markdown';
    host.innerHTML = window.HarborMath.renderMarkdown(text);
    document.body.replaceChildren(host);
    window.HarborMath.typesetMath(host);
    const deadline = Date.now() + 10_000;
    while (host.querySelector('.math:not([data-typeset])') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await document.fonts.ready;
    return {
      math: host.querySelectorAll('.math').length,
      typeset: host.querySelectorAll('.math[data-typeset]').length,
      display: host.querySelectorAll('.math-display .katex-display').length,
      errors: [...host.querySelectorAll('.katex-error')].map((node) => node.textContent),
      text: host.textContent,
      fontsLoaded: [...document.fonts].filter((font) => font.family.startsWith('KaTeX') && font.status === 'loaded').length,
      styled: getComputedStyle(host.querySelector('.katex')).fontFamily,
    };
  }, SAMPLE);
  assert.equal(result.math, 5);
  assert.equal(result.typeset, 5);
  assert.equal(result.display, 1);
  // KaTeX shows TeX it cannot parse as its source instead of throwing (an unknown
  // command is shown in red where it stands).
  assert.deepEqual(result.errors, ['\\frac{a}{']);
  assert.match(result.text, /It costs \$5 and \$10\./);
  assert.ok(result.fontsLoaded > 0, 'KaTeX fonts load');
  assert.match(result.styled, /KaTeX_Main/);
  if (process.env.MATH_SCREENSHOT) await page.locator('.markdown').screenshot({ path: process.env.MATH_SCREENSHOT });
});
