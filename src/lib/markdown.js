// Markdown → sanitized HTML. Links that look like project files are rewritten to
// `/__file/...` and tagged so a click opens the side panel at that line.
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { fileHref, fileReference } from './fileReference.js';
import { highlight, resolveLanguage } from './highlight.js';
import { localImagePath } from './localImage.js';
import { mathExtensions } from './math.js';

const escapeAttr = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SANITIZE = {
  FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select'],
  FORBID_ATTR: ['style'],
};

// Tags a sanitized <a>: project files get data attributes for the side panel,
// everything else opens in a new tab.
export function decorateLink(node, origin) {
  const href = node.getAttribute('href');
  const ref = fileReference(href, origin);
  if (ref) {
    node.setAttribute('class', ((node.getAttribute('class') || '') + ' file-link').trim());
    node.setAttribute('data-file-path', ref.path);
    if (ref.line) node.setAttribute('data-file-line', String(ref.line));
    node.setAttribute('title', 'Open ' + ref.path + (ref.line ? ' at line ' + ref.line : ''));
    node.removeAttribute('target');
  } else if (href) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
}

// `sanitize` can be injected for tests (DOMPurify needs a real browser DOM).
export function createMarkdownRenderer({ window: win = globalThis.window, origin = win?.location?.origin, sanitize } = {}) {
  let clean = sanitize;
  if (!clean) {
    const purify = createDOMPurify(win);
    purify.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeName === 'A') decorateLink(node, origin);
    });
    // Without a usable DOM, show the markup as text rather than unsanitized HTML.
    clean = purify.isSupported ? (html) => purify.sanitize(html, SANITIZE) : escapeAttr;
  }

  const marked = new Marked({
    gfm: true,
    breaks: false,
    extensions: mathExtensions,
    renderer: {
      link({ href, title, tokens }) {
        const ref = fileReference(href, origin);
        const url = ref ? fileHref(ref) : href;
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        return `<a href="${escapeAttr(url)}"${titleAttr}>${this.parser.parseInline(tokens)}</a>`;
      },
      // A local file has no src until it is shown: Markdown.jsx points it at the server
      // with the open session (relative paths are the session's), and the cached HTML
      // stays the same for every session.
      image({ href, title, text }) {
        const local = localImagePath(href);
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        const source = local ? `data-local-src="${escapeAttr(local)}"` : `src="${escapeAttr(href)}"`;
        return `<img ${source} alt="${escapeAttr(text)}"${titleAttr} loading="lazy">`;
      },
      code({ text, lang, escaped }) {
        const language = String(lang || '').trim().split(/\s+/)[0];
        const cls = language ? ` class="language-${escapeAttr(language)} hljs"` : ' class="hljs"';
        const label = language ? ` data-lang="${escapeAttr(language)}"` : '';
        // Fenced code arrives unescaped; highlight() escapes it (and adds only
        // hljs <span>s). Unknown labels are shown plain; unlabelled short code is
        // auto-detected.
        const body = escaped ? text : resolveLanguage(language) || !language ? highlight(text, language, { auto: !language }) : escapeAttr(text);
        return `<div class="code-block"${label}><pre><code${cls}>${body}</code></pre></div>`;
      },
    },
  });

  return (text) => clean(marked.parse(String(text || '')));
}

let defaultRenderer = null;

export function renderMarkdown(text) {
  defaultRenderer ??= createMarkdownRenderer();
  return defaultRenderer(text);
}

// Rendered HTML by source text, most recently used last. Parsing and sanitizing is most
// of the cost of showing a long session (about 175 ms of 350 at 4x CPU throttle for 800
// messages), and switching back to a session renders the same texts again.
const CACHE_MAX_CHARS = 8_000_000;
const cache = new Map();
let cachedChars = 0;

export function renderMarkdownCached(text) {
  const key = String(text || '');
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const html = renderMarkdown(key);
  cache.set(key, html);
  cachedChars += key.length + html.length;
  for (const [oldKey, oldHtml] of cache) {
    if (cachedChars <= CACHE_MAX_CHARS || cache.size <= 1) break;
    cache.delete(oldKey);
    cachedChars -= oldKey.length + oldHtml.length;
  }
  return html;
}

// The top-level blocks of `text` (paragraphs, lists, code, tables…) as their source, in
// order; blank lines stay with the block before them. Streaming text renders block by
// block, so each tick re-renders only the last, still-growing block (the others come
// from the cache and keep their DOM, and with it the reader's selection).
let blockLexer = null;

export function splitBlocks(text) {
  blockLexer ??= new Marked({ gfm: true, breaks: false, extensions: mathExtensions });
  const blocks = [];
  for (const token of blockLexer.lexer(String(text || ''))) {
    if (token.type === 'space' && blocks.length) blocks[blocks.length - 1] += token.raw;
    else if (token.raw) blocks.push(token.raw);
  }
  return blocks;
}
