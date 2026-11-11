# Harbor

A private web workbench for Claude Code: chats with Claude and gateway models, model
workers, subagents, background tasks, MCP servers, settings and session import from the
Claude Code and Codex CLIs. It runs on one machine behind Tailscale and serves the browser
over a unix socket.

- Server: Express 5 (`server.mjs`, `server/`), driving the Claude Code CLI through the
  Claude Agent SDK.
- Client: Preact, bundled with esbuild (`src/`, `public/`).

## Run

```bash
npm install
npm run build
WORKBENCH_OWNER=<tailscale-login> WORKBENCH_HOST=<host> node server.mjs
```

Or copy `local.env.example` to `local.env`, fill it in and start `./run.sh`, which loads
it and restarts the server when it exits. `local.env.example` lists every setting: the
model gateway and its Claude relay, the usage dashboard link, the default project, remote
clusters (`WORKBENCH_CLUSTERS_FILE`) and changes to the model catalog
(`WORKBENCH_CATALOG_FILE`, described at the top of `server/catalog.mjs`).

## Test

```bash
npm test                 # unit
npm run test:browser     # Chromium against a mocked server
npm run test:integration # real server and Claude Code CLI against a mock gateway
npm run test:e2e         # end to end
```
