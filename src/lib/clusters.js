// Clusters a session's agent can run on. The list comes from GET /api/info as
// `clusters` ([{ id, label, host, home }], `local` first); an older server has no field,
// which means this server only. A session carries the id it runs on (`cluster`), and a
// missing one is the local cluster.

export const LOCAL_CLUSTER = Object.freeze({ id: 'local', label: 'Local', host: null, home: null });

// A normalized cluster list: missing or malformed entries dropped, `local` always there
// (so `length > 1` means the picker is worth showing).
export function clusterList(info) {
  const source = Array.isArray(info?.clusters) ? info.clusters : [];
  const clusters = [];
  for (const entry of source) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || clusters.some((c) => c.id === entry.id)) continue;
    clusters.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label ? entry.label : entry.id,
      host: entry.host || null,
      home: entry.home || null,
    });
  }
  if (!clusters.some((cluster) => cluster.id === 'local')) clusters.unshift({ ...LOCAL_CLUSTER });
  return clusters;
}

// The cluster with this id, else the first (the local one).
export function findCluster(clusters, id) {
  return clusters?.find((cluster) => cluster.id === id) || clusters?.[0] || { ...LOCAL_CLUSTER };
}

// Whether sessions on it run somewhere else (a server of their own, reached over ssh).
export function isRemote(cluster) {
  return !!cluster && cluster.id !== 'local';
}

// The cluster an app-state's requests about a folder are for: the open session's own
// (its commands and agents are there), else the one chosen for the next new chat. A
// request that carries a session id leaves the cluster out (the server reads the session).
export function folderClusterId(state) {
  const id = state?.current ? state.current.cluster : state?.cluster;
  return id || 'local';
}

// The fields a create/prepare request needs to name a remote cluster (none for local).
// `cluster` is a cluster of the list or just its id.
export function clusterFields(cluster) {
  const id = typeof cluster === 'string' ? cluster : cluster?.id;
  return id && id !== 'local' ? { cluster: id } : {};
}

// The `cluster` suffix a request about a folder carries (`&cluster=alpha`); empty for the
// local cluster, which the server takes by default. Takes a cluster or its id.
export function clusterQuery(cluster) {
  const { cluster: id } = clusterFields(cluster);
  return id ? `&cluster=${encodeURIComponent(id)}` : '';
}

// A cache key for something about a folder: the folder alone on the local cluster, the
// cluster first otherwise, so switching cluster cannot serve the other cluster's copy.
export function folderKey(cluster, folder) {
  const { cluster: id } = clusterFields(cluster);
  return id ? `${id}\0${folder}` : folder;
}

// The label to show for a session's cluster; null for the local one (no badge). An id
// this page does not know (a newer server) is shown as it is rather than as another's label.
export function clusterLabel(clusters, id) {
  if (!id || id === 'local') return null;
  return clusters?.find((cluster) => cluster.id === id)?.label || id;
}

// The folder a new chat on `cluster` starts in: the one last used there, else its home.
export function clusterFolder(cluster, saved) {
  return saved || cluster?.home || '';
}
