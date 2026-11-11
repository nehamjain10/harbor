// Everything that changes app state or talks to the server lives here; components
// call these and read state through useAppState().
import { api } from './api.js';
import { store } from './state.js';
import {
  applyDelta,
  applyDeltaToList,
  applyFetchedSession,
  applyLiveEvent,
  applyOlderMessages,
  applyOptimistic,
  applySessionEvent,
  createSessionCache,
  heldFrom,
  patchFields,
  restorePending,
  undoOptimistic,
  updateSession,
  withoutPending,
} from './store.js';
import { createSync } from './sync.js';
import { saveTheme } from './theme.js';
import { clearSentAttachments, clearSentDrafts, moveNewAttachments, moveNewDraft, storeForkDraft } from './lib/drafts.js';
import { KEYS, getItem, getJSON, removeItem, setItem, setJSON } from './lib/storage.js';
import { canonicalMode, isV2Info, wireMode } from './lib/modes.js';
import { clusterFields, clusterFolder, clusterList, findCluster, isRemote } from './lib/clusters.js';
import { IMPORT_BATCH_SIZE, chunk } from './lib/imports.js';
import { findModel, isOpenRouterId } from './lib/models.js';
import { isBusy, upsertSession } from './lib/sessions.js';
import { shouldMarkViewed } from './lib/notify.js';
import { AGENT_ID, agentPath, agentUrl, parseAgentUrl, samePath } from './lib/agentTranscript.js';
import { TAIL_MESSAGES, olderRoute, sessionRoute } from './lib/tail.js';

// Bumped whenever the visible session changes, so late responses are dropped.
let viewVersion = 0;
let sync = null;
// Touch screens (phones) have no hover to load ahead with, and less memory to hold with.
const touchScreen = () => Boolean(globalThis.matchMedia?.('(hover: none)').matches);
// Sessions opened or loaded ahead: switching to one paints from here at once while the
// server confirms it is current.
const sessionCache = createSessionCache(touchScreen() ? { entries: 12, messages: 6000 } : undefined);
let toastTimer = null;

const get = () => store.get();
const set = (patch) => store.set(patch);

const draftStorage = { getItem, setItem, removeItem };

const isMobile = () => globalThis.matchMedia?.('(max-width: 759px)').matches;

// The page URL names the open session and the agent shown (lib/agentTranscript.js). The
// history entry keeps its agent views (see pushAgentUrl) while it shows the same session.
function setUrl(sessionId, agents = []) {
  try {
    const views = history.state?.agentViews;
    history.replaceState(views?.session === sessionId ? history.state : null, '', agentUrl(sessionId, agents));
  } catch {
    // ignore (e.g. sandboxed previews)
  }
}

/* Toasts */

export function toast(text, undo) {
  clearTimeout(toastTimer);
  const id = Date.now() + Math.random();
  set({ toast: { id, text, undo } });
  toastTimer = setTimeout(() => {
    if (get().toast?.id === id) set({ toast: null });
  }, undo ? 10_000 : 4500);
}

export function dismissToast() {
  clearTimeout(toastTimer);
  set({ toast: null });
}

const fail = (error) => toast(error?.message || 'Something went wrong.');

/* Boot */

export async function init() {
  const efforts = getJSON(KEYS.efforts, {});
  const savedMode = getItem(KEYS.mode);
  set({
    efforts: efforts && typeof efforts === 'object' ? efforts : {},
    mode: savedMode ? canonicalMode(savedMode) : 'bypassPermissions',
    sidebarCollapsed: getItem(KEYS.sidebar) === 'collapsed',
  });
  try {
    const info = await api.get('info');
    const savedModel = getItem(KEYS.model);
    set({
      info,
      isV2: isV2Info(info),
      ...clusterState(info, get()),
      model: info.models?.some((m) => m.id === savedModel) || isOpenRouterId(savedModel) ? savedModel : info.models?.[0]?.id || 'opus',
      project: getItem(KEYS.project) || info.defaultProject || info.root || '',
    });
    const sessions = await api.get('sessions');
    set({ sessions: Array.isArray(sessions) ? sessions : [], sessionsLoaded: true });
    const fromUrl = parseAgentUrl(location.search);
    const requested = fromUrl.session || getItem(KEYS.session);
    if (requested && get().sessions.some((s) => s.id === requested)) {
      await selectSession(requested);
      // A reload with an agent open opens it again.
      if (fromUrl.session === requested && fromUrl.agents.length && get().current?.id === requested) showAgent(fromUrl.agents, 'replace');
    } else setUrl(null);
    set({ booting: false });
    setTimeout(() => warmUp().catch(() => {}), 1500);
  } catch (error) {
    set({ booting: false, bootError: error.message, connection: 'offline' });
    fail(error);
  }
  startSync();
  globalThis.addEventListener('popstate', onPopState);
}

function startSync() {
  sync?.stop();
  sync = createSync({
    onStatus: (connection) => set({ connection }),
    onReady: () => {
      // Events may have been missed while disconnected. Cached copies stay: opening one
      // asks the server whether its revision is still current, and a delta that does not
      // fit a copy drops it.
      reloadAll().catch(fail);
    },
    onSession: (session) => {
      sessionCache.update(session);
      store.set((state) => applySessionEvent(state, session));
    },
    onLive: (event) => store.set((state) => applyLiveEvent(state, event)),
    onDelta: applyDeltaEvent,
    onInfo: () => loadInfo().catch(() => {}),
    onDeleted: dropSessions,
    poll: reloadAll,
  });
  sync.start();
  const resume = () => {
    if (document.visibilityState !== 'hidden') sync?.resume();
  };
  document.addEventListener('visibilitychange', resume);
  globalThis.addEventListener('online', resume);
}

/* Deltas (see server/events.mjs) */

// Session id -> {fetches, deltas}: while a full copy of a session is on its way, its
// deltas wait here and are replayed on that copy once it is shown.
const loads = new Map();

