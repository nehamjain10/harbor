// Shared pieces of session import: the bounded message window both converters fill
// through applySdkMessage (so imported tool cards, todos and plans look exactly like
// live ones), and the size caps an imported session is stored with.
import { addMessage, addNotice, settleOrphanedTools } from './store.mjs';
import { applySdkMessage } from './transcript.mjs';

export const IMPORT_LIMITS = {
  // Stored messages per imported session, subagent messages included.
  messages: 500,
  // Stored JSON per imported session.
  bytes: 8 * 1024 * 1024,
  // Characters kept of each tool result, of each long string in a tool input, and of
  // each user, assistant or thinking text.
  toolOutput: 32 * 1024,
  toolInputString: 16 * 1024,
  text: 100_000,
  // Latest messages shown inside each subagent card.
  subagentMessages: 100,
  // Subagents inside subagents are followed this deep.
  subagentDepth: 3,
};

export const IMAGE_PLACEHOLDER = '[Image]';
const TRUNCATED = '\n[Truncated]';

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Text without the <system-reminder> blocks Claude Code adds for the model. */
export function stripReminders(text) {
  if (typeof text !== 'string' || !text.includes('<system-reminder>')) return text;
  return text.replace(SYSTEM_REMINDER, '').trim();
}

/** A timestamp in epoch milliseconds from an ISO string, or undefined. */
export function timeOf(value) {
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** One line of at most `max` characters for a list title. */
export function titleLine(text, max = 120) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

function clip(text, max) {
  return typeof text === 'string' && text.length > max ? text.slice(0, max) + TRUNCATED : text;
}

/** A tool input with every long string cut, so one huge Write cannot fill the budget. */
function clipInput(value, max, depth = 0) {
  if (typeof value === 'string') return clip(value, max);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => clipInput(item, max, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipInput(item, max, depth + 1)]));
}

/**
 * A session-shaped sink for converted history that keeps only about the latest `keep`
 * messages in memory, counting the ones it lets go (those `counts` picks: by default the
 * top-level ones). `apply` takes Claude Agent SDK messages (what the live runner sees);
 * `add` and `notice` record messages directly. Every call takes the time the original
 * message happened.
 */
export function createHistory({ keep = IMPORT_LIMITS.messages, counts = (message) => !message.parentToolId } = {}) {
  const session = { messages: [], todos: [], plan: null };
  let omitted = 0;
  let lastAt;

  function trim() {
    if (session.messages.length <= keep * 2) return;
    const dropped = session.messages.splice(0, session.messages.length - keep);
    omitted += dropped.filter(counts).length;
  }

  function seen(at) {
    if (at !== undefined && (lastAt === undefined || at > lastAt)) lastAt = at;
  }

  return {
    session,
    get omitted() {
      return omitted;
    },
    get lastAt() {
      return lastAt;
    },
    apply(message, { at, model } = {}) {
      seen(at);
      applySdkMessage(session, message, { at, model });
      trim();
    },
    add(role, text, extra = {}, at) {
      seen(at);
      const message = addMessage(session, role, text, { ...extra, ...(at !== undefined ? { at } : {}) });
      trim();
      return message;
    },
    notice(text, level = 'info', at) {
      seen(at);
      const message = addNotice(session, text, level, at !== undefined ? { at } : {});
      trim();
      return message;
    },
    /** Tool calls that never got a result end as interrupted, at the last known time. */
    settle() {
      settleOrphanedTools(session, lastAt ?? Date.now());
      return session;
    },
  };
}

/** Per-message caps and the import marker. Returns the message (changed in place). */
function capMessage(message) {
  message.imported = true;
  delete message.sdkId;
  if (message.role === 'tool') {
    if (typeof message.output === 'string' && message.output.length > IMPORT_LIMITS.toolOutput) {
      message.output = message.output.slice(0, IMPORT_LIMITS.toolOutput) + '\n[Output truncated]';
    }
    message.input = clipInput(message.input, IMPORT_LIMITS.toolInputString);
  } else {
    message.text = clip(message.text, IMPORT_LIMITS.text);
  }
  return message;
}

/**
 * The stored history: the latest messages within the message and byte budgets, each
 * capped, subagent messages right after their Agent card (`children` maps a toolId to its
 * subagent's messages). Whole units (a message with all of its subagent messages) are kept
 * or dropped together, newest first; a cut window then starts at a user message when one
 * is near its start. Returns `{messages, omitted}`, where `omitted` counts the top-level
 * messages left out here.
 */
export function capHistory(messages, children = new Map(), { maxMessages = IMPORT_LIMITS.messages, maxBytes = IMPORT_LIMITS.bytes } = {}) {
  const descendants = (message, depth = 0) => {
    if (message.role !== 'tool' || depth > IMPORT_LIMITS.subagentDepth) return [];
    return (children.get(message.toolId) || []).flatMap((child) => [child, ...descendants(child, depth + 1)]);
  };
  const units = [];
  let count = 0;
  let bytes = 0;
  let omitted = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const unit = [messages[index], ...descendants(messages[index])].map(capMessage);
    const size = unit.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
    if (count + unit.length > maxMessages || bytes + size > maxBytes) {
      omitted = index + 1;
      break;
    }
    units.push(unit);
    count += unit.length;
    bytes += size;
  }
  units.reverse();
  // A cut window starts at a request rather than mid-turn, unless that would cost more
  // than a quarter of it (a long turn of background work).
  if (omitted) {
    const start = units.findIndex(([message]) => message.role === 'user');
    if (start > 0 && start <= units.length / 4) {
      units.splice(0, start);
      omitted += start;
    }
  }
  return { messages: units.flat(), omitted };
}

/** The notice at the top of an imported transcript when older history is not shown. */
export function omittedNotice(count, kind) {
  const amount = count === 1 ? '1 earlier message' : `${count.toLocaleString('en-US')} earlier messages`;
  const verb = count === 1 ? 'is' : 'are';
  return kind === 'claude'
    ? `${amount} ${verb} not shown here. The conversation continues with its full history.`
    : `${amount} from this Codex session ${verb} not shown here.`;
}
