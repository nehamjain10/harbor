// Edits members of a JSON object text in place, leaving every other byte as it was:
// key order, indentation, escapes and number formats of the members that are not touched
// survive, which `JSON.stringify(JSON.parse(text))` would not guarantee. Used for Claude
// Code's settings files, where Harbor changes `permissions` and `hooks` and must not
// disturb anything else (env, enabledPlugins, hooks of other tools, ...).
//
// The text must already be valid JSON with an object at the top. An object written on one
// line has no layout to follow, so when one of its members changes that object (and only
// it) is written out in full. After every edit the result is parsed and compared with the
// same edit applied to the parsed object; if the text surgery ever disagrees, the whole
// file is written back with `JSON.stringify` instead, so the result is always correct.
import { isDeepStrictEqual } from 'node:util';

/** Pass as an edit's value to delete the member. */
export const REMOVE = Symbol('remove');

const WHITESPACE = ' \t\r\n';
const DEFAULT_UNIT = '  ';

function skipSpace(text, index) {
  let i = index;
  while (i < text.length && WHITESPACE.includes(text[i])) i += 1;
  return i;
}

/** The index after the string that starts at `index`. */
function endOfString(text, index) {
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"') return i + 1;
    else i += 1;
  }
  throw new Error('Unterminated string');
}

/** The index after the value that starts at `index`. */
function endOfValue(text, index) {
  if (text[index] === '"') return endOfString(text, index);
  if (text[index] === '{' || text[index] === '[') {
    let depth = 0;
    for (let i = index; i < text.length; i += 1) {
      const char = text[i];
      if (char === '"') i = endOfString(text, i) - 1;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    throw new Error('Unbalanced brackets');
  }
  let i = index;
  while (i < text.length && !`,}]${WHITESPACE}`.includes(text[i])) i += 1;
  return i;
}

/** The members of the object that opens at `open`: `{key, keyStart, valueStart, valueEnd}`, and where it closes. */
function scanObject(text, open) {
  const members = [];
  let i = skipSpace(text, open + 1);
  while (text[i] !== '}') {
    const keyStart = i;
    const keyEnd = endOfString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    i = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const valueEnd = endOfValue(text, i);
    members.push({ key, keyStart, valueStart: i, valueEnd });
    i = skipSpace(text, valueEnd);
    if (text[i] === ',') i = skipSpace(text, i + 1);
  }
  return { open, close: i, members };
}

/** Where the top-level object opens (after a byte order mark and blank space). */
function rootOpen(text) {
  const start = skipSpace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (text[start] !== '{') throw new Error('The top level must be an object');
  return start;
}

/** The whitespace before `index` when only whitespace sits between it and the line start, else null. */
function lineIndent(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(lineStart, index);
  return /^[ \t]*$/.test(before) ? before : null;
}

function lineStart(text, index) {
  return lineIndent(text, index) === null ? null : text.lastIndexOf('\n', index - 1) + 1;
}

/** One indentation step of the file: its first member's indent, else two spaces. */
function detectUnit(text) {
  const { members } = scanObject(text, rootOpen(text));
  return (members.length && lineIndent(text, members[0].keyStart)) || DEFAULT_UNIT;
}

/** `value` as JSON text for a member whose key sits at `indent`: nested lines follow that indent. */
function formatValue(value, indent, unit, eol) {
  return JSON.stringify(value, null, unit).split('\n').join(eol + indent);
}

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/** The object at `open` rewritten from its parsed value after `change(object)`, laid out like a member of its line. */
function rewriteObject(text, open, change, { unit, eol }) {
  const { close } = scanObject(text, open);
  const object = JSON.parse(text.slice(open, close + 1));
  change(object);
  const lineFrom = text.lastIndexOf('\n', open) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineFrom))[0];
  return text.slice(0, open) + formatValue(object, indent, unit, eol) + text.slice(close + 1);
}

