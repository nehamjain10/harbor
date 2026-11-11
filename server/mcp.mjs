// MCP servers of a session: what Claude Code has connected (or could not), a per-session
// switch for each server, reconnecting, and signing in to the ones that need it.
//
// Status comes from the session's live Claude Code process when it has one
// (`mcpServerStatus()`), otherwise from a no-prompt process started for the session's
// folder and model route and closed after use (as commands.mjs does), kept for a minute.
// The route matters: the Claude login serves claude.ai connectors only on Claude models;
// on gateway models (an API key) the CLI lists just the servers of its own configuration,
// and a plugin server whose address a claude.ai connector also has is left out.
//
// Switching a server off is a deny rule in the process's flag settings (mcp-status.mjs),
// not Claude Code's `mcp_toggle`, which writes the server as disabled for the whole
// project into ~/.claude.json and so would reach every session in the folder.
//
// Sign-in:
//   claude.ai connector  the CLI gives a claude.ai address that starts the connector's
//                        sign-in there (the token lives on claude.ai); afterwards Reconnect.
//   OAuth (http/sse)     the CLI opens a listener on localhost (a fixed port for servers with
//                        a registered client, like Slack's 3118) and gives the authorization
//                        address. The browser ends on http://localhost:<port>/callback?code=…,
//                        which cannot load on the user's own machine; they paste that address
//                        back and the SAME process (it holds the OAuth state, so it is kept
//                        alive meanwhile) exchanges the code. The token goes to the CLI's own
//                        credential store, shared by every session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { isRemote } from './clusters.mjs';
import { httpError } from './errors.mjs';
import { authKind, disabledServers, parseCallbackUrl, parseHiddenServers, publicServers, scrubError } from './mcp-status.mjs';
import { AGENT_SERVER } from './model-agents.mjs';
import { MODELS, findModel, resolveEffort, runsDirect } from './models.mjs';
import { buildQueryOptions } from './runner.mjs';

const CACHE_TTL_MS = 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
// Claude Code reports plugin servers and claude.ai connectors as they load, not as
// pending: a list is trusted once it did not change for this many reads in a row.
const STABLE_POLLS = 3;
// A process this young may still be loading; an older one only has servers connecting.
const YOUNG_PROCESS_MS = 10_000;
const PENDING_WAIT_MS = 5_000;
// An OAuth flow started by mcp_authenticate expires after about five minutes (measured on
// 2.1.290: a later submit fails with "No active OAuth flow"); its process is kept a little longer.
const SIGN_IN_FLOW_MS = 5 * 60 * 1000;
const SIGN_IN_KEEP_ALIVE_MS = SIGN_IN_FLOW_MS + 30_000;
const CALLBACK_TIMEOUT_MS = 60_000;
const CONNECT_WAIT_MS = 15_000;
const MAX_CONCURRENT_DISCOVERIES = 2;
const MAX_CACHED_FOLDERS = 50;

export const CLAUDE_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

