// Renders the math placeholders of markdown.js (see math.js) with KaTeX. KaTeX and
// its stylesheet load the first time a message has math, so the app bundle does not
// carry them. Its output goes in after DOMPurify: it escapes the TeX, and runs with
// trust off, so no links, classes or raw HTML come from the source.

// Versioned by scripts/build.mjs, so they are cached for good.
const ASSETS = typeof __KATEX_ASSETS__ === 'undefined' ? { js: '/dist/katex/katex.js', css: '/dist/katex/katex.css' } : __KATEX_ASSETS__;
const CACHE_MAX = 2000;

let katex = null;
let loading = null;
// Rendered HTML by display flag + TeX, most recently used last: a growing message
// re-renders its last block on every tick, with the same math in it.
const cache = new Map();

function loadCss() {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = ASSETS.css;
    // Without the stylesheet KaTeX's output is unreadable, but a failed load should
    // not leave the source hidden behind a promise that never settles.
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  });
}

function load() {
  loading ??= Promise.all([import(ASSETS.js), loadCss()]).then(
    ([module]) => {
      katex = module.default;
    },
    (error) => {
      loading = null; // tried again with the next math
      throw error;
    },
  );
  return loading;
}

function toHtml(tex, display) {
  const key = (display ? 'D' : 'I') + tex;
  let html = cache.get(key);
  if (html !== undefined) {
    cache.delete(key);
  } else {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  cache.set(key, html);
  return html;
}

function typesetNow(nodes) {
  for (const node of nodes) {
    if (!node.isConnected || node.dataset.typeset) continue;
    node.innerHTML = toHtml(node.dataset.tex, node.classList.contains('math-display'));
    node.dataset.typeset = '1';
  }
}

// Typesets the math under `root` now when KaTeX is loaded, otherwise once it is
// (the source stays as text meanwhile, and for good if it cannot load).
export function typesetMath(root) {
  const nodes = root.querySelectorAll('.math[data-tex]:not([data-typeset])');
  if (!nodes.length) return;
  if (katex) return typesetNow(nodes);
  load().then(
    () => typesetNow(nodes),
    () => {},
  );
}