/** Sets member `key` of the object at `open`, to `value`. */
function setMember(text, open, key, value, { unit, eol, depth }) {
  const { close, members } = scanObject(text, open);
  const existing = members.findLast((member) => member.key === key);
  if (existing) {
    const indent = lineIndent(text, existing.keyStart) ?? unit.repeat(depth);
    return text.slice(0, existing.valueStart) + formatValue(value, indent, unit, eol) + text.slice(existing.valueEnd);
  }
  const keyText = JSON.stringify(key);
  if (!members.length) {
    const closeIndent = lineIndent(text, close) ?? unit.repeat(depth - 1);
    const indent = closeIndent + unit;
    return `${text.slice(0, open + 1)}${eol}${indent}${keyText}: ${formatValue(value, indent, unit, eol)}${eol}${closeIndent}${text.slice(close)}`;
  }
  const indent = lineIndent(text, members[0].keyStart);
  if (indent === null) return rewriteObject(text, open, (object) => { object[key] = value; }, { unit, eol });
  const last = members.at(-1);
  return `${text.slice(0, last.valueEnd)},${eol}${indent}${keyText}: ${formatValue(value, indent, unit, eol)}${text.slice(last.valueEnd)}`;
}

/** Removes every member `key` of the object at `open`. */
function removeMember(text, open, key, format) {
  let result = text;
  for (;;) {
    const { members } = scanObject(result, open);
    const index = members.findLastIndex((member) => member.key === key);
    if (index < 0) return result;
    const member = members[index];
    if (members.length === 1) {
      const { close } = scanObject(result, open);
      result = result.slice(0, open + 1) + result.slice(close);
    } else if (index === members.length - 1) {
      // The last one takes the comma that follows the member before it.
      result = result.slice(0, members[index - 1].valueEnd) + result.slice(member.valueEnd);
    } else {
      const from = lineStart(result, member.keyStart);
      const to = lineStart(result, members[index + 1].keyStart);
      if (from === null || to === null) return rewriteObject(result, open, (object) => { delete object[key]; }, format);
      result = result.slice(0, from) + result.slice(to);
    }
  }
}

/** Applies one edit (`path` into nested objects) to the text. */
function applyEdit(text, { path, value }, unit, eol) {
  let open = rootOpen(text);
  for (let depth = 0; depth < path.length - 1; depth += 1) {
    const { members } = scanObject(text, open);
    const member = members.findLast((m) => m.key === path[depth]);
    if (member && text[member.valueStart] === '{') {
      open = member.valueStart;
      continue;
    }
    // Missing (or not an object): the rest of the path becomes a new object.
    if (value === REMOVE && !member) return text;
    let nested = value === REMOVE ? {} : value;
    for (let i = path.length - 1; i > depth; i -= 1) nested = { [path[i]]: nested };
    return setMember(text, open, path[depth], nested, { unit, eol, depth: depth + 1 });
  }
  const key = path.at(-1);
  return value === REMOVE ? removeMember(text, open, key, { unit, eol }) : setMember(text, open, key, value, { unit, eol, depth: path.length });
}

/** The same edits on a parsed object (the reference for checking the text surgery). */
function applyToObject(object, edits) {
  const result = structuredClone(object);
  for (const { path, value } of edits) {
    let target = result;
    for (const key of path.slice(0, -1)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        if (value === REMOVE) return result;
        target[key] = {};
      }
      target = target[key];
    }
    if (value === REMOVE) delete target[path.at(-1)];
    else target[path.at(-1)] = structuredClone(value);
  }
  return result;
}

/**
 * Applies `edits` ([{path: string[], value | REMOVE}], in order) to the JSON object `text`.
 * Throws when `text` is not a JSON object.
 */
export function editJson(text, edits) {
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The top level must be an object');
  const expected = applyToObject(parsed, edits);
  const eol = eolOf(text);
  let unit;
  let result = text;
  try {
    unit = detectUnit(text);
    for (const edit of edits) result = applyEdit(result, edit, unit, eol);
    if (!isDeepStrictEqual(JSON.parse(result.replace(/^\uFEFF/, '')), expected)) result = null;
  } catch {
    result = null;
  }
  if (result !== null) return result;
  // Fallback: a plain re-serialization (2 spaces, the file's line ending, trailing newline kept).
  const bom = text.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const body = JSON.stringify(expected, null, DEFAULT_UNIT).split('\n').join(eol);
  return bom + body + (/\n\s*$/.test(text) ? eol : '');
}
