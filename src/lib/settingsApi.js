// The /api/settings routes (server/settings-routes.mjs). `cwd` is the project folder and
// `cluster` the cluster it is on; the user's own files need no folder. Writes carry the
// `version` the editor started from (null: the file did not exist) and fail with a 409
// whose `error.data.current` is the file now. Settings files are this machine's, so a
// folder on another cluster is refused by the server (edit them on that cluster).
import { api } from '../api.js';
import { clusterFields } from './clusters.js';

const query = (params) => {
  const text = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString();
  return text ? '?' + text : '';
};
const enc = encodeURIComponent;

// The user's files do not depend on a project, and the server would refuse a bad folder anyway.
const forScope = (scope, body) => (scope === 'user' ? { ...body, cwd: undefined } : body);

export const settingsApi = {
  files: (cwd, cluster) => api.get('settings/files' + query({ cwd, ...clusterFields(cluster) })),
  file: (scope, id, cwd, cluster) => api.get(`settings/files/${scope}/${enc(id)}` + query(forScope(scope, { cwd, ...clusterFields(cluster) }))),
  putFile: (scope, id, body, cluster) => api.put(`settings/files/${scope}/${enc(id)}`, forScope(scope, { ...body, ...clusterFields(cluster) })),
  patchFile: (scope, id, body, cluster) => api.patch(`settings/files/${scope}/${enc(id)}`, forScope(scope, { ...body, ...clusterFields(cluster) })),
  memories: (cwd, cluster) => api.get('settings/memory' + query({ cwd, ...clusterFields(cluster) })),
  memory: (cwd, name, cluster) => api.get(`settings/memory/${enc(name)}` + query({ cwd, ...clusterFields(cluster) })),
  putMemory: (name, body, cluster) => api.put(`settings/memory/${enc(name)}`, { ...body, ...clusterFields(cluster) }),
  deleteMemory: (cwd, name, version, cluster) => api.delete(`settings/memory/${enc(name)}` + query({ cwd, version, ...clusterFields(cluster) })),
};
