// Codex sessions for import: listing the rollouts under `~/.codex/sessions` and
// `~/.codex/archived_sessions`, converting one into Harbor messages, and the condensed
// history (the handoff) the first Claude Code turn of an imported Codex session carries.
// Codex rollouts are `rollout-<time>-<id>.jsonl`: a `session_meta` line, then
// `response_item`s (messages, tool calls and their outputs, reasoning), `event_msg`s and
// `turn_context`s. A rollout can continue another one: its session_meta's `history_base`
// names the rollout (by the id at the end of its file name) and the byte offset up to which
// that one's lines come first. Codex writes these when it starts a new file for a long
// thread (`rollout-<time>-<thread>_<segment>.jsonl`) and when a thread is forked.
// Everything here only reads.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_PLACEHOLDER, capHistory, createHistory, timeOf } from './import-history.mjs';
import { forEachLine, parseLine } from './jsonl.mjs';
import { catalogIdForModel } from './models.mjs';
import { NOTICES } from './transcript.mjs';

const ROLLOUT = /^rollout-.+\.jsonl$/;
// The id a rollout's file name ends with: the thread's, or a segment's after `_`.
const STORAGE_ID = /[-_]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
// How far into a rollout the listing looks for the session_meta line (which carries
// Codex's whole system prompt) and the first user message, in small reads.
const HEAD_SCAN_BYTES = 2 * 1024 * 1024;
const HEAD_CHUNK_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------------------
// User messages: what the user typed, without what Codex added for the model.

// Blocks Codex puts into user messages for the model (instructions, environment, ambient
// app state). Matched at the start of a text item, or as a whole tagged block.
const INJECTED_PREFIXES = [
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
  '<environment_context>',
  '<user_instructions>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<codex_internal_context',
  '<turn_aborted>',
  '<subagent_notification>',
  '<recommended_plugins>',
  '<external_',
  '<goal_context>',
  '<skill>',
  '<user_shell_command>',
  '<in-app-browser-context',
  '# In app browser:',
  '<image',
  '</image>',
];
const INJECTED_BLOCK = /<(in-app-browser-context|environment_context|user_instructions|codex_internal_context|goal_context|recommended_plugins)\b[^>]*>[\s\S]*?<\/\1>/g;

