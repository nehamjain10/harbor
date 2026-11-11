// The frontend's cluster helpers (src/lib/clusters.js): the list /api/info offers, the
// badge a session gets, the field a create request carries, the cluster a folder request
// names, and the folder a new chat on a cluster starts in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_CLUSTER, clusterFields, clusterFolder, clusterLabel, clusterList, clusterQuery, findCluster, folderClusterId, folderKey, isRemote } from '../src/lib/clusters.js';

const INFO = {
  clusters: [
    { id: 'local', label: 'Here', host: null, home: '/home/you' },
    { id: 'alpha', label: 'Alpha', host: 'alpha-login', home: '/srv/you' },
    { id: 'beta', label: 'Beta', host: 'beta-login', home: '/srv/you' },
  ],
};

test('without a `clusters` field the server is the only cluster and no picker shows', () => {
  assert.deepEqual(clusterList({ models: [] }), [{ ...LOCAL_CLUSTER }]);
  assert.deepEqual(clusterList(null), [{ ...LOCAL_CLUSTER }]);
  // An empty list is the same as a missing one.
  assert.deepEqual(clusterList({ clusters: [] }), [{ ...LOCAL_CLUSTER }]);
  assert.equal(clusterList({ models: [] }).length, 1);
});

test('clusterList keeps the server order, fills defaults and always has local first', () => {
  assert.deepEqual(clusterList(INFO).map((c) => c.id), ['local', 'alpha', 'beta']);
  // Without a local entry one is added in front; labels fall back to the id and
  // host/home are null when the server did not send them.
  const list = clusterList({ clusters: [{ id: 'alpha', host: 'alpha-login' }] });
  assert.deepEqual(list.map((c) => c.id), ['local', 'alpha']);
  assert.deepEqual(list[1], { id: 'alpha', label: 'alpha', host: 'alpha-login', home: null });
  // Entries without an id, and duplicates, are ignored.
  assert.deepEqual(clusterList({ clusters: [null, {}, { id: '' }, { id: 'alpha' }, { id: 'alpha' }] }).map((c) => c.id), ['local', 'alpha']);
});

test('findCluster falls back to the first (local) cluster', () => {
  const clusters = clusterList(INFO);
  assert.equal(findCluster(clusters, 'alpha').label, 'Alpha');
  assert.equal(findCluster(clusters, 'gone').id, 'local');
  assert.equal(findCluster([], 'alpha').id, 'local');
  assert.equal(findCluster(undefined, undefined).id, 'local');
});

test('only a non-local cluster is remote, and only it names itself in a create request', () => {
  const clusters = clusterList(INFO);
  assert.equal(isRemote(findCluster(clusters, 'local')), false);
  assert.equal(isRemote(findCluster(clusters, 'alpha')), true);
  assert.equal(isRemote(null), false);
  assert.deepEqual(clusterFields(findCluster(clusters, 'local')), {});
  assert.deepEqual(clusterFields(findCluster(clusters, 'alpha')), { cluster: 'alpha' });
  assert.deepEqual(clusterFields(undefined), {});
});

test('sessions on the local cluster get no badge; remote ones get its label', () => {
  const clusters = clusterList(INFO);
  assert.equal(clusterLabel(clusters, 'local'), null);
  // A session without a cluster field is local (sessions from before clusters existed).
  assert.equal(clusterLabel(clusters, undefined), null);
  assert.equal(clusterLabel(clusters, 'beta'), 'Beta');
  // A cluster this page does not know (a newer server) shows its id rather than nothing.
  assert.equal(clusterLabel(clusters, 'newcluster'), 'newcluster');
});

test('a new chat on a cluster starts in its last folder, else its home', () => {
  const clusters = clusterList(INFO);
  assert.equal(clusterFolder(findCluster(clusters, 'alpha'), '/srv/you/proj'), '/srv/you/proj');
  assert.equal(clusterFolder(findCluster(clusters, 'alpha'), null), '/srv/you');
  assert.equal(clusterFolder({ id: 'alpha', home: null }, undefined), '');
});

test('a request about a folder names its remote cluster, and none for the local one', () => {
  const clusters = clusterList(INFO);
  // The server takes no `cluster` as this machine, so the local cluster is left out.
  assert.equal(clusterQuery(findCluster(clusters, 'alpha')), '&cluster=alpha');
  assert.equal(clusterQuery('alpha'), '&cluster=alpha');
  assert.equal(clusterQuery(findCluster(clusters, 'local')), '');
  assert.equal(clusterQuery('local'), '');
  assert.equal(clusterQuery(undefined), '');
  // The same fields, as a body or query object (clusterFields takes an id too).
  assert.deepEqual(clusterFields('alpha'), { cluster: 'alpha' });
  assert.deepEqual(clusterFields('local'), {});
  assert.deepEqual(clusterFields('beta'), { cluster: 'beta' });
});

test('caches about a folder are keyed by its cluster too', () => {
  const clusters = clusterList(INFO);
  assert.equal(folderKey(findCluster(clusters, 'local'), '/p'), '/p');
  assert.equal(folderKey('alpha', '/p'), 'alpha\0/p');
  // Home paths are the same on both machines: the folders are not.
  assert.notEqual(folderKey('alpha', '/srv/you'), folderKey('local', '/srv/you'));
  assert.equal(folderKey(undefined, '/p'), '/p');
});

test('folder requests use the open session’s cluster, else the new chat’s', () => {
  const clusters = clusterList(INFO);
  assert.equal(folderClusterId({ clusters, cluster: 'alpha' }), 'alpha');
  // With a session open its own cluster wins (commands and agents are there).
  assert.equal(folderClusterId({ clusters, cluster: 'alpha', current: { cluster: 'beta' } }), 'beta');
  // Sessions from before clusters existed, and no state at all, are local.
  assert.equal(folderClusterId({ clusters, current: { cwd: '/p' } }), 'local');
  assert.equal(folderClusterId(undefined), 'local');
});
