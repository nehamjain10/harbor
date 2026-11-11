// Fuzzy matching and ranking for the command palette. Pure, so it is unit tested.
import { basename } from './format.js';
import { sourceLabel } from './imports.js';
import { sortTime } from './sessions.js';

const DAY = 86_400_000;

const isWordChar = (ch) => /[\p{L}\p{N}]/u.test(ch);

// True when text[index] starts a word: the start, after a separator, or a
// lower→upper camelCase step.
function isBoundary(text, index) {
  if (index === 0) return true;
  const previous = text[index - 1];
  const char = text[index];
  if (!isWordChar(previous)) return true;
  return previous === previous.toLowerCase() && char !== char.toLowerCase();
}

// Scores one query token against `text`. Returns { score, indices } or null.
// Contiguous matches beat scattered ones; matches at the start of the text or of a
// word beat matches inside a word. One-letter tokens only match at word starts.
// Scattered matches must start a word, and for tokens under four letters every
// later letter must follow the previous one or start a word too ("sm" → Split
// Modules), so short queries do not light up random letters.
export function fuzzyMatch(token, text) {
  const needle = String(token || '').toLowerCase();
  const source = String(text || '');
  const haystack = source.toLowerCase();
  if (!needle) return { score: 0, indices: [] };
  if (!haystack) return null;

  // Contiguous: prefer the earliest occurrence that starts a word.
  let best = null;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const boundary = isBoundary(source, at);
    if (needle.length === 1 && !boundary) continue;
    let score = 100 + (at === 0 ? 40 : boundary ? 25 : 0) - Math.min(at, 30) * 0.5;
    const end = at + needle.length;
    if (boundary && (end === source.length || !isWordChar(source[end]))) score += 10; // whole word
    if (!best || score > best.score) best = { score, indices: Array.from(needle, (_, i) => at + i) };
    if (boundary) break;
  }
  if (best || needle.length === 1) return best;

  // Scattered (in order). Try two alignments, characters jumping ahead to word
  // starts and plain left-to-right, and keep the better one.
  let scattered = null;
  for (const preferWordStarts of [true, false]) {
    const indices = alignScattered(needle, source, haystack, preferWordStarts);
    if (!indices || !isBoundary(source, indices[0])) continue;
    if (needle.length < 4 && !indices.every((at, i) => i === 0 || at === indices[i - 1] + 1 || isBoundary(source, at))) continue;
    let score = 40;
    indices.forEach((at, i) => {
      if (i && at === indices[i - 1] + 1) score += 5;
      if (isBoundary(source, at)) score += 8;
    });
    const span = indices[indices.length - 1] - indices[0] + 1;
    score -= (span - needle.length) * 0.75 + Math.min(indices[0], 30) * 0.25;
    if (!scattered || score > scattered.score) scattered = { score, indices };
  }
  return scattered;
}

function alignScattered(needle, source, haystack, preferWordStarts) {
  const indices = [];
  let from = 0;
  for (const char of needle) {
    let at = haystack.indexOf(char, from);
    if (at < 0) return null;
    if (preferWordStarts) {
      for (let probe = at; probe >= 0; probe = haystack.indexOf(char, probe + 1)) {
        if (isBoundary(source, probe)) {
          at = probe;
          break;
        }
      }
    }
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

export function tokenize(query) {
  return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Matches every query token against a list of weighted fields
// ([{ key, text, weight }]). All tokens must match somewhere. Returns
// { score, matches: { [key]: indices[] } } or null.
export function matchFields(query, fields) {
  const tokens = tokenize(query);
  if (!tokens.length) return { score: 0, matches: {} };
  let total = 0;
  const matches = {};
  for (const token of tokens) {
    let best = null;
    for (const field of fields) {
      if (!field.text) continue;
      const match = fuzzyMatch(token, field.text);
      if (!match) continue;
      const score = match.score * (field.weight ?? 1);
      if (!best || score > best.score) best = { score, key: field.key, indices: match.indices };
    }
    if (!best) return null;
    total += best.score;
    (matches[best.key] ||= []).push(...best.indices);
  }
  return { score: total, matches };
}

// A small bonus for recent sessions so that equal matches list newest first.
export function recencyBonus(ts, now = Date.now()) {
  if (!ts) return 0;
  const days = Math.max(0, (now - ts) / DAY);
  return 6 / (1 + days);
}

// Sessions for the palette: never the open one or anything in the Trash. Without a
// query, the most recent active sessions; with one, fuzzy matches on title, project
// and model name, and for imported sessions their source app (archived sessions
// included, ranked lower).
export function rankSessions(sessions, query, { currentId = null, modelName = (id) => id, now = Date.now(), limit = 8 } = {}) {
  const candidates = sessions.filter((s) => s.id !== currentId && !s.removed);
  if (!tokenize(query).length) {
    return candidates
      .filter((s) => !s.archived)
      .sort((a, b) => sortTime(b) - sortTime(a))
      .slice(0, limit)
      .map((session) => ({ session, score: 0, matches: {} }));
  }
  const ranked = [];
  for (const session of candidates) {
    const result = matchFields(query, [
      { key: 'title', text: session.title || 'New session', weight: 1 },
      { key: 'project', text: basename(session.cwd, ''), weight: 0.75 },
      { key: 'model', text: modelName(session.model), weight: 0.6 },
      { key: 'source', text: sourceLabel(session.source?.kind), weight: 0.5 },
    ]);
    if (!result) continue;
    const score = result.score + recencyBonus(sortTime(session), now) - (session.archived ? 25 : 0);
    ranked.push({ session, score, matches: result.matches });
  }
  return ranked.sort((a, b) => b.score - a.score || sortTime(b.session) - sortTime(a.session)).slice(0, limit);
}

// Commands for the palette: [{ id, label, keywords?, hidden? }]. Without a query,
// every command that is not marked `searchOnly`; with one, fuzzy matches on the
// label (keywords count less), best first, ties in list order.
export function rankCommands(commands, query) {
  if (!tokenize(query).length) return commands.filter((c) => !c.searchOnly).map((command) => ({ command, score: 0, matches: {} }));
  const ranked = [];
  commands.forEach((command, order) => {
    const result = matchFields(query, [
      { key: 'label', text: command.label, weight: 1 },
      { key: 'keywords', text: command.keywords, weight: 0.7 },
    ]);
    if (result) ranked.push({ command, score: result.score - (command.searchOnly ? 8 : 0), matches: result.matches, order });
  });
  return ranked.sort((a, b) => b.score - a.score || a.order - b.order);
}

// Splits `text` into [{ text, match }] runs for highlighting matched characters.
export function highlightRuns(text, indices = []) {
  const source = String(text || '');
  if (!indices.length) return [{ text: source, match: false }];
  const marked = new Set(indices);
  const runs = [];
  for (let i = 0; i < source.length; i++) {
    const match = marked.has(i);
    const last = runs[runs.length - 1];
    if (last && last.match === match) last.text += source[i];
    else runs.push({ text: source[i], match });
  }
  return runs;
}
