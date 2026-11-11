// Routes of the settings dialog: Claude Code's settings.json (permissions, hooks), CLAUDE.md
// files and the auto-memory folder of a project. The files and the rules about them are in
// settings-files.mjs; this module checks the request, then after a write tells the runner
// which live Claude Code processes read stale settings.
import fs from 'node:fs';
import { isRemote } from './clusters.mjs';
import { httpError } from './errors.mjs';
import { projectPath } from './files.mjs';

const FILE_SCOPES = ['user', 'project', 'local'];

/** The parsed JSON body; requests that need one fail with 400 without it. */
function jsonBody(req) {
  if (!req.body || typeof req.body !== 'object') throw httpError(400, 'Send a JSON request body.');
  return req.body;
}

/** The version the editor started from: a string, or null for a file that did not exist. */
function versionOf(value) {
  if (value === null || typeof value === 'string') return value;
  throw httpError(400, 'Send the version of the file you edited (null when creating it).');
}

/**
 * @param {object} app  the Express app
 * @param {object} deps
 * @param {object} deps.settings  from createSettingsFiles()
 * @param {object} deps.store     from createStore()
 * @param {object} deps.runner    from createRunner()
 * @param {string} deps.root      the home directory every project lives in
 */
export function registerSettingsRoutes(app, { settings, store, runner, root }) {
  /** A project folder from a request (query or body): a directory inside the home directory. */
  async function project(value, { required = true } = {}) {
    if (value === undefined || value === '') {
      if (required) throw httpError(400, 'Choose a project folder.');
      return null;
    }
    if (typeof value !== 'string') throw httpError(400, 'Choose a project folder.');
    try {
      return await projectPath(value, root);
    } catch (error) {
      if (error.status) throw error;
      throw httpError(400, 'Choose a project folder that exists inside your home directory.');
    }
  }

  const sameFolder = (sessionCwd, cwd) => {
    if (sessionCwd === cwd) return true;
    try {
      return fs.realpathSync(sessionCwd) === cwd;
    } catch {
      return false;
    }
  };

  /**
   * After a write: the live Claude Code processes that read the old file (every session
   * for the user scope, the project's sessions otherwise) restart when idle. Returns how
   * many were marked.
   */
  function restartAffected(affects) {
    if (!affects) return 0;
    // A remote session reads its cluster's files, never these.
    const sessions = [...store.sessions.values()].filter((session) => !isRemote(session) && (!affects.cwd || sameFolder(session.cwd, affects.cwd)));
    return runner.settingsChanged(sessions);
  }

  const written = ({ file, changed, affects }) => ({ ...file, changed, restartsPending: restartAffected(affects) });

  /** A stale write answers 409 with the file as it is now; everything else goes to the error handler. */
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (!error.conflict) throw error;
      res.status(409).json({ error: error.message, conflict: true, current: error.current });
    }
  };

  const fileScope = (value) => {
    if (!FILE_SCOPES.includes(value)) throw httpError(404, 'Unknown settings scope.');
    return value;
  };
  // Project and local files need a project folder; the user's do not.
  const scopeCwd = (scope, value) => project(value, { required: scope !== 'user' });

  app.get('/api/settings/files', handle(async (req, res) => {
    res.json(await settings.list(await project(req.query.cwd, { required: false })));
  }));

  app.get('/api/settings/files/:scope/:id', handle(async (req, res) => {
    const scope = fileScope(req.params.scope);
    res.json(await settings.read(scope, req.params.id, await scopeCwd(scope, req.query.cwd)));
  }));

  // Replaces a whole file: `{cwd, content, version}`.
  app.put('/api/settings/files/:scope/:id', handle(async (req, res) => {
    const scope = fileScope(req.params.scope);
    const body = jsonBody(req);
    const cwd = await scopeCwd(scope, body.cwd);
    res.json(written(await settings.write(scope, req.params.id, cwd, { content: body.content, version: versionOf(body.version) })));
  }));

  // Changes the permissions and/or hooks of a settings file: `{cwd, version, permissions?, hooks?}`.
  app.patch('/api/settings/files/:scope/:id', handle(async (req, res) => {
    const scope = fileScope(req.params.scope);
    const body = jsonBody(req);
    const cwd = await scopeCwd(scope, body.cwd);
    if (body.permissions === undefined && body.hooks === undefined) throw httpError(400, 'Send the permissions or hooks to change.');
    const result = await settings.patchSettings(scope, req.params.id, cwd, { version: versionOf(body.version), permissions: body.permissions, hooks: body.hooks });
    res.json(written(result));
  }));

  app.get('/api/settings/memory', handle(async (req, res) => {
    res.json(await settings.memoryList(await project(req.query.cwd)));
  }));

  app.get('/api/settings/memory/:name', handle(async (req, res) => {
    res.json(await settings.memoryRead(await project(req.query.cwd), req.params.name));
  }));

  // Creates (`version: null`) or replaces a memory: `{cwd, content, version, index?: {title, hook}}`.
  app.put('/api/settings/memory/:name', handle(async (req, res) => {
    const body = jsonBody(req);
    const cwd = await project(body.cwd);
    const index = body.index && typeof body.index === 'object' ? body.index : undefined;
    res.json(written(await settings.memoryWrite(cwd, req.params.name, { content: body.content, version: versionOf(body.version), index })));
  }));

  app.delete('/api/settings/memory/:name', handle(async (req, res) => {
    const cwd = await project(req.query.cwd);
    if (typeof req.query.version !== 'string') throw httpError(400, 'Send the version of the memory you are deleting.');
    const result = await settings.memoryDelete(cwd, req.params.name, { version: req.query.version });
    res.json({ deleted: true, name: result.name, restartsPending: restartAffected(result.affects) });
  }));
}
