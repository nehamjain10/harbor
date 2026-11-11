// MCP servers: the last list fetched for a session (or a project folder), the sign-ins
// waiting for the address the user pastes, and the actions behind the MCP panel
// (components/McpPanel.jsx) and the topbar chip. The state is `mcp` in the store, keyed
// by session id or, for a project folder, `project:<route>:` and its folder key
// (lib/clusters.js: the cluster first for a remote one):
//   { servers: rows|null, hidden: [{name, reason}], live, route, at, error, loading, busy: {name: action},
//     notes: {name: {tone, text}}, signIn: {name: {kind, authUrl, ...}}, notice }
import { api } from './api.js';
import { toast } from './actions.js';
import { store } from './state.js';
import { clusterQuery, folderClusterId, folderKey } from './lib/clusters.js';
import { displayName } from './lib/mcp.js';

const get = () => store.get();
const encoded = encodeURIComponent;

const EMPTY = { servers: null, hidden: [], live: false, route: null, at: 0, error: null, loading: false, busy: {}, notes: {}, signIn: {}, notice: null };

// Late responses of an older request for the same key are dropped.
const versions = new Map();

// A project folder's servers are the ones on its cluster, so the key (and the request)
// names the cluster; a session's are its own.
export const projectKey = (cwd, route, cluster) => `project:${route}:${folderKey(cluster, cwd)}`;
export const entryFor = (state, key) => state.mcp?.[key] || EMPTY;

function patch(key, update) {
  const { mcp } = get();
  const entry = { ...EMPTY, ...mcp[key] };
  store.set({ mcp: { ...mcp, [key]: { ...entry, ...(typeof update === 'function' ? update(entry) : update) } } });
}

// One name of a per-server map set (`busy`, `notes`, `signIn`); `undefined` clears it.
function setField(key, field, name, value) {
  patch(key, (entry) => {
    const next = { ...entry[field] };
    if (value === undefined) delete next[name];
    else next[name] = value;
    return { [field]: next };
  });
}

const replaceRow = (key, server) =>
  server && patch(key, (entry) => ({ servers: entry.servers?.map((row) => (row.name === server.name ? server : row)) ?? entry.servers }));

const errorNote = (error) => ({ tone: 'error', text: error?.message || String(error) });

/** Fetches the list for a session, or a project folder (`{cwd, route, cluster}`) without one. `cached` never starts a process. */
export async function loadMcp(target, { fresh = false, cached = false } = {}) {
  const cluster = target.sessionId ? null : target.cluster || folderClusterId(get());
  const key = target.sessionId || projectKey(target.cwd, target.route, cluster);
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  if (!cached) patch(key, { loading: true, error: null });
  const route = target.sessionId
    ? `sessions/${encoded(target.sessionId)}/mcp${cached ? '?cached=1' : fresh ? '?fresh=1' : ''}`
    : `mcp?cwd=${encoded(target.cwd || '')}&route=${target.route === 'gateway' ? 'gateway' : 'claude'}${clusterQuery(cluster)}`;
  try {
    const data = await api.get(route, { timeout: 45_000 });
    if (versions.get(key) !== version) return;
    if (!data?.servers) patch(key, { loading: false });
    else {
      patch(key, (entry) => ({ servers: data.servers, hidden: data.hidden || [], live: Boolean(data.live), route: data.route, at: data.at || Date.now(), error: data.error || null, loading: false, ...finishedSignIns(entry, data.servers) }));
    }
  } catch (error) {
    if (versions.get(key) === version && !cached) patch(key, { loading: false, error: error.message });
  }
}

// A sign-in finished in the browser on the machine that runs Harbor connects without
// the paste step: its row turns connected, and the waiting steps give way to a note.
function finishedSignIns(entry, servers) {
  const done = Object.keys(entry.signIn).filter((name) => servers.find((row) => row.name === name)?.status === 'connected');
  if (!done.length) return {};
  const signIn = { ...entry.signIn };
  const notes = { ...entry.notes };
  for (const name of done) {
    delete signIn[name];
    notes[name] = { tone: 'ok', text: 'Signed in and connected.' };
  }
  return { signIn, notes };
}

/** Makes the rows follow the session's own list of switched-off servers (it changed in another tab). */
export function syncDisabled(key, list) {
  const entry = get().mcp[key];
  const off = new Set(list || []);
  if (!entry?.servers || entry.servers.every((row) => row.builtin || Boolean(row.disabledInSession) === off.has(row.name))) return;
  patch(key, { servers: entry.servers.map((row) => (row.builtin ? row : { ...row, disabledInSession: off.has(row.name) })) });
}

// Runs one server action: marks the row busy meanwhile and clears its old note.
async function act(key, name, action, run) {
  patch(key, (entry) => ({ busy: { ...entry.busy, [name]: action }, notes: withoutKey(entry.notes, name) }));
  try {
    await run();
  } catch (error) {
    setField(key, 'notes', name, errorNote(error));
  } finally {
    patch(key, (entry) => ({ busy: withoutKey(entry.busy, name) }));
  }
}

