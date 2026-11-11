// Syntax highlighting: highlight.js core with a fixed set of languages (the full build
// is ~1 MB). Output is HTML whose text is escaped by highlight.js; the only markup is
// `<span class="hljs-…">`, so it is safe to insert as innerHTML.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = { bash, c, cpp, css, diff, dockerfile, go, ini, javascript, json, markdown, plaintext, python, rust, shell, sql, typescript, xml, yaml };
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);
hljs.registerAliases(['sbatch', 'slurm'], { languageName: 'bash' });
hljs.registerAliases(['jsonl', 'ndjson', 'ipynb'], { languageName: 'json' });
hljs.registerAliases(['scss', 'less'], { languageName: 'css' });
hljs.registerAliases(['cu', 'cuh'], { languageName: 'cpp' });
hljs.registerAliases(['cfg', 'conf'], { languageName: 'ini' });

// Unlabelled code is only auto-detected when short: detection runs every grammar.
export const AUTO_DETECT_LIMIT = 5_000;
// Past this size highlighting costs more than it helps; the text is shown plain.
export const HIGHLIGHT_LIMIT = 200_000;
// Auto-detection on short or prose-like snippets often guesses wrong; below this
// relevance the snippet stays plain.
const MIN_AUTO_RELEVANCE = 6;

const EXTENSIONS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  py: 'python', pyi: 'python', pyx: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', sbatch: 'bash', slurm: 'bash',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ipynb: 'json', webmanifest: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  go: 'go', rs: 'rust',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cu: 'cpp', cuh: 'cpp',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml', vue: 'xml',
  diff: 'diff', patch: 'diff',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sql: 'sql',
  txt: 'plaintext', log: 'plaintext',
};

const FILENAMES = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// The registered language for a fence label or alias (`js`, `Python`, `sh`), or null.
export function resolveLanguage(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const language = hljs.getLanguage(key);
  if (!language) return null;
  return Object.keys(LANGUAGES).find((id) => hljs.getLanguage(id) === language) || null;
}

// The language for a file path, by name (Dockerfile) or extension; null when unknown.
export function languageForPath(filePath) {
  const name = String(filePath || '').split('/').pop().toLowerCase();
  if (!name) return null;
  if (FILENAMES[name]) return FILENAMES[name];
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 && !name.startsWith('.')) return null;
  return EXTENSIONS[name.slice(dot + 1)] || null;
}

// Highlighted HTML for `code`. `language` may be a fence label or alias; with
// `auto` set, unlabelled code under AUTO_DETECT_LIMIT is auto-detected.
export function highlight(code, language, { auto = false } = {}) {
  const text = String(code ?? '');
  if (!text || text.length > HIGHLIGHT_LIMIT) return escapeHtml(text);
  const resolved = resolveLanguage(language);
  try {
    if (resolved && resolved !== 'plaintext') return hljs.highlight(text, { language: resolved, ignoreIllegals: true }).value;
    if (!resolved && auto && text.length <= AUTO_DETECT_LIMIT) {
      const result = hljs.highlightAuto(text);
      if (result.relevance >= MIN_AUTO_RELEVANCE) return result.value;
    }
  } catch {
    // A grammar error must never break rendering; fall through to plain text.
  }
  return escapeHtml(text);
}

// Splits highlighted HTML into one string per source line, closing the spans that
// are open at each line break and reopening them on the next line, so every line
// can be rendered on its own (numbered tables, diffs).
export function splitHighlightedLines(html) {
  const lines = [];
  const open = [];
  let current = '';
  let last = 0;
  const token = /<span[^>]*>|<\/span>|\n/g;
  let match;
  while ((match = token.exec(html))) {
    current += html.slice(last, match.index);
    last = token.lastIndex;
    if (match[0] === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (match[0] === '</span>') {
      open.pop();
      current += match[0];
    } else {
      open.push(match[0]);
      current += match[0];
    }
  }
  lines.push(current + html.slice(last));
  return lines;
}

// Highlighted HTML per line of `code` (same length as code.split('\n')).
export function highlightLines(code, language, options) {
  return splitHighlightedLines(highlight(code, language, options));
}
