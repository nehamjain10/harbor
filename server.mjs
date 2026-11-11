// Harbor server entry: wires the modules in server/ together and starts listening.
import fs from 'node:fs';
import { createApp } from './server/app.mjs';
import { createClusters } from './server/clusters.mjs';
import { createCommandCatalog } from './server/commands.mjs';
import { SHUTDOWN_GRACE_MS, loadConfig } from './server/config.mjs';
import { createEvents } from './server/events.mjs';
import { createImporter } from './server/importer.mjs';
import { createMcpManager } from './server/mcp.mjs';
import { createOpenRouterCatalog } from './server/openrouter.mjs';
import { readRelayKey, startGatewayProxy } from './server/gateway-proxy.mjs';
import { createRunner } from './server/runner.mjs';
import { listenOnSocket } from './server/socket.mjs';
import { createStore, publicSession } from './server/store.mjs';
import { createUploads } from './server/uploads.mjs';
import { ensureHost, listHost } from './server/host-client.mjs';
import { proxyAddress, saveProxyAddress } from './server/proxy-address.mjs';

const config = loadConfig();
// The install directory holds the data and the socket by default; keep it private.
fs.chmodSync(config.repoDir, 0o700);

// Claude Code processes run in the CLI host and outlive server restarts: the ones the last
// server left running are taken back below, so their sessions are not "interrupted".
let hostProcs = [];
if (config.cliHostSocket) {
  try {
    await ensureHost({ socketPath: config.cliHostSocket, logFile: config.cliHostLog });
    hostProcs = await listHost(config.cliHostSocket);
  } catch (error) {
    console.error(`No CLI host (${error.message}); Claude Code processes end with this server.`);
    config.cliHostSocket = null;
  }
}
const liveSessions = new Set(hostProcs.filter((proc) => proc.key.startsWith('s:')).map((proc) => proc.key.slice(2)));

const store = createStore({ dataDir: config.dataDir });
store.load({ live: liveSessions });
// persist: a long session is written off the event loop (store.mjs).
const events = createEvents({ save: store.persist, toPublic: publicSession });
// Non-Claude models reach the gateway through the tool-input normalizing proxy.
// Same port and secret as last time: processes that outlived the last server use them.
const proxy = await startGatewayProxy({ upstream: config.gatewayUrl, upstreamKey: config.gatewayKey, relayKey: () => readRelayKey(config.relayKeyFile), ...proxyAddress(config.dataDir) });
saveProxyAddress(config.dataDir, proxy);
const gateway = { url: proxy.url, apiKey: proxy.secret };
const uploads = createUploads({ dataDir: config.dataDir });
uploads.load();
// Sessions can run on other clusters over ssh; runner and app share what is known of them.
const clusters = createClusters({ list: config.clusters });
const runner = createRunner({ config, events, gateway, uploads, clusters });
const commands = createCommandCatalog({ config, gateway });
const mcp = createMcpManager({ config, gateway, runner });
const importer = createImporter({ config, store, events });
// The OpenRouter models (the disk cache now, a fetch in the background, then every 6 h):
// before the queued turns below start, so an `or:` session knows its model's window.
const openrouter = createOpenRouterCatalog({ dataDir: config.dataDir });
void openrouter.start();
const app = createApp({ config, store, events, runner, uploads, commands, importer, mcp, clusters, openrouter });

const server = await listenOnSocket(app, config.socketPath);
console.log('Claude Workbench listening on private socket');
// Compress the bundle now rather than on the first page load after a deploy.
app.locals.warmAssets().catch((error) => console.error('Could not prepare the frontend bundle:', error.message));

process.on('SIGTERM', () => {
  // With the CLI host every process carries on for the next server; without it they end.
  if (config.cliHostSocket) runner.detach();
  else runner.shutdown();
  store.saveAll();
  server.close();
  // Give aborted turns a moment to record their notice, then exit.
  setTimeout(() => {
    void proxy.close();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS).unref();
});

if (hostProcs.length) {
  const taken = await runner.reattach(hostProcs, (id) => store.sessions.get(id));
  if (taken.length) console.log(`Took back ${taken.length} Claude Code process(es) from the last server.`);
}
runner.startQueued(store.sessions.values());
runner.backfillTitles([...store.sessions.values()]);
// Sessions with recurring jobs get their Claude Code process back, so the jobs go on.
void runner.resumeScheduled([...store.sessions.values()]);
