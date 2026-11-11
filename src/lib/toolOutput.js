// Parsers for tool output text (what Claude Code returned to the model) so the tool
// cards can show structure instead of raw text. All pure; unit tested.
import { relativePath } from './format.js';

// ANSI escape sequences: CSI (colors, cursor), OSC (titles, hyperlinks) and the
// remaining two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// Removes terminal escape codes and resolves carriage-return overwrites (progress
// bars) to the text that was finally visible on each line.
export function stripAnsi(text) {
  const plain = String(text ?? '').replace(ANSI, '');
  if (!plain.includes('\r')) return plain;
  return plain
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r+$/, '').split('\r');
      return parts.at(-1);
    })
    .join('\n');
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// Drops the `<system-reminder>` blocks Claude Code appends for the model.
export function stripReminders(text) {
  return String(text ?? '').replace(REMINDER, '').replace(/\s+$/, '');
}

// Tool errors arrive wrapped as <tool_use_error>…</tool_use_error>; show the message.
// A truncated copy may have lost the closing tag; anything after it (a reminder for
// the model) is kept unless it is only reminders.
export function unwrapToolError(text) {
  const value = String(text ?? '');
  const match = value.match(/^\s*<tool_use_error>([\s\S]*?)(?:<\/tool_use_error>([\s\S]*))?$/);
  if (!match) return value;
  return [match[1].trim(), stripReminders(match[2] || '').trim()].filter(Boolean).join('\n');
}

const NUMBERED = /^\s*(\d+)(?:→|\t)(.*)$/;

// Parses `cat -n` style Read output (`    12→text` or `12\ttext`) into
// { startLine, lines: [text…] }, or null when the output is not numbered.
export function parseNumberedLines(output) {
  const text = stripReminders(output);
  if (!text) return null;
  const raw = text.split('\n');
  const lines = [];
  let startLine = null;
  let expected = null;
  for (const line of raw) {
    const match = line.match(NUMBERED);
    if (!match) {
      // A numbered line whose content contained a newline is not possible, so any
      // unnumbered line ends the listing; allow only trailing notes after it.
      if (lines.length) break;
      return null;
    }
    const number = Number(match[1]);
    if (expected !== null && number !== expected) break;
    if (startLine === null) startLine = number;
    lines.push(match[2]);
    expected = number + 1;
  }
  if (!lines.length) return null;
  return { startLine: startLine || 1, lines };
}

// Tool results are sometimes stored as JSON content blocks
// (`[{"type":"text","text":"…"}]`, v1 data and MCP tools). Returns the joined text,
// or null when `output` is not such a list.
export function contentBlocksText(output) {
  const text = String(output ?? '').trim();
  if (!text.startsWith('[')) return null;
  let blocks;
  try {
    blocks = JSON.parse(text);
  } catch {
    return partialTextBlock(text);
  }
  if (!Array.isArray(blocks) || !blocks.length || !blocks.every((b) => b && typeof b === 'object' && typeof b.type === 'string')) return null;
  return blocks
    .map((block) => (block.type === 'text' ? block.text || '' : block.type === 'image' ? '[Image]' : JSON.stringify(block)))
    .join('\n');
}

// A text block list cut off mid-string (pushed copies are truncated): decode what
// there is of the first block's text.
const TEXT_BLOCK_START = /^\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"/;
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

function partialTextBlock(text) {
  const start = text.match(TEXT_BLOCK_START);
  if (!start) return null;
  let out = '';
  for (let i = start[0].length; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === 'u') {
      const code = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(code)) break;
      out += String.fromCharCode(parseInt(code, 16));
      i += 5;
    } else if (next in ESCAPES) {
      out += ESCAPES[next];
      i += 1;
    } else break;
  }
  return out;
}

const HAND_BACK = /^\[Subagent hand-back\][\s\S]*?The report follows:\n/;

// A subagent's final report as markdown: unwraps content blocks, the v1 hand-back
// frame (whose report lines are indented by two spaces) and the trailing agent id.
export function agentReport(output) {
  let text = contentBlocksText(output) ?? String(output ?? '');
  if (HAND_BACK.test(text)) {
    text = text
      .replace(HAND_BACK, '')
      .split('\n')
      .map((line) => line.replace(/^ {2}/, ''))
      .join('\n');
  }
  return text.replace(/\n+agentId: [\w-]+[^\n]*$/, '').trim();
}

// The placeholder result of an agent started in the background (its report comes
// later as a separate message).
export function isAsyncAgentLaunch(output) {
  return /^\s*Async agent launched successfully/.test(contentBlocksText(output) ?? String(output ?? ''));
}

// MCP output as display text: content blocks joined, else the raw text.
export function mcpOutputText(output) {
  return contentBlocksText(output) ?? String(output ?? '');
}

