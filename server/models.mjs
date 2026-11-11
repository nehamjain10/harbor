// Model catalog and the environment each model's Claude Code process runs with.
import { DEFAULT_GATEWAY, GATEWAY_PLACEHOLDER_KEY } from './config.mjs';
import * as initialCatalog from './catalog.mjs';
import { OPENROUTER_PREFIX, isOpenRouterId, openRouterModel, openRouterVersion } from './openrouter.mjs';

// The catalog data (catalog.mjs) is reloadable: MODELS, MODE_OPTIONS and AGENT_HINTS are
// live bindings that reloadCatalog() replaces, so code reading them at call time sees the
// new catalog. The user's context limits and fast-mode choices carry over.
export const MIN_CONTEXT = 100_000;
// A Claude model's full window (Claude Code's own 1M).
const CLAUDE_CONTEXT = 1_000_000;
export let MODELS = initialCatalog.MODELS;
export let MODE_OPTIONS = initialCatalog.MODE_OPTIONS;
export let AGENT_HINTS = initialCatalog.AGENT_HINTS;
let contextLimits = {};
let fastChoices = {};
let catalogVersion = 0;

const REQUIRED = ['id', 'name', 'model', 'provider', 'efforts', 'description', 'maxContext', 'defaultContext', 'modes'];

/** Problems that keep a catalog from loading (an empty list when it is usable). */
export function catalogProblems(ns) {
  const models = ns?.MODELS;
  if (!Array.isArray(models) || !models.length) return ['MODELS must be a non-empty array'];
  const problems = [];
  const ids = new Set();
  for (const model of models) {
    const missing = REQUIRED.filter((key) => model?.[key] === undefined);
    if (missing.length) problems.push(`${model?.id ?? '?'}: missing ${missing.join(', ')}`);
    if (ids.has(model?.id)) problems.push(`${model.id}: listed twice`);
    ids.add(model?.id);
  }
  if (!ids.has(DEFAULT_MODEL)) problems.push(`the default model ${DEFAULT_MODEL} is missing`);
  if (!Array.isArray(ns.MODE_OPTIONS) || !ns.MODE_OPTIONS.length) problems.push('MODE_OPTIONS must be a non-empty array');
  if (!ns.AGENT_HINTS || typeof ns.AGENT_HINTS !== 'object') problems.push('AGENT_HINTS must be an object');
  return problems;
}

/**
 * Loads catalog.mjs again (a deploy changed it) and swaps it in. A catalog that does not
 * load or fails catalogProblems leaves the current one in place and throws.
 */
export async function reloadCatalog(url = new URL('./catalog.mjs', import.meta.url)) {
  catalogVersion += 1;
  const ns = await import(`${url.href}?v=${Date.now()}-${catalogVersion}`);
  const problems = catalogProblems(ns);
  if (problems.length) throw new Error('The model catalog is not usable: ' + problems.join('; '));
  MODELS = ns.MODELS;
  MODE_OPTIONS = ns.MODE_OPTIONS;
  AGENT_HINTS = ns.AGENT_HINTS;
  setContextLimits(contextLimits);
  setFastModes(fastChoices);
  return { models: MODELS.map((model) => model.id) };
}

export const DEFAULT_MODEL = 'opus';

export function findModel(id) {
  return MODELS.find((model) => model.id === id) ?? openRouterEntry(id);
}

// The window of an OpenRouter model the cached list does not (yet) know.
const OPENROUTER_UNKNOWN_CONTEXT = 200_000;
const OPENROUTER_MAX_CONTEXT = 1_000_000;
const OPENROUTER_EFFORTS = ['low', 'medium', 'high'];
// Synthesized catalog entries of `or:` models, by id; kept (and updated in place when the
// list changes) so a running turn's entry stays the one findModel returns.
const openRouterEntries = new Map();
let openRouterEntriesVersion = -1;

function openRouterFields(id) {
  const known = openRouterModel(id);
  const route = id.slice(OPENROUTER_PREFIX.length);
  const context = Math.min(known?.contextWindow || OPENROUTER_UNKNOWN_CONTEXT, OPENROUTER_MAX_CONTEXT);
  const window = Math.max(context, MIN_CONTEXT);
  const reasoning = known ? known.reasoning : true;
  return {
    id,
    name: known?.name || route.split('/').pop(),
    model: 'openrouter/' + route,
    provider: 'OpenRouter',
    // A model without reasoning has no effort to choose (like Grok).
    efforts: reasoning ? OPENROUTER_EFFORTS : [],
    defaultEffort: reasoning ? 'medium' : null,
    description: `${known?.vendor || route.split('/')[0]} model through OpenRouter (zero data retention)`,
    contextWindow: validContextLimit({ maxContext: window }, contextLimits[id]) ? contextLimits[id] : window,
    maxContext: window,
    defaultContext: window,
    vision: Boolean(known?.vision),
    modes: MODE_OPTIONS.map((mode) => mode.id).filter((mode) => mode !== 'auto'),
  };
}