// The session's tail (its recent messages, lib/tail.js); older ones load on demand
// (loadOlderMessages). `rev`: the revision of a copy already held. While it is current
// the server answers {unchanged: true} instead of sending it again.
async function fetchSession(id, rev) {
  const load = loads.get(id) || { fetches: 0, deltas: [] };
  load.fetches += 1;
  loads.set(id, load);
  return api.get(sessionRoute(id, { rev }));
}

// Call after the fetched copy was applied (or the fetch failed).
function fetchDone(id) {
  const load = loads.get(id);
  if (!load || --load.fetches > 0) return;
  loads.delete(id);
  for (const delta of load.deltas) applyDeltaEvent(delta);
}

let listReload = null;

// The list, refetched when a delta names a session it does not have.
function reloadList() {
  listReload ??= api
    .get('sessions')
    .then((sessions) => set({ sessions: Array.isArray(sessions) ? sessions : [], sessionsLoaded: true }))
    .catch(() => {})
    .finally(() => {
      listReload = null;
    });
}

// A delta updates the list entry, a cached copy and the open session. A copy at another
// revision cannot take it: the open session is fetched again (the delta waits for it).
function applyDeltaEvent(delta) {
  const sessions = applyDeltaToList(get().sessions, delta);
  if (sessions) set({ sessions });
  else reloadList();
  sessionCache.applyDelta(delta);
  const load = loads.get(delta.id);
  if (load) {
    load.deltas.push(delta);
    return;
  }
  const current = get().current;
  if (current?.id !== delta.id || (current.rev != null && delta.rev <= current.rev)) return;
  const next = applyDelta(current, delta);
  if (next) set({ current: next });
  else refreshCurrent().catch(() => {});
}

async function loadInfo() {
  const info = await api.get('info');
  const state = get();
  const next = clusterState(info, state);
  // The chosen remote cluster went away (a deploy): the new chat is local again, and its
  // folder is the local one rather than the remote path it held.
  const lost = next.cluster !== state.cluster;
  set({
    info,
    isV2: isV2Info(info),
    ...next,
    bootError: null,
    project: (!lost && state.project) || getItem(KEYS.project) || info.defaultProject || info.root || '',
  });
}

// After a reconnect too: a deploy may have changed the catalog.
async function reloadAll() {
  await loadInfo();
  const sessions = await api.get('sessions');
  set({ sessions: Array.isArray(sessions) ? sessions : [], sessionsLoaded: true });
  await refreshCurrent();
}

/* Sessions */

// A session opened before is shown from the cache at once and then refreshed (over
// Tailscale a long session takes a noticeable while to arrive); others show when loaded.
export async function selectSession(id) {
  const version = ++viewVersion;
  clearTimeout(hoverTimer);
  sessionCache.put(get().current);
  const cached = sessionCache.get(id);
  if (cached) showSession(cached);
  else set({ loadingSessionId: id, drawerOpen: false });
  try {
    const session = await (takePrefetch(id) || fetchSession(id, cached?.rev));
    if (version !== viewVersion) return;
    if (session.unchanged) {
      // The copy shown is current.
    } else if (cached) store.set((state) => applyFetchedSession(state, session));
    else showSession(session);
    sessionCache.put(get().current);
    markViewed();
  } catch (error) {
    if (error?.status === 404) sessionCache.delete(id);
    if (version !== viewVersion) return;
    set({ loadingSessionId: null });
    fail(error);
  } finally {
    fetchDone(id);
  }
}

// Sessions not in memory start loading before they are opened: when the pointer rests on
// a row, when it presses one (the click follows some 100 ms later), and in the background
// after the page loads (warmUp). A load nobody opened goes into the cache, so opening the
// session later paints at once. One load per session at a time.
const prefetches = new Map(); // id -> { promise, taken }
const HOVER_PREFETCH_MS = 100;
let hoverTimer = null;

export function prefetchSession(id) {
  // Not when it is open, in memory or on its way already (a load of any kind).
  if (!id || prefetches.has(id) || loads.has(id) || get().current?.id === id || sessionCache.has(id)) return null;
  const entry = { promise: fetchSession(id), taken: false };
  prefetches.set(id, entry);
  entry.promise
    .then(
      (session) => {
        if (!entry.taken) sessionCache.put(session);
      },
      () => {},
    )
    .finally(() => {
      if (prefetches.get(id) === entry) prefetches.delete(id);
      // A taken load is finished by selectSession; this one replays its deltas on the cached copy.
      if (!entry.taken) fetchDone(id);
    });
  return entry.promise;
}

function takePrefetch(id) {
  const entry = prefetches.get(id);
  if (!entry) return null;
  entry.taken = true;
  prefetches.delete(id);
  return entry.promise;
}

// The pointer rests on a session row (not just passing over the list).
export function hoverSession(id) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => prefetchSession(id), HOVER_PREFETCH_MS);
}

export function leaveSession() {
  clearTimeout(hoverTimer);
}

// After the page loads, the most recent sessions are loaded one at a time while the page
// is idle, so even the first switch to one paints at once. On touch screens only a few
// short ones (data plans, memory).
const WARM_SESSIONS = 12;
const WARM_TOUCH = { sessions: 4, messages: 800 };

const whenIdle = () =>
  new Promise((resolve) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(() => resolve(), { timeout: 2000 }) : setTimeout(resolve, 200)));

async function warmUp() {
  if (getItem(KEYS.warmUp) === '0') return;
  const touch = touchScreen();
  const picks = get()
    .sessions.filter((s) => !s.removed && !s.archived && (!touch || (s.messageCount ?? Infinity) <= WARM_TOUCH.messages))
    .slice(0, touch ? WARM_TOUCH.sessions : WARM_SESSIONS);
  for (const { id } of picks) {
    await whenIdle();
    if (get().connection === 'offline') return;
    await prefetchSession(id)?.catch(() => {});
  }
}

