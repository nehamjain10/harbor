// HTTP layer: security headers, Tailscale identity check, JSON API routes, static files.
// Talks to the runner and store through their public functions only.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { createAgentTranscripts } from './agent-transcript.mjs';
import { DEFAULT_CLUSTERS, LOCAL_CLUSTER, createClusters, isRemote, sessionCluster } from './clusters.mjs';
import { parseApprovalChoice, ruleString } from './approvals.mjs';
import { createCommandCatalog, toCommandList } from './commands.mjs';
import { GATEWAY_PLACEHOLDER_KEY, HEARTBEAT_MS, MAX_MESSAGE_LENGTH, MAX_QUEUED_MESSAGES } from './config.mjs';
import { httpError } from './errors.mjs';
import { createFileSearch } from './file-search.mjs';
import { createForks } from './fork.mjs';
import { createChangesCache, listProjects, previewFile, projectPath, writtenFiles } from './files.mjs';
import { createImporter } from './importer.mjs';
import { createMcpManager } from './mcp.mjs';
import { modelAgentList } from './model-agents.mjs';
import { createModelSettings } from './model-settings.mjs';
import { createOpenRouterCatalog } from './openrouter.mjs';
import { createRemoteFiles } from './remote-files.mjs';
import { DEFAULT_MODEL, MODELS, MODE_OPTIONS, isKnownModel, reloadCatalog, validEffort } from './models.mjs';
import { createSettingsFiles } from './settings-files.mjs';
import { registerSettingsRoutes } from './settings-routes.mjs';
import { createStaticAssets } from './static.mjs';
import { DEFAULT_MODE, createSession, normalizeMode, publicMessage, publicSession } from './store.mjs';
import { DEFAULT_PAGE, parseLimit, windowStart } from './tail.mjs';
import { listTasks, readTaskOutput } from './tasks.mjs';
import { DRAFT_SCOPE, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, createUploads, publicAttachment, readHead, sniffImageType } from './uploads.mjs';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
};

const GATEWAY_PROBE_TIMEOUT_MS = 3000;
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_LOCAL_IMAGE_BYTES = 50 * 1024 * 1024;
const UPLOAD_CACHE_CONTROL = 'private, max-age=86400, immutable';

// JSON responses at least this large are compressed. The browser is remote (Tailscale,
// often through a relay), and a long session is about 1 MB of JSON, so transfer, not
// the server, is what makes opening one slow. Brotli at quality 4 shrinks it ~4x in
// a few ms (off the event loop); gzip for clients without br.
const COMPRESS_MIN_BYTES = 1024;
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const COMPRESSORS = {
  br: (text) => brotli(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text) } }),
  gzip: (text) => gzip(text, { level: 6 }),
};

/** A Content-Disposition value with an ASCII fallback and the UTF-8 file name. */
function contentDisposition(kind, name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** The parsed JSON body; requests that need one fail with 400 without it. */
function jsonBody(req) {
  if (!req.body || typeof req.body !== 'object') throw httpError(400, 'Send a JSON request body.');
  return req.body;
}

const refuse = (status, error) => ({ rejection: { status, error } });

/**
 * Middleware: `res.json` compresses large bodies with br or gzip when the client accepts
 * it. Only `res.json` is affected, so the event stream (`res.write`) is never buffered.
 */
export function compressJson(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    const text = JSON.stringify(body);
    if (typeof text !== 'string') return json(body);
    res.vary('Accept-Encoding');
    const encoding = text.length < COMPRESS_MIN_BYTES ? null : ['br', 'gzip'].find((name) => req.acceptsEncodings(name) === name);
    if (!encoding) return json(body);
    COMPRESSORS[encoding](text).then(
      (data) => {
        if (res.headersSent) return;
        res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': encoding });
        res.send(data);
      },
      () => {
        if (!res.headersSent) json(body);
      },
    );
    return res;
  };
  next();
}

/**
 * Checks a PATCH body against the session without touching it. Returns either
 * `{changes}` (normalized values to apply) or `{rejection: {status, error}}`.
 * Checks run in v1's order so the same request gets the same error.
 */