/** The catalog entry of an `or:` model (memoized); undefined for anything else. */
function openRouterEntry(id) {
  if (!isOpenRouterId(id)) return undefined;
  if (openRouterEntriesVersion !== openRouterVersion()) {
    openRouterEntriesVersion = openRouterVersion();
    for (const [key, entry] of openRouterEntries) Object.assign(entry, openRouterFields(key));
  }
  let entry = openRouterEntries.get(id);
  if (!entry) {
    entry = openRouterFields(id);
    openRouterEntries.set(id, entry);
  }
  return entry;
}

// Gateway models compact well before their window: Claude Code counts tokens with
// Claude's tokenizer, which can undercount another model's.
const GATEWAY_COMPACT_RATIO = 0.8;
// Claude Code's own range for autoCompactWindow.
const MAX_COMPACT_WINDOW = 1_000_000;

/** A context limit the user may set for a model: a whole number of tokens within its range. */
export function validContextLimit(model, value) {
  return Number.isInteger(value) && value >= MIN_CONTEXT && value <= model.maxContext;
}

/**
 * Apply the user's context limits ({modelId: tokens}; others use their default). Invalid or
 * unknown entries are ignored. The catalog is changed in place: /api/info, new turns and
 * the context meter all read `contextWindow`.
 */
export function setContextLimits(limits = {}) {
  contextLimits = limits || {};
  for (const model of MODELS) {
    const limit = limits?.[model.id];
    model.contextWindow = validContextLimit(model, limit) ? limit : model.defaultContext;
  }
  for (const entry of openRouterEntries.values()) {
    const limit = contextLimits[entry.id];
    entry.contextWindow = validContextLimit(entry, limit) ? limit : entry.defaultContext;
  }
}

/** Apply the user's fast-mode choices ({modelId: true}); models without a fast tier stay off. */
export function setFastModes(choices = {}) {
  fastChoices = choices || {};
  for (const model of MODELS) {
    if (model.fastNote) model.fast = choices?.[model.id] === true;
  }
}

/**
 * What a model's Claude Code process is told about its context: `autoCompactWindow`
 * (undefined for a Claude model at its full 1M, so the user's own setting applies)
 * and the env that sets a gateway model's window.
 */
export function contextSettings(model) {
  if (runsDirect(model)) {
    return { autoCompactWindow: model.contextWindow < CLAUDE_CONTEXT ? model.contextWindow : undefined, env: {} };
  }
  const compact = Math.round(model.contextWindow * GATEWAY_COMPACT_RATIO);
  return {
    autoCompactWindow: Math.min(MAX_COMPACT_WINDOW, Math.max(MIN_CONTEXT, compact)),
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.contextWindow) },
  };
}

// Claude Code compacts this far before the window it compacts in (2.1.290, probed).
const COMPACT_BUFFER = 33_000;

/** About where Claude Code auto-compacts a model's conversation, in tokens. */
export function compactThreshold(model) {
  return (contextSettings(model).autoCompactWindow ?? model.contextWindow) - COMPACT_BUFFER;
}

export function isKnownModel(id) {
  return Boolean(findModel(id));
}

/**
 * The catalog id for a model name as transcripts record it: the route
 * (`codex/gpt-6-luna`), the id Claude Code sends direct (`claude-opus-5-5`, optionally
 * with a `[1m]` context suffix) or a bare gateway name (`gpt-6-luna`). Undefined when the
 * catalog has no such model.
 */
export function catalogIdForModel(name) {
  if (typeof name !== 'string' || !name) return undefined;
  const bare = name.replace(/\[[^\]]*\]$/, '').replace(FAST_SUFFIX_RE, '');
  const match = MODELS.find((model) => model.model === bare || sdkModelId(model) === bare || model.model.endsWith('/' + bare));
  if (match) return match.id;
  const openrouter = bare.startsWith('openrouter/') && OPENROUTER_PREFIX + bare.slice('openrouter/'.length);
  return openrouter && isOpenRouterId(openrouter) ? openrouter : undefined;
}

/** 'default' is always accepted; otherwise the effort must be listed for the model. */
export function validEffort(modelId, value) {
  return value === 'default' || Boolean(findModel(modelId)?.efforts.includes(value));
}

/** The concrete effort a turn runs with, given the session's per-model choices. */
export function resolveEffort(modelId, efforts) {
  const chosen = efforts?.[modelId] || 'default';
  return chosen === 'default' ? findModel(modelId)?.defaultEffort : chosen;
}

/** Claude models run on the user's own subscription login instead of the gateway. */
export function runsDirect(model) {
  return model.provider === 'Claude';
}

// The gateway serves a model's fast tier for its name with this suffix.
const FAST_SUFFIX = '+fast';
const FAST_SUFFIX_RE = /\+fast$/;

/**
 * The model id passed to the SDK: direct models drop the gateway's `claude/` prefix, and a
 * model in fast mode gets the gateway's fast suffix (switched on a live process like any model).
 */
