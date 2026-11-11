// A stand-in for the SDK's query() in streaming-input mode: one fake Claude Code process
// per call, reading user messages from the prompt iterable and answering each one with a
// scripted turn. It speaks the parts of the protocol the runner relies on: system init,
// command_lifecycle frames, replayed user messages, results listing the uuids they
// consumed, and the control methods (interrupt with cancelQueued, cancelAsyncMessage,
// setModel, applyFlagSettings, setPermissionMode, close).
//
// const cli = createFakeCli(async function* (turn) { yield ...; });
// createRunner({ ..., query: cli.query });  cli.spawns, cli.processes[0].controls
//
// `turn` (one per user message, or per own turn):
//   text, content, uuid, priority   the user message (text joins text blocks)
//   options                         the query options the process started with
//   proc                            the fake process (model, effort, mode, controls, ...)
//   index                           0-based turn number across all processes
//   fold()                          takes queued messages into this turn now (as the CLI
//                                   does between tool rounds); returns their texts
//   interrupted                     a promise that resolves when the turn is interrupted
//   tool(name, input, id?)          asks canUseTool like the CLI; resolves to the decision
//
// MCP servers: `behavior.mcp` is a list of status rows (or a function of the process's
// options returning one) such as { name, status, scope, source, config, tools }. Every
// process gets its own copy as `proc.mcp.servers` (a Map by name) and answers
// mcpServerStatus, reconnectMcpServer, toggleMcpServer, mcpAuthenticate,
// mcpSubmitOAuthCallbackUrl and mcpClearAuth like Claude Code 2.1.290 does (messages and
// shapes measured against it); `proc.mcp.calls` lists the control calls, `proc.mcp.signIn`
// the OAuth sign-ins waiting for a pasted address, and `proc.toolsOffered()` the tools of
// connected servers that no flag-settings deny rule hides. A row's `afterSignIn` (what
// the reconnect after a pasted address ends as) and `onReconnect` ('connected' | 'failed' |
// 'needs-auth') decide how those calls end.
//
// A script yields SDK messages (session_id is filled in). A yielded result ends the turn
// (user_message_uuids is filled in); without one a success result is added. A throw
// crashes the process: the stream throws that error.

import fs from 'node:fs';

const INTERRUPTED = Symbol('interrupted');

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

export function successResult(extra = {}) {
  return { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 42, num_turns: 1, modelUsage: {}, result: '', ...extra };
}

/**
 * @param {(turn: object) => AsyncIterable<object>} script
 * @param {object} [behavior]
 * @param {boolean} [behavior.lifecycle]  emit command_lifecycle frames (newer CLIs)
 * @param {boolean} [behavior.interruptFails]  interrupt() rejects
 * @param {boolean} [behavior.interruptIgnored]  interrupt() resolves but the turn goes on
 * @param {'cancelled'|'silent'} [behavior.interruptDrops]  a plain interrupt() drops the queued
 *   messages too (with 'cancelled' lifecycle frames, or without a word) instead of keeping them
 * @param {number} [behavior.mcpDelayMs]  every MCP control request (status, reconnect, sign-in) answers this late
 * @param {(options: object, n: number) => string} [behavior.sessionId]  id of a new conversation
 */