function withoutKey(object, name) {
  const next = { ...object };
  delete next[name];
  return next;
}

const serverPath = (sessionId, name, tail) => `sessions/${encoded(sessionId)}/mcp/${encoded(name)}/${tail}`;

/** Switches a server on or off for this session (it takes effect at once in a running process). */
export function setServerEnabled(sessionId, name, enabled) {
  return act(sessionId, name, 'toggle', async () => {
    const result = await api.post(serverPath(sessionId, name, 'toggle'), { enabled }, { timeout: 60_000 });
    const off = new Set(result.mcpDisabled || []);
    patch(sessionId, (entry) => ({
      servers: entry.servers?.map((row) => (row.builtin ? row : { ...row, disabledInSession: off.has(row.name), ...(result.projectEnabled && row.name === name ? { status: 'connected' } : {}) })) ?? entry.servers,
      // The tool list changed, so the model's cached prompt prefix is stale once.
      notice: result.live ? 'Claude’s tool list changed. The next message re-reads the conversation once, so it can take a little longer.' : null,
    }));
    // The one switch that is not per session: Claude Code had it off for the whole project.
    if (result.projectEnabled) setField(sessionId, 'notes', name, { tone: 'info', text: 'It was switched off in Claude Code for this project, so that setting is now on again for the project (the terminal too).' });
  });
}

/** Retries a server's connection. */
export function reconnectServer(sessionId, name) {
  return act(sessionId, name, 'reconnect', async () => {
    const result = await api.post(serverPath(sessionId, name, 'reconnect'), {}, { timeout: 75_000 });
    replaceRow(sessionId, result.server);
    if (result.ok) {
      setField(sessionId, 'signIn', name, undefined);
      setField(sessionId, 'notes', name, { tone: 'ok', text: 'Connected.' });
    } else setField(sessionId, 'notes', name, { tone: 'error', text: result.error || 'It did not connect.' });
  });
}

/** Starts a sign-in: a claude.ai link, or the authorization link plus the paste step. */
export function startSignIn(sessionId, name) {
  return act(sessionId, name, 'auth', async () => {
    const result = await api.post(serverPath(sessionId, name, 'auth'), {}, { timeout: 75_000 });
    if (result.done || !result.authUrl) {
      replaceRow(sessionId, result.server);
      setField(sessionId, 'notes', name, { tone: 'ok', text: result.server?.status === 'connected' ? 'Connected.' : 'Claude Code is reconnecting. Refresh in a moment.' });
      return;
    }
    setField(sessionId, 'signIn', name, {
      kind: result.kind,
      authUrl: result.authUrl,
      settingsUrl: result.settingsUrl || null,
      instructions: result.instructions || [],
      callbackPort: result.callbackPort || null,
      startedAt: Date.now(),
      expiresAt: result.expiresInSeconds ? Date.now() + result.expiresInSeconds * 1000 : null,
    });
  });
}

/** Forgets the waiting sign-in in the panel (the server's process drops it when it expires). */
export function cancelSignIn(sessionId, name) {
  setField(sessionId, 'signIn', name, undefined);
  setField(sessionId, 'notes', name, undefined);
}

/** Finishes an OAuth sign-in with the address copied from the browser. */
export function finishSignIn(sessionId, name, pasted) {
  return act(sessionId, name, 'callback', async () => {
    let result;
    try {
      result = await api.post(serverPath(sessionId, name, 'auth/callback'), { url: pasted }, { timeout: 90_000 });
    } catch (error) {
      // A wrong address can be pasted again; an expired sign-in has to be started again.
      if (error.status === 409) setField(sessionId, 'signIn', name, undefined);
      throw error;
    }
    replaceRow(sessionId, result.server);
    setField(sessionId, 'signIn', name, undefined);
    if (result.ok) {
      setField(sessionId, 'notes', name, { tone: 'ok', text: 'Signed in and connected.' });
      toast(`${displayName(result.server).title} is connected.`);
    } else setField(sessionId, 'notes', name, { tone: 'error', text: result.error || 'The sign-in finished, but the server did not connect.' });
  });
}

/** Signs out of an OAuth server (the token is shared by every session on this machine). */
export function signOutServer(sessionId, name) {
  return act(sessionId, name, 'clear', async () => {
    const result = await api.post(serverPath(sessionId, name, 'auth/clear'), {}, { timeout: 60_000 });
    replaceRow(sessionId, result.server);
    setField(sessionId, 'notes', name, { tone: 'ok', text: 'Signed out.' });
  });
}

/** Drops what the panel held about a session (it was deleted, or its process restarted). */
export function forgetMcp(key) {
  const { mcp } = get();
  if (!(key in mcp)) return;
  const next = { ...mcp };
  delete next[key];
  store.set({ mcp: next });
}