function showSession(session) {
  const { panel, sessions, agent, current } = get();
  const same = current?.id === session.id;
  set({
    current: session,
    loadingSessionId: null,
    drawerOpen: false,
    sessions: upsertSession(sessions, session),
    panel: { ...panel, filePath: '', fileLine: null },
    // An agent shown stays with its session.
    agent: agent.sessionId === session.id ? agent : { ...agent, sessionId: session.id, path: [] },
    ...(same ? {} : { agentFiles: {} }),
    // Show the session in the list it belongs to.
    filter: session.removed ? 'trash' : session.archived ? 'archived' : 'active',
    scrollNonce: get().scrollNonce + 1,
  });
  setUrl(session.id, get().agent.path);
  setItem(KEYS.session, session.id);
  markViewed(session);
}

// `fresh`: send the copy again even when the server thinks it is current (the copy's
// window no longer lines up with the list, see loadOlderMessages).
export async function refreshCurrent({ fresh = false } = {}) {
  const current = get().current;
  if (!current) return;
  const version = viewVersion;
  try {
    const session = await fetchSession(current.id, fresh ? null : current.rev);
    if (version !== viewVersion || session.unchanged) return;
    store.set((state) => applyFetchedSession(state, session));
  } finally {
    fetchDone(current.id);
  }
}

export function newSession() {
  viewVersion += 1;
  sessionCache.put(get().current);
  const { panel } = get();
  set({
    current: null,
    loadingSessionId: null,
    filter: 'active',
    drawerOpen: false,
    panel: { ...panel, open: false, filePath: '', fileLine: null },
    agent: { ...get().agent, sessionId: null, path: [] },
    agentFiles: {},
    focusNonce: get().focusNonce + 1,
  });
  setUrl(null);
  removeItem(KEYS.session);
}

// Session id → the turnEndedAt already reported as viewed, so each finished turn is
// PATCHed once even before the server's echo arrives.
const viewedMarks = new Map();

// Tells the server the user has seen the session's latest turn, which clears its
// unread dot on every device. Only while the page is visible.
export function markViewed(session = get().current) {
  if (!session || !get().isV2 || document.visibilityState === 'hidden') return;
  if (!shouldMarkViewed(session, viewedMarks)) return;
  viewedMarks.set(session.id, session.turnEndedAt);
  const rollback = showPatch(session.id, { viewed: true });
  api.patch('sessions/' + encodeURIComponent(session.id), { viewed: true })
    .then((next) => store.set((state) => applySessionEvent(state, next)))
    .catch(() => {
      rollback();
      viewedMarks.delete(session.id);
    });
}

// Shows what a PATCH will change right away (the round trip to the server is 100+ ms
// over Tailscale) and returns the function that takes it back if the PATCH fails.
function showPatch(id, patch) {
  const state = get();
  const session = state.current?.id === id ? state.current : state.sessions.find((s) => s.id === id);
  if (!session) return () => {};
  const fields = patchFields(session, patch);
  if (!Object.keys(fields).length) return () => {};
  const before = Object.fromEntries(Object.keys(fields).map((key) => [key, session[key]]));
  store.set((s) => applyOptimistic(s, id, fields));
  return () => store.set((s) => undoOptimistic(s, id, fields, before));
}

export async function patchSession(id, patch) {
  const rollback = showPatch(id, patch);
  let session;
  try {
    session = await api.patch('sessions/' + encodeURIComponent(id), patch);
  } catch (error) {
    rollback();
    throw error;
  }
  store.set((state) => ({
    sessions: upsertSession(state.sessions, session),
    // The response is the list form (a patch never changes the messages).
    ...(state.current?.id === id ? { current: updateSession(state.current, session) } : null),
  }));
  return session;
}

/** Sessions deleted for good leave the list; the open one gives way to a new chat. */
function dropSessions(ids) {
  const gone = new Set(ids);
  store.set((state) => ({ sessions: state.sessions.filter((s) => !gone.has(s.id)) }));
  if (gone.has(get().current?.id) || gone.has(get().loadingSessionId)) newSession();
}

/** Deletes every session in Trash for good. Resolves how many were deleted and kept. */
export async function emptyTrash() {
  const { deleted = [], kept = 0 } = await api.post('trash/empty', {});
  dropSessions(deleted);
  return { deleted: deleted.length, kept };
}

export async function renameSession(id, title) {
  await patchSession(id, { title });
}

export async function toggleArchived(id) {
  const session = get().sessions.find((s) => s.id === id);
  if (!session) return;
  const archived = !session.archived;
  // The row leaves the list at once (optimistic), so the view does too.
  if (archived && get().current?.id === id) newSession();
  try {
    const next = await patchSession(id, { archived });
    toast(next.archived ? 'Chat archived.' : 'Chat restored.', () => patchSession(id, { archived: !next.archived }));
  } catch (error) {
    fail(error);
  }
}

export async function toggleRemoved(id) {
  const session = get().sessions.find((s) => s.id === id);
  if (!session) return;
  const removed = !session.removed;
  if (removed && get().current?.id === id) newSession();
  try {
    const next = await patchSession(id, { removed });
    toast(next.removed ? 'Chat moved to Trash.' : 'Chat restored.', () => patchSession(id, { removed: !next.removed }));
  } catch (error) {
    fail(error);
  }
}

export async function togglePinned(id) {
  const session = get().sessions.find((s) => s.id === id);
  if (!session) return;
  try {
    await patchSession(id, { pinned: !session.pinned });
  } catch (error) {
    fail(error);
  }
}

// Copies text to the clipboard and reports a failure with a toast. Returns whether
// the copy worked.
export async function copyText(text, failure = 'Copy failed. Select the text to copy it.') {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast(failure);
    return false;
  }
}

export async function copySessionLink(id) {
  const url = location.origin + '/?session=' + encodeURIComponent(id);
  if (await copyText(url, 'Could not copy the link.')) toast('Link copied. Continue on your other device.');
}

/* Fork */

let forking = false;