function isInjected(text) {
  const start = text.trimStart();
  return INJECTED_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/**
 * The user's own words in a Codex user message, images as placeholders, or null when the
 * whole message was added by Codex. Newer rollouts label each content item
 * (`user.text`, `user.image`, `agents_md.instructions`, ...); older ones are told apart
 * by their tags.
 */
export function codexUserText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const kinds = payload?.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const labelled = Array.isArray(kinds) && kinds.length === content.length;
  const parts = [];
  content.forEach((item, index) => {
    if (labelled && typeof kinds[index] === 'string' && !kinds[index].startsWith('user.')) return;
    if (item?.type === 'input_image') parts.push(IMAGE_PLACEHOLDER);
    else if (item?.type === 'input_text' && typeof item.text === 'string') {
      const stripped = item.text.replace(INJECTED_BLOCK, '');
      // The Codex app heads the request "## My request:" after its context blocks.
      const text = (stripped === item.text ? stripped : stripped.replace(/^\s*## My request:\s*/, '')).trim();
      if (text && !isInjected(text)) parts.push(text);
    }
  });
  if (!parts.some((part) => part !== IMAGE_PLACEHOLDER)) return parts.length ? parts.join('\n') : null;
  return parts.join('\n\n');
}

// The user's answers to Codex's question tool come back as a user message.
const QUESTION_REPLY = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/;

/**
 * The answers in a reply to Codex's questions (`[{questionItemId, question, answer}]`
 * inside `<send_user_message_question_reply>`), as `[{callId, index, question, answer}]`;
 * null when the text is not such a reply.
 */
export function questionReply(text) {
  const match = QUESTION_REPLY.exec(String(text ?? '').trim());
  const items = match ? parseLine(match[1]) : null;
  if (!Array.isArray(items)) return null;
  return items
    .filter((item) => typeof item?.answer === 'string')
    .map((item) => {
      // `["request_user_input_async", "<call id>", <question index>]`
      const key = typeof item.questionItemId === 'string' ? parseLine(item.questionItemId) : null;
      return {
        callId: Array.isArray(key) && typeof key[1] === 'string' ? key[1] : null,
        index: Array.isArray(key) && Number.isInteger(key[2]) ? key[2] : 0,
        question: typeof item.question === 'string' ? item.question.trim() : '',
        answer: item.answer.trim(),
      };
    });
}

/** A reply as its user message reads: each question, shortened, with the answer under it. */
function replyText(answers) {
  return answers.map(({ question, answer }) => (question ? `${clipText(question, 160)}\n→ ${answer}` : answer)).join('\n\n');
}

// Codex ends some answers with the memory notes they drew on, for its own bookkeeping.
const MEMORY_CITATION = /\s*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*/g;

/** An assistant message's text without Codex's memory citations. */
function answerText(text) {
  return text.includes('<oai-mem-citation>') ? text.replace(MEMORY_CITATION, '\n\n').trim() : text;
}

// ---------------------------------------------------------------------------------------
// Tool calls

/** A command line from an argv array: `bash -lc "<script>"` is just the script. */
function commandLine(argv) {
  if (!Array.isArray(argv)) return String(argv ?? '');
  if (argv.length >= 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) return String(argv[2]);
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${String(part).replace(/'/g, `'\\''`)}'`)).join(' ');
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { input: parsed };
  } catch {
    return { input: value };
  }
}

/** The tool name Harbor shows for a Codex function: MCP tools as `mcp__server__tool`. */
function toolName(payload) {
  const name = String(payload.name ?? 'tool');
  const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
  if (namespace.startsWith('mcp__')) return `${namespace.replace(/_+$/, '')}__${name.replace(/^_+/, '')}`;
  return name;
}

/**
 * A Codex tool call as a Harbor tool card: shell commands become Bash, patches
 * (from the apply_patch tool or run through the shell) ApplyPatch, plan updates
 * TodoWrite, a code-mode script running one command Bash, anything else keeps its name
 * and arguments.
 */
export function mapCodexTool(name, args) {
  switch (name) {
    case 'shell':
    case 'container.exec':
    case 'local_shell':
      return shellTool(args.command);
    case 'exec_command':
      return shellTool(String(args.cmd ?? args.command ?? ''));
    case 'apply_patch':
      return { tool: 'ApplyPatch', input: { patch: String(args.input ?? args.patch ?? '') } };
    case 'update_plan': {
      const steps = Array.isArray(args.plan) ? args.plan : [];
      const todos = steps
        .filter((step) => typeof step?.step === 'string')
        .map((step) => ({ content: step.step, status: ['pending', 'in_progress', 'completed'].includes(step.status) ? step.status : 'pending' }));
      return { tool: 'TodoWrite', input: { todos } };
    }
    case 'exec': {
      // Code mode: a script calling Codex's tools. A script that only prints the results
      // of commands, patches and output reads becomes one card per call (`steps`, or the
      // card itself for one call); any other script that runs one command and prints
      // nothing else reads as Bash.
      const code = String(args.code ?? '');
      const steps = scriptSteps(code)?.map(stepCard);
      if (steps?.every(Boolean)) return steps.length === 1 ? { ...steps[0], codeMode: true } : { tool: 'exec', input: { code }, codeMode: true, steps };
      const commands = execCommands(code);
      if (commands.length === 1 && (code.match(TOOL_CALL) || []).length === 1 && (code.match(PRINTS) || []).length <= 1) {
        return { ...shellTool(commands[0]), codeMode: true };
      }
      return { tool: 'exec', input: { code }, codeMode: true };
    }
    case 'request_user_input':
    case 'request_user_input_async':
      return { tool: 'AskUserQuestion', input: { questions: questionsOf(args.questions) } };
    default:
      return { tool: name, input: hideEncrypted(args) };
  }
}

const TOOL_CALL = /\btools\.\w+\(/g;
const PRINTS = /\b(?:text|console\.log)\(/g;

// One statement of a code-mode script that prints a tool call's result:
// `text(await tools.exec_command({cmd: "ls", yield_time_ms: 1000}));`. Arguments are
// plain literals (JSON strings, numbers, booleans).
const JS_STRING = String.raw`"(?:[^"\\\n]|\\.)*"`;
const JS_VALUE = String.raw`(?:${JS_STRING}|-?\d+(?:\.\d+)?|true|false|null)`;
const JS_PROPERTY = String.raw`["']?\w+["']?\s*:\s*${JS_VALUE}`;
const JS_OBJECT = String.raw`\{\s*(?:${JS_PROPERTY}\s*(?:,\s*${JS_PROPERTY}\s*)*,?\s*)?\}`;
const SCRIPT_STEP = new RegExp(String.raw`[\s;]*text\(\s*await\s+tools\.(exec_command|write_stdin|apply_patch)\(\s*(${JS_OBJECT}|${JS_STRING})\s*\)\s*\)[\s;]*`, 'y');
const PROPERTY = new RegExp(String.raw`["']?(\w+)["']?\s*:\s*(${JS_VALUE})`, 'g');

function literal(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The tool calls of a code-mode script that does nothing but print their results, in
 * order, as `[{tool, args}]`; null for any other script.
 */
export function scriptSteps(code) {
  const steps = [];
  let position = 0;
  while (position < code.length) {
    SCRIPT_STEP.lastIndex = position;
    const match = SCRIPT_STEP.exec(code);
    if (!match) return null;
    position = SCRIPT_STEP.lastIndex;
    const [, tool, argument] = match;
    const args = argument.startsWith('"') ? { input: literal(argument) } : Object.fromEntries([...argument.matchAll(PROPERTY)].map(([, key, value]) => [key, literal(value)]));
    steps.push({ tool, args });
  }
  return steps.length ? steps : null;
}

/** One step of a script as a tool card: Bash (or ApplyPatch), ApplyPatch, BashOutput. */
function stepCard({ tool, args }) {
  if (tool === 'exec_command' && typeof args.cmd === 'string') return shellTool(args.cmd);
  if (tool === 'apply_patch' && typeof args.input === 'string') return { tool: 'ApplyPatch', input: { patch: args.input } };
  if (tool === 'write_stdin' && (typeof args.session_id === 'number' || typeof args.session_id === 'string')) {
    // An empty write only reads what a running command printed since.
    if (!args.chars) return { tool: 'BashOutput', input: { bash_id: String(args.session_id) } };
    return { tool: 'write_stdin', input: { session_id: args.session_id, chars: String(args.chars) } };
  }
  return null;
}

/**
 * What one step of a script printed (`{output, exit_code, ...}` for commands, `{}` for a
 * patch) as the card's output and whether it failed.
 */
function stepOutput(text) {
  const result = text.startsWith('{') ? parseLine(text) : null;
  if (typeof result?.output === 'string') {
    const body = result.output.replace(/\n$/, '');
    const code = typeof result.exit_code === 'number' ? result.exit_code : 0;
    return code ? { text: `Exit code ${code}${body ? '\n' + body : ''}`, error: true } : { text: body, error: false };
  }
  if (result && typeof result === 'object' && !Object.keys(result).length) return { text: '', error: false };
  return { text, error: false };
}

/**
 * Codex's questions to the user (`{title|question, header?, options: [string |
 * {label, description}]}`) as AskUserQuestion's (`{question, header, options: [{label}]}`).
 */
function questionsOf(questions) {
  return (Array.isArray(questions) ? questions : [])
    .map((item) => {
      const question = String(item?.question ?? item?.title ?? '').trim();
      const options = (Array.isArray(item?.options) ? item.options : [])
        .map((option) => (typeof option === 'string' ? { label: option } : { label: String(option?.label ?? ''), ...(option?.description ? { description: String(option.description) } : {}) }))
        .filter((option) => option.label);
      return question ? { question, ...(item?.header ? { header: String(item.header) } : {}), options } : null;
    })
    .filter(Boolean);
}
// `apply_patch <<'PATCH' ... PATCH` in a shell script.
const HEREDOC_PATCH = /\bapply_patch\s*<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;

/**
 * The patch a shell command applies when the command does nothing else: Codex sometimes
 * runs apply_patch through its shell (`["apply_patch", patch]`, or heredocs, optionally
 * after a `cd`). Null for any other command.
 */
function shellPatch(command) {
  if (Array.isArray(command)) {
    if (command.length === 2 && /(^|\/)apply_patch$/.test(command[0]) && typeof command[1] === 'string') return command[1];
    if (command.length >= 3 && /(^|\/)(ba|z)?sh$/.test(command[0]) && /^-l?c$/.test(command[1])) return shellPatch(String(command[2]));
    return null;
  }
  const patches = [];
  const rest = String(command ?? '').replace(HEREDOC_PATCH, (match, quote, tag, body) => {
    patches.push(body);
    return '';
  });
  if (!patches.length || !/^(?:\s|&&|;|cd\s+\S+)*$/.test(rest)) return null;
  return patches.join('\n');
}

/** A shell command (argv or script) as a Bash card, or ApplyPatch when it only patches. */
function shellTool(command) {
  const patch = shellPatch(command);
  if (patch !== null) return { tool: 'ApplyPatch', input: { patch } };
  return { tool: 'Bash', input: { command: Array.isArray(command) ? commandLine(command) : String(command ?? '') } };
}
// Messages Codex agents send each other are stored encrypted.
const ENCRYPTED = /^gAAAAA[\w-]{40,}={0,2}$/;

function hideEncrypted(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' && ENCRYPTED.test(value) ? '[Encrypted]' : value]));
}

/** Tool output as text; images as placeholders. */
function outputText(output) {
  if (typeof output === 'string') {
    // Older rollouts wrap shell output as {"output": "...", "metadata": {...}}.
    if (output.startsWith('{"output"')) {
      const parsed = parseLine(output);
      if (typeof parsed?.output === 'string') return parsed.output;
    }
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((item) => (item?.type === 'input_image' ? IMAGE_PLACEHOLDER : typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return output === undefined || output === null ? '' : JSON.stringify(output);
}

/**
 * A command result as Claude Code's Bash shows one: Codex's header (`Chunk ID`, the wall
 * time, the token count; older rollouts nest a second one) dropped, and `Exit code N` in
 * front when the command failed.
 */
function commandOutput(text) {
  let body = text;
  let code = null;
  for (let depth = 0; depth < 2; depth += 1) {
    const match = /^(?:Chunk ID|Wall time|Exit code):[^\n]*\n(?:[A-Z][^\n]*\n)*?Output:\n?([\s\S]*)$/.exec(body);
    if (!match) break;
    const header = body.slice(0, body.length - match[1].length);
    code = /^(?:Process exited with code|Exit code:) (-?\d+)$/m.exec(header)?.[1] ?? code;
    body = match[1];
  }
  if (body === text) return text;
  body = body.replace(/\n$/, '');
  return code && code !== '0' ? `Exit code ${code}${body ? '\n' + body : ''}` : body;
}

/** True when the output reports a failed command (a non-zero exit code). */
function failed(output, text) {
  if (typeof output === 'string' && output.startsWith('{"output"')) {
    const code = parseLine(output)?.metadata?.exit_code;
    if (typeof code === 'number') return code !== 0;
  }
  const match = /^(?:Process exited with code|Exit code:) (-?\d+)/m.exec(text.slice(0, 500));
  return Boolean(match && match[1] !== '0');
}

/** Files an apply_patch patch touches. */
export function patchFiles(patch) {
  const files = [];
  for (const match of String(patch ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const file = (match[1] ?? match[2]).trim();
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/** The string literals a code-mode script passes to Codex tools, by `pattern`. */
function scriptStrings(code, pattern) {
  const values = [];
  for (const match of String(code ?? '').matchAll(pattern)) {
    try {
      values.push(JSON.parse(match[1]));
    } catch {
      // Not a plain string literal.
    }
  }
  return values;
}

/** Shell commands inside a code-mode `exec` call (`tools.exec_command({cmd: "..."})`). */
function execCommands(code) {
  return scriptStrings(code, /exec_command\(\s*\{\s*["']?cmd["']?\s*:\s*("(?:[^"\\]|\\.)*")/g);
}

/** Patches inside a code-mode `exec` call (`tools.apply_patch("...")`). */
function execPatches(code) {
  return scriptStrings(code, /apply_patch\(\s*("(?:[^"\\]|\\.)*")/g);
}

/**
 * A code-mode result (`Script completed`, the wall time, then `Output:` and what the
 * script printed, one JSON result per tool call) as the commands' own output, and whether
 * the script or one of its commands failed. Null when the text is not a script result.
 */
function execResult(text) {
  const match = /^Script (\w+)[^\n]*\n(?:Wall time[^\n]*\n)?Output:\n+([\s\S]*)$/.exec(text);
  if (!match) return /^Script (?:failed|error)/.test(text) ? { text, error: true } : null;
  let commandFailed = false;
  const parts = match[2].split('\n').map((line) => {
    let result = line.startsWith('{') ? parseLine(line) : null;
    if (result?.status === 'fulfilled' && result.value) result = result.value;
    // A patch prints {} when it applied.
    if (line === '{}') return '';
    if (typeof result?.output !== 'string') return line;
    if (typeof result.exit_code === 'number' && result.exit_code !== 0) commandFailed = true;
    return result.output.replace(/\n$/, '');
  });
  return { text: parts.join('\n').trim(), error: match[1] !== 'completed' || commandFailed };
}

// ---------------------------------------------------------------------------------------
// The handoff: a condensed history for the first Claude Code turn.

export const HANDOFF_LIMITS = {
  chars: 48_000,
  userText: 2_000,
  answer: 4_000,
  command: 300,
  output: 300,
  commandsPerTurn: 12,
  filesPerTurn: 40,
};

function clipText(text, max) {
  const value = String(text ?? '').trim();
  return value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value;
}

/** The first and last lines of a command's output, at most `max` characters. */
function shortOutput(text, max = HANDOFF_LIMITS.output) {
  const lines = String(text ?? '')
    .replace(/^(?:Script completed|Chunk ID|Wall time|Original token count|Process exited with code|Exit code)[^\n]*\n/gm, '')
    .replace(/^Output:\n/m, '')
    .trim();
  if (lines.length <= max) return lines;
  // Whole lines from each end where they are short enough.
  const half = Math.floor(max / 2) - 2;
  let head = lines.slice(0, half);
  let tail = lines.slice(-half);
  const headCut = head.lastIndexOf('\n');
  const tailCut = tail.indexOf('\n');
  if (headCut > half / 2) head = head.slice(0, headCut);
  if (tailCut >= 0 && tailCut < half / 2) tail = tail.slice(tailCut + 1);
  return head.trimEnd() + '\n…\n' + tail.trimStart();
}

function formatTime(at) {
  return at ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
}

/**
 * Collects the handoff while a rollout is read: per turn the user's request, the commands
 * Codex ran with short outputs, the files it changed and its final answer. Keeps a
 * bounded number of the latest turns.
 */
export function createHandoffBuilder(limits = HANDOFF_LIMITS) {
  const turns = [];
  let dropped = 0;
  let current = null;
  // Rendered size of the finished turns still kept.
  let keptSize = 0;
  const pendingCommands = new Map();

  function startTurn(at) {
    if (current) keptSize += renderTurn(current, 0).length;
    current = { at, user: '', commands: [], moreCommands: 0, files: [], answer: '', final: false };
    turns.push(current);
    // Far more than fits is never rendered; drop the oldest beyond three times the cap.
    while (turns.length > 1 && keptSize > limits.chars * 3) {
      keptSize -= renderTurn(turns.shift(), 0).length;
      dropped += 1;
    }
    return current;
  }
  const turn = (at) => current ?? startTurn(at);

  function renderTurn(item, number) {
    const lines = [`## Turn ${number}${item.at ? ` (${formatTime(item.at)})` : ''}`];
    if (item.user) lines.push(`User: ${item.user}`);
    if (item.commands.length) {
      lines.push('Commands Codex ran:');
      for (const command of item.commands) {
        lines.push(`- \`${command.command}\`` + (command.output ? `\n  Output: ${command.output.replace(/\n/g, '\n  ')}` : ''));
      }
      if (item.moreCommands) lines.push(`- (${item.moreCommands} more commands)`);
    }
    if (item.files.length) lines.push(`Files Codex changed: ${item.files.join(', ')}`);
    if (item.answer) lines.push(`Codex answered: ${item.answer}`);
    return lines.join('\n');
  }

  return {
    user(text, at) {
      startTurn(at).user = clipText(text, limits.userText);
    },
    answer(text, phase) {
      const item = turn();
      // The final answer wins over later progress notes; otherwise the latest text.
      if (item.final && phase !== 'final_answer') return;
      item.answer = clipText(text, limits.answer);
      item.final = phase === 'final_answer';
    },
    command(callId, command) {
      const item = turn();
      if (item.commands.length >= limits.commandsPerTurn) {
        item.commands.shift();
        item.moreCommands += 1;
      }
      const entry = { command: clipText(command.replace(/\s*\n\s*/g, ' ; '), limits.command), output: '' };
      item.commands.push(entry);
      if (callId) pendingCommands.set(callId, entry);
    },
    output(callId, text) {
      const entry = pendingCommands.get(callId);
      if (!entry) return;
      pendingCommands.delete(callId);
      entry.output = shortOutput(text);
    },
    files(paths) {
      const item = turn();
      for (const file of paths) if (!item.files.includes(file) && item.files.length < limits.filesPerTurn) item.files.push(file);
    },
    /**
     * The handoff text. Under the cap the turns read oldest first; over it the latest
     * turns come first and older ones follow while they fit.
     */
    build({ cwd, title, createdAt, updatedAt } = {}) {
      const kept = turns.filter((item) => item.user || item.answer || item.commands.length || item.files.length);
      const from = formatTime(createdAt);
      const to = formatTime(updatedAt);
      const span = from && to && from !== to ? `${from} to ${to}` : from || to;
      const header =
        '[Harbor: the user imported this conversation from a Codex session' +
        (title ? ` ("${clipText(title, 120)}")` : '') +
        (cwd ? ` that ran in ${cwd}` : '') +
        (span ? `, ${span}` : '') +
        '. Codex conversations cannot be continued here, so what follows is a condensed record of that session, ' +
        "not work you did: the user's requests, Codex's final answers, the commands Codex ran with short outputs, " +
        'and the files it changed. Treat it as background and check the current state of the files before relying on it. ' +
        "The user's new message comes after the record.]";
      const rendered = kept.map((item, index) => renderTurn(item, dropped + index + 1));
      const all = rendered.join('\n\n');
      let body;
      if (all.length <= limits.chars && !dropped) body = all;
      else {
        const parts = [];
        let size = 0;
        for (let index = rendered.length - 1; index >= 0; index -= 1) {
          if (parts.length && size + rendered[index].length > limits.chars) break;
          parts.push(rendered[index]);
          size += rendered[index].length + 2;
        }
        const left = dropped + rendered.length - parts.length;
        body =
          `The record is long, so the latest turns come first and older ones follow while they fit (${left} earlier turns are left out).\n\n` +
          parts.join('\n\n');
      }
      if (!body) body = '(The Codex session has no recorded requests or answers.)';
      // Imported text must not be able to close the history block early.
      const safe = body.replace(/<(\/?\s*codex_history)/gi, '‹$1');
      return `${header}\n\n<codex_history>\n${safe}\n</codex_history>`;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Converting a rollout

const COMPACTED = /^\{[^{]*"type":"compacted"/;
const TIMESTAMP = /"timestamp":"([^"]+)"/;

/**
 * Converts a Codex rollout into Harbor messages and builds its handoff. Streams the
 * file line by line, after the lines of the rollouts it continues: `bases` lists them
 * oldest first as `{file, end}`, each read up to its byte offset `end`. Returns
 * `{messages, omitted, todos, plan, handoff, meta, lastAt}`; `meta` is the session_meta
 * of `file`.
 */
export async function convertCodexRollout(file, { title, bases = [] } = {}) {
  const history = createHistory();
  const handoff = createHandoffBuilder();
  // The session_meta of the file being read, and of the oldest one (when the thread began).
  let fileMeta = null;
  let firstMeta = null;
  let model;
  let lineNumber = 0;
  // Calls whose output goes into the handoff, code-mode calls (their output wrapped), and
  // scripts shown as one card per step (call id -> the steps' card ids).
  const handoffCalls = new Set();
  const codeModeCalls = new Set();
  const scriptCards = new Map();

  const callCard = (callId, mapped, at) => {
    history.apply({ type: 'assistant', uuid: `codex-${lineNumber}`, message: { content: [{ type: 'tool_use', id: callId, name: mapped.tool, input: mapped.input }] } }, { at, model });
  };
  const finishCard = (callId, text, isError, at) => {
    history.apply({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: callId, content: text, is_error: isError }] } }, { at });
    if (handoffCalls.has(callId)) {
      handoffCalls.delete(callId);
      handoff.output(callId, text);
    }
  };
  /**
   * A script's output to its step cards: Codex stores one item per printed result after
   * the `Script completed` header. Steps after a failure get the error or a note.
   */
  const finishSteps = (ids, output, at) => {
    if (!Array.isArray(output)) {
      const result = execResult(outputText(output)) ?? { text: outputText(output), error: false };
      ids.forEach((id, index) => finishCard(id, index === ids.length - 1 ? result.text : '', index === ids.length - 1 && result.error, at));
      return;
    }
    const items = output.map((item) => (item?.type === 'input_image' ? IMAGE_PLACEHOLDER : String(item?.text ?? '')));
    let [header = '', ...printed] = items;
    // A failed script ends with "Script error:" and why; the step after the last one
    // that printed is the one that failed.
    let failure = null;
    if (!/^Script completed/.test(header)) {
      if (/^Script error/.test(printed.at(-1) ?? '')) {
        failure = printed.at(-1).replace(/^Script error:?\s*/, '');
        printed = printed.slice(0, -1);
      }
      failure ||= header.replace(/\n?Output:\s*$/, '').trim() || 'The script failed.';
    }
    ids.forEach((id, index) => {
      if (index < printed.length) {
        const { text, error } = stepOutput(printed[index]);
        finishCard(id, text, error, at);
      } else if (failure && index === printed.length) finishCard(id, failure, true, at);
      else finishCard(id, failure ? 'Not run: the script stopped at an earlier step.' : '', Boolean(failure), at);
    });
  };
  /** Commands and changed files of a card, for the handoff. */
  const noteCall = (callId, mapped) => {
    if (mapped.tool === 'Bash') {
      handoff.command(callId, mapped.input.command);
      handoffCalls.add(callId);
      if (mapped.input.command.includes('*** Begin Patch')) handoff.files(patchFiles(mapped.input.command));
    } else if (mapped.tool === 'ApplyPatch') {
      handoff.files(patchFiles(mapped.input.patch));
    }
  };
  const resultCard = (callId, output, at) => {
    const steps = scriptCards.get(callId);
    if (steps) {
      scriptCards.delete(callId);
      finishSteps(steps, output, at);
      return;
    }
    let text = outputText(output);
    let isError = failed(output, text);
    const unwrapped = codeModeCalls.has(callId) ? execResult(text) : null;
    codeModeCalls.delete(callId);
    if (unwrapped) {
      text = unwrapped.text;
      isError = unwrapped.error;
    } else text = commandOutput(text);
    finishCard(callId, text, isError, at);
  };

  /** Marks the answers on the question card they answer, when it is still in the window. */
  const answerQuestions = (answers) => {
    for (const { callId, index, question, answer } of answers) {
      const card = callId && history.session.messages.find((message) => message.toolId === callId && message.tool === 'AskUserQuestion');
      if (!card) continue;
      const key = card.input?.questions?.[index]?.question ?? question;
      card.input = { ...card.input, answers: { ...card.input?.answers, [key]: answer } };
    }
  };

  const onLine = (text) => {
    lineNumber += 1;
    // Compaction lines carry the whole replacement history (often over 10 MB); only their
    // time is needed, so they are not parsed.
    const head = text.slice(0, 300);
    if (COMPACTED.test(head)) {
      history.notice(NOTICES.compacted, 'info', timeOf(TIMESTAMP.exec(head)?.[1]));
      return;
    }
    const line = parseLine(text);
    if (!line) return;
    const at = timeOf(line.timestamp);
    const payload = line.payload ?? {};
    if (line.type === 'session_meta') {
      if (!fileMeta) fileMeta = payload;
      firstMeta ??= payload;
      return;
    }
    if (line.type === 'turn_context') {
      if (typeof payload.model === 'string') model = catalogIdForModel(payload.model) ?? payload.model;
      return;
    }
    if (line.type === 'event_msg') {
      if (payload.type === 'turn_aborted') history.notice('The turn was interrupted.', 'info', at);
      return;
    }
    if (line.type !== 'response_item') return;

    switch (payload.type) {
      case 'message': {
        if (payload.role === 'user') {
          let userText = codexUserText(payload);
          if (userText === null) return;
          const reply = questionReply(userText);
          if (reply) {
            if (!reply.length) return;
            answerQuestions(reply);
            userText = replyText(reply);
          }
          history.add('user', userText, { delivery: 'done' }, at);
          handoff.user(userText, at);
        } else if (payload.role === 'assistant') {
          const reply = answerText(
            (payload.content || [])
              .map((item) => (typeof item?.text === 'string' ? item.text : ''))
              .join('')
              .trim(),
          );
          if (!reply) return;
          history.apply({ type: 'assistant', uuid: `codex-${lineNumber}`, message: { content: [{ type: 'text', text: reply }] } }, { at, model });
          handoff.answer(reply, payload.phase);
        }
        return;
      }
      case 'reasoning': {
        const summary = (Array.isArray(payload.summary) ? payload.summary : [])
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n\n');
        if (summary) history.apply({ type: 'assistant', uuid: `codex-${lineNumber}`, message: { content: [{ type: 'thinking', thinking: summary }] } }, { at, model });
        return;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const callId = payload.call_id ?? payload.id ?? `codex-call-${lineNumber}`;
        const name = payload.type === 'local_shell_call' ? 'local_shell' : toolName(payload);
        let args;
        if (payload.type === 'local_shell_call') args = { command: payload.action?.command };
        else if (payload.type === 'custom_tool_call') args = name === 'exec' ? { code: String(payload.input ?? '') } : { input: payload.input };
        else args = parseArguments(payload.arguments);
        const mapped = mapCodexTool(name, args);
        if (mapped.steps) {
          const ids = mapped.steps.map((step, index) => `${callId}:${index + 1}`);
          mapped.steps.forEach((step, index) => {
            callCard(ids[index], step, at);
            noteCall(ids[index], step);
          });
          scriptCards.set(callId, ids);
          return;
        }
        callCard(callId, mapped, at);
        if (mapped.codeMode) codeModeCalls.add(callId);
        if (mapped.tool === 'Bash' || mapped.tool === 'ApplyPatch') noteCall(callId, mapped);
        else if (name === 'exec') {
          // The script's combined output goes with its last command.
          const commands = execCommands(args.code);
          commands.forEach((command, index) => handoff.command(index === commands.length - 1 ? callId : null, command));
          if (commands.length) handoffCalls.add(callId);
          for (const patch of execPatches(args.code)) handoff.files(patchFiles(patch));
        }
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        if (payload.call_id) resultCard(payload.call_id, payload.output, at);
        return;
      case 'web_search_call': {
        const action = payload.action ?? {};
        const query = action.query ?? (Array.isArray(action.queries) ? action.queries.join('; ') : undefined) ?? action.url ?? '';
        const callId = payload.id ?? `codex-search-${lineNumber}`;
        callCard(callId, { tool: 'WebSearch', input: { query } }, at);
        resultCard(callId, payload.status === 'completed' ? 'Search completed.' : `Search ${payload.status ?? 'ended'}.`, at);
        return;
      }
      case 'tool_search_call': {
        const callId = payload.call_id ?? `codex-tool-search-${lineNumber}`;
        callCard(callId, { tool: 'ToolSearch', input: parseArguments(payload.arguments) }, at);
        return;
      }
      case 'tool_search_output': {
        const names = (payload.tools || []).flatMap((tool) => (Array.isArray(tool?.tools) ? tool.tools.map((inner) => `${tool.name}.${inner.name}`) : [tool?.name]));
        if (payload.call_id) resultCard(payload.call_id, names.filter(Boolean).join('\n') || 'No tools found.', at);
        return;
      }
      default:
    }
  };

  for (const base of bases) {
    fileMeta = null;
    try {
      await forEachLine(base.file, onLine, { limit: base.end });
    } catch (error) {
      history.notice(`The start of this Codex thread could not be read (${error.code ?? error.message}).`, 'warning');
    }
  }
  fileMeta = null;
  await forEachLine(file, onLine);
  const meta = fileMeta;

  const session = history.settle();
  const capped = capHistory(session.messages);
  const lastAt = history.lastAt;
  return {
    messages: capped.messages,
    omitted: history.omitted + capped.omitted,
    todos: session.todos,
    plan: session.plan,
    meta,
    lastAt,
    handoff: handoff.build({ cwd: meta?.cwd, title, createdAt: timeOf(firstMeta?.timestamp), updatedAt: lastAt }),
  };
}

// ---------------------------------------------------------------------------------------
// Listing

async function* rolloutFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* rolloutFiles(full);
    else if (entry.isFile() && ROLLOUT.test(entry.name)) yield full;
  }
}

/** The id a rollout's file name ends with, which `history_base` links use; or null. */
export function rolloutStorageId(file) {
  return STORAGE_ID.exec(path.basename(file))?.[1].toLowerCase() ?? null;
}

/** Every rollout under the Codex home's sessions and archived sessions. */
export async function findRollouts(codexHome) {
  const files = [];
  for (const dir of ['sessions', 'archived_sessions']) {
    for await (const file of rolloutFiles(path.join(codexHome, dir))) files.push(file);
  }
  return files;
}

/**
 * The listing facts of one rollout, read from its start: the session_meta and the first
 * message the user typed (skipped when `hasTitle(id)` says the thread already has a
 * name). Returns null for files that are not Codex sessions and `{subagent: true}` for
 * subagent threads (shown inside their parent in Codex, not on their own).
 */
export async function readRolloutHead(file, { hasTitle = () => false } = {}) {
  let meta = null;
  let firstPrompt = '';
  let scannedForPrompt = false;
  let invalid = false;
  await forEachLine(
    file,
    (text) => {
      const line = parseLine(text);
      if (!meta) {
        if (line?.type !== 'session_meta' || !line.payload) {
          invalid = true;
          return false;
        }
        meta = { ...line.payload, lineTimestamp: line.timestamp };
        delete meta.base_instructions;
        delete meta.dynamic_tools;
        scannedForPrompt = !isSubagent(meta) && !hasTitle(meta.id);
        return scannedForPrompt;
      }
      if (line?.type === 'response_item' && line.payload?.type === 'message' && line.payload.role === 'user') {
        const prompt = codexUserText(line.payload);
        if (prompt && prompt !== IMAGE_PLACEHOLDER) {
          // Only a title is made from it; the cache must not hold a huge first message.
          firstPrompt = prompt.slice(0, 1000);
          return false;
        }
      }
      return true;
    },
    { limit: HEAD_SCAN_BYTES, chunkBytes: HEAD_CHUNK_BYTES },
  );
  if (invalid || !meta) return null;
  if (isSubagent(meta)) return { subagent: true };
  const base = meta.history_base;
  const historyBase = typeof base?.thread_id === 'string' && Number.isSafeInteger(base.end_byte_offset) && base.end_byte_offset > 0 ? { id: base.thread_id.toLowerCase(), end: base.end_byte_offset } : null;
  return {
    meta: { id: meta.id, cwd: meta.cwd, timestamp: meta.timestamp, lineTimestamp: meta.lineTimestamp, originator: meta.originator, git: meta.git, ...(historyBase ? { historyBase } : {}) },
    firstPrompt,
    scannedForPrompt,
  };
}

function isSubagent(meta) {
  return meta.thread_source === 'subagent' || Boolean(meta.source && typeof meta.source === 'object' && meta.source.subagent);
}

/**
 * Thread names Codex keeps in `session_index.jsonl` (`{id, thread_name, updated_at}`
 * per line; a later line renames). Missing or unreadable: none.
 */
export async function readThreadNames(codexHome) {
  const names = new Map();
  try {
    await forEachLine(path.join(codexHome, 'session_index.jsonl'), (text) => {
      const line = parseLine(text);
      if (typeof line?.id === 'string' && typeof line.thread_name === 'string' && line.thread_name.trim()) names.set(line.id, line.thread_name.trim());
    });
  } catch {
    // No index yet.
  }
  return names;
}
