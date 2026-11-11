// localStorage wrapper that never throws (private mode, quota, disabled storage).
// Keys keep the v1 `mesh-code-*` names so drafts and preferences carry over.

export const KEYS = {
  model: 'mesh-code-model',
  mode: 'mesh-code-mode',
  project: 'mesh-code-project',
  efforts: 'mesh-code-efforts',
  session: 'mesh-code-session',
  wrap: 'mesh-code-wrap',
  theme: 'mesh-code-theme',
  sidebar: 'mesh-code-sidebar',
  // How the sidebar groups sessions: 'date' (default) or 'cluster'.
  groupBy: 'mesh-code-group-by',
  panelWidth: 'mesh-code-panel-width',
  importTab: 'mesh-code-import-tab',
  // '0' turns off loading recent sessions in the background after the page loads.
  warmUp: 'mesh-code-warm-up',
  draft: (id) => 'mesh-code-draft-' + (id || 'new'),
  // The folder last used for a new chat on a remote cluster (see lib/clusters.js).
  clusterFolder: (id) => 'mesh-code-cluster-folder-' + id,
  // v1 name, kept so an in-flight send survives the upgrade.
  pendingSend: (id) => 'mesh-pending-' + id,
};

function backend() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function getItem(key) {
  try {
    return backend()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setItem(key, value) {
  try {
    backend()?.setItem(key, value);
  } catch {
    // Storage full or unavailable; preferences are best-effort.
  }
}

export function removeItem(key) {
  try {
    backend()?.removeItem(key);
  } catch {
    // ignore
  }
}

export function getJSON(key, fallback) {
  const raw = getItem(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setJSON(key, value) {
  setItem(key, JSON.stringify(value));
}