// Copies a session's conversation into a new session and opens it; the original is
// untouched. With `messageId` the copy keeps what came before that user message, and the
// message (text and attachments) goes into the new session's composer to edit and send.
export async function forkSession(id, { messageId } = {}) {
  if (forking) return;
  forking = true;
  try {
    const { session, draft } = await api.post(`sessions/${encodeURIComponent(id)}/fork?tail=${TAIL_MESSAGES}`, messageId ? { messageId } : {}, { timeout: 60_000 });
    store.set((state) => ({ sessions: upsertSession(state.sessions, session) }));
    // The composer reads its draft when a session opens, so the draft goes in first.
    storeForkDraft(draftStorage, session.id, draft);
    sessionCache.put(session);
    selectSession(session.id);
    set({ focusNonce: get().focusNonce + 1 });
    toast(draft ? 'Forked. Edit your message and send it.' : 'Forked into a new session.');
  } catch (error) {
    fail(error);
  } finally {
    forking = false;
  }
}

/* Rewind */

// What rewinding the session to before `messageId` would do to the files Claude edited
// since: {canRewind, error?, filesChanged?, insertions?, deletions?}.
export async function previewRewind(id, messageId) {
  const { files } = await api.post(`sessions/${encodeURIComponent(id)}/rewind`, { messageId, dryRun: true }, { timeout: 60_000 });
  return files;
}

// Rewinds the session in place to before `messageId`, with `code` also the files; resolves
// {draft} (the message's text and attachments, for the composer).
export async function rewindSession(id, messageId, { code = false } = {}) {
  return api.post(`sessions/${encodeURIComponent(id)}/rewind`, { messageId, code }, { timeout: 60_000 });
}

/* Sending */

