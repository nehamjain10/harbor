// TeX math in markdown: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` as display
// math. Marked emits a placeholder holding the source (shown as is until KaTeX is
// loaded); typeset.js renders placeholders in the DOM after sanitizing, so KaTeX's
// inline styles survive and the markdown cache stays small.

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Display math on lines of its own; it may span lines and blank lines.
const BLOCK = [/^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/, /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n+|$)/];

// `$…$` follows pandoc so prices are left alone: no space just inside either `$`,
// and no digit right after the closing one ("$5 and $10", "$5-$10"). Math does not
// cross a blank line or a code span.
const INLINE = [
  { re: /^\$\$(?!\$)((?:\\[\s\S]|[^\\$`]|\n(?!\n))+?)\$\$/, display: true },
  { re: /^\\\[((?:[^`]|\n(?!\n))+?)\\\]/, display: true },
  { re: /^\\\(((?:[^`]|\n(?!\n))+?)\\\)/, display: false },
  { re: /^\$(?![\s$])((?:\\[\s\S]|[^\\$`\n]|\n(?!\n))+?)(?<![\s\\])\$(?![\d$])/, display: false },
];

// Display math inside a paragraph stays a <span> (a <div> would end the <p>).
function placeholder(tex, raw, display, block = false) {
  const tag = block ? 'div' : 'span';
  return `<${tag} class="math ${display ? 'math-display' : 'math-inline'}" data-tex="${escapeHtml(tex.trim())}">${escapeHtml(raw)}</${tag}>`;
}

// Where the next math may start in `src`: a `$` that is not escaped, `\(` or `\[`.
function inlineStart(src) {
  for (const match of src.matchAll(/\\[([]|\\?\$/g)) {
    if (match[0] !== '\\$') return match.index;
  }
  return undefined;
}

export const mathExtensions = [
  {
    name: 'mathBlock',
    level: 'block',
    // Only where display math really starts, so a line like "$$x$$ is the cost" does
    // not cut its paragraph in two.
    start(src) {
      for (const match of src.matchAll(/^ {0,3}(?:\$\$|\\\[)/gm)) {
        if (BLOCK.some((re) => re.test(src.slice(match.index)))) return match.index;
      }
      return undefined;
    },
    tokenizer(src) {
      for (const re of BLOCK) {
        const match = re.exec(src);
        if (match && match[1].trim()) return { type: 'mathBlock', raw: match[0], tex: match[1], source: match[0].trim() };
      }
      return undefined;
    },
    renderer: (token) => placeholder(token.tex, token.source, true, true) + '\n',
  },
  {
    name: 'mathInline',
    level: 'inline',
    start: inlineStart,
    tokenizer(src) {
      for (const { re, display } of INLINE) {
        const match = re.exec(src);
        if (match && match[1].trim()) return { type: 'mathInline', raw: match[0], tex: match[1], display };
      }
      return undefined;
    },
    renderer: (token) => placeholder(token.tex, token.raw, token.display),
  },
];
