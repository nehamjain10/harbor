// A scripted stand-in for the Anthropic Messages API (and the model gateway in front of
// it), used by the integration tests and staging. Responses are chosen by a marker in the
// latest human message of the conversation (the last marker when there are several),
// e.g. `[[mock:read-empty-pages]]`:
//
//   (none)            plain text "ok"
//   text              plain text "ok"
//   read-empty-pages  Read {file_path, pages: "", limit: "", offset: "1"} -> reports the result
//   todos-as-string   TodoWrite with `todos` sent as a JSON string -> reports the result
//   thinking          a thinking block (with signature) followed by text
//   agent             Agent tool call whose prompt carries [[mock:subagent]] -> reports the result
//                     (background by default; `[[mock:agent:foreground]]` waits for it)
//   agent-slow        like agent, but the subagent takes [[mock:subagent-slow:3]] (argument as agent)
//   agent-ask         a foreground Agent whose subagent runs a Bash command that asks for approval
//   agents            two Agent calls at once ("First probe", 2 s; "Second probe", 4 s), background
//                     unless `[[mock:agents:foreground]]`
//   agent-steps       a background Agent ("Survey in steps") whose subagent runs [[mock:subagent-steps]]
//   subagent          (inside the subagent) Bash `echo subagent-ok` -> "Subagent finished."
//   subagent-slow     (inside the subagent) Bash `echo subagent-ok`, then waits N seconds
//                     (`[[mock:subagent-slow:N]]`, default 3) before "Subagent finished."
//   subagent-ask      (inside the subagent) Bash `touch subagent.txt` (asks) -> "Subagent finished."
//   subagent-steps    (inside the subagent) "Surveying." with Bash `echo step-one`, then after N
//                     seconds (`[[mock:subagent-steps:N]]`, default 2) Bash `echo step-two`, then
//                     after N more "Survey complete: two steps ran."
//   bash              Bash `echo mock-bash` -> reports the result. Read-only commands run
//                     without approval; `[[mock:bash:touch x.txt]]` runs a command that asks.
//   bg-then-wait      a background Bash `sleep N; touch bg-done.txt`, then a foreground
//                     Bash `sleep 60` -> reports the result (`[[mock:bg-then-wait:N]]`,
//                     default 6; interrupt tests check the background one survives)
//   bg                a background Bash printing `tick 1`..`tick N` a second apart, then "Started."
//                     (`[[mock:bg:N]]`, default 3; the turn ends while it runs)
//   monitor           Monitor "Watch the ticks" on a command printing `tick 1`..`tick N` a second
//                     apart (`[[mock:monitor:N]]`, default 3), then "Watching."
//   cron              CronCreate "*/30 * * * *" or `[[mock:cron:SCHEDULE]]` (recurring, prompt
//                     "Check the run.") and
//                     ScheduleWakeup in 1200 s, then "Scheduled."
//   edit              Read hello.txt, then Edit "hello" -> "goodbye" -> reports the result
//   ask               AskUserQuestion with two options -> reports the result
//   ask-as-string     AskUserQuestion with `questions` sent as a JSON string -> reports the result
//   plan              ExitPlanMode with a markdown plan -> reports the result
//                     (`[[mock:plan:file]]`: Write the CLI's plan file, then ExitPlanMode {})
//   delegate          model agents through Harbor's MCP tools: `[[mock:delegate:luna,deepseek;wait;sleep=3]]`
//                     calls mcp__meshy__delegate once per listed model in one message (each worker
//                     runs [[mock:worker]]), then, one call per step and in this order, the tools
//                     the flags ask for, then reports the result. Flags: message (message_agent to
//                     the first worker: STEER_TEXT), check (check_agents), stop (stop_agent on the
//                     first worker, reason "mock stop"), wait (wait_agents); the first of these
//                     other than wait comes 3 s after the workers start; sleep=N (worker's Bash
//                     sleep), worktree (isolation), edit (the worker writes part-<n>.txt), ask (the
//                     worker runs `touch part-<n>.txt`, which asks), steps=N (the worker runs N
//                     Bash steps instead of one: a busy worker streaming events)
//   worker            (inside a model agent) Bash `sleep N && echo worker-ok`, then Write
//                     (`[[mock:worker:N,edit=FILE]]`) or `touch` (`,ask=FILE`), then "Worker finished."
//                     `[[mock:worker:N,steps=K]]`: K steps of Bash `sleep N && echo step-<k>` instead.
//   tools             `[[mock:tools:NAME*N]]`: N calls of tool NAME in one message (input {index})
//   slow              streams text for about 3 seconds (stop / interrupt tests)
//   api-error         HTTP 400 invalid_request_error
//
// File markers take an optional path: `[[mock:read-empty-pages:/abs/file.txt]]`; relative
// paths (and the default `hello.txt`) resolve against the working directory named in the
// system prompt. After a tool result the scripts reply "Tool result: ok — <text>" or
// "Tool result: error — <text>" so tests can tell whether the tool call succeeded.
//
// Requests without tools (titles, the small/fast model) get a short text reply.
//
// Usage: `import { startMockGateway } from './mock-gateway.mjs'` or
//        `node tests/mock-gateway.mjs --port 18950`
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = /\[\[mock:([a-z-]+)(?::([^\]]+))?\]\]/g;