// crypto.randomUUID needs a secure context; the fallback is unique enough for de-duplicating sends.
function newClientId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The settings a new chat is created with (POST sessions, and the same body goes to
// sessions/prepare): folder, model, mode and effort, plus the cluster when the agent
// runs on another server.
function newChatBody({ project, model, mode, effort }, cluster) {
  const body = { cwd: project, model, mode, effort, ...clusterFields(cluster) };
  // No folder yet: the server picks its default.
  if (!body.cwd) delete body.cwd;
  return body;
}

// Sends `text` (and uploaded `attachments`) to the open session, creating one first
// when needed. The clientId is kept in localStorage until the server confirms, so a
// retry after a dropped response is not delivered twice. Drafts follow the text: a
// send from the new-session view moves it (and its attachments) to the new session's
// draft as soon as that session exists, and the drafts are cleared only once the
// server accepts the message. Returns { ok, sessionId, created }; a failed send that
// still created a session reports it too.
/**
 * Sends a message. While a turn runs, a plain message goes to Claude right away (it reads
 * it at its next step); `queue: true` keeps it for after the turn instead. Attachments
 * and slash commands always wait for the turn to end (the server decides).
 */
// Sends go out one at a time, in the order they were made: one sent while another is
// on its way waits for it (and shows as "Sending…" meanwhile, see QueueBar).
let sendChain = Promise.resolve();
let outgoingSeq = 0;

export function sendMessage(rawText, { attachments = [], queue = false } = {}) {
  const ids = attachments.map((a) => a.id);
  if (!rawText.trim() && !ids.length) return Promise.resolve({ ok: false });
  const item = { key: ++outgoingSeq, id: null, sessionId: get().current?.id ?? null, version: viewVersion, text: rawText.trim() || `${ids.length} ${ids.length === 1 ? 'file' : 'files'}`, queue };
  set({ outgoing: [...get().outgoing, item], sending: true, scrollNonce: get().scrollNonce + 1 });
  const run = sendChain.then(() => sendNow(rawText, { attachments, queue }, item));
  sendChain = run.catch(() => {});
  return run.finally(() => {
    const outgoing = get().outgoing.filter((o) => o.key !== item.key);
    set({ outgoing, sending: outgoing.length > 0 });
  });
}

// Replaces the outgoing entry `key` (its clientId and session are known once it is sent).
function updateOutgoing(key, fields) {
  set({ outgoing: get().outgoing.map((o) => (o.key === key ? { ...o, ...fields } : o)) });
}

async function sendNow(rawText, { attachments, queue }, item) {
  const ids = attachments.map((a) => a.id);
  const typed = rawText.trim();
  // An attachment-only message is sent with empty text (the server lists the files).
  const text = typed;
  // It goes where it was written, even if another session is open by now. One written
  // in the new-session view goes to the session a send just before it created (still
  // open), else to a new one.
  const version = item.version;
  const { isV2, model, mode, efforts, project } = get();
  const cluster = findCluster(get().clusters, get().cluster);
  let target = item.sessionId ? { id: item.sessionId } : version === viewVersion ? get().current : null;
  const created = !target;
  try {
    if (created) {
      const settings = newChatBody({ project, model, mode: wireMode(mode, isV2), effort: efforts[model] || 'default' }, cluster);
      target = await api.post('sessions', { ...settings, prepareId: await preparedFor(settings) });
      if (typed) moveNewDraft(draftStorage, target.id, typed);
      moveNewAttachments(draftStorage, target.id, attachments);
      store.set((state) => ({ sessions: upsertSession(state.sessions, target) }));
      if (version === viewVersion) {
        set({ current: target });
        setUrl(target.id);
        setItem(KEYS.session, target.id);
      }
    }
    const id = target.id;
    const pendingKey = KEYS.pendingSend(id);
    let pending = getJSON(pendingKey, null);
    if (!pending || pending.text !== text || String(pending.attachments || '') !== String(ids)) {
      pending = { text, id: newClientId(), attachments: ids };
      setJSON(pendingKey, pending);
    }
    const body = { text, clientId: pending.id };
    if (ids.length) body.attachments = ids;
    if (queue) body.queue = true;
    // Shown above the composer until the server's copy (with this clientId) arrives.
    updateOutgoing(item.key, { id: pending.id, sessionId: id });
    await api.post(`sessions/${encodeURIComponent(id)}/messages`, body);
    removeItem(pendingKey);
    if (typed) clearSentDrafts(draftStorage, id, typed, { created });
    clearSentAttachments(draftStorage, id, ids, { created });
    // The server published the message before answering, so a live event stream has
    // it already; otherwise (polling, reconnecting) fetch the session.
    if (version === viewVersion && get().current?.id === id) {
      if (get().connection !== 'live') await refreshCurrent().catch(() => {});
      set({ scrollNonce: get().scrollNonce + 1 });
    }
    return { ok: true, sessionId: id, created };
  } catch (error) {
    fail(error);
    return created && target ? { ok: false, sessionId: target.id, created } : { ok: false };
  }
}

export async function stopSession() {
  const current = get().current;
  if (!current) return;
  // Shown as "Stopping…" until the turn ends (see isStopping in store.js): the server
  // answers after a round trip and the turn can take a moment longer to wind down.
  const stopping = { id: current.id, turn: current.currentMessageId ?? null };
  set({ stopping });
  try {
    await api.post(`sessions/${encodeURIComponent(current.id)}/stop`);
  } catch (error) {
    if (get().stopping === stopping) set({ stopping: null });
    fail(error);
  }
}

// "Interrupt and send now": ends the step Claude is on so the messages sent mid-turn run
// at once. Shown as "Interrupting…" until they are read (see isInterrupting).
export async function interruptAndSend() {
  const current = get().current;
  if (!current) return;
  const interrupting = { id: current.id, turn: current.currentMessageId ?? null };
  set({ interrupting });
  try {
    await api.post(`sessions/${encodeURIComponent(current.id)}/interrupt`);
  } catch (error) {
    if (get().interrupting === interrupting) set({ interrupting: null });
    fail(error);
  }
}

// Stops one subagent of the current session; the rest of the session carries on.
/** Stops a background command or Monitor of the open session (Background tab). */
export async function stopTask(taskId) {
  const current = get().current;
  if (!current) return;
  try {
    await api.post(`sessions/${encodeURIComponent(current.id)}/tasks/${encodeURIComponent(taskId)}/stop`);
  } catch (error) {
    fail(error);
  }
}

export async function stopAgent(toolId) {
  const current = get().current;
  if (!current) return;
  try {
    await api.post(`sessions/${encodeURIComponent(current.id)}/agents/${encodeURIComponent(toolId)}/stop`);
  } catch (error) {
    fail(error);
  }
}

/* Messaging a model agent (the agent panel's message box) */

// A message sent to a running model agent shows in its transcript as "Sending…" at once
// (state.agentOutgoing) and stays until the server's copy arrives with the same
// clientId, or a few seconds after the server accepted it. Sends go out one at a time,
// in order, as the agent reads them in order.
const AGENT_SEND_GRACE = 5000;
let agentSendChain = Promise.resolve();
let agentSendSeq = 0;
// `session/agent` -> the text and clientId of a send that got no answer (it may have
// arrived), so the same text sent again is recognised as the same message.
const agentRetries = new Map();

// Resolves to { ok } or, when the server refused or could not be reached, { ok: false,
// error, status }: the message is then gone from the transcript and its text is the
// caller's to put back.
export function sendAgentMessage(toolId, rawText) {
  const session = get().current;
  const text = String(rawText ?? '').trim();
  if (!session || !text) return Promise.resolve({ ok: false, error: '', status: 0 });
  const retryKey = `${session.id}/${toolId}`;
  const retry = agentRetries.get(retryKey);
  const item = { key: ++agentSendSeq, clientId: retry?.text === text ? retry.clientId : newClientId(), sessionId: session.id, toolId, text, at: Date.now() };
  set({ agentOutgoing: [...get().agentOutgoing, item] });
  const run = agentSendChain.then(() => postAgentMessage(item, retryKey));
  agentSendChain = run.catch(() => {});
  return run;
}

function dropAgentSend(key) {
  set({ agentOutgoing: get().agentOutgoing.filter((item) => item.key !== key) });
}

async function postAgentMessage(item, retryKey) {
  const route = `sessions/${encodeURIComponent(item.sessionId)}/agents/${encodeURIComponent(item.toolId)}/message`;
  try {
    await api.post(route, { text: item.text, clientId: item.clientId });
  } catch (error) {
    dropAgentSend(item.key);
    if (error.status) agentRetries.delete(retryKey);
    else agentRetries.set(retryKey, { text: item.text, clientId: item.clientId });
    return { ok: false, error: error.message, status: error.status || 0 };
  }
  agentRetries.delete(retryKey);
  // The copy normally arrives over the live stream; otherwise fetch the session.
  if (get().connection !== 'live' && get().current?.id === item.sessionId) await refreshCurrent().catch(() => {});
  setTimeout(() => dropAgentSend(item.key), AGENT_SEND_GRACE);
  return { ok: true };
}

export async function cancelQueued(messageId) {
  const current = get().current;
  if (!current) return;
  // Gone from the bar at once; back if the server says it is too late.
  const fields = {};
  for (const key of ['queue', 'steering']) {
    if (current[key]?.some((item) => item.id === messageId)) fields[key] = current[key].filter((item) => item.id !== messageId);
  }
  const before = Object.fromEntries(Object.keys(fields).map((key) => [key, current[key]]));
  store.set((state) => applyOptimistic(state, current.id, fields));
  try {
    await api.post(`sessions/${encodeURIComponent(current.id)}/queue/${encodeURIComponent(messageId)}/cancel`);
  } catch (error) {
    store.set((state) => undoOptimistic(state, current.id, fields, before));
    fail(error);
  }
}

export async function resumeQueue() {
  const current = get().current;
  if (!current) return;
  try {
    await api.post(`sessions/${encodeURIComponent(current.id)}/queue/resume`);
  } catch (error) {
    fail(error);
  }
}

// Answers a pending approval. `body` is built by approvalBody() in lib/approvals.js:
// {decision: allow|allowAlways|deny, allow (v1), reason?, answers?, mode?}. The card
// goes at once (the next one, if any, shows) and the server's delta confirms it. A 409
// (already answered, or the session was stopped) leaves it gone; the error is rethrown
// with `dropped: true` so the card can show a quiet note. Any other failure puts the
// card back.
export async function answerApproval(pending, body) {
  const { current } = get();
  const sessionId = current?.id;
  const index = current?.pending?.findIndex((p) => p.id === pending.id) ?? -1;
  store.set((state) => withoutPending(state, pending.id));
  try {
    await api.post('approvals/' + encodeURIComponent(pending.id), body);
  } catch (error) {
    if (error?.status === 409) error.dropped = true;
    else if (index >= 0) store.set((state) => restorePending(state, sessionId, pending, index));
    throw error;
  }
}

/* Older messages (a session opens with its tail, lib/tail.js) */

// The open session's load of older messages under way: { id, all, promise }.
let olderLoad = null;
// Pages asked for per load before giving up (each retry follows a change meanwhile).
const OLDER_ATTEMPTS = 3;

/**
 * Loads the page of messages before the first one the open session holds (with `all`,
 * every one it lacks) and puts it in front of them. Resolves to true when the copy then
 * starts earlier (or held everything already), false when nothing was added: the
 * session moved on, or the load failed (reported). A page that no longer fits the copy
 * (it took deltas meanwhile, see applyOlderMessages) is asked for again; a copy whose
 * window is not where the server's list has it is fetched again first.
 */
export function loadOlderMessages({ all = false } = {}) {
  const session = get().current;
  if (!session || !heldFrom(session)) return Promise.resolve(true);
  if (olderLoad?.id === session.id) {
    if (!all || olderLoad.all) return olderLoad.promise;
    return olderLoad.promise.then(() => loadOlderMessages({ all }));
  }
  const id = session.id;
  const load = { id, all, promise: null };
  olderLoad = load;
  load.promise = (async () => {
    try {
      for (let attempt = 0; attempt < OLDER_ATTEMPTS; attempt++) {
        const current = get().current;
        if (current?.id !== id) return false;
        if (!heldFrom(current)) return true;
        const before = current.messagesFrom;
        const beforeId = current.messages?.[0]?.id ?? null;
        let page;
        try {
          page = await api.get(olderRoute(current, { all }), { timeout: 60_000 });
        } catch (error) {
          if (error?.status !== 409) throw error;
          page = null;
        }
        if (get().current?.id !== id) return false;
        if (!page || page.before !== before) {
          // The copy's first message is gone, or not where the copy thinks it is.
          await refreshCurrent({ fresh: true });
          continue;
        }
        const patch = applyOlderMessages(get(), id, beforeId, page);
        if (patch) {
          set(patch);
          return true;
        }
      }
      return false;
    } catch (error) {
      if (get().current?.id === id) fail(error);
      return false;
    } finally {
      if (olderLoad === load) olderLoad = null;
    }
  })();
  return load.promise;
}

// Every message of the open session (find in page, an agent outside the window).
export function loadAllMessages() {
  return loadOlderMessages({ all: true });
}

/* Tool output */

// Full (untruncated) tool output by message id. Pushed copies cut long output; the
// message route returns the stored one. Cached for the page's lifetime.
const fullOutputs = new Map();

export function cachedFullOutput(messageId) {
  return fullOutputs.get(messageId);
}

export async function loadFullOutput(message) {
  if (fullOutputs.has(message.id)) return fullOutputs.get(message.id);
  const session = get().current;
  if (!session) throw new Error('Open the session first.');
  const full = await api.get(`sessions/${encodeURIComponent(session.id)}/messages/${encodeURIComponent(message.id)}`, { timeout: 30_000 });
  const output = typeof full?.output === 'string' ? full.output : '';
  fullOutputs.set(message.id, output);
  return output;
}

/* Import (Claude Code and Codex sessions) */

// Candidates for the import picker. The first scan on the server can take a while.
export function loadImportCandidates(source) {
  return api.get('import/' + encodeURIComponent(source), { timeout: 120_000 });
}

// Imports `ids` from `source` ('claude' | 'codex'), at most 20 per request, with the
// model and mode picked for new sessions. Imported sessions join the list as each
// batch lands; `onBatch({ done, sessions, errors })` reports progress. A failed
// request counts as an error for each id in it. Resolves to { sessions, errors }.
export async function importSessions(source, ids, { onBatch } = {}) {
  const { model, mode, isV2 } = get();
  const sessions = [];
  const errors = [];
  let done = 0;
  for (const batch of chunk(ids, IMPORT_BATCH_SIZE)) {
    let result = { sessions: [], errors: [] };
    try {
      const data = await api.post('import', { source, ids: batch, model, mode: wireMode(mode, isV2) }, { timeout: 600_000 });
      result = { sessions: Array.isArray(data?.sessions) ? data.sessions : [], errors: Array.isArray(data?.errors) ? data.errors : [] };
    } catch (error) {
      result.errors = batch.map((id) => ({ id, error: error.message }));
    }
    if (result.sessions.length) store.set((state) => ({ sessions: result.sessions.reduce(upsertSession, state.sessions) }));
    sessions.push(...result.sessions);
    errors.push(...result.errors);
    done += batch.length;
    onBatch?.({ done, batch, ...result });
  }
  return { sessions, errors };
}

/* Model, mode, effort */

export async function chooseModel(id) {
  const current = get().current;
  try {
    if (current) await patchSession(current.id, { model: id });
    else {
      set({ model: id });
      setItem(KEYS.model, id);
    }
  } catch (error) {
    fail(error);
  }
}

export async function chooseMode(mode) {
  const { current, isV2 } = get();
  try {
    if (current) await patchSession(current.id, { mode: wireMode(mode, isV2) });
    else {
      set({ mode });
      setItem(KEYS.mode, mode);
    }
  } catch (error) {
    fail(error);
  }
}

export async function chooseEffort(effort) {
  const { current, model, efforts } = get();
  try {
    if (current) await patchSession(current.id, { effort });
    else {
      const next = { ...efforts, [model]: effort };
      set({ efforts: next });
      setJSON(KEYS.efforts, next);
    }
  } catch (error) {
    fail(error);
  }
}

/**
 * Fetches the OpenRouter models (the model picker's side menu) into `info.openrouterModels`,
 * once; `openrouterStatus` is 'loading', 'ready' or 'error' (a failed load can be retried).
 */
export async function loadOpenRouterModels() {
  const status = get().openrouterStatus;
  if (status === 'loading' || status === 'ready') return;
  set({ openrouterStatus: 'loading' });
  try {
    const list = await api.get('openrouter-models');
    store.set((state) => ({ openrouterStatus: 'ready', info: state.info && { ...state.info, openrouterModels: Array.isArray(list) ? list : [] } }));
  } catch {
    set({ openrouterStatus: 'error' });
  }
}

/** The catalog in app state follows a model-settings change, so pickers and new meters use it at once. */
export function applyModelSettings(models) {
  store.set((state) => {
    if (!state.info?.models) return {};
    const byId = new Map(models.map((m) => [m.id, m]));
    return {
      info: {
        ...state.info,
        models: state.info.models.map((m) => (byId.has(m.id) ? { ...m, contextWindow: byId.get(m.id).contextWindow, fast: byId.get(m.id).fast } : m)),
      },
    };
  });
}

/** Turns a model's fast mode on or off, for every chat from its next turn. Resolves to the new settings, or null. */
export async function setFastMode(modelId, on) {
  try {
    const data = await api.put('model-settings', { fast: { [modelId]: on } });
    applyModelSettings(data.models);
    return data;
  } catch (error) {
    fail(error);
    return null;
  }
}

export function activeModel(state = get()) {
  return findModel(state.info, state.current?.model || state.model);
}

/* Projects */

export function chooseProject(path) {
  // The folder a remote cluster last used is remembered per cluster; the local one stays
  // the page's own remembered project.
  const cluster = findCluster(get().clusters, get().cluster);
  set({ project: path });
  setItem(isRemote(cluster) ? KEYS.clusterFolder(cluster.id) : KEYS.project, path);
}

/* Clusters (lib/clusters.js) */

// The cluster list from /api/info and the id still selectable (a deploy can drop one).
function clusterState(info, state) {
  const clusters = clusterList(info);
  const cluster = clusters.some((c) => c.id === state.cluster) ? state.cluster : 'local';
  return { clusters, cluster };
}

// Picks the cluster for the next new chat, with the folder last used there (its home
// until one is chosen). The local cluster goes back to the page's remembered project.
export function chooseCluster(id) {
  const state = get();
  const clusters = state.clusters.length ? state.clusters : clusterList(state.info);
  const cluster = findCluster(clusters, id);
  const project = isRemote(cluster)
    ? clusterFolder(cluster, getItem(KEYS.clusterFolder(cluster.id)))
    : getItem(KEYS.project) || state.info?.defaultProject || state.info?.root || '';
  set({ clusters, cluster: cluster.id, project });
}

export async function listProjects(path) {
  return api.get('projects?path=' + encodeURIComponent(path || ''));
}

/* Layout */

export function toggleSidebar() {
  if (isMobile()) set({ drawerOpen: !get().drawerOpen });
  else {
    const collapsed = !get().sidebarCollapsed;
    set({ sidebarCollapsed: collapsed });
    setItem(KEYS.sidebar, collapsed ? 'collapsed' : 'open');
  }
}

export function closeDrawer() {
  set({ drawerOpen: false });
}

export function setFilter(filter) {
  set({ filter });
}

export function setGroupBy(groupBy) {
  setItem(KEYS.groupBy, groupBy);
  set({ groupBy });
}

export function setSearch(search) {
  set({ search });
}

export function openPanel(tab) {
  const { panel } = get();
  set({ panel: { ...panel, open: true, tab: tab || panel.tab, taskId: null } });
}

export function togglePanel() {
  const { panel } = get();
  // With an agent shown the panel is open whatever the tab state says: this hides it.
  if (shownAgent()) {
    closeAgent();
    set({ panel: { ...panel, open: false } });
    return;
  }
  set({ panel: { ...panel, open: !panel.open } });
}

export function closePanel() {
  if (shownAgent()) closeAgent();
  set({ panel: { ...get().panel, open: false } });
}

/* Agent view (the side panel's agent mode, AgentPanel.jsx) */

// The agent path shown for the open session, or null.
export function shownAgent(state = get()) {
  const { agent, current } = state;
  return current && agent.sessionId === current.id && agent.path.length ? agent.path : null;
}

/**
 * Shows the agent call `toolId` of the open session in the side panel, under the agents
 * that started it. `from` is the agent view it is opened from: an agent inside it may be
 * known only from Claude Code's transcript loaded there.
 */
export function openAgent(toolId, { from = [] } = {}) {
  const session = get().current;
  if (!session || !AGENT_ID.test(String(toolId))) return;
  let path = agentPath(session.messages, toolId);
  const files = get().agentFiles;
  for (let i = from.length - 1; !path && i >= 0; i--) {
    const inner = files[from[i]]?.data ? agentPath(files[from[i]].data.messages, toolId, from[i]) : null;
    if (inner) path = [...from.slice(0, i + 1), ...inner];
  }
  showAgent(path || [...from, toolId], 'push');
}

export function closeAgent() {
  showAgent([], 'back');
}

// A breadcrumb: the agent at `index` of the path shown.
export function showOuterAgent(index) {
  const path = shownAgent();
  if (path && index >= 0 && index < path.length - 1) showAgent(path.slice(0, index + 1), 'back');
}

export function toggleAgentWide() {
  const { agent } = get();
  set({ agent: { ...agent, wide: !agent.wide } });
}

/**
 * Sets the agent path of the open session ([] shows none) and the page URL: `push` adds
 * a history entry (Back returns here), `back` goes back to an entry that showed `path`
 * when there is one (closing, a breadcrumb), `replace` and `none` stay on this entry.
 */
function showAgent(path, mode) {
  const { current, agent } = get();
  if (!current) return;
  const before = shownAgent() || [];
  if (!samePath(before, path)) set({ agent: { ...agent, sessionId: current.id, path } });
  if (mode === 'none' || (samePath(before, path) && mode !== 'replace')) return;
  try {
    const views = history.state?.agentViews?.session === current.id ? history.state.agentViews : null;
    const url = agentUrl(current.id, path);
    if (mode === 'push') {
      // Each entry lists the agent views below it, for `back`.
      history.pushState({ agentViews: { session: current.id, stack: [...(views?.stack || []), before] } }, '', url);
      return;
    }
    const index = mode === 'back' && views ? views.stack.findLastIndex((p) => samePath(p, path)) : -1;
    if (index >= 0) history.go(index - views.stack.length);
    else history.replaceState(history.state, '', url);
  } catch {
    // ignore (e.g. sandboxed previews)
  }
}

// Back and Forward: the session and agent the entry names.
function onPopState() {
  const { session: id, agents } = parseAgentUrl(location.search);
  const current = get().current;
  if (!id || current?.id === id) {
    if (current) showAgent(agents, 'none');
    return;
  }
  if (!get().sessions.some((s) => s.id === id)) return;
  selectSession(id).then(() => {
    if (get().current?.id === id && agents.length) showAgent(agents, 'replace');
  });
}

/**
 * Reads Claude Code's own transcript of an agent of the open session (GET
 * /api/sessions/:id/agents/:toolId/transcript) and, with `show`, shows it in place of
 * the steps the session recorded. A copy read before stays shown while it is read again.
 */
export async function loadAgentFiles(toolId, { show = true } = {}) {
  const session = get().current;
  if (!session) return;
  const known = get().agentFiles[toolId];
  if (known?.loading) {
    if (known.shown !== show) setAgentFiles(toolId, { ...known, shown: show });
    return;
  }
  setAgentFiles(toolId, { loading: true, data: known?.data || null, error: null, shown: show });
  let result;
  try {
    const data = await api.get(`sessions/${encodeURIComponent(session.id)}/agents/${encodeURIComponent(toolId)}/transcript`, { timeout: 60_000 });
    result = { data, error: null };
  } catch (error) {
    result = { data: known?.data || null, error: { message: error.message, status: error.status || 0 } };
  }
  if (get().current?.id !== session.id) return;
  setAgentFiles(toolId, { loading: false, ...result, shown: get().agentFiles[toolId]?.shown ?? show });
}

// "Full transcript": on reads the file again (it may have grown, or failed before); off
// goes back to the recorded steps.
export function showAgentFiles(toolId, shown) {
  const known = get().agentFiles[toolId];
  if (shown) loadAgentFiles(toolId);
  else if (known) setAgentFiles(toolId, { ...known, shown: false });
}

function setAgentFiles(toolId, entry) {
  set({ agentFiles: { ...get().agentFiles, [toolId]: entry } });
}

/** Opens the Background tab on one task (expanded, scrolled to). */
export function openTask(taskId) {
  const { panel } = get();
  if (shownAgent()) closeAgent();
  set({ panel: { ...panel, open: true, tab: 'background', taskId, nonce: panel.nonce + 1 } });
}

export function setPanelTab(tab) {
  set({ panel: { ...get().panel, tab, taskId: null } });
}

export function openFile(filePath, line = null) {
  const { panel } = get();
  set({ panel: { ...panel, open: true, tab: 'files', filePath, fileLine: line, nonce: panel.nonce + 1, taskId: null } });
}

export function browseTo(filePath) {
  const { panel } = get();
  set({ panel: { ...panel, filePath, fileLine: null, nonce: panel.nonce + 1 } });
}

export function openDialog(type, props = {}) {
  set({ dialog: { type, ...props } });
}

export function closeDialog() {
  set({ dialog: null });
}

export function setTheme(theme) {
  saveTheme(theme);
  set({ theme });
}

export function presetComposer(text) {
  set({ composerPreset: { text, nonce: Date.now() } });
}

export function scrollToLatest() {
  set({ scrollNonce: get().scrollNonce + 1 });
}

// Claude Code takes seconds to start (MCP servers, tools). Begun while the first words
// are typed, it is ready by the send: a new chat's session is prepared on the server
// (POST sessions/prepare, adopted by the create), an open one whose process has closed is
// warmed (POST sessions/:id/warm).
const WARM_EVERY_MS = 60_000;
const PREPARE_EVERY_MS = 5 * 60_000; // within the server's 10 minutes
let preparing = null; // { key, at, promise }: the new chat's prepared session
const warmedAt = new Map();

export function warmForTyping() {
  const { current, isV2, model, mode, efforts, project } = get();
  if (!isV2) return;
  if (current?.id) {
    if (isBusy(current) || Date.now() - (warmedAt.get(current.id) || 0) < WARM_EVERY_MS) return;
    warmedAt.set(current.id, Date.now());
    api.post(`sessions/${encodeURIComponent(current.id)}/warm`).catch(() => {});
    return;
  }
  if (!project) return;
  const body = newChatBody({ project, model, mode: wireMode(mode, isV2), effort: efforts[model] || 'default' }, findCluster(get().clusters, get().cluster));
  const key = JSON.stringify(body);
  if (preparing?.key === key && Date.now() - preparing.at < PREPARE_EVERY_MS) return;
  preparing = { key, at: Date.now(), promise: api.post('sessions/prepare', body).then((r) => r.prepareId || null, () => null) };
}

/** The prepared session for a new chat with these settings, once: the send adopts it. */
async function preparedFor(body) {
  const mine = preparing?.key === JSON.stringify(body) ? preparing : null;
  preparing = null;
  return mine ? (await mine.promise) || undefined : undefined;
}
