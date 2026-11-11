// The remote clusters a session can run on. `local` is this machine (Claude Code runs
// here, as it always has); the others are login nodes reached over ssh, where a session's
// Claude Code process and its workers run (see remote-spawn.mjs). A session's cluster is
// chosen when it is created and never changes.
//
// The list is JSON [{id, label, host}] (host null for local), from WORKBENCH_CLUSTERS or
// from the file WORKBENCH_CLUSTERS_FILE names; without either only `local` is offered.
import fs from 'node:fs';
import path from 'node:path';
import { httpError } from './errors.mjs';
import { shQuote } from './remote-command.mjs';
import { runSsh } from './ssh.mjs';

export const LOCAL_CLUSTER = 'local';

export const DEFAULT_CLUSTERS = [
  { id: LOCAL_CLUSTER, label: 'This machine', host: null },
];

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// An ssh destination: a host alias or user@host, never an option.
const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/;

/** The cluster list from WORKBENCH_CLUSTERS (JSON), or the defaults. Throws on a bad list. */
export function parseClusters(value) {
  if (value === undefined || value === null || value.trim() === '') return DEFAULT_CLUSTERS.map((cluster) => ({ ...cluster }));
  let list;
  try {
    list = JSON.parse(value);
  } catch (error) {
    throw new Error(`WORKBENCH_CLUSTERS: not JSON (${error.message})`);
  }
  if (!Array.isArray(list) || !list.length) throw new Error('WORKBENCH_CLUSTERS: expected a non-empty array');
  const clusters = list.map((item) => {
    const id = String(item?.id ?? '');
    const host = item?.host ?? null;
    if (!ID.test(id)) throw new Error(`WORKBENCH_CLUSTERS: bad id "${id}"`);
    if (host !== null && !HOST.test(String(host))) throw new Error(`WORKBENCH_CLUSTERS: bad host for ${id}`);
    if ((id === LOCAL_CLUSTER) !== (host === null)) throw new Error(`WORKBENCH_CLUSTERS: only "${LOCAL_CLUSTER}" has no host`);
    return { id, label: String(item.label || id).slice(0, 40), host };
  });
  if (new Set(clusters.map((cluster) => cluster.id)).size !== clusters.length) throw new Error('WORKBENCH_CLUSTERS: an id is listed twice');
  if (!clusters.some((cluster) => cluster.id === LOCAL_CLUSTER)) clusters.unshift({ ...DEFAULT_CLUSTERS[0] });
  return clusters;
}

/**
 * The cluster list of an environment: WORKBENCH_CLUSTERS (JSON), else the JSON file
 * WORKBENCH_CLUSTERS_FILE, else the defaults. Throws on a bad list or an unreadable file.
 */
export function loadClusters(env = process.env) {
  if (env.WORKBENCH_CLUSTERS?.trim()) return parseClusters(env.WORKBENCH_CLUSTERS);
  const file = env.WORKBENCH_CLUSTERS_FILE?.trim();
  if (!file) return parseClusters(undefined);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`WORKBENCH_CLUSTERS_FILE: cannot read ${file} (${error.message})`);
  }
  return parseClusters(text);
}

/** A session's cluster id: sessions from before clusters run here. */
export const sessionCluster = (session) => session?.cluster || LOCAL_CLUSTER;

export const isRemote = (session) => sessionCluster(session) !== LOCAL_CLUSTER;

/**
 * The clusters and what is known about each over ssh (its home folder, asked once and
 * kept). `ssh` runs a command on a host (replaceable in tests).
 */
export function createClusters({ list = DEFAULT_CLUSTERS, ssh = runSsh, log = console.error } = {}) {
  const homes = new Map(); // cluster id -> Promise<string>
  const known = new Map(); // cluster id -> home, once answered

  function find(id) {
    return list.find((cluster) => cluster.id === (id || LOCAL_CLUSTER));
  }

  /** The cluster of a session, or of a request's `cluster` (400 when unknown). */
  function get(id) {
    const cluster = find(id);
    if (!cluster) throw httpError(400, `Unknown cluster "${id}".`);
    return cluster;
  }

  /** The remote HOME of a cluster; a failure is not kept, so the next call asks again. */
  function home(cluster) {
    if (!cluster.host) return Promise.resolve(null);
    if (!homes.has(cluster.id)) {
      const asked = ssh(cluster.host, 'printf "%s\\n" "$HOME"', { timeoutMs: 20_000 }).then((out) => {
        const value = out.trim();
        if (!path.posix.isAbsolute(value)) throw new Error(`no home folder on ${cluster.label}`);
        known.set(cluster.id, value);
        return value;
      });
      asked.catch((error) => {
        homes.delete(cluster.id);
        log(`Could not reach ${cluster.label} (${cluster.host}): ${error.message}`);
      });
      homes.set(cluster.id, asked);
    }
    return homes.get(cluster.id);
  }

  /**
   * A folder on a remote cluster, as the canonical absolute path there: `~` and `~/…`
   * are its home; the folder must exist. Throws a 400 otherwise.
   */
  async function remoteFolder(cluster, value) {
    const remoteHome = await home(cluster).catch((error) => {
      throw httpError(502, `Could not reach ${cluster.label}: ${error.message}`);
    });
    let folder = String(value || '').trim() || remoteHome;
    if (folder === '~' || folder.startsWith('~/')) folder = remoteHome + folder.slice(1);
    if (!path.posix.isAbsolute(folder) || folder.includes('\0') || folder.includes('\n')) {
      throw httpError(400, `Give an absolute folder on ${cluster.label}.`);
    }
    folder = path.posix.normalize(folder);
    let real = '';
    try {
      real = (await ssh(cluster.host, `cd -- ${shQuote(folder)} 2>/dev/null && pwd -P`, { timeoutMs: 20_000 })).trim();
    } catch (error) {
      if (error.code !== 1) throw httpError(502, `Could not reach ${cluster.label}: ${error.message}`);
    }
    if (!real) throw httpError(400, `${folder} is not a folder on ${cluster.label}.`);
    return real;
  }

  /**
   * What the frontend shows: every cluster with its home. A home not known yet is asked
   * for, waiting at most `waitMs`: a cluster that does not answer never holds this up.
   */
  async function publicList({ waitMs = 1500 } = {}) {
    const timeout = new Promise((resolve) => setTimeout(resolve, waitMs));
    await Promise.race([Promise.allSettled(list.map((cluster) => home(cluster))), timeout]);
    return list.map((cluster) => ({ id: cluster.id, label: cluster.label, host: cluster.host, home: known.get(cluster.id) ?? null }));
  }

  return { list, find, get, home, remoteFolder, publicList };
}
