// Composer state that lives outside the component: attachments (uploads per draft),
// the slash-command cache, `@` file completion, local slash commands, and requests to
// open a picker / the lightbox. Attachment items are kept in the store under
// `attachments[slot]`, where slot is the session id or 'new'.
import { api } from './api.js';
import { store } from './state.js';
import { chooseCluster, chooseEffort, chooseMode, chooseModel, chooseProject, forkSession, newSession, openDialog, openPanel, renameSession, toast } from './actions.js';
import { createCommandCache } from './lib/commands.js';
import { clusterQuery, folderClusterId, folderKey } from './lib/clusters.js';
import { tabFromArg } from './lib/settings.js';
import { readAttachments, writeAttachments } from './lib/drafts.js';
import { getItem, removeItem, setItem } from './lib/storage.js';
import { checkFiles, isImage, uploadFile, uploadName } from './lib/uploads.js';
import { effortOptions, findModel } from './lib/models.js';
import { isBusy } from './lib/sessions.js';

const get = () => store.get();
const draftStorage = { getItem, setItem, removeItem };
const EMPTY = Object.freeze([]);

export const slotFor = (sessionId) => sessionId || 'new';
const storageId = (slot) => (slot === 'new' ? null : slot);

/* Attachments */

// Upload handles by item key, so a removal can abort an upload in flight.
const inflight = new Map();
let keySeed = 0;

export function attachmentItems(state, slot) {
  return state.attachments?.[slot] || EMPTY;
}

function setItems(slot, update) {
  store.set((state) => {
    const items = attachmentItems(state, slot);
    const next = typeof update === 'function' ? update(items) : update;
    return { attachments: { ...(state.attachments || {}), [slot]: next } };
  });
}

function patchItem(slot, key, patch) {
  setItems(slot, (items) => items.map((item) => (item.key === key ? { ...item, ...patch } : item)));
}

function persist(slot) {
  const done = attachmentItems(get(), slot)
    .filter((item) => item.status === 'done')
    .map((item) => item.attachment);
  writeAttachments(draftStorage, storageId(slot), done);
}

const fromAttachment = (attachment) => ({
  key: 'a-' + attachment.id,
  name: attachment.name,
  size: attachment.size,
  type: attachment.type,
  image: !!attachment.image,
  status: 'done',
  progress: 1,
  attachment,
});

/** Puts uploads back into a session's draft (a rewound message's), after any there. */
export function restoreAttachments(sessionId, attachments) {
  const slot = slotFor(sessionId);
  hydrateAttachments(slot);
  setItems(slot, (items) => [...items, ...attachments.filter((a) => !items.some((item) => item.key === 'a-' + a.id)).map(fromAttachment)]);
  persist(slot);
}

// Loads a draft's stored attachments into the store the first time it is shown.
export function hydrateAttachments(slot) {
  if (get().attachments?.[slot]) return;
  setItems(slot, readAttachments(draftStorage, storageId(slot)).map(fromAttachment));
}

function startUpload(slot, key) {
  const item = attachmentItems(get(), slot).find((x) => x.key === key);
  if (!item?.file) return;
  const scope = slot === 'new' ? 'draft' : slot;
  const handle = uploadFile(item.file, {
    scope,
    name: item.name,
    onProgress: (progress) => patchItem(slot, key, { progress }),
  });
  inflight.set(key, handle);
  patchItem(slot, key, { status: 'uploading', progress: 0, error: null });
  handle.promise.then(
    (attachment) => {
      inflight.delete(key);
      // The server sniffs the bytes: its image/type verdict replaces the browser's guess.
      patchItem(slot, key, { status: 'done', progress: 1, attachment, file: null, image: Boolean(attachment.image), type: attachment.type });
      persist(slot);
      swapPreview(slot, key, attachment);
    },
    (error) => {
      inflight.delete(key);
      if (error.aborted) return;
      patchItem(slot, key, { status: 'error', error: error.message });
    },
  );
}

// Keep the local preview until the server copy has loaded, so the thumbnail does not
// flash, then free the object URL.
function swapPreview(slot, key, attachment) {
  const item = attachmentItems(get(), slot).find((x) => x.key === key);
  if (!item?.previewUrl) return;
  const done = () => {
    const current = attachmentItems(get(), slot).find((x) => x.key === key);
    if (current?.previewUrl) {
      URL.revokeObjectURL(current.previewUrl);
      patchItem(slot, key, { previewUrl: null });
    }
  };
  if (!item.image || !attachment.url) return done();
  const img = new Image();
  img.onload = done;
  img.onerror = done;
  img.src = attachment.url;
}

// Adds files to a draft and starts uploading them. Returns how many were accepted.
export function addFiles(slot, fileList, { pasted = false } = {}) {
  const files = [...(fileList || [])];
  if (!files.length) return 0;
  const existing = attachmentItems(get(), slot).length;
  const { accepted, problems } = checkFiles(files, existing);
  if (problems.length) toast(problems.join(' '));
  const now = new Date();
  const items = accepted.map((file) => {
    const image = isImage(file);
    return {
      key: `u-${Date.now().toString(36)}-${(keySeed += 1)}`,
      file,
      name: uploadName(file, { pasted, now }),
      size: file.size,
      type: file.type,
      image,
      previewUrl: image ? URL.createObjectURL(file) : null,
      status: 'uploading',
      progress: 0,
    };
  });
  if (!items.length) return 0;
  setItems(slot, (current) => [...current, ...items]);
  for (const item of items) startUpload(slot, item.key);
  return items.length;
}

