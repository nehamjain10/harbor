// The user's per-model settings, kept in <data dir>/model-settings.json:
// `{ context: { [modelId]: tokens }, fast: { [modelId]: true } }`: the most context a
// model's conversations use (the catalog's `contextWindow`; see setContextLimits), and
// the models in fast mode (`fast`; see setFastModes). A model without an entry uses its
// default, and fast mode off.
import fs from 'node:fs';
import path from 'node:path';
import { httpError } from './errors.mjs';
import { MIN_CONTEXT, MODELS, findModel, setContextLimits, setFastModes, validContextLimit } from './models.mjs';

const FILE = 'model-settings.json';

export function createModelSettings({ dataDir }) {
  const file = path.join(dataDir, FILE);
  let context = {};
  let fast = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, limit] of Object.entries(saved?.context ?? {})) {
      const model = findModel(id);
      if (model && validContextLimit(model, limit)) context[id] = limit;
    }
    for (const [id, on] of Object.entries(saved?.fast ?? {})) {
      if (on === true && findModel(id)?.fastNote) fast[id] = true;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read ${file}; using the default context windows: ${error.message}`);
  }
  setContextLimits(context);
  setFastModes(fast);

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(Object.keys(fast).length ? { context, fast } : { context }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }

  return {
    /** Each model's context range and current window, for the settings tab. */
    get() {
      return {
        models: MODELS.map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
          contextWindow: model.contextWindow,
          maxContext: model.maxContext,
          defaultContext: model.defaultContext,
          minContext: MIN_CONTEXT,
          custom: model.id in context,
          fastNote: model.fastNote,
          fast: model.fast,
        })),
      };
    },

    /**
     * Sets context limits: `{ [modelId]: tokens }`, null (or the model's default) for
     * its default. Every entry is checked before any applies. Live processes pick a new
     * window up at their next turn.
     */
    setContext(changes) {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw httpError(400, 'Send `context` as {modelId: tokens}.');
      const next = { ...context };
      for (const [id, limit] of Object.entries(changes)) {
        const model = findModel(id);
        if (!model) throw httpError(400, `Unknown model "${id}".`);
        if (limit === null || limit === model.defaultContext) delete next[id];
        else if (validContextLimit(model, limit)) next[id] = limit;
        else throw httpError(400, `${model.name}'s context must be a whole number of tokens from ${MIN_CONTEXT} to ${model.maxContext}.`);
      }
      context = next;
      save();
      setContextLimits(context);
      return this.get();
    },

    /**
     * Turns fast mode on or off: `{ [modelId]: boolean }`, for models with a fast tier.
     * Every entry is checked before any applies. A live process switches at its next turn.
     */
    setFast(changes) {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw httpError(400, 'Send `fast` as {modelId: true|false}.');
      const next = { ...fast };
      for (const [id, on] of Object.entries(changes)) {
        const model = findModel(id);
        if (!model) throw httpError(400, `Unknown model "${id}".`);
        if (!model.fastNote) throw httpError(400, `${model.name} has no fast mode.`);
        if (typeof on !== 'boolean') throw httpError(400, 'Fast mode is true or false.');
        if (on) next[id] = true;
        else delete next[id];
      }
      fast = next;
      save();
      setFastModes(fast);
      return this.get();
    },
  };
}