export function parseSessionPatch(session, body, { running }) {
  const changes = {};
  if (body.effort !== undefined && !validEffort(body.model || session.model, body.effort)) {
    return refuse(400, 'Unsupported effort for this model');
  }
  // Model and mode may change mid-turn: a new model applies from the next turn, a new
  // mode is applied to the running turn at once.
  if (body.model) {
    if (!isKnownModel(body.model)) return refuse(400, 'Unknown model');
    changes.model = body.model;
  }
  if (body.mode) {
    const mode = normalizeMode(body.mode);
    if (!mode) return refuse(400, 'Unknown mode');
    changes.mode = mode;
  }
  if (body.effort !== undefined) changes.effort = body.effort;
  if (typeof body.removed === 'boolean') {
    if (running) return refuse(409, 'Stop the session before removing it.');
    changes.removed = body.removed;
  }
  if (typeof body.archived === 'boolean') {
    if (running) return refuse(409, 'Stop the session before archiving.');
    changes.archived = body.archived;
  }
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== 'string') return refuse(400, 'The title must be text.');
    // Blank titles are ignored, as in v1.
    if (body.title.trim()) changes.title = body.title.trim().slice(0, 100);
  }
  // Sidebar flags; allowed while running.
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') return refuse(400, 'Pinned must be true or false.');
    changes.pinned = body.pinned;
  }
  if (body.viewed !== undefined) {
    if (body.viewed !== true) return refuse(400, 'Viewed can only be true.');
    changes.viewed = true;
  }
  // "Allow always" grants can only be revoked, never added from here: the body lists the
  // grants to keep (some of the current ones; `[]` clears them all).
  for (const field of ['allowRules', 'allowDirectories']) {
    if (body[field] === undefined) continue;
    const kept = keptGrants(session[field] ?? [], body[field], GRANTS[field]);
    if (!kept) return refuse(400, 'Grants can only be removed.');
    changes[field] = kept;
  }
  return { changes };
}

// The two kinds of grant: what one looks like, and how two are told apart.
const GRANTS = {
  allowRules: { valid: (item) => Boolean(item) && typeof item === 'object' && typeof item.toolName === 'string', key: ruleString },
  allowDirectories: { valid: (item) => typeof item === 'string', key: String },
};

/**
 * The grants of `current` that `keep` names (in `current`'s order), or null when `keep` is
 * not a list of grants or names one `current` does not have.
 */
function keptGrants(current, keep, { valid, key }) {
  if (!Array.isArray(keep) || !keep.every(valid)) return null;
  const wanted = new Set(keep.map(key));
  const have = new Set(current.map(key));
  if ([...wanted].some((id) => !have.has(id))) return null;
  return current.filter((item) => wanted.has(key(item)));
}

/** Applies validated changes. Effort is recorded for the (possibly new) model. */
function applySessionPatch(session, changes) {
  if ('model' in changes) session.model = changes.model;
  if ('mode' in changes) session.mode = changes.mode;
  if ('effort' in changes) {
    session.efforts ??= {};
    session.efforts[session.model] = changes.effort;
  }
  if ('removed' in changes) {
    session.removed = changes.removed;
    session.queuePaused = true;
  }
  if ('archived' in changes) session.archived = changes.archived;
  if ('title' in changes) {
    session.title = changes.title;
    session.titleAuto = false; // named by the user: Haiku leaves it alone
  }
  if ('pinned' in changes) session.pinned = changes.pinned;
  if (changes.viewed) session.lastViewedAt = Date.now();
  if (changes.allowRules) session.allowRules = changes.allowRules;
  if (changes.allowDirectories) session.allowDirectories = changes.allowDirectories;
}

/**
 * @param {object} deps
 * @param {object} deps.config  from loadConfig()
 * @param {object} deps.store   from createStore()
 * @param {object} deps.events  from createEvents()
 * @param {object} deps.runner  from createRunner()
 * @param {object} [deps.uploads]     from createUploads() (share it with the runner)
 * @param {object} [deps.commands]    from createCommandCatalog()
 * @param {object} [deps.mcp]         from createMcpManager()
 * @param {object} [deps.fileSearch]  from createFileSearch()
 * @param {object} [deps.importer]    from createImporter()
 * @param {object} [deps.agentTranscripts]  from createAgentTranscripts()
 * @param {object} [deps.settingsFiles]  from createSettingsFiles()
 * @param {object} [deps.forks]  from createForks()
 * @param {object} [deps.clusters]  from createClusters() (share it with the runner)
 * @param {object} [deps.remoteFiles]  from createRemoteFiles(): a remote session's folder over ssh
 * @param {object} [deps.openrouter]  from createOpenRouterCatalog(): the picker's OpenRouter models
 */