export function retryAttachment(slot, key) {
  startUpload(slot, key);
}

export function removeAttachment(slot, key) {
  inflight.get(key)?.abort();
  inflight.delete(key);
  const item = attachmentItems(get(), slot).find((x) => x.key === key);
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
  setItems(slot, (items) => items.filter((x) => x.key !== key));
  persist(slot);
}

// Drops attachments that were sent (by attachment id) from a draft.
export function clearSentItems(slot, ids) {
  if (!ids.length || !get().attachments?.[slot]) return;
  const sent = new Set(ids);
  for (const item of attachmentItems(get(), slot)) {
    if (item.attachment && sent.has(item.attachment.id) && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  setItems(slot, (items) => items.filter((item) => !(item.attachment && sent.has(item.attachment.id))));
}

/* `@` file completion */

// Resolves to [{path, directory}] for the open session (or the chosen project).
export async function completeFiles(query, { signal } = {}) {
  const state = get();
  const { current, project } = state;
  // A session's folder is on its cluster and the request names the session; a new chat's
  // folder needs the cluster chosen for it.
  const scope = current
    ? 'session=' + encodeURIComponent(current.id)
    : 'cwd=' + encodeURIComponent(project || '') + clusterQuery(folderClusterId(state));
  const fetchImpl = (url, init) => {
    const signals = [init.signal, signal].filter(Boolean);
    return fetch(url, { ...init, signal: signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : signal || init.signal });
  };
  const data = await api.get(`complete/files?${scope}&q=${encodeURIComponent(query)}`, { fetchImpl, timeout: 8000 });
  return Array.isArray(data?.items) ? data.items : [];
}

/* Slash commands */

export const commandCwd = (state = get()) => state.current?.cwd || state.project || '';

// A session's commands are on its cluster, a new chat's on the one chosen for it.
export const commandScope = (state = get()) => folderKey(folderClusterId(state), commandCwd(state));

const commandCache = createCommandCache({
  load: async (scope) => {
    // `folderKey`: a remote cluster's id first, then the folder.
    const [cluster, cwd] = scope.includes('\0') ? scope.split('\0') : [null, scope];
    const data = await api.get(`commands?cwd=${encodeURIComponent(cwd || '')}${clusterQuery(cluster)}`, { timeout: 20_000 });
    return data?.commands || [];
  },
});

export function cachedCommands(scope) {
  return commandCache.peek(scope);
}

// Fetches the project's commands when missing or older than five minutes.
export function loadCommands(scope) {
  return commandCache.ensure(scope);
}

/* Pickers, dialogs, lightbox */

// Asks a composer picker ('model' | 'mode' | 'effort') to open.
export function requestPicker(name) {
  store.set({ pickerRequest: { name, nonce: Date.now() + Math.random() } });
}

export function openLightbox(attachment) {
  store.set({ lightbox: { url: attachment.url, name: attachment.name || 'Image', size: attachment.size } });
}

export function closeLightbox() {
  store.set({ lightbox: null });
}

/* Local slash commands */

// Runs a local command. Returns true when handled (the composer then clears).
export function runLocalCommand({ name, args }) {
  const { current, info } = get();
  switch (name) {
    case 'clear': {
      if (!current) {
        toast('This is already a new chat.');
        return true;
      }
      const effort = current.efforts?.[current.model] || 'default';
      newSession();
      // A new chat on the same cluster, in the same folder.
      chooseCluster(current.cluster || 'local');
      chooseProject(current.cwd);
      chooseModel(current.model);
      chooseMode(current.mode);
      chooseEffort(effort);
      return true;
    }
    case 'model':
    case 'mode':
      requestPicker(name);
      return true;
    case 'effort': {
      const model = findModel(info, current?.model || get().model);
      if (effortOptions(model).length <= 1) toast(`${model.name} has a fixed reasoning effort.`);
      else requestPicker('effort');
      return true;
    }
    case 'rename':
      if (!current) {
        toast('Send a message first; new chats are named automatically.');
        return true;
      }
      if (args) {
        renameSession(current.id, args.slice(0, 100)).then(
          () => toast('Chat renamed.'),
          (error) => toast(error.message),
        );
      } else openDialog('rename', { id: current.id });
      return true;
    case 'fork':
      if (!current) toast('Send a message first; there is nothing to fork yet.');
      else if (current.removed) toast('Restore this session from the Trash to fork it.');
      else if (isBusy(current)) toast('Wait for the turn to end, then fork.');
      else forkSession(current.id);
      return true;
    case 'help':
      openDialog('help');
      return true;
    case 'import':
      openDialog('import');
      return true;
    case 'agents':
      openDialog('agents');
      return true;
    case 'tasks':
      if (!current) toast('Send a message first; nothing runs in the background yet.');
      else openPanel('background');
      return true;
    case 'settings':
      openDialog('settings', { tab: tabFromArg(args) || undefined });
      return true;
    case 'mcp':
      openDialog('mcp', { sessionId: current?.id || null });
      return true;
    default:
      return false;
  }
}