// Harbor's own server only exists inside a session's process; a listing made without one
// shows it from what the runner puts there (model-agents.mjs).
const BUILTIN_ROW = {
  name: AGENT_SERVER,
  status: 'connected',
  scope: 'sdk',
  source: 'sdk',
  config: { type: 'sdk' },
  tools: [
    { name: 'delegate', description: 'Start a worker on another model and carry on.', annotations: {} },
    { name: 'wait_agents', description: 'Collect the reports of the workers started with delegate.', annotations: { readOnly: true } },
    { name: 'message_agent', description: 'Send a running worker a message; it reads it at its next step.', annotations: { readOnly: true } },
    { name: 'stop_agent', description: 'Stop a worker and get its partial report.', annotations: {} },
    { name: 'check_agents', description: "Each worker's latest step and what it last said, without waiting.", annotations: { readOnly: true } },
  ],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const signature = (rows) => rows.map((row) => `${row.name}:${row.status}`).sort().join('|');

/**
 * Reads the status until it settles: no server pending and the list unchanged for
 * `stablePolls` reads, or `timeoutMs` is over (then the last read stands).
 */
async function settled(read, { timeoutMs, stablePolls = STABLE_POLLS, pollMs = POLL_MS }) {
  const deadline = Date.now() + timeoutMs;
  let rows = await read();
  let last = signature(rows);
  let steady = rows.some((row) => row.status === 'pending') ? 0 : 1;
  while (steady < stablePolls && Date.now() < deadline) {
    await sleep(pollMs);
    rows = await read();
    const current = signature(rows);
    if (rows.some((row) => row.status === 'pending')) steady = 0;
    else steady = current === last ? steady + 1 : 1;
    last = current;
  }
  return rows;
}

/** The first message of a control error, without paths or addresses that carry secrets. */
function failureText(error, fallback) {
  return scrubError(error?.message) || fallback;
}

/**
 * @param {object} deps
 * @param {{claudeExecutable: string, settingSources?: string[], claudeConfigDir?: string}} deps.config
 * @param {{url: string, apiKey: string}} [deps.gateway]  the normalizing proxy (as for turns)
 * @param {{pool: object, ensureCli: Function, applyMcpDisabled: Function}} deps.runner
 * @param {Function} [deps.query]  the SDK query function (replaceable in tests)
 */
export function createMcpManager({
  config,
  gateway,
  runner,
  query = sdkQuery,
  log = console.error,
  ttlMs = CACHE_TTL_MS,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  pollMs = POLL_MS,
  now = Date.now,
}) {
  const cache = new Map(); // `${cwd}|${route}` -> { expires, ok, hidden, found: Promise<{rows, failed, hidden}> }, oldest first
  // What the last listing of a folder and route found left out (kept when the cache is cleared:
  // a live process cannot tell, so its list borrows the folder's last answer).
  const hiddenSeen = new Map();
  let running = 0;
  const waiting = [];

  async function limited(task) {
    if (running >= MAX_CONCURRENT_DISCOVERIES) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  /** Starts a no-prompt process for a folder and route, reads its server list, closes it. */
  async function discoverProject(cwd, direct) {
    // A catalog model of the session's route: Claude models use the login (claude.ai
    // connectors), the others the gateway. No message is sent, so no model is called.
    const model = MODELS.find((entry) => runsDirect(entry) === direct);
    const abortController = new AbortController();
    const options = buildQueryOptions(
      { cwd, mode: 'default' },
      {
        model,
        effort: resolveEffort(model.id, {}),
        claudeExecutable: config.claudeExecutable,
        gateway,
        settingSources: config.settingSources,
        claudeConfigDir: config.claudeConfigDir,
        abortController,
      },
    );
    options.persistSession = false;
    options.includePartialMessages = false;
    // The debug log says which servers Claude Code left out as duplicates (see parseHiddenServers).
    const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mcp-'));
    options.debugFile = path.join(debugDir, 'debug.log');
    // The SDK ends the control channel when its prompt iterable finishes.
    let release;
    const released = new Promise((resolve) => (release = resolve));
    const prompt = (async function* idle() {
      await released;
    })();
    let stream;
    try {
      stream = query({ prompt, options });
      const rows = await withTimeout(settled(() => stream.mcpServerStatus(), { timeoutMs, pollMs }), timeoutMs + 5000, 'Listing MCP servers timed out');
      let hidden = [];
      try {
        hidden = parseHiddenServers(fs.readFileSync(options.debugFile, 'utf8'));
      } catch {
        // No log (an older Claude Code): nothing to say about hidden servers.
      }
      return { rows, hidden };
    } finally {
      stream?.close();
      abortController.abort();
      release();
      fs.rmSync(debugDir, { recursive: true, force: true });
    }
  }

  const routeOf = (session) => runsDirect(findModel(session.model) ?? MODELS[0]);
  const cacheKey = (cwd, direct) => `${cwd}|${direct ? 'claude' : 'gateway'}`;

  /** The folder's server rows (public form, none switched off), cached; never rejects. */
  function discover(cwd, direct, { fresh = false } = {}) {
    const key = cacheKey(cwd, direct);
    const hit = cache.get(key);
    if (hit && !fresh && hit.expires > now()) return hit.found;
    cache.delete(key);
    while (cache.size >= MAX_CACHED_FOLDERS) cache.delete(cache.keys().next().value);
    const entry = { expires: Infinity, ok: false };
    entry.found = limited(() => discoverProject(cwd, direct)).then(
      ({ rows, hidden }) => {
        entry.expires = now() + ttlMs;
        entry.ok = true;
        hiddenSeen.delete(key);
        hiddenSeen.set(key, hidden);
        while (hiddenSeen.size > MAX_CACHED_FOLDERS) hiddenSeen.delete(hiddenSeen.keys().next().value);
        return { rows: publicServers([...rows, ...(rows.some((row) => row.name === AGENT_SERVER) ? [] : [BUILTIN_ROW])]), failed: null, hidden };
      },
      (error) => {
        log(`MCP server listing failed in ${cwd}: ${error.message}`);
        // A failure is retried soon, not cached for a minute.
        entry.expires = now() + 5000;
        return { rows: publicServers([BUILTIN_ROW]), failed: failureText(error, 'Claude Code could not be started.'), hidden: [] };
      },
    );
    cache.set(key, entry);
    return entry.found;
  }

  const forget = () => cache.clear();

  /** The live process's list, once it has settled. */
  function liveRows(cli) {
    const young = now() - cli.startedAt < YOUNG_PROCESS_MS;
    return settled(() => cli.stream.mcpServerStatus(), {
      timeoutMs: young ? YOUNG_PROCESS_MS : PENDING_WAIT_MS,
      stablePolls: young ? STABLE_POLLS : 1,
      pollMs,
    });
  }

  // Keeps a process from being closed as idle while work runs on it (the idle check looks at
  // when it was last used, and a slow reply can outlast a short timeout), then counts as used.
  async function holding(cli, work) {
    cli.holds = (cli.holds || 0) + 1;
    try {
      return await work();
    } finally {
      cli.holds -= 1;
      runner.pool.touch(cli);
    }
  }

  // A cached listing was made without any session: its servers get this session's switches.
  const overlay = (rows, session) => {
    const disabled = new Set(disabledServers(session));
    return rows.map((row) => ({ ...row, disabledInSession: !row.builtin && disabled.has(row.name) }));
  };

  // The servers the folder's last listing found left out, minus any the list now shows.
  const hiddenFor = (cwd, direct, servers) => (hiddenSeen.get(cacheKey(cwd, direct)) ?? []).filter((entry) => !servers.some((server) => server.name === entry.name));

  /**
   * The session's servers: from its live process, else a no-prompt listing of its folder
   * and route. `cached` never starts a process: without a live one it answers from a
   * recent listing or with `servers: null`. `fresh` ignores a cached listing.
   */
  async function list(session, { cached = false, fresh = false } = {}) {
    const direct = routeOf(session);
    const route = direct ? 'claude' : 'gateway';
    const cli = runner.pool.get(session.id);
    if (cli) {
      try {
        const rows = await holding(cli, () => liveRows(cli));
        const servers = publicServers(rows, session);
        return { live: true, route, at: now(), servers, hidden: hiddenFor(session.cwd, direct, servers) };
      } catch (error) {
        throw httpError(502, `Claude Code did not answer: ${failureText(error, 'no reply')}`);
      }
    }
    // A remote session's servers are its cluster's: known from its live process only.
    if (isRemote(session)) return { live: false, route, at: now(), servers: null };
    if (cached) {
      const hit = cache.get(cacheKey(session.cwd, direct));
      if (!hit?.ok || hit.expires <= now()) return { live: false, route, at: now(), servers: null };
      const { rows } = await hit.found;
      return { live: false, route, at: now(), servers: overlay(rows, session), hidden: hiddenFor(session.cwd, direct, rows) };
    }
    const { rows, failed } = await discover(session.cwd, direct, { fresh });
    return { live: false, route, at: now(), servers: overlay(rows, session), hidden: hiddenFor(session.cwd, direct, rows), ...(failed ? { error: failed } : {}) };
  }

  /** A project folder's servers without a session: read only, from a listing. */
  async function listProject(cwd, direct) {
    const { rows, failed } = await discover(cwd, direct);
    return { live: false, route: direct ? 'claude' : 'gateway', at: now(), servers: rows, hidden: hiddenFor(cwd, direct, rows), ...(failed ? { error: failed } : {}) };
  }

  /** One server of the session's list, or a 404. */
  async function find(session, name) {
    const found = await list(session);
    if (!found.servers) throw httpError(409, 'Send this session a message first: its MCP servers are listed by its Claude Code process on its cluster.');
    const server = found.servers.find((entry) => entry.name === name);
    if (!server) throw httpError(404, 'This session has no MCP server with that name.');
    return { server, found };
  }

  function builtinRefusal(server, verb) {
    if (server.builtin) throw httpError(400, `${AGENT_SERVER} is Harbor’s own server. It is built in and cannot be ${verb}.`);
  }

  /**
   * Switches a server off or on for this session. The list is kept on the session (it
   * survives restarts of Claude Code and of this server) and applied to the live process
   * at once; a process started later gets it right after it starts, before its first
   * prompt (runner.startCli), so even its first request carries no tool of a server that is off.
   * @returns {{enabled: boolean, mcpDisabled: string[], live: boolean, projectEnabled: boolean}}
   */
  async function toggle(session, name, enabled) {
    if (typeof enabled !== 'boolean') throw httpError(400, 'Enabled must be true or false.');
    const current = disabledServers(session);
    // A name that is no longer listed can still be switched on again.
    const stale = enabled && current.includes(name);
    let server = null;
    if (!stale) {
      server = (await find(session, name)).server;
      builtinRefusal(server, 'switched off');
    }
    const next = enabled ? current.filter((entry) => entry !== name) : [...new Set([...current, name])];
    let cli = runner.pool.get(session.id);
    let projectEnabled = false;
    // Off in Claude Code's own settings for this folder (/mcp in a terminal): only its
    // own switch can bring it back, which is the one case where this writes to its config.
    if (enabled && server?.status === 'disabled') {
      try {
        cli = await runner.ensureCli(session);
        await cli.stream.toggleMcpServer(name, true);
        projectEnabled = true;
      } catch (error) {
        throw httpError(502, `Claude Code could not turn this server on: ${failureText(error, 'no reply')}`);
      }
    }
    const before = session.mcpDisabled;
    session.mcpDisabled = next;
    if (cli) {
      try {
        await runner.applyMcpDisabled(session);
      } catch (error) {
        session.mcpDisabled = before;
        throw httpError(502, `Claude Code could not apply this change: ${failureText(error, 'no reply')}`);
      }
    }
    if (!next.length) delete session.mcpDisabled;
    forget();
    return { enabled, mcpDisabled: next, live: Boolean(cli), projectEnabled };
  }

  /** Reads one server's row from the live process until it is no longer connecting. */
  async function connectedRow(cli, name, waitMs = CONNECT_WAIT_MS) {
    const rows = await settled(() => cli.stream.mcpServerStatus(), { timeoutMs: waitMs, stablePolls: 1, pollMs });
    return rows.find((row) => row.name === name);
  }

  /**
   * Retries a server's connection. With a live process that is Claude Code's reconnect;
   * without one a fresh listing is the retry (a new process connects from scratch).
   * `ok` says whether the server is connected afterwards.
   */
  async function reconnect(session, name) {
    const { server } = await find(session, name);
    builtinRefusal(server, 'reconnected');
    const cli = runner.pool.get(session.id);
    forget();
    if (!cli) {
      const { servers } = await list(session, { fresh: true });
      const again = servers.find((entry) => entry.name === name);
      if (!again) throw httpError(404, 'This session has no MCP server with that name.');
      return { ok: again.status === 'connected', live: false, server: again, ...(again.status === 'connected' ? {} : { error: again.error || statusMessage(again) }) };
    }
    return holding(cli, async () => {
      let error;
      try {
        await withTimeout(cli.stream.reconnectMcpServer(name), CONNECT_WAIT_MS * 3, 'The server did not answer in time.');
      } catch (failure) {
        // Claude Code says "Server status: needs-auth" when the retry ended unauthorized.
        error = failureText(failure, 'The connection failed.');
      }
      const row = await connectedRow(cli, name, 5000).catch(() => null);
      const publicRow = row ? publicServers([row], session)[0] : server;
      const ok = publicRow.status === 'connected';
      return { ok, live: true, server: publicRow, ...(ok ? {} : { error: publicRow.error || (publicRow.status === 'needs-auth' ? statusMessage(publicRow) : error) || statusMessage(publicRow) }) };
    });
  }

  function statusMessage(server) {
    if (server.status === 'needs-auth') return 'This server still needs you to sign in.';
    if (server.status === 'pending') return 'The server is still connecting.';
    if (server.status === 'disabled') return 'The server is switched off in Claude Code.';
    return 'The server did not connect.';
  }

  /** Other live processes pick up a server that was just signed in to (the token is shared). */
  function refreshOthers(name, exceptSessionId) {
    for (const cli of runner.pool.live()) {
      if (cli.sessionId === exceptSessionId) continue;
      void (async () => {
        const row = (await cli.stream.mcpServerStatus()).find((entry) => entry.name === name);
        if (row && (row.status === 'needs-auth' || row.status === 'failed')) await cli.stream.reconnectMcpServer(name);
      })().catch((error) => log(`Could not reconnect ${name} in session ${cli.sessionId}: ${error.message}`));
    }
  }

  /**
   * Starts a sign-in: the session's process is started if needed (no prompt) and asked
   * for the authorization address. For an OAuth server that process then stays up until
   * the pasted address arrives (submitCallback), the sign-in expires, or it is restarted.
   * @returns {Promise<{kind: 'claudeai'|'oauth', authUrl: string, instructions: string[], ...}>}
   */
  async function authenticate(session, name) {
    const cli = await runner.ensureCli(session).catch((error) => {
      throw httpError(502, `Claude Code could not be started: ${failureText(error, 'no reply')}`);
    });
    return holding(cli, () => startSignIn(session, name, cli));
  }

  async function startSignIn(session, name, cli) {
    const rows = await liveRows(cli).catch((error) => {
      throw httpError(502, `Claude Code did not answer: ${failureText(error, 'no reply')}`);
    });
    const row = rows.find((entry) => entry.name === name);
    if (!row) throw httpError(404, 'This session has no MCP server with that name.');
    const [server] = publicServers([row], session);
    builtinRefusal(server, 'signed in to');
    const kind = authKind(row);
    if (!kind) throw httpError(400, 'This server does not use a sign-in (it is a local command or Harbor’s own).');
    let response;
    try {
      response = await cli.stream.mcpAuthenticate(name);
    } catch (error) {
      throw httpError(502, `Claude Code could not start the sign-in: ${failureText(error, 'no reply')}`);
    }
    if (!response?.authUrl) {
      // Nothing for the user to do (a stored token was enough): Claude Code is reconnecting.
      forget();
      const connecting = await connectedRow(cli, name).catch(() => null);
      return { kind, authUrl: null, done: true, ...(connecting ? { server: publicServers([connecting], session)[0] } : {}) };
    }
    if (kind === 'claudeai') {
      return {
        kind,
        authUrl: response.authUrl,
        settingsUrl: CLAUDE_CONNECTORS_URL,
        instructions: [
          'Open the claude.ai link and connect this service there.',
          'Approve access in the service’s own window.',
          'Come back here and press Reconnect.',
        ],
      };
    }
    cli.signIn ??= new Map();
    cli.signIn.set(name, { state: response.state, startedAt: now(), port: response.callbackPort });
    cli.signInUntil = Date.now() + SIGN_IN_KEEP_ALIVE_MS;
    const port = response.callbackPort ? `:${response.callbackPort}` : '';
    return {
      kind,
      authUrl: response.authUrl,
      callbackPort: response.callbackPort,
      expiresInSeconds: SIGN_IN_FLOW_MS / 1000,
      instructions: [
        'Open the link and approve access.',
        `Your browser then goes to http://localhost${port}/callback?code=…, a port on the machine that runs Harbor. If that page fails to load, it is expected.`,
        'Copy the whole address from the address bar and paste it below. If the page says you are signed in, nothing more is needed.',
      ],
    };
  }

  /**
   * Finishes an OAuth sign-in with the address the user copied from their browser. The
   * session's process that started the sign-in exchanges the code and stores the token.
   * @returns {Promise<{ok: boolean, server: object, error?: string}>}
   */
  async function submitCallback(session, name, pasted) {
    const parsed = parseCallbackUrl(pasted);
    if (!parsed.ok) throw httpError(400, parsed.error);
    const cli = runner.pool.get(session.id);
    const pending = cli?.signIn?.get(name);
    if (!cli || !pending) {
      throw httpError(409, 'No sign-in is waiting for this server. It may have expired, or Claude Code restarted in the meantime. Start the sign-in again.');
    }
    if (parsed.error && !parsed.code) {
      throw httpError(400, `The service did not approve the sign-in (${scrubError(parsed.error)}). Start again and approve access.`);
    }
    if (pending.state && parsed.state && parsed.state !== pending.state) {
      throw httpError(400, 'That address belongs to an earlier sign-in attempt. Start the sign-in again and use the newest link.');
    }
    return holding(cli, () => exchangeCallback(session, name, cli, parsed));
  }

  async function exchangeCallback(session, name, cli, parsed) {
    try {
      await withTimeout(cli.stream.mcpSubmitOAuthCallbackUrl(name, parsed.url), CALLBACK_TIMEOUT_MS, 'The service did not answer in time.');
    } catch (error) {
      const message = failureText(error, 'The sign-in failed.');
      if (/No active OAuth flow/i.test(message)) {
        cli.signIn.delete(name);
        throw httpError(409, 'The sign-in expired. Start it again.');
      }
      if (/not accepted|Invalid callback/i.test(message)) throw httpError(400, message);
      throw httpError(502, `The sign-in did not finish: ${message}`);
    }
    cli.signIn.delete(name);
    if (!cli.signIn.size) cli.signInUntil = 0;
    forget();
    // The token is stored now, but Claude Code leaves the server as it was (needs-auth, measured
    // against 2.1.290 with a local OAuth server) until it is asked to connect again.
    let row = await connectedRow(cli, name, 3000).catch(() => null);
    let failure;
    if (row?.status !== 'connected') {
      try {
        await withTimeout(cli.stream.reconnectMcpServer(name), CONNECT_WAIT_MS * 3, 'The server did not answer in time.');
      } catch (error) {
        failure = failureText(error, 'The connection failed.');
      }
      row = await connectedRow(cli, name, 5000).catch(() => row);
    }
    if (row?.status === 'connected') refreshOthers(name, session.id);
    const server = row ? publicServers([row], session)[0] : null;
    const ok = server?.status === 'connected';
    return { ok, server, ...(ok ? {} : { error: server?.error || (failure && !/needs-auth/.test(failure) ? failure : null) || 'The sign-in finished, but the server did not connect. Try Reconnect.' }) };
  }

  /** Signs out of an OAuth server: Claude Code revokes and forgets the token (shared by every session). */
  async function clearAuth(session, name) {
    const cli = await runner.ensureCli(session).catch((error) => {
      throw httpError(502, `Claude Code could not be started: ${failureText(error, 'no reply')}`);
    });
    return holding(cli, async () => {
      const rows = await liveRows(cli).catch((error) => {
        throw httpError(502, `Claude Code did not answer: ${failureText(error, 'no reply')}`);
      });
      const row = rows.find((entry) => entry.name === name);
      if (!row) throw httpError(404, 'This session has no MCP server with that name.');
      builtinRefusal(publicServers([row], session)[0], 'signed out of');
      const kind = authKind(row);
      if (kind === 'claudeai') throw httpError(400, 'This connector is signed in on claude.ai. Disconnect it there.');
      if (!kind) throw httpError(400, 'This server does not use a sign-in.');
      try {
        await cli.stream.mcpClearAuth(name);
      } catch (error) {
        throw httpError(502, `Claude Code could not sign out: ${failureText(error, 'no reply')}`);
      }
      cli.signIn?.delete(name);
      forget();
      const after = await connectedRow(cli, name, 3000).catch(() => null);
      return { ok: true, server: after ? publicServers([after], session)[0] : null };
    });
  }

  return { list, listProject, toggle, reconnect, authenticate, submitCallback, clearAuth, forget };
}