/** Claude Code's name for a server inside tool names (see server/mcp-status.mjs). */
const toolPrefix = (name) => {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${name.startsWith('claude.ai ') ? normalized.replace(/_+/g, '_').replace(/^_|_$/g, '') : normalized}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakeCli(script, behavior = {}) {
  const mcpDelay = () => (behavior.mcpDelayMs ? sleep(behavior.mcpDelayMs) : undefined);
  const { lifecycle = true, interruptFails = false, interruptIgnored = false, interruptDrops = null } = behavior;
  const processes = [];
  let turnCount = 0;
  let conversations = 0;
  const newSessionId = behavior.sessionId ?? (() => `sdk-${++conversations}`);

  function query({ prompt, options }) {
    const proc = {
      options,
      sessionId: options.resume && !options.forkSession ? options.resume : newSessionId(options, processes.length + 1),
      model: options.model,
      effort: options.effort,
      mode: options.permissionMode,
      flags: { ...options.settings },
      controls: [],
      commands: [],
      received: [],
      events: [], // 'flags' (applyFlagSettings) and 'user' (a message on stdin), in the order they arrived
      current: null,
      inputEnded: false,
      ended: false,
      initSent: false,
    };
    // The process's MCP servers, as Claude Code lists them.
    const rows = typeof behavior.mcp === 'function' ? behavior.mcp(options) : (behavior.mcp ?? []);
    proc.mcp = { servers: new Map(rows.map((row) => [row.name, structuredClone(row)])), calls: [], signIn: new Map(), callbacks: [] };
    proc.toolsOffered = () => {
      const deny = proc.flags.permissions?.deny ?? [];
      return [...proc.mcp.servers.values()]
        .filter((row) => row.status === 'connected' && !deny.includes(toolPrefix(row.name)))
        .flatMap((row) => (row.tools ?? []).map((tool) => `${toolPrefix(row.name)}__${tool.name}`));
    };
    processes.push(proc);
    // The debug log a process writes to `debugFile` (behavior.debugLog: text, or a function of the options).
    if (options.debugFile && behavior.debugLog) fs.writeFileSync(options.debugFile, typeof behavior.debugLog === 'function' ? behavior.debugLog(options) : behavior.debugLog);

    // Output channel: what the SDK iterator yields.
    const out = [];
    let wakeOut = null;
    let failure = null;
    const emit = (message) => {
      if (proc.ended) return;
      out.push({ session_id: proc.sessionId, ...message });
      wakeOut?.();
    };
    const end = (error = null) => {
      if (proc.ended) return;
      proc.ended = true;
      failure = error;
      wakeOut?.();
      wakeEngine?.();
      proc.current?.interrupt();
    };
    proc.emit = emit;
    proc.crash = (error = new Error('Claude Code process exited with code 1')) => end(error);
    const replay = options.extraArgs && 'replay-user-messages' in options.extraArgs;

    let wakeEngine = null;
    const acknowledge = (command) => {
      if (!command.uuid) return;
      proc.current?.uuids.push(command.uuid);
      if (replay) emit({ type: 'user', message: { role: 'user', content: command.content }, parent_tool_use_id: null, uuid: command.uuid, isReplay: true });
      if (lifecycle) emit({ type: 'command_lifecycle', command_uuid: command.uuid, state: 'started', uuid: crypto.randomUUID() });
    };

    async function runTurn(command) {
      let interrupt;
      const interrupted = new Promise((resolve) => (interrupt = resolve));
      const current = { uuids: [], interrupted: false, interrupt: () => ((current.interrupted = true), interrupt(INTERRUPTED)) };
      proc.current = current;
      if (!proc.initSent) {
        proc.initSent = true;
        emit({ type: 'system', subtype: 'init', mcp_servers: [] });
      }
      acknowledge(command);
      const turn = {
        text: textOf(command.content),
        content: command.content,
        uuid: command.uuid,
        priority: command.priority,
        own: Boolean(command.own),
        options,
        proc,
        index: turnCount++,
        interrupted,
        fold() {
          const taken = [];
          while (proc.commands.length && !proc.commands[0].own && proc.commands[0].priority !== 'later') {
            const next = proc.commands.shift();
            acknowledge(next);
            taken.push(textOf(next.content));
          }
          return taken;
        },
        async tool(name, input, id = `tool-${crypto.randomUUID().slice(0, 8)}`) {
          emit({ type: 'assistant', uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id: 'msg-' + id, content: [{ type: 'tool_use', id, name, input }] } });
          const signal = new AbortController().signal;
          const decision = await options.canUseTool(name, input, { signal, toolUseID: id, suggestions: [] });
          const denied = decision.behavior !== 'allow';
          emit({
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: denied ? decision.message : 'ok', is_error: denied }] },
          });
          return decision;
        },
      };
      const iterator = (command.script ?? script)(turn)[Symbol.asyncIterator]();
      let resultSent = false;
      try {
        while (!proc.ended) {
          const step = await Promise.race([iterator.next(), interrupted]);
          if (step === INTERRUPTED || proc.ended) {
            void iterator.return?.();
            break;
          }
          if (step.done) break;
          const message = step.value;
          if (message.type === 'result') {
            emit({ ...message, user_message_uuids: [...current.uuids] });
            resultSent = true;
            break;
          }
          emit(message);
        }
      } catch (error) {
        end(error);
        return;
      }
      if (proc.ended) return;
      if (!resultSent) {
        emit(
          current.interrupted
            ? { type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, duration_ms: 1, num_turns: 1, modelUsage: {}, user_message_uuids: [...current.uuids] }
            : { ...successResult(), user_message_uuids: [...current.uuids] },
        );
      }
      if (lifecycle) for (const uuid of current.uuids) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
      proc.current = null;
    }

    // The engine: one turn at a time, in order.
    (async () => {
      while (!proc.ended) {
        if (proc.commands.length) await runTurn(proc.commands.shift());
        else if (proc.inputEnded) return end();
        else await new Promise((resolve) => (wakeEngine = resolve));
      }
    })();

    // stdin.
    (async () => {
      try {
        for await (const message of prompt) {
          if (proc.ended) return;
          const command = { uuid: message.uuid, content: message.message.content, priority: message.priority };
          proc.received.push(command);
          proc.events.push('user');
          proc.commands.push(command);
          if (lifecycle && command.uuid) emit({ type: 'command_lifecycle', command_uuid: command.uuid, state: 'queued' });
          wakeEngine?.();
        }
      } catch {
        // The prompt failed: treat as end of input.
      }
      proc.inputEnded = true;
      wakeEngine?.();
    })();

    options.abortController?.signal.addEventListener('abort', () => end(new Error('Claude Code process aborted by user')), { once: true });

    /** Claude Code starting a turn of its own (a background task finished). */
    proc.ownTurn = (ownScript) => {
      proc.commands.push({ own: true, content: '', script: ownScript });
      wakeEngine?.();
    };

    const cancelQueuedCommands = () => {
      const cancelled = [];
      for (const command of proc.commands.splice(0)) {
        if (!command.uuid) continue;
        cancelled.push(command.uuid);
        if (lifecycle) emit({ type: 'command_lifecycle', command_uuid: command.uuid, state: 'cancelled' });
      }
      return cancelled;
    };

    const stream = {
      async next() {
        while (!out.length && !proc.ended) await new Promise((resolve) => (wakeOut = resolve));
        if (out.length) return { value: out.shift(), done: false };
        if (failure) throw failure;
        return { value: undefined, done: true };
      },
      async return() {
        end();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async interrupt(params = {}) {
        proc.controls.push(['interrupt', params]);
        if (interruptFails) throw new Error('interrupt not supported');
        const cancelled = params.cancelQueued ? cancelQueuedCommands() : [];
        if (!params.cancelQueued && interruptDrops) {
          for (const command of proc.commands.splice(0)) {
            if (lifecycle && command.uuid && interruptDrops === 'cancelled') emit({ type: 'command_lifecycle', command_uuid: command.uuid, state: 'cancelled' });
          }
        }
        if (!interruptIgnored) proc.current?.interrupt();
        const stillQueued = params.cancelQueued ? [] : proc.commands.map((c) => c.uuid).filter(Boolean);
        return { still_queued: stillQueued, ...(params.cancelQueued ? { cancelled } : {}) };
      },
      async cancelAsyncMessage(uuid) {
        proc.controls.push(['cancelAsyncMessage', uuid]);
        const index = proc.commands.findIndex((command) => command.uuid === uuid);
        if (index < 0) return false;
        proc.commands.splice(index, 1);
        if (lifecycle) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' });
        return true;
      },
      async rewindFiles(uuid, request) {
        proc.controls.push(['rewindFiles', uuid, request]);
        const answer = behavior.rewindFiles?.(uuid, request);
        if (answer) return answer;
        return request?.dryRun ? { canRewind: true, filesChanged: [`${options.cwd}/a.txt`], insertions: 1, deletions: 1 } : { canRewind: true, skippedLinks: 0 };
      },
      async setModel(model) {
        proc.controls.push(['setModel', model]);
        proc.model = model;
      },
      async applyFlagSettings(settings) {
        proc.controls.push(['applyFlagSettings', settings]);
        proc.events.push('flags');
        if (behavior.applyFlagFails && settings.permissions) throw new Error(behavior.applyFlagFails);
        // Objects merge, arrays replace (measured: a partial `permissions` keeps the allow rules).
        const { permissions, ...rest } = settings;
        Object.assign(proc.flags, rest);
        if (permissions) proc.flags.permissions = { ...proc.flags.permissions, ...permissions };
        if ('effortLevel' in settings) proc.effort = settings.effortLevel;
      },
      async mcpServerStatus() {
        proc.mcp.calls.push(['mcpServerStatus']);
        await mcpDelay();
        if (behavior.mcpStatusFails) throw new Error(behavior.mcpStatusFails);
        return [...proc.mcp.servers.values()].map((row) => structuredClone(row));
      },
      async reconnectMcpServer(name) {
        proc.mcp.calls.push(['reconnectMcpServer', name]);
        await mcpDelay();
        const row = proc.mcp.servers.get(name);
        if (!row) throw new Error(`Server not found: ${name}`);
        if (row.status === 'disabled') throw new Error('Server status: disabled');
        const outcome = row.signedIn ? (row.afterSignIn ?? 'connected') : (row.onReconnect ?? (row.status === 'needs-auth' || row.status === 'failed' ? row.status : 'connected'));
        row.status = outcome;
        if (outcome === 'failed') {
          row.error = row.error || 'Connection failed';
          throw new Error('Connection failed');
        }
        if (outcome !== 'connected') throw new Error(`Server status: ${outcome}`);
        delete row.error;
      },
      async toggleMcpServer(name, enabled) {
        proc.mcp.calls.push(['toggleMcpServer', name, enabled]);
        const row = proc.mcp.servers.get(name);
        if (!row) throw new Error(`Server not found: ${name}`);
        row.status = enabled ? 'connected' : 'disabled';
      },
      async mcpAuthenticate(name, redirectUri) {
        proc.mcp.calls.push(['mcpAuthenticate', name, redirectUri]);
        await mcpDelay();
        const row = proc.mcp.servers.get(name);
        if (!row) throw new Error(`Server not found: ${name}`);
        const type = row.config?.type;
        if (type === 'claudeai-proxy') {
          return { authUrl: `https://claude.ai/api/organizations/org-1/mcp/start-auth/${row.config.id}?product_surface=sdk-ts`, requiresUserAction: true, callbackExpected: false };
        }
        if (type !== 'http' && type !== 'sse') throw new Error(`Server type "${type ?? 'stdio'}" does not support OAuth authentication`);
        const state = `state-${proc.mcp.signIn.size + proc.mcp.calls.length}`;
        proc.mcp.signIn.set(name, { state, port: row.config.oauth?.callbackPort ?? 3118 });
        const port = row.config.oauth?.callbackPort ?? 3118;
        const redirect = encodeURIComponent(`http://localhost:${port}/callback`);
        return {
          authUrl: `https://auth.example/oauth/authorize?response_type=code&client_id=cid&redirect_uri=${redirect}&state=${state}`,
          requiresUserAction: true,
          callbackExpected: true,
          redirectScheme: 'localhost',
          state,
          callbackPort: port,
        };
      },
      async mcpSubmitOAuthCallbackUrl(name, callbackUrl) {
        proc.mcp.calls.push(['mcpSubmitOAuthCallbackUrl', name, callbackUrl]);
        await mcpDelay();
        const flow = proc.mcp.signIn.get(name);
        if (!flow) throw new Error(`No active OAuth flow for server: ${name}`);
        const url = new URL(callbackUrl);
        if (!url.searchParams.has('code') && !url.searchParams.has('error')) throw new Error('Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.');
        if (url.searchParams.get('state') !== flow.state) {
          throw new Error('Callback URL not accepted: it belongs to a different sign-in attempt (OAuth state mismatch) or carries no authorization code. The sign-in in progress is still waiting; submit the redirect URL from its own browser page.');
        }
        // Like Claude Code 2.1.290: the token is stored, the server stays as it was until a reconnect.
        proc.mcp.signIn.delete(name);
        proc.mcp.servers.get(name).signedIn = true;
        proc.mcp.callbacks.push(name);
      },
      async mcpClearAuth(name) {
        proc.mcp.calls.push(['mcpClearAuth', name]);
        await mcpDelay();
        const row = proc.mcp.servers.get(name);
        if (!row) throw new Error(`Server not found: ${name}`);
        if (row.config?.type !== 'http' && row.config?.type !== 'sse') throw new Error(`Cannot clear auth for server type "${row.config?.type}"`);
        // Measured: the server is left needing a sign-in.
        row.status = 'needs-auth';
        row.signedIn = false;
        delete row.error;
      },
      async setPermissionMode(mode) {
        proc.controls.push(['setPermissionMode', mode]);
        if (behavior.failMode?.(mode)) throw new Error('cannot switch now');
        proc.mode = mode;
      },
      close() {
        proc.controls.push(['close']);
        end();
      },
    };
    proc.stream = stream;
    return stream;
  }

  return {
    query,
    processes,
    get spawns() {
      return processes.length;
    },
    /** The newest process. */
    get last() {
      return processes.at(-1);
    },
  };
}