/**
 * The last marker in `text` as [match, script, argument], or null. The last one wins:
 * after a failed turn Claude Code merges the failed message into the next one, and the
 * newest text is the current instruction.
 */
function lastMarker(text) {
  return [...String(text).matchAll(MARKER)].at(-1) ?? null;
}

// Fixed usage so context math is easy to assert: 120 + 850 + 30 = 1000 tokens in context.
const USAGE = { input_tokens: 120, cache_read_input_tokens: 850, cache_creation_input_tokens: 30 };
const OUTPUT_TOKENS = 20;

export const MOCK_MODELS = [
  'codex/gpt-6.1-sol',
  'codex/gpt-6-astra',
  'codex/gpt-6-luna',
  'litellm/DeepSeek-V4-Flash',
  'litellm/SGLang-Kimi-K3',
  'claude/claude-opus-5-5',
  'claude/claude-sonnet-5',
  'claude/claude-sonnet-5-5',
  'claude/claude-haiku-5-5',
];

/** What `delegate;message` tells the first worker. */
export const STEER_TEXT = 'Also mention steering-ok in your final report.';

const text = (value) => ({ type: 'text', text: value });
const thinking = (value) => ({ type: 'thinking', thinking: value, signature: 'mock-signature-' + crypto.randomBytes(6).toString('hex') });
const toolUse = (name, input) => ({ type: 'tool_use', id: 'toolu_mock_' + crypto.randomBytes(8).toString('hex'), name, input });

/** The text of a message's content (string or blocks), ignoring tool results. */
function contentText(content) {
  if (typeof content === 'string') return content;
  return (content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function isToolResultMessage(message) {
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result');
}

/** The latest message the human typed: the last user message that is not a tool result. */
function humanMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user' && !isToolResultMessage(messages[index])) return index;
  }
  return -1;
}

/** The tool result answering the latest assistant turn (the CLI may append system notes after it). */
function lastToolResult(messages) {
  const last = messages.filter((message) => message.role !== 'system').at(-1);
  if (!last || !isToolResultMessage(last)) return null;
  const block = last.content.find((item) => item.type === 'tool_result');
  const content = typeof block.content === 'string' ? block.content : contentText(block.content);
  return { toolUseId: block.tool_use_id, isError: Boolean(block.is_error), content };
}

/** The worker ids the delegate calls of this turn returned ("Started worker luna-3f2a1c (…)"), in order. */
function startedWorkers(messages) {
  const ids = [];
  for (const message of messages) {
    if (!isToolResultMessage(message)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const content = typeof block.content === 'string' ? block.content : contentText(block.content);
      const id = /^Started worker (\S+) /.exec(content)?.[1];
      if (id) ids.push(id);
    }
  }
  return ids;
}