// Pretty JSON when `text` is a JSON object or array, else null.
export function prettyJson(text) {
  const value = String(text ?? '').trim();
  if (!/^[[{]/.test(value)) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return null;
  }
}

// WebSearch output: `Web search results for query: "q"`, then `Links: [json]`
// blocks and free text, ending with a reminder for the model.
export function parseWebSearch(output) {
  const text = String(output ?? '');
  const links = [];
  const notes = [];
  for (const block of text.split(/\n\n+/)) {
    const trimmed = block.trim();
    if (!trimmed || /^Web search results for query:/.test(trimmed) || /^REMINDER:/.test(trimmed)) continue;
    if (trimmed.startsWith('Links:')) {
      try {
        const list = JSON.parse(trimmed.slice(6).trim());
        for (const item of Array.isArray(list) ? list : []) {
          if (item?.url) links.push({ title: String(item.title || item.url), url: String(item.url) });
        }
        continue;
      } catch {
        // Not JSON: keep it as text.
      }
    }
    if (trimmed !== 'No links found.') notes.push(trimmed);
  }
  return { links, text: notes.join('\n\n') };
}

// A whole output line that is a file path (Glob results, Grep file lists).
function looksLikePath(line) {
  if (/^\s|: /.test(line) || line.length > 1000) return false;
  return line.startsWith('/') || line.startsWith('./') || line.includes('/') || /\.[\w-]+$/.test(line);
}

// Content-mode Grep lines: `path:12:text` (a match) or `path-12-text` (context).
// The match form is unambiguous (paths rarely contain `:`); in the context form the
// path itself may contain `-12-` (dated file names), so it is split after a path
// seen on a match line when there is one.
const MATCH_LINE = /^(.+?):(\d+):(.*)$/;
const CONTEXT_LINE = /^(.+?)-(\d+)-(.*)$/;
// Every position where `-<digits>-` starts (overlapping, hence the lookahead).
const CONTEXT_SEPARATOR = /(?=-(\d+)-)/g;

const isPathCandidate = (path) => !/\s/.test(path) && looksLikePath(path);

function grepMatchLine(line) {
  const match = line.match(MATCH_LINE);
  return match && isPathCandidate(match[1]) ? { path: match[1], line: Number(match[2]), text: match[3], context: false } : null;
}

function grepContextLine(line, matchPaths) {
  for (const separator of line.matchAll(CONTEXT_SEPARATOR)) {
    const path = line.slice(0, separator.index);
    if (matchPaths.has(path)) {
      return { path, line: Number(separator[1]), text: line.slice(separator.index + separator[1].length + 2), context: true };
    }
  }
  return null;
}

function grepFallbackContextLine(line) {
  const match = line.match(CONTEXT_LINE);
  return match && isPathCandidate(match[1]) ? { path: match[1], line: Number(match[2]), text: match[3], context: true } : null;
}

// Grep / Glob output → { header, items: [{ path, line, text, context }], note }.
// Paths are made relative to `cwd`. Content-mode lines are `path:12:text`
// (matches) or `path-12-text` (context lines); searching a single file drops the
// path (`12:text`), so `file` (the searched path) fills it in.
export function parseSearchOutput(output, { cwd = '', tool = 'Grep', file = '' } = {}) {
  const lines = stripReminders(output).split('\n');
  let header = '';
  const items = [];
  const notes = [];
  // Paths of match lines anywhere in the output, so context lines before a file's
  // first match split correctly too.
  const matchPaths = new Set();
  if (tool === 'Grep') {
    for (const line of lines) {
      const match = grepMatchLine(line);
      if (match) matchPaths.add(match.path);
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (/^(Found \d+|No (files|matches) found)/.test(line)) {
      header = line;
      continue;
    }
    if (/^\(Results are truncated|^\[Showing results/.test(line)) {
      notes.push(line.replace(/^\(|\)$/g, ''));
      continue;
    }
    if (line === '--') continue;
    if (tool === 'Grep') {
      const parsed = grepContextLine(line, matchPaths) || grepMatchLine(line);
      if (parsed) {
        items.push({ ...parsed, path: relativePath(parsed.path, cwd) });
        continue;
      }
      const bare = line.match(/^(\d+)([:-])(.*)$/);
      if (bare && file) {
        items.push({ path: relativePath(file, cwd), line: Number(bare[1]), text: bare[3], context: bare[2] === '-' });
        continue;
      }
      const counted = line.match(/^(.+?):(\d+)$/);
      if (counted && looksLikePath(counted[1])) {
        items.push({ path: relativePath(counted[1], cwd), line: null, text: `${counted[2]} ${counted[2] === '1' ? 'match' : 'matches'}`, context: false });
        continue;
      }
      const context = grepFallbackContextLine(line);
      if (context) {
        items.push({ ...context, path: relativePath(context.path, cwd) });
        continue;
      }
    }
    if (looksLikePath(line)) items.push({ path: relativePath(line, cwd), line: null, text: '', context: false });
    else notes.push(line);
  }
  return { header, items, note: notes.join('\n') };
}

// AskUserQuestion answers as [{ question, answer }]: from `input.answers` when the
// answered input was stored, else from the result text
// (`User has answered your questions: "Q"="A", "Q2"="B". …`).
export function parseAnswers(input, output) {
  const answers = input?.answers;
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    return Object.entries(answers).map(([question, answer]) => ({ question, answer: String(answer) }));
  }
  const text = String(output ?? '');
  const found = [];
  const pair = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pair.exec(text))) found.push({ question: match[1], answer: match[2] });
  return found;
}

// Write tool outcome from its result text: created | overwrote | null.
export function writeOutcome(output) {
  const text = String(output ?? '');
  if (/^File created successfully/m.test(text)) return 'created';
  if (/has been (updated|overwritten) successfully/.test(text)) return 'overwrote';
  return null;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif)$/i;

// What a Read call returned when it was not text: 'image', 'pdf', 'notebook' or null.
export function readKind(filePath, output) {
  const path = String(filePath || '');
  if (IMAGE_EXTENSIONS.test(path) || /^\[Image\]$/m.test(String(output || '').trim())) return 'image';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (/\.ipynb$/i.test(path)) return 'notebook';
  return null;
}