export function createApp({
  config,
  store,
  events,
  runner,
  uploads = createUploads({ dataDir: config.dataDir }),
  commands = createCommandCatalog({ config, gateway: { url: config.gatewayUrl, apiKey: config.gatewayKey || GATEWAY_PLACEHOLDER_KEY } }),
  mcp = createMcpManager({ config, gateway: { url: config.gatewayUrl, apiKey: config.gatewayKey || GATEWAY_PLACEHOLDER_KEY }, runner }),
  fileSearch = createFileSearch(),
  importer = createImporter({ config, store, events }),
  agentTranscripts = createAgentTranscripts({ config }),
  settingsFiles = createSettingsFiles({ config }),
  // Without a configured list (tests) only this machine: nothing is asked over ssh.
  clusters = createClusters({ list: config.clusters ?? DEFAULT_CLUSTERS.filter((cluster) => !cluster.host) }),
  forks = createForks({ config, store, events, uploads, clusters }),
  modelSettings = createModelSettings({ dataDir: config.dataDir }),
  remoteFiles = createRemoteFiles(),
  openrouter = createOpenRouterCatalog({ dataDir: config.dataDir }),
}) {
  const { owner, origin, homeRoot: root } = config;
  const changes = createChangesCache();
  // Keyed by cluster and folder, like the local cache by folder.
  const remoteChanges = createChangesCache({
    run: (key) => {
      const [id, cwd] = key.split('\0');
      return remoteFiles.changes(clusters.get(id), cwd);
    },
  });
  // A remote session's folder is on its cluster (remote-files.mjs): `@` candidates are
  // listed there, keyed by cluster and folder.
  const remoteSearch = createFileSearch({
    list: (key) => {
      const [id, cwd] = key.split('\0');
      return remoteFiles.entries(clusters.get(id), cwd);
    },
  });
  const remoteCluster = (session) => (isRemote(session) ? clusters.get(sessionCluster(session)) : null);
  // Requests about a folder name its cluster (`cluster`); none means this machine.
  const requestCluster = (value) => clusters.get(typeof value === 'string' && value ? value : LOCAL_CLUSTER);
  // The full form plus the revision of the last `delta` event it includes (see events.mjs).
  const fullSession = (session) => {
    const pub = publicSession(session, true);
    return { ...pub, rev: events.revision(session, pub) };
  };
  // The full form with only the recent end of the messages (see tail.mjs): those from
  // `messagesFrom` on, of `messageCount`. Only they are serialized, here and for the rev.
  const tailSession = (session, count) => {
    const from = windowStart(session.messages, { limit: count, currentMessageId: session.currentMessageId });
    const { rev, pub } = events.tailRevision(session, from);
    const { messages, ...fields } = pub;
    return { ...fields, messages: messages.slice(from), messagesFrom: from, messageCount: messages.length, rev };
  };
  // `?tail=N` asks for the tail form; without it, the full form (as before tails).
  const sessionForm = (req, session) => {
    if (req.query.tail === undefined) return fullSession(session);
    const count = parseLimit(req.query.tail);
    if (!count) throw httpError(400, 'The tail must be a number of messages.');
    return tailSession(session, count);
  };
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    if (req.get('Tailscale-User-Login') !== owner) {
      return res.status(403).json({ error: 'Connect with your Tailscale account to open this workspace.' });
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.get('Origin') !== origin) {
      return res.status(403).json({ error: 'Invalid origin' });
    }
    next();
  });

  // Composer uploads take the raw body (any type, up to 50 MB), so this route comes
  // before the JSON parser. `scope` is a session id or `draft`.
  app.post('/api/uploads', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const scope = String(req.query.scope ?? '');
    if (scope !== DRAFT_SCOPE && !store.sessions.has(scope)) {
      return res.status(400).json({ error: 'Upload to an existing session or as a draft.' });
    }
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const record = await uploads.save({ scope, name: String(req.query.name ?? ''), type: req.get('Content-Type'), data });
    res.json(publicAttachment(record));
  });
  app.use('/api/uploads', (err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Files can be at most 50 MB.' });
    next(err);
  });

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', compressJson);

  app.get('/api/info', async (req, res) => {
    let gateway = false;
    try {
      const response = await fetch(config.gatewayUrl + '/v1/models', {
        headers: { 'x-api-key': config.gatewayKey || GATEWAY_PLACEHOLDER_KEY },
        signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS),
      });
      gateway = response.ok;
    } catch {
      // Gateway down or slow: report it as unavailable.
    }
    // WORKBENCH_DEFAULT_PROJECT (absolute, or relative to the home folder) when it exists.
    const preferred = config.defaultProject ? path.resolve(root, config.defaultProject) : null;
    res.json({
      owner,
      root,
      models: MODELS,
      modes: MODE_OPTIONS,
      gateway,
      defaultProject: preferred && fs.existsSync(preferred) ? preferred : root,
      dashboard: config.dashboardUrl,
      // Where a new session can run (clusters.mjs): [{id, label, host, home}].
      clusters: await clusters.publicList(),
    });
  });

  // The OpenRouter models with a zero-data-retention endpoint (the picker's side menu);
  // a session runs one as `or:<id>`.
  app.get('/api/openrouter-models', async (req, res) => {
    const list = await openrouter.list();
    if (!list.length) return res.status(502).json({ error: 'Could not load the OpenRouter models.' });
    res.json(list);
  });

  // Per-model settings (Settings > Models): each model's context window and fast mode.
  app.get('/api/model-settings', (req, res) => {
    res.json(modelSettings.get());
  });

  app.put('/api/model-settings', (req, res) => {
    const { context, fast } = req.body || {};
    if (context === undefined && fast === undefined) return res.json(modelSettings.setContext(context));
    if (context !== undefined) modelSettings.setContext(context);
    res.json(fast !== undefined ? modelSettings.setFast(fast) : modelSettings.get());
  });

  app.get('/api/sessions', (req, res) => {
    res.json(store.list().map((session) => publicSession(session)));
  });

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const unsubscribe = events.subscribe(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /** A new session's settings from a request body; throws 400 for bad ones. */
  async function newSessionParams(body) {
    const cluster = requestCluster(body.cluster);
    // A remote folder is checked on its cluster (and defaults to its home there).
    const cwd = cluster.host ? await clusters.remoteFolder(cluster, body.cwd) : await projectPath(body.cwd || root, root);
    const model = body.model || DEFAULT_MODEL;
    if (!isKnownModel(model)) throw httpError(400, 'Unknown model');
    const effort = body.effort || 'default';
    if (!validEffort(model, effort)) throw httpError(400, 'Unsupported effort for this model');
    // Only an absent mode gets the v1 default; anything unrecognized is refused.
    const modeGiven = body.mode !== undefined && body.mode !== null && body.mode !== '';
    const mode = modeGiven ? normalizeMode(body.mode) : DEFAULT_MODE;
    if (!mode) throw httpError(400, 'Unknown mode');
    return { cwd, model, mode, effort, cluster: cluster.id };
  }
  const paramsKey = ({ cwd, model, mode, effort, cluster }) => JSON.stringify([cwd, model, mode, effort, cluster]);

  app.post('/api/sessions', async (req, res) => {
    const body = jsonBody(req);
    const params = await newSessionParams(body);
    const title = body.title || 'New session';
    // Prepared while the first message was written (POST /api/sessions/prepare): its
    // Claude Code process is already up.
    const adopted = typeof body.prepareId === 'string' ? runner.adopt?.(body.prepareId, paramsKey(params)) : null;
    if (adopted) {
      const now = Date.now();
      Object.assign(adopted, { title: title.slice(0, 100), createdAt: now, updatedAt: now });
    }
    const session = store.insert(adopted || createSession({ ...params, title }));
    // Its cluster gets this machine's Claude Code now, not on the first message.
    if (isRemote(session)) runner.readyCluster?.(session);
    events.flush(session);
    res.json(fullSession(session));
  });

  // A new chat's first message is being written: its session is made and its Claude Code
  // process started now, unlisted until the send adopts it (`prepareId`).
  app.post('/api/sessions/prepare', async (req, res) => {
    const params = await newSessionParams(jsonBody(req));
    const prepareId = runner.prepare ? runner.prepare(createSession(params), paramsKey(params)) : null;
    res.json({ prepareId });
  });

  // `?rev=N`: the client holds the copy of revision N (kept current by delta events). When
  // that is still the session, the answer says so instead of sending it all again (a long
  // session is megabytes, sent on every switch back to it).
  // `?tail=N`: only the recent end of the messages (tail.mjs), with `messagesFrom` and
  // `messageCount`; older ones come from GET /api/sessions/:id/messages.
  app.get('/api/sessions/:id', (req, res) => {
    const session = store.get(req.params.id);
    const full = sessionForm(req, session);
    if (req.query.rev !== undefined && String(full.rev) === String(req.query.rev)) {
      return res.json({ id: session.id, rev: full.rev, unchanged: true });
    }
    res.json(full);
  });

  // Older messages for a client holding a tail: the page before index `before` (the first
  // message it holds; `beforeId` is that message's id, so a list that changed since is
  // read where that message is now), of about `limit` messages, cut so that what the
  // client then holds is complete (tail.mjs). `rev`: the revision whose messages these
  // are (events.mjs pageRevision).
  app.get('/api/sessions/:id/messages', (req, res) => {
    const session = store.get(req.params.id);
    const { messages } = session;
    const given = req.query.before;
    let before = given === undefined ? messages.length : typeof given === 'string' && /^\d{1,9}$/.test(given) ? Number(given) : -1;
    if (before < 0 || before > messages.length) {
      return res.status(400).json({ error: 'Before must be the index of a message.' });
    }
    const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId : '';
    if (beforeId && messages[before]?.id !== beforeId) {
      before = messages.findIndex((m) => m.id === beforeId);
      if (before < 0) return res.status(409).json({ error: 'This conversation changed. Open it again to see it.' });
    }
    const limit = req.query.limit === undefined ? DEFAULT_PAGE : parseLimit(req.query.limit);
    if (!limit) return res.status(400).json({ error: 'The limit must be a number of messages.' });
    const from = windowStart(messages, { end: before, limit, currentMessageId: session.currentMessageId });
    const rev = events.pageRevision(session, from);
    res.json({ messages: messages.slice(from, before).map(publicMessage), from, before, messageCount: messages.length, rev });
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const session = store.get(req.params.id);
    const { changes, rejection } = parseSessionPatch(session, jsonBody(req), {
      running: runner.isRunning(session.id),
    });
    if (rejection) return res.status(rejection.status).json({ error: rejection.error });
    applySessionPatch(session, changes);
    // A new mode reaches the live Claude Code process at once; revoked grants restart it.
    runner.sessionChanged(session, changes);
    // A patch never touches the messages, so the reply is the list form (for a long
    // session the full form is ~1 MB) with the revision it belongs to: a client that
    // already applied a newer delta keeps that (see src/store.js updateSession).
    const rev = events.announce(session);
    res.json({ ...publicSession(session), rev });
  });

  // Deletes trashed sessions for good (Harbor's copy; Claude Code's own transcript in
  // ~/.claude stays). One that is still working, or has a process or workers up, is kept.
  function deleteTrashed(sessions) {
    const ids = [];
    for (const session of sessions) {
      if (!session.removed) continue;
      if (runner.isRunning(session.id) || runner.pool.get(session.id) || runner.modelAgents.running(session.id) > 0) continue;
      store.remove(session.id);
      ids.push(session.id);
    }
    if (ids.length) events.broadcast('deleted', { ids });
    return ids;
  }

  app.post('/api/trash/empty', (req, res) => {
    const trashed = store.list().filter((session) => session.removed);
    const ids = deleteTrashed(trashed);
    res.json({ deleted: ids, kept: trashed.length - ids.length });
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const session = store.get(req.params.id);
    if (!session.removed) return res.status(409).json({ error: 'Move it to Trash first.' });
    const ids = deleteTrashed([session]);
    if (!ids.length) return res.status(409).json({ error: 'It is still running. Try again in a moment.' });
    res.json({ deleted: ids });
  });

  // The untruncated copy of one message (pushed copies cut long tool output).
  app.get('/api/sessions/:id/messages/:messageId', (req, res) => {
    const message = store.get(req.params.id).messages.find((m) => m.id === req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  });

  // The user is writing to a session whose Claude Code process is not running (closed
  // when idle, or since a restart): start it now, so the message does not wait for it.
  app.post('/api/sessions/:id/warm', (req, res) => {
    const session = store.get(req.params.id);
    res.json({ started: Boolean(runner.warm?.(session)) });
  });

  app.post('/api/sessions/:id/messages', (req, res) => {
    const session = store.get(req.params.id);
    const body = jsonBody(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const attachmentIds = body.attachments ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS) {
      return res.status(400).json({ error: `Attach at most ${MAX_ATTACHMENTS} files.` });
    }
    if (!text && !attachmentIds.length) return res.status(400).json({ error: 'Write a message first.' });
    if (text.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: 'This message is too long.' });
    // A retried send (same clientId) is acknowledged without queueing it twice.
    // (A message to a model agent is nested under its card and never counts here.)
    if (body.clientId && session.messages.some((m) => m.clientId === body.clientId && !m.parentToolId)) return res.json({ ok: true });
    if (body.queue !== undefined && typeof body.queue !== 'boolean') return res.status(400).json({ error: 'Queue must be true or false.' });
    if ((session.queue?.length ?? 0) + (session.steering?.length ?? 0) >= MAX_QUEUED_MESSAGES) {
      return res
        .status(429)
        .json({ error: `There are ${MAX_QUEUED_MESSAGES} messages queued. Wait for a turn to finish.` });
    }
    // Drafts move into the session's folder here; ids from other sessions are refused.
    const attachments = uploads.claim([...new Set(attachmentIds)], session.id).map(publicAttachment);
    // While a turn runs, a plain message goes to Claude at once (steering) unless the
    // client asks to queue it for after the turn.
    const { queued, steering } = runner.enqueue(session, { text, clientId: body.clientId, attachments, queue: body.queue === true });
    res.json({ ok: true, queued, ...(steering ? { steering: true } : {}) });
  });

  app.post('/api/sessions/:id/stop', (req, res) => {
    runner.stop(store.get(req.params.id));
    res.json({ ok: true });
  });

  // "Interrupt and send now": ends the current step so the messages sent mid-turn run at
  // once; unlike stop, nothing is paused and the session carries on.
  app.post('/api/sessions/:id/interrupt', async (req, res) => {
    const outcome = await runner.interrupt(store.get(req.params.id));
    if (outcome !== true) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true });
  });

  // Stops one subagent; the turn (or, for a background agent, the idle session) goes on.
  app.post('/api/sessions/:id/agents/:toolId/stop', async (req, res) => {
    const outcome = await runner.stopAgent(store.get(req.params.id), req.params.toolId);
    if (outcome !== true) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true });
  });

  // Background commands and Monitors (running and finished) and the scheduled jobs that
  // will wake the session (see tasks.mjs).
  app.get('/api/sessions/:id/tasks', (req, res) => {
    res.json(listTasks(store.get(req.params.id)));
  });

  // The end of a background task's output file (`?bytes=N`, at most 256 KB).
  app.get('/api/sessions/:id/tasks/:taskId/output', (req, res) => {
    const bytes = req.query.bytes === undefined ? undefined : parseLimit(req.query.bytes);
    if (req.query.bytes !== undefined && !bytes) throw httpError(400, 'bytes must be a positive number.');
    const output = readTaskOutput(store.get(req.params.id), req.params.taskId, { bytes });
    if (!output) throw httpError(404, 'This task has no output on disk.');
    res.json(output);
  });

  app.post('/api/sessions/:id/tasks/:taskId/stop', async (req, res) => {
    const outcome = await runner.stopTask(store.get(req.params.id), req.params.taskId);
    if (outcome !== true) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true });
  });

  // A message to a running model agent: it reads it at its next step and the message
  // shows under its card (nested user message, delivery sent -> done).
  app.post('/api/sessions/:id/agents/:toolId/message', (req, res) => {
    const body = jsonBody(req);
    const outcome = runner.messageAgent(store.get(req.params.id), req.params.toolId, {
      text: body.text,
      clientId: typeof body.clientId === 'string' && body.clientId ? body.clientId : undefined,
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true, messageId: outcome.messageId });
  });

  // A subagent's conversation from Claude Code's transcript on disk, for agents whose
  // steps the session did not capture live (see agent-transcript.mjs). Read only.
  app.get('/api/sessions/:id/agents/:toolId/transcript', async (req, res) => {
    const session = store.get(req.params.id);
    if (isRemote(session)) throw httpError(404, `Claude Code keeps this agent's transcript on ${remoteCluster(session).label}; only the steps recorded live are shown.`);
    res.json(await agentTranscripts.read(store.get(req.params.id), req.params.toolId));
  });

  // A new session with a copy of this one's conversation: whole, or before one of the
  // user's messages (`messageId`), whose text and attachments come back as its draft.
  // `?tail=N` answers with the new session's tail form (see GET /api/sessions/:id).
  app.post('/api/sessions/:id/fork', async (req, res) => {
    if (req.query.tail !== undefined && !parseLimit(req.query.tail)) throw httpError(400, 'The tail must be a number of messages.');
    const { session, draft } = await forks.fork(store.get(req.params.id), { messageId: req.body?.messageId });
    res.json({ session: sessionForm(req, session), ...(draft ? { draft } : {}) });
  });

  // Rewinds a session in place to before one of the user's messages (`messageId`), with
  // `code` also the files Claude edited since; `dryRun` answers what the code restore would
  // change. The message's text and attachments come back as `draft`.
  app.post('/api/sessions/:id/rewind', async (req, res) => {
    const { messageId, code, dryRun } = req.body ?? {};
    const hooks = { busy: runner.rewindBlocked, rewindFiles: runner.rewindFiles, restartCli: runner.restartCli };
    res.json(await forks.rewind(store.get(req.params.id), { messageId, code: code === true, dryRun: dryRun === true }, hooks));
  });

  app.post('/api/sessions/:id/queue/resume', (req, res) => {
    runner.resumeQueue(store.get(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/sessions/:id/queue/:messageId/cancel', async (req, res) => {
    const session = store.get(req.params.id);
    const steering = session.steering?.some((item) => item.id === req.params.messageId);
    if (!(await runner.cancelQueued(session, req.params.messageId))) {
      return res.status(409).json({ error: steering ? 'Claude has already read this message.' : 'This message has already started.' });
    }
    res.json({ ok: true });
  });

  app.post('/api/approvals/:id', (req, res) => {
    if (!runner.hasApproval(req.params.id)) {
      return res.status(409).json({ error: 'This request has already been resolved.' });
    }
    // {decision: allow|allowAlways|deny, reason?, answers?, mode?}, or v1's {allow: boolean}.
    const { choice, error } = parseApprovalChoice(jsonBody(req));
    if (error) return res.status(400).json({ error });
    const outcome = runner.resolveApproval(req.params.id, choice);
    if (outcome !== true) {
      return res.status(outcome?.status || 409).json({ error: outcome?.error || 'This request has already been resolved.' });
    }
    res.json({ ok: true });
  });

  // Attachment bytes with their stored type. Only raster images display inline; anything
  // else (svg, html, scripts, ...) downloads.
  app.get('/api/uploads/:id', (req, res, next) => {
    const record = uploads.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Upload not found' });
    // Only sniffed raster images display; everything else is opaque bytes, so an uploaded
    // .html/.js/.css can never run or style on this origin.
    const inline = record.image && INLINE_TYPES.has(record.type);
    res.set({
      'Content-Type': inline ? record.type : 'application/octet-stream',
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', record.name),
      'Cache-Control': UPLOAD_CACHE_CONTROL,
    });
    res.sendFile(record.path, { dotfiles: 'allow', cacheControl: false, etag: false, lastModified: false }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  });

  // Deploys that change only reloadable server files (the model catalog) call this instead
  // of restarting, so running agents carry on. Open pages are told to fetch /api/info again.
  app.post('/api/admin/reload', async (req, res) => {
    try {
      const catalog = await reloadCatalog();
      events.broadcast('info', {});
      res.json({ ok: true, catalog });
    } catch (error) {
      res.status(422).json({ error: error.message });
    }
  });

  // Composer event shapes from the browser (src/inputLog.js), for dictation apps whose
  // text goes missing. A rolling file: at 5 MB it becomes input-log.1.jsonl.
  app.post('/api/debug/input-log', (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 1000) : [];
    if (events.length) {
      const file = path.join(config.dataDir, 'input-log.jsonl');
      try {
        if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, path.join(config.dataDir, 'input-log.1.jsonl'));
      } catch {
        // no log yet
      }
      const ua = String(req.body.ua || '').slice(0, 200);
      fs.appendFileSync(file, events.map((event, i) => JSON.stringify(i ? event : { ...event, ua })).join('\n') + '\n', { mode: 0o600 });
    }
    res.json({ ok: true });
  });

  // Images the agent names by path (markdown `![…](/tmp/…/plot.png)`, a Read of a
  // .png). Any file the server can read, but only sniffed raster images: anything else
  // (svg, html…) is refused, so nothing served here can run on this origin. Relative
  // paths are the session's.
  app.get('/api/local-image', async (req, res, next) => {
    const imageSession = req.query.session ? store.get(String(req.query.session)) : null;
    // A remote session's agent names files on its cluster.
    if (remoteCluster(imageSession)) return remoteImage(req, res, imageSession);
    let value = String(req.query.path ?? '');
    if (value === '~' || value.startsWith('~/')) value = path.join(root, value.slice(1));
    if (!path.isAbsolute(value)) {
      if (!req.query.session) return res.status(400).json({ error: 'A relative image path needs its session.' });
      value = path.resolve(store.get(String(req.query.session)).cwd, value);
    }
    const file = await fs.promises.realpath(value).catch(() => null);
    const stats = file && (await fs.promises.stat(file).catch(() => null));
    if (!stats?.isFile()) return res.status(404).json({ error: 'Image not found' });
    if (stats.size > MAX_LOCAL_IMAGE_BYTES) return res.status(413).json({ error: 'This image is too large to show.' });
    const type = sniffImageType(await readHead(file));
    if (!type) return res.status(415).json({ error: 'Not a PNG, JPEG, GIF or WebP image.' });
    res.set({ 'Content-Type': type, 'Content-Disposition': contentDisposition('inline', path.basename(file)), 'Cache-Control': 'private, no-cache' });
    res.sendFile(file, { dotfiles: 'allow', cacheControl: false }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  });

  async function remoteImage(req, res, session) {
    const cluster = remoteCluster(session);
    let value = String(req.query.path ?? '');
    if (value === '~' || value.startsWith('~/')) value = (await clusters.home(cluster)) + value.slice(1);
    const file = path.posix.resolve(session.cwd, value);
    const data = await remoteFiles.readFile(cluster, file, MAX_LOCAL_IMAGE_BYTES);
    if (!data) return res.status(404).json({ error: 'Image not found' });
    const type = sniffImageType(data.subarray(0, 64));
    if (!type) return res.status(415).json({ error: 'Not a PNG, JPEG, GIF or WebP image.' });
    res.set({ 'Content-Type': type, 'Content-Disposition': contentDisposition('inline', path.posix.basename(file)), 'Cache-Control': 'private, no-cache' });
    res.end(data);
  }

  // `@` mentions: files and folders of a project folder (`cwd`, on `cluster`) or a session's folder.
  app.get('/api/complete/files', async (req, res) => {
    const session = req.query.session ? store.get(String(req.query.session)) : null;
    const cluster = session ? remoteCluster(session) : requestCluster(req.query.cluster).host && requestCluster(req.query.cluster);
    const cwd = session ? session.cwd : req.query.cwd;
    if (!cwd) return res.status(400).json({ error: 'Choose a project folder.' });
    if (cluster) {
      if (!path.posix.isAbsolute(String(cwd))) return res.status(400).json({ error: 'Choose a project folder.' });
      return res.json({ items: await remoteSearch.search(`${cluster.id}\0${path.posix.normalize(String(cwd))}`, String(req.query.q ?? '')) });
    }
    const project = await projectPath(String(cwd), root);
    res.json({ items: await fileSearch.search(project, String(req.query.q ?? '')) });
  });

  // `/` commands. Never fails: without a usable folder or CLI, the local commands remain.
  app.get('/api/commands', async (req, res) => {
    // A folder on another cluster: its commands are there, Harbor's own are listed.
    if (requestCluster(req.query.cluster).host) return res.json({ commands: toCommandList([]) });
    let cwd;
    try {
      cwd = await projectPath(String(req.query.cwd || root), root);
    } catch {
      return res.json({ commands: toCommandList([]) });
    }
    res.json({ commands: await commands.list(cwd) });
  });

  // The Agents view: Claude Code's subagents in a project and the model agents
  // (parallel workers on any model of the catalog, started with Harbor's delegate tool).
  app.get('/api/agents', async (req, res) => {
    let agents = [];
    try {
      if (requestCluster(req.query.cluster).host) throw new Error('on another cluster');
      const cwd = await projectPath(String(req.query.cwd || root), root);
      agents = await commands.agents(cwd);
    } catch {
      // Without a usable folder only the model agents are listed.
    }
    res.json({ agents, models: modelAgentList() });
  });

  // MCP servers (see mcp.mjs). Names contain spaces and colons ("claude.ai Slack",
  // "plugin:slack:slack"), so clients URL-encode them; they are checked against the
  // session's own list. Every write answers with the new state of the server.
  app.get('/api/sessions/:id/mcp', async (req, res) => {
    res.json(await mcp.list(store.get(req.params.id), { cached: req.query.cached === '1', fresh: req.query.fresh === '1' }));
  });

  // The servers of a project folder without a session, from a listing; read only.
  app.get('/api/mcp', async (req, res) => {
    if (requestCluster(req.query.cluster).host) return res.json({ live: false, route: req.query.route !== 'gateway' ? 'claude' : 'gateway', at: Date.now(), servers: null });
    const cwd = await projectPath(String(req.query.cwd || root), root);
    res.json(await mcp.listProject(cwd, req.query.route !== 'gateway'));
  });

  app.post('/api/sessions/:id/mcp/:name/toggle', async (req, res) => {
    const session = store.get(req.params.id);
    const result = await mcp.toggle(session, req.params.name, jsonBody(req).enabled);
    const rev = events.announce(session);
    res.json({ ok: true, ...result, rev });
  });

  app.post('/api/sessions/:id/mcp/:name/reconnect', async (req, res) => {
    res.json(await mcp.reconnect(store.get(req.params.id), req.params.name));
  });

  app.post('/api/sessions/:id/mcp/:name/auth', async (req, res) => {
    res.json(await mcp.authenticate(store.get(req.params.id), req.params.name));
  });

  app.post('/api/sessions/:id/mcp/:name/auth/callback', async (req, res) => {
    res.json(await mcp.submitCallback(store.get(req.params.id), req.params.name, jsonBody(req).url));
  });

  app.post('/api/sessions/:id/mcp/:name/auth/clear', async (req, res) => {
    res.json(await mcp.clearAuth(store.get(req.params.id), req.params.name));
  });

  // Session import: candidates from Claude Code or Codex, then the picked ones.
  app.get('/api/import/:source', async (req, res) => {
    res.json(await importer.list(req.params.source));
  });

  app.post('/api/import', async (req, res) => {
    res.json(await importer.importSessions(jsonBody(req)));
  });

  // Claude Code's settings.json, CLAUDE.md files and memory, edited from the settings dialog.
  // They are this machine's: a remote session's Claude Code reads its cluster's own.
  app.use('/api/settings', (req, res, next) => {
    if (requestCluster(req.query.cluster ?? req.body?.cluster).host) {
      return res.status(400).json({ error: 'Settings files of another cluster cannot be edited here. Edit them on that cluster.' });
    }
    next();
  });
  registerSettingsRoutes(app, { settings: settingsFiles, store, runner, root });

  app.get('/api/projects', async (req, res) => {
    res.json(await listProjects(req.query.path, root));
  });

  app.get('/api/sessions/:id/files', async (req, res) => {
    const session = store.get(req.params.id);
    const cluster = remoteCluster(session);
    if (cluster) return res.json(await remoteFiles.preview(cluster, session.cwd, req.query.path));
    res.json(await previewFile(session.cwd, req.query.path));
  });

  // Sessions in one folder share runs (see createChangesCache); `fresh=1` reruns git.
  app.get('/api/sessions/:id/changes', async (req, res) => {
    const session = store.get(req.params.id);
    const cluster = remoteCluster(session);
    if (cluster) return res.json(await remoteChanges(`${cluster.id}\0${session.cwd}`, null, { fresh: req.query.fresh === '1' }));
    res.json(await changes(session.cwd, root, { hints: writtenFiles(session.messages), fresh: req.query.fresh === '1' }));
  });

  // The v1 frontend loads these as ES modules; node_modules sits under a dot-folder.
  app.get('/vendor/marked.js', (req, res) => {
    res.sendFile(path.join(config.repoDir, 'node_modules/marked/lib/marked.esm.js'), { dotfiles: 'allow' });
  });
  app.get('/vendor/purify.js', (req, res) => {
    res.sendFile(path.join(config.repoDir, 'node_modules/dompurify/dist/purify.es.mjs'), { dotfiles: 'allow' });
  });

  // The page and the built bundle: compressed and cacheable (see static.mjs).
  const assets = createStaticAssets({ publicDir: config.publicDir });
  app.locals.warmAssets = assets.warm;
  app.get(['/', '/index.html'], assets.index);
  app.use('/dist', assets.dist);
  app.use(express.static(config.publicDir, { etag: false }));

  // Express 5 forwards rejected async handlers here too.
  app.use((err, req, res, next) => {
    console.error(err.message);
    if (!res.headersSent) res.status(err.status || 400).json({ error: err.message || 'Something went wrong.' });
  });

  return app;
}