export function sdkModelId(model) {
  if (runsDirect(model)) return model.model.replace(/^claude\//, '');
  return model.fast ? model.model + FAST_SUFFIX : model.model;
}

/** The permission mode a turn runs with: modes the model does not offer fall back to `default`. */
export function turnMode(model, mode) {
  return model?.modes.includes(mode) ? mode : 'default';
}

export const TOOL_HYGIENE =
  'When calling tools, send arguments with their correct JSON types and omit optional parameters you are not using (never send empty strings).';

/**
 * Lines appended to Claude Code's system prompt. The prompt is recorded with a session's
 * first turn and replayed verbatim afterwards (prompt-cache and thinking friendly), so a
 * later model switch is announced in the user message instead (see modelSwitchNote).
 * The tool hint is for open models.
 */
export function systemPromptAppend(model) {
  const lines = [
    `Model identity: you are ${model.name} (route ${model.model}, provider ${model.provider}), selected by the user in Harbor. ` +
      'If a later "[Harbor: ...]" note in the conversation says the user switched models, that note is current.',
  ];
  if (!runsDirect(model)) lines.push(TOOL_HYGIENE);
  return lines.join('\n');
}

/**
 * The note that tells the model it was switched in, put in front of the user's message
 * on the first turn a different model runs. `previousId` is the catalog id (or the raw
 * name) of the model that ran the turn before.
 */
export function modelSwitchNote(model, previousId) {
  const previous = findModel(previousId)?.name ?? previousId;
  const hygiene = runsDirect(model) ? '' : ` ${TOOL_HYGIENE}`;
  return (
    `[Harbor: from this message on you are ${model.name} (route ${model.model}, provider ${model.provider}); ` +
    `earlier turns in this conversation ran on ${previous}.${hygiene}]`
  );
}

// Started from inside another Claude Code session (desktop app, SSH child, agent), the
// environment carries that host's session plumbing: OAuth scopes, a host auth-refresh
// channel, messaging sockets, effort. The child CLI would then authenticate with the
// host's subscription token, even on gateway routes, so every CLAUDE_* variable goes
// except the config dir.
const KEPT_CLAUDE_ENV = new Set(['CLAUDE_CONFIG_DIR']);
const STRIPPED_ENV = new Set(['CLAUDECODE', 'AI_AGENT', 'USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH']);

function strippedFromChild(key) {
  if (key.startsWith('ANTHROPIC_') || STRIPPED_ENV.has(key)) return true;
  return key.startsWith('CLAUDE_') && !KEPT_CLAUDE_ENV.has(key);
}

// Headless Claude Code ships without a task checklist tool. Turn on the single-list
// TodoWrite tool (rather than the TaskCreate/TaskUpdate family) so every model can keep
// the Tasks strip current with one call.
export const TODO_TOOL_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' };

// Claude Code started from the SDK leaves artifacts off (pages on claude.ai the model
// publishes with the Artifact tool; the transcript shows them as cards). Turn them on, as
// in the desktop app. On gateway routes Claude Code keeps them off by itself (not
// first-party), and the account must have them.
export const ARTIFACT_ENV = { CLAUDE_CODE_ARTIFACT: '1' };

/**
 * Environment for the Claude Code child process. All provider/auth overrides are
 * removed; direct runs use the CLI's own login, everything else goes to `gatewayUrl`
 * (the local normalizing proxy in production) with `apiKey`.
 * `claudeConfigDir` replaces CLAUDE_CONFIG_DIR (test isolation only).
 */
export function sdkEnv(direct = false, { gatewayUrl = DEFAULT_GATEWAY, apiKey = GATEWAY_PLACEHOLDER_KEY, claudeConfigDir, claudeRelay } = {}, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (strippedFromChild(key)) delete env[key];
  }
  Object.assign(env, TODO_TOOL_ENV, ARTIFACT_ENV);
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  if (direct && claudeRelay) {
    // Authenticate to Harbor's proxy; it replaces the placeholder with the gateway's relay
    // key. The gateway owns the Claude accounts, so local sessions need no separate login.
    return Object.assign(env, {
      ANTHROPIC_BASE_URL: gatewayUrl.replace(/\/+$/, '') + '/claude-relay',
      ANTHROPIC_CUSTOM_HEADERS: `X-Harbor-Key: ${apiKey}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'harbor-relay',
      ENABLE_TOOL_SEARCH: 'true',
    });
  }
  if (direct) return env;
  return Object.assign(env, {
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_API_KEY: apiKey,
    // Deferred MCP tools (ToolSearch): Claude Code turns them off for a custom base URL,
    // but it loads a found tool into the next request itself, so they work through the
    // gateway too, and the tool schemas stay out of every request (measured: half the
    // first request with 31 MCP tools).
    ENABLE_TOOL_SEARCH: 'true',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude/claude-opus-5-5',
    // Subagent and background (haiku) aliases on gateway routes go through the gateway,
    // which serves the 5.5 models (checked 10-16).
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude/claude-sonnet-5-5',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude/claude-fable-5-2',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude/claude-haiku-5-5',
  });
}
