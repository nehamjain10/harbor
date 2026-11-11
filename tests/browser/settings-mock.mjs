// An in-memory stand-in for the /api/settings routes (server/settings-routes.mjs) for the
// browser tests: settings files, CLAUDE.md files and a project's memory, with the same
// versions, 409 conflicts and answers, but no disk. Add it to a page with
// `server.routes.push(mock.handle)`; change things behind the page's back with
// `mock.setFile` / `mock.setMemory` (that is how a test makes a file "change on disk").
import { MEMORY_NAME, addIndexLine, memoryTitle, parseFrontmatter, parseIndex, removeIndexLines } from '../../server/memory-format.mjs';
import { hooksProblem, hooksView, permissionsProblem, permissionsView, settingsProblem } from '../../server/settings-schema.mjs';

const hash = (text) => {
  let h = 5381;
  for (const char of text) h = ((h * 33) ^ char.codePointAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0');
};

const ENTRIES = {
  user: [
    { id: 'settings', kind: 'settings', rel: 'settings.json' },
    { id: 'claude-md', kind: 'markdown', rel: 'CLAUDE.md' },
  ],
  project: [
    { id: 'settings', kind: 'settings', rel: '.claude/settings.json' },
    { id: 'claude-md', kind: 'markdown', rel: 'CLAUDE.md' },
    { id: 'dot-claude-md', kind: 'markdown', rel: '.claude/CLAUDE.md' },
  ],
  local: [
    { id: 'settings', kind: 'settings', rel: '.claude/settings.local.json' },
    { id: 'claude-md', kind: 'markdown', rel: 'CLAUDE.local.md' },
  ],
};

const INDEX = 'MEMORY.md';
const fail = (status, error, extra) => ({ status, json: { error, ...extra } });

export function createSettingsMock({ home = '/home/you', folders = [] } = {}) {
  const files = new Map();
  const memory = new Map();
  let clock = Date.now() - 3_600_000;
  // How many running sessions a change reaches ("restartsPending" in the replies).
  const mock = { restarts: 2, requests: [], files, memory, folders };

  const fileKey = (scope, id, cwd) => `${scope}|${scope === 'user' ? '' : cwd}|${id}`;
  const memoryKey = (cwd, name) => `${cwd}|${name}`;
  const stamp = () => (clock += 60_000);
  const state = (entry) => (entry ? { exists: true, content: entry.content, size: Buffer.byteLength(entry.content), mtime: entry.mtime, version: hash(entry.content) } : { exists: false, content: '', size: 0, mtime: null, version: null });

  mock.setFile = (scope, id, content, cwd = '') => {
    if (content === null) files.delete(fileKey(scope, id, cwd));
    else files.set(fileKey(scope, id, cwd), { content, mtime: stamp() });
  };
  mock.setMemory = (cwd, name, content) => {
    if (content === null) memory.delete(memoryKey(cwd, name));
    else memory.set(memoryKey(cwd, name), { content, mtime: stamp() });
  };
  mock.file = (scope, id, cwd = '') => files.get(fileKey(scope, id, cwd))?.content ?? null;
  mock.memoryFile = (cwd, name) => memory.get(memoryKey(cwd, name))?.content ?? null;

  function parseSettings(content) {
    if (!content.trim()) return { valid: true, empty: true, permissions: permissionsView({}), hooks: {}, keys: [] };
    try {
      const settings = JSON.parse(content);
      const warning = settingsProblem(settings);
      return { valid: true, permissions: permissionsView(settings), hooks: hooksView(settings), keys: Object.keys(settings), ...(warning ? { warning } : {}) };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  const base = (scope, cwd) => (scope === 'user' ? `${home}/.claude` : cwd);
  function fileView(scope, entry, cwd) {
    const view = { scope, id: entry.id, kind: entry.kind, name: entry.rel.split('/').pop(), rel: entry.rel, path: `${base(scope, cwd)}/${entry.rel}`, ...state(files.get(fileKey(scope, entry.id, cwd))) };
    return entry.kind === 'settings' ? { ...view, parsed: parseSettings(view.content) } : view;
  }
  const entryOf = (scope, id) => ENTRIES[scope]?.find((entry) => entry.id === id);

  const known = (cwd) => folders.includes(cwd);
  const projectProblem = (cwd, required = true) => {
    if (!cwd) return required ? fail(400, 'Choose a project folder.') : null;
    return known(cwd) ? null : fail(400, 'Choose a project folder that exists inside your home directory.');
  };

  const conflict = (current) => fail(409, 'This file changed on disk since you opened it.', { conflict: true, current });
  const reply = (view, changed, affects) => ({ json: { ...view, changed, restartsPending: changed && affects ? mock.restarts : 0 } });


  function writeFile(scope, entry, cwd, version, build) {
    const key = fileKey(scope, entry.id, cwd);
    const before = state(files.get(key));
    const content = build(before);
    if (content === null || (before.exists && content === before.content)) return { view: fileView(scope, entry, cwd), changed: false };
    if (version !== before.version) return { conflict: fileView(scope, entry, cwd) };
    files.set(key, { content, mtime: stamp() });
    return { view: fileView(scope, entry, cwd), changed: true };
  }

  function patchedSettings(before, { permissions, hooks }) {
    let settings;
    try {
      settings = before.content.trim() ? JSON.parse(before.content) : {};
    } catch (error) {
      return { error: `This file is not valid JSON (${error.message}). Fix it first.` };
    }
    if (permissions !== undefined) {
      const next = { ...(settings.permissions || {}) };
      for (const [key, value] of Object.entries(permissions)) {
        if (value === null || value === '' || (Array.isArray(value) && !value.length)) delete next[key];
        else next[key] = value;
      }
      if (Object.keys(next).length) settings.permissions = next;
      else delete settings.permissions;
    }
    if (hooks !== undefined) {
      if (hooks === null || !Object.keys(hooks).length) delete settings.hooks;
      else settings.hooks = hooks;
    }
    return { content: JSON.stringify(settings, null, 2) + '\n' };
  }

  function memoryRows(cwd) {
    const indexEntry = memory.get(memoryKey(cwd, INDEX));
    const index = { ...state(indexEntry), lines: parseIndex(indexEntry?.content ?? '') };
    const linked = new Set(index.lines.map((line) => line.file));
    const names = [...memory.keys()].filter((key) => key.startsWith(cwd + '|')).map((key) => key.slice(cwd.length + 1)).filter((name) => name !== INDEX).sort();
    const rows = names.map((name) => {
      const view = state(memory.get(memoryKey(cwd, name)));
      const { data, type } = parseFrontmatter(view.content);
      const { content, ...row } = view;
      return { scope: 'memory', name, path: `${home}/.claude/projects/${cwd.replaceAll('/', '-')}/memory/${name}`, ...row, frontmatter: { name: data.name ?? '', description: data.description ?? '', type }, inIndex: linked.has(name) };
    });
    return { dir: `${home}/.claude/projects/${cwd.replaceAll('/', '-')}/memory`, exists: rows.length > 0 || !!indexEntry, cwd, index, files: rows, missing: index.lines.filter((line) => !names.includes(line.file)) };
  }

  function memoryView(cwd, name) {
    const view = state(memory.get(memoryKey(cwd, name)));
    const { data, body, type } = parseFrontmatter(view.content);
    return { scope: 'memory', name, path: `${home}/.claude/projects/${cwd.replaceAll('/', '-')}/memory/${name}`, ...view, frontmatter: { name: data.name ?? '', description: data.description ?? '', type }, body };
  }

  mock.handle = async ({ route, method, url, body }) => {
    if (!route.startsWith('settings/')) return null;
    if (method !== 'GET') mock.requests.push({ method, route, body, query: Object.fromEntries(url.searchParams) });
    const cwd = method === 'GET' || method === 'DELETE' ? url.searchParams.get('cwd') || '' : body?.cwd || '';
    let match;

    if (route === 'settings/files' && method === 'GET') {
      const problem = projectProblem(cwd, false);
      if (problem) return problem;
      const list = [];
      for (const scope of cwd ? Object.keys(ENTRIES) : ['user']) {
        for (const entry of ENTRIES[scope]) {
          const { content, ...view } = fileView(scope, entry, cwd);
          list.push(view);
        }
      }
      return { json: { configDir: `${home}/.claude`, cwd: cwd || null, files: list } };
    }

    if ((match = route.match(/^settings\/files\/(user|project|local)\/([^/]+)$/))) {
      const [, scope, id] = match;
      const entry = entryOf(scope, id);
      if (!entry) return fail(404, 'Unknown settings file.');
      const problem = projectProblem(cwd, scope !== 'user');
      if (problem) return problem;
      if (method === 'GET') return { json: fileView(scope, entry, cwd) };
      if (method === 'PUT') {
        if (typeof body.content !== 'string') return fail(400, 'Send the new content as text.');
        if (entry.kind === 'settings') {
          let parsed;
          try {
            parsed = JSON.parse(body.content || '{}');
          } catch (error) {
            return fail(400, `Invalid JSON: ${error.message}`);
          }
          const invalid = settingsProblem(parsed);
          if (invalid) return fail(400, invalid);
        }
        const result = writeFile(scope, entry, cwd, body.version, () => body.content);
        return result.conflict ? conflict(result.conflict) : reply(result.view, result.changed, true);
      }
      if (method === 'PATCH') {
        if (body.permissions !== undefined) {
          const invalid = permissionsProblem(Object.fromEntries(Object.entries(body.permissions).filter(([, value]) => value !== null && value !== '')));
          if (invalid) return fail(400, invalid);
        }
        if (body.hooks) {
          const invalid = hooksProblem(body.hooks);
          if (invalid) return fail(400, invalid);
        }
        let failure = null;
        const result = writeFile(scope, entry, cwd, body.version, (before) => {
          const next = patchedSettings(before, body);
          failure = next.error;
          return next.error ? null : next.content;
        });
        if (failure) return fail(400, failure);
        return result.conflict ? conflict(result.conflict) : reply(result.view, result.changed, true);
      }
    }

    if (route === 'settings/memory' && method === 'GET') {
      const problem = projectProblem(cwd);
      return problem || { json: memoryRows(cwd) };
    }

    if ((match = route.match(/^settings\/memory\/([^/]+)$/))) {
      const name = decodeURIComponent(match[1]);
      const problem = projectProblem(cwd);
      if (problem) return problem;
      if (!MEMORY_NAME.test(name)) return fail(400, 'A memory file name is letters, digits, dots, dashes and underscores, ending in .md.');
      const key = memoryKey(cwd, name);
      if (method === 'GET') return { json: memoryView(cwd, name) };
      if (method === 'PUT') {
        const before = state(memory.get(key));
        if (body.content === before.content && before.exists) return reply(memoryView(cwd, name), false, false);
        if (body.version !== before.version) return conflict(memoryView(cwd, name));
        memory.set(key, { content: body.content, mtime: stamp() });
        let indexChanged = name === INDEX;
        if (!before.exists && name !== INDEX) {
          const { data } = parseFrontmatter(body.content);
          const indexKey = memoryKey(cwd, INDEX);
          const text = addIndexLine(memory.get(indexKey)?.content ?? '', { title: memoryTitle(name, data), file: name, hook: data.description ?? '' });
          memory.set(indexKey, { content: text, mtime: stamp() });
          indexChanged = true;
        }
        return reply(memoryView(cwd, name), true, indexChanged);
      }
      if (method === 'DELETE') {
        const before = state(memory.get(key));
        if (!before.exists) return fail(404, 'This memory no longer exists.');
        if (url.searchParams.get('version') !== before.version) return conflict(memoryView(cwd, name));
        memory.delete(key);
        const indexKey = memoryKey(cwd, INDEX);
        const index = memory.get(indexKey);
        if (index) memory.set(indexKey, { content: removeIndexLines(index.content, name), mtime: stamp() });
        return { json: { deleted: true, name, restartsPending: mock.restarts } };
      }
    }
    return fail(404, 'Not mocked: ' + route);
  };

  return mock;
}