function systemText(system) {
  if (!system) return '';
  return typeof system === 'string' ? system : system.map((block) => block.text || '').join('\n');
}

/**
 * The working directory the CLI announces, either in the system prompt or (Claude Code
 * 2.1.x through a gateway) in a `role: "system"` message inside `messages`.
 */
function workingDirectory(body) {
  const texts = [systemText(body.system), ...(body.messages || []).filter((m) => m.role === 'system').map((m) => contentText(m.content))];
  for (const value of texts) {
    const match = /(?:Primary working directory|Working directory):\s*(\S+)/.exec(value);
    if (match) return match[1];
  }
  return process.cwd();
}

function resolvePath(argument, body, fallback) {
  const file = argument || fallback;
  return path.isAbsolute(file) ? file : path.join(workingDirectory(body), file);
}

function describeResult(result) {
  const status = result.isError ? 'error' : 'ok';
  return `Tool result: ${status} — ${result.content.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/**
 * Picks the reply for one request. `step` counts assistant replies since the human
 * message, so step 0 is the first response and step 1 follows the first tool result.
 */
function scriptedContent(body) {
  const messages = body.messages || [];
  if (!body.tools?.length) return { content: [text('Mock reply')] };

  const humanIndex = humanMessageIndex(messages);
  const human = humanIndex >= 0 ? contentText(messages[humanIndex].content) : '';
  const [, script = 'text', argument] = lastMarker(human) || [];
  const step = messages.slice(humanIndex + 1).filter((message) => message.role === 'assistant').length;
  const result = lastToolResult(messages);
  const reportResult = () => ({ content: [text(result ? describeResult(result) : 'ok')] });

  switch (script) {
    case 'read-empty-pages':
      if (step === 0) {
        const file = resolvePath(argument, body, 'hello.txt');
        return { content: [toolUse('Read', { file_path: file, pages: '', offset: '1', limit: '' })] };
      }
      return reportResult();

    case 'todos-as-string':
      if (step === 0) {
        const todos = [
          { content: 'Inspect the repository', status: 'completed', activeForm: 'Inspecting the repository' },
          { content: 'Write the fix', status: 'in_progress', activeForm: 'Writing the fix' },
          { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
        ];
        return { content: [text('Planning the work.'), toolUse('TodoWrite', { todos: JSON.stringify(todos) })] };
      }
      return reportResult();

    case 'thinking':
      if (step === 0) {
        return { content: [thinking('Let me think about this step by step. The answer is 42.'), text('The answer is 42.')] };
      }
      return reportResult();

    case 'agent':
      if (step === 0) {
        return {
          content: [
            toolUse('Agent', {
              description: 'Check the workspace',
              prompt: '[[mock:subagent]] Run a quick command and report back.',
              subagent_type: 'general-purpose',
              // Claude Code runs agents in the background unless told otherwise.
              ...(argument === 'foreground' ? { run_in_background: false } : {}),
            }),
          ],
        };
      }
      return reportResult();

    case 'agent-slow':
    case 'agent-ask':
      if (step === 0) {
        const ask = script === 'agent-ask';
        return {
          content: [
            toolUse('Agent', {
              description: ask ? 'Touch a file' : 'Check the workspace slowly',
              prompt: ask ? '[[mock:subagent-ask]] Create the file.' : '[[mock:subagent-slow:3]] Run a quick command, wait, and report back.',
              subagent_type: 'general-purpose',
              ...(ask || argument === 'foreground' ? { run_in_background: false } : {}),
            }),
          ],
        };
      }
      return reportResult();

    case 'agents':
      if (step === 0) {
        const background = argument === 'foreground' ? { run_in_background: false } : {};
        return {
          content: [
            text('Starting two agents.'),
            toolUse('Agent', { description: 'First probe', prompt: '[[mock:subagent-slow:2]] Probe one.', subagent_type: 'general-purpose', ...background }),
            toolUse('Agent', { description: 'Second probe', prompt: '[[mock:subagent-slow:4]] Probe two.', subagent_type: 'Explore', ...background }),
          ],
        };
      }
      return reportResult();

    case 'agent-steps':
      if (step === 0) {
        return {
          content: [toolUse('Agent', { description: 'Survey in steps', prompt: `[[mock:subagent-steps${argument ? ':' + argument : ''}]] Survey the workspace step by step.`, subagent_type: 'general-purpose' })],
        };
      }
      return reportResult();

    case 'subagent-steps': {
      const delayMs = (Number(argument) || 2) * 1000;
      if (step === 0) return { content: [text('Surveying.'), toolUse('Bash', { command: 'echo step-one', description: 'First step' })] };
      if (step === 1) return { content: [toolUse('Bash', { command: 'echo step-two', description: 'Second step' })], delayMs };
      return { content: [text('Survey complete: two steps ran.')], delayMs };
    }

    case 'subagent':
      if (step === 0) return { content: [toolUse('Bash', { command: 'echo subagent-ok', description: 'Print a marker' })] };
      return { content: [text('Subagent finished.')] };

    case 'subagent-slow':
      if (step === 0) return { content: [toolUse('Bash', { command: 'echo subagent-ok', description: 'Print a marker' })] };
      return { content: [text('Subagent finished.')], delayMs: (Number(argument) || 3) * 1000 };

    case 'subagent-ask':
      if (step === 0) return { content: [toolUse('Bash', { command: 'touch subagent.txt', description: 'Create a file' })] };
      return { content: [text(result ? `Subagent finished. ${describeResult(result)}` : 'Subagent finished.')] };

    case 'bash':
      if (step === 0) return { content: [toolUse('Bash', { command: argument || 'echo mock-bash', description: 'Run a mock command' })] };
      return reportResult();

    case 'bg-then-wait': {
      const seconds = Number(argument) || 6;
      if (step === 0) {
        const command = `sleep ${seconds}; touch ${resolvePath('bg-done.txt', body)}`;
        return { content: [toolUse('Bash', { command, description: 'Background marker', run_in_background: true })] };
      }
      if (step === 1) return { content: [toolUse('Bash', { command: 'sleep 60', description: 'Wait a minute' })] };
      return reportResult();
    }

    case 'bg':
    case 'monitor': {
      const ticks = Number(argument) || 3;
      const command = `for i in $(seq 1 ${ticks}); do echo tick $i; sleep 1; done`;
      if (step === 0 && script === 'bg') return { content: [toolUse('Bash', { command, description: 'Count ticks', run_in_background: true })] };
      if (step === 0) return { content: [toolUse('Monitor', { command, description: 'Watch the ticks', timeout_ms: 60_000 })] };
      return { content: [text(script === 'bg' ? 'Started.' : 'Watching.')] };
    }

    case 'cron':
      if (step === 0) return { content: [toolUse('CronCreate', { cron: argument || '*/30 * * * *', prompt: 'Check the run.', recurring: true })] };
      if (step === 1) return { content: [toolUse('ScheduleWakeup', { delaySeconds: 1200, prompt: 'Look again.', reason: 'mock wakeup', noop: false })] };
      return { content: [text('Scheduled.')] };

    case 'edit': {
      const file = resolvePath(argument, body, 'hello.txt');
      if (step === 0) return { content: [toolUse('Read', { file_path: file })] };
      if (step === 1) return { content: [toolUse('Edit', { file_path: file, old_string: 'hello', new_string: 'goodbye' })] };
      return reportResult();
    }

    case 'ask':
    case 'ask-as-string':
      if (step === 0) {
        const questions = [
          {
            question: 'Which approach should I take?',
            header: 'Approach',
            multiSelect: false,
            options: [
              { label: 'Small fix', description: 'Patch the one failing case' },
              { label: 'Refactor', description: 'Restructure the module first' },
            ],
          },
        ];
        const input = { questions: script === 'ask' ? questions : JSON.stringify(questions) };
        return { content: [toolUse('AskUserQuestion', input)] };
      }
      return reportResult();

    case 'plan': {
      const plan = '# Plan\n\n1. Read the code\n2. Make the change\n3. Run the tests';
      if (argument === 'file') {
        // As current Claude Code expects in plan mode: write the plan file it names, then
        // call ExitPlanMode without input (the CLI reads the plan from that file).
        const planFile = /create your plan at (\S+) using the Write tool/.exec(JSON.stringify(body.messages))?.[1];
        if (step === 0 && planFile) return { content: [toolUse('Write', { file_path: planFile, content: plan })] };
        if (step <= 1) return { content: [toolUse('ExitPlanMode', {})] };
        return reportResult();
      }
      if (step === 0) return { content: [toolUse('ExitPlanMode', { plan })] };
      return reportResult();
    }

    case 'delegate': {
      // `[[mock:delegate:luna,deepseek;message;check;wait;sleep=3;worktree;edit;ask]]`: one model
      // agent per model (all in one message), each running `[[mock:worker]]`; then one call per
      // step for the tools named by the flags (message, check, stop, wait), and the result.
      const [list = 'luna', ...flags] = String(argument || '').split(';');
      const has = (flag) => flags.includes(flag);
      const sleep = Number(flags.find((flag) => flag.startsWith('sleep='))?.slice(6)) || 1;
      const steps = Number(flags.find((flag) => flag.startsWith('steps='))?.slice(6)) || 0;
      if (step === 0) {
        const calls = list.split(',').map((model, index) => {
          const part = `part-${index + 1}`;
          const extra = has('edit') ? `,edit=${part}.txt` : has('ask') ? `,ask=${part}.txt` : steps ? `,steps=${steps}` : '';
          return toolUse('mcp__meshy__delegate', {
            model,
            task: `[[mock:worker:${sleep}${extra}]] Do ${part}.`,
            description: `Part ${index + 1}`,
            ...(has('worktree') ? { isolation: 'worktree' } : {}),
          });
        });
        return { content: [text(`Starting ${calls.length} workers.`), ...calls] };
      }
      const [first] = startedWorkers(messages.slice(humanIndex + 1));
      const call = ['message', 'check', 'stop', 'wait'].filter(has)[step - 1];
      // The first steering call comes after a pause, so the workers are at work by then.
      const delayMs = step === 1 && call !== 'wait' ? 3000 : 0;
      if (call === 'message') return { content: [toolUse('mcp__meshy__message_agent', { id: first, message: STEER_TEXT })], delayMs };
      if (call === 'check') return { content: [toolUse('mcp__meshy__check_agents', {})], delayMs };
      if (call === 'stop') return { content: [toolUse('mcp__meshy__stop_agent', { id: first, reason: 'mock stop' })], delayMs };
      if (call === 'wait') return { content: [toolUse('mcp__meshy__wait_agents', {})] };
      return reportResult();
    }

    case 'worker': {
      // Inside a model agent: Bash `sleep N`, then (`edit=FILE`) Write FILE or (`ask=FILE`)
      // a command that asks, then "Worker finished. <last tool result>".
      const [seconds, extra = ''] = String(argument || '1').split(',');
      const [action, file] = extra.split('=');
      if (action === 'steps') {
        if (step < Number(file)) return { content: [toolUse('Bash', { command: `sleep ${Number(seconds) || 0} && echo step-${step + 1}`, description: `Step ${step + 1}` })] };
        return { content: [text(`Worker finished. ${result ? describeResult(result) : ''}`.trim())] };
      }
      if (step === 0) return { content: [toolUse('Bash', { command: `sleep ${Number(seconds) || 1} && echo worker-ok`, description: 'Work for a while' })] };
      if (step === 1 && action === 'edit') return { content: [toolUse('Write', { file_path: resolvePath(file, body, 'part.txt'), content: 'written by a worker\n' })] };
      if (step === 1 && action === 'ask') return { content: [toolUse('Bash', { command: `touch ${file}`, description: 'Create a file' })] };
      return { content: [text(`Worker finished. ${result ? describeResult(result) : ''}`.trim())] };
    }

    case 'tools': {
      // `[[mock:tools:NAME*N]]`: N calls of tool NAME in one message, input {index}.
      const [, name, count = '1'] = /^(.+?)(?:\*(\d+))?$/.exec(argument || '') || [];
      if (step === 0 && name) return { content: Array.from({ length: Number(count) }, (_, index) => toolUse(name, { index })) };
      return reportResult();
    }

    case 'slow':
      return { content: [text('')], slow: true };

    case 'api-error':
      return { error: { status: 400, type: 'invalid_request_error', message: 'Mock API error' } };

    default:
      return { content: [text(step === 0 ? 'ok' : result ? describeResult(result) : 'ok')] };
  }
}

function messageEnvelope(body, content, stopReason) {
  return {
    id: 'msg_mock_' + crypto.randomBytes(8).toString('hex'),
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { ...USAGE, output_tokens: stopReason ? OUTPUT_TOKENS : 1 },
  };
}

/** Splits a string into `parts` roughly equal chunks (at least one character each). */
function split(value, parts) {
  const size = Math.max(1, Math.ceil(value.length / parts));
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += size) chunks.push(value.slice(offset, offset + size));
  return chunks.length ? chunks : [''];
}

function writeEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Streams one scripted response as Anthropic SSE events. */
async function streamResponse(req, res, body, { content, slow, delayMs = 0 }) {
  let closed = false;
  res.on('close', () => (closed = true));
  // A slow model: nothing arrives until the delay is over (or the client gave up).
  for (let waited = 0; waited < delayMs && !closed; waited += 100) await delay(100);
  if (closed) return;
  const stopReason = content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  writeEvent(res, 'message_start', { message: messageEnvelope(body, [], null) });
  writeEvent(res, 'ping', {});

  for (const [index, block] of content.entries()) {
    if (block.type === 'text') {
      writeEvent(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
      if (slow) {
        for (let tick = 0; tick < 30 && !closed; tick += 1) {
          writeEvent(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: `chunk ${tick} ` } });
          await delay(100);
        }
        if (closed) return;
      } else {
        for (const chunk of split(block.text, 2)) {
          writeEvent(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: chunk } });
        }
      }
    } else if (block.type === 'thinking') {
      writeEvent(res, 'content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      for (const chunk of split(block.thinking, 2)) {
        writeEvent(res, 'content_block_delta', { index, delta: { type: 'thinking_delta', thinking: chunk } });
      }
      writeEvent(res, 'content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'tool_use') {
      writeEvent(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      for (const chunk of split(JSON.stringify(block.input), 3)) {
        writeEvent(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: chunk } });
      }
    }
    writeEvent(res, 'content_block_stop', { index });
  }

  writeEvent(res, 'message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: OUTPUT_TOKENS } });
  writeEvent(res, 'message_stop', {});
  res.end();
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function humanBlockTypes(message) {
  if (!message) return [];
  if (typeof message.content === 'string') return ['text'];
  return (message.content || []).map((block) => block.type);
}

/**
 * Tools offered as deferred (tool search): Claude Code names them in the conversation
 * ("The following deferred tools are now available via ToolSearch…", one per line) instead
 * of sending their schemas, and names the ones gone in a later note.
 */
function deferredTools(body) {
  const texts = [];
  const add = (content) => {
    if (typeof content === 'string') texts.push(content);
    else for (const block of content || []) if (block.type === 'text') texts.push(block.text);
  };
  add(body?.system);
  for (const message of body?.messages || []) add(message.content);
  const offered = new Set();
  for (const text of texts) {
    // The names follow the announcement, one per line, up to a blank line.
    for (const match of text.matchAll(/deferred tools (are now available|are no longer available)[^\n]*\n((?:[^\n]+\n?)*)/gi)) {
      const gone = /no longer/i.test(match[1]);
      for (const line of match[2].split('\n')) {
        const name = line.trim();
        if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) gone ? offered.delete(name) : offered.add(name);
      }
    }
  }
  return [...offered];
}

/** One log line per request, small enough to print. */
function describeRequest(req, pathname, body) {
  const messages = body?.messages || [];
  const humanIndex = humanMessageIndex(messages);
  const human = humanIndex >= 0 ? contentText(messages[humanIndex].content) : '';
  return {
    at: Date.now(),
    method: req.method,
    path: pathname,
    model: body?.model,
    stream: Boolean(body?.stream),
    tools: (body?.tools || []).map((tool) => tool.name),
    // Named in the conversation for tool search, schemas not sent (see deferredTools).
    deferred: deferredTools(body),
    system: systemText(body?.system),
    messageCount: messages.length,
    // What the user's latest message said, as the CLI sent it (with any harness notes).
    human,
    // Block types of that message (e.g. ['image', 'text'] for an inline image).
    humanBlocks: humanBlockTypes(messages[humanIndex]),
    // Notes the CLI added after it, as system messages: a message sent mid-turn is folded in as one.
    notes: messages.slice(humanIndex + 1).filter((message) => message.role === 'system').map((message) => contentText(message.content)),
    marker: lastMarker(human)?.[1] ?? null,
    lastToolResult: lastToolResult(messages),
    thinking: body?.thinking ?? null,
    // Claude Code's session id; the gateway keys Codex prompt caching on it.
    sessionId: req.headers['x-claude-code-session-id'] ?? null,
  };
}

function authorized(req, key) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const given = Buffer.from(String(req.headers['x-api-key'] || bearer?.[1]?.trim() || ''));
  const expected = Buffer.from(key);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Starts the mock on 127.0.0.1. `requests` collects every request (also served at
 * GET /__log); `schemas` maps tool name -> input_schema from the latest request with tools.
 * The login node is shared, so every route requires the per-start `key` (x-api-key or Bearer):
 * the log holds prompts and tool results.
 */
export async function startMockGateway({ port = 0, quiet = true, keepBodies = false } = {}) {
  // keepBodies: each request entry also keeps its full `body` and `headers` (cache-prefix checks).
  const key = crypto.randomBytes(24).toString('hex');
  const requests = [];
  const schemas = {};
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://mock');
    if (!authorized(req, key)) {
      req.resume();
      return sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid mock gateway key' } });
    }
    try {
      const raw = await readBody(req);
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Body is not JSON' } });
        }
      }

      if (req.method === 'GET' && pathname === '/__log') return sendJson(res, 200, requests);

      if (req.method === 'GET' && pathname === '/v1/models') {
        const data = MOCK_MODELS.map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' }));
        return sendJson(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id });
      }

      if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
        requests.push(describeRequest(req, pathname, body));
        return sendJson(res, 200, { input_tokens: Math.ceil(raw.length / 4) });
      }

      if (req.method === 'POST' && pathname === '/v1/messages') {
        const entry = describeRequest(req, pathname, body);
        if (keepBodies) {
          entry.body = body;
          entry.headers = req.headers;
        }
        requests.push(entry);
        for (const tool of body.tools || []) schemas[tool.name] = tool.input_schema;
        log(`mock: ${entry.model} stream=${entry.stream} marker=${entry.marker} messages=${entry.messageCount}`);
        const reply = scriptedContent(body);
        if (reply.error) {
          const { status, type, message } = reply.error;
          return sendJson(res, status, { type: 'error', error: { type, message } });
        }
        if (body.stream) return await streamResponse(req, res, body, reply);
        const stopReason = reply.content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
        const content = reply.slow ? [text('slow reply')] : reply.content;
        return sendJson(res, 200, messageEnvelope(body, content, stopReason));
      }

      requests.push({ ...describeRequest(req, pathname, body), unknownRoute: true });
      log(`mock: unknown route ${req.method} ${req.url}`);
      sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `No mock for ${req.method} ${pathname}` } });
    } catch (error) {
      log('mock: handler failed', error);
      if (!res.headersSent) sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: error.message } });
      else res.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    key,
    requests,
    schemas,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex > 0 ? Number(process.argv[portIndex + 1]) : 0;
  const gateway = await startMockGateway({ port, quiet: false });
  console.log(`Mock gateway listening on ${gateway.url} (key ${gateway.key})`);
}
