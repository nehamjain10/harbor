// The model catalog: what /api/info lists, in order. This file holds data only and is
// reloaded by a running server (models.mjs reloadCatalog, POST /api/admin/reload), so
// adding, renaming or retuning a model deploys without a restart. It must not import
// other server modules.
//
// A deployment changes the catalog without editing this file through the JSON file
// WORKBENCH_CATALOG_FILE names (read again on every reload):
//   {"models": [{"id": "deepseek", "model": "my-proxy/DeepSeek-V4-Flash"},
//               {"id": "mine", "name": "…", …every field of an entry…, "before": "kimi31"}],
//    "agentHints": {"mine": "what it is good for"}}
// An entry whose id is in the catalog changes the fields it gives (field order stays);
// any other is a new model, put before the model `before` names, else at the end.
import fs from 'node:fs';

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Permission modes, in the order the UI lists them. `auto` relies on Anthropic's
// safety classifier, so only Claude models offer it.
export const MODE_OPTIONS = [
  { id: 'default', label: 'Ask', description: 'Ask before editing files or running commands' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Edit files without asking; ask before running commands' },
  { id: 'plan', label: 'Plan', description: 'Read and plan only; nothing changes until you approve the plan' },
  { id: 'auto', label: 'Auto', description: 'A safety classifier approves routine actions and blocks risky ones (Claude models only)' },
  { id: 'bypassPermissions', label: 'Bypass', description: 'Run every tool without asking' },
];
const ALL_MODES = MODE_OPTIONS.map((mode) => mode.id);
const GATEWAY_MODES = ALL_MODES.filter((mode) => mode !== 'auto');

// The most context each model takes, in tokens (`maxContext`): Claude 5 models 1M; the
// Codex models' max_context_window in ~/.codex/models_cache.json; the open models as the
// gateway serves them (its /model/info and its length errors).
// `defaultContext` is what a model uses unless the user sets a limit (Settings > Models,
// setContextLimits): the user chose 400k for Claude, Astra, Luna and DeepSeek (10-15/16; DeepSeek took
// GLM's place when the gateway dropped GLM 5.3 Flash). A model's
// `contextWindow` is the one in effect. Claude Code is told the window of a gateway model
// (CLAUDE_CODE_MAX_CONTEXT_TOKENS; it assumes 200k for models it does not know) and
// compacts before it (see contextSettings).
const CLAUDE_CONTEXT = 1_000_000;
const CLAUDE_DEFAULT_CONTEXT = 400_000;

// `fastNote` marks a model with a fast tier (Codex's Fast mode, the ChatGPT backend's
// priority service tier, through the gateway's `+fast` model suffix); `fast` is whether the
// user turned it on (Settings > Models, setFastModes).
// Order and field order are part of the /api/info response (v1 fields first).
const BASE_MODELS = [
  {
    id: 'opus',
    name: 'Claude Opus 5.5',
    model: 'claude/claude-opus-5-5',
    provider: 'Claude',
    efforts: ALL_EFFORTS,
    defaultEffort: 'medium',
    description: "Anthropic's most capable model, on your Claude subscription",
    contextWindow: CLAUDE_DEFAULT_CONTEXT,
    maxContext: CLAUDE_CONTEXT,
    defaultContext: CLAUDE_DEFAULT_CONTEXT,
    vision: true,
    modes: ALL_MODES,
  },
  {
    id: 'sonnet',
    name: 'Claude Sonnet 5.5',
    model: 'claude/claude-sonnet-5-5',
    provider: 'Claude',
    efforts: ALL_EFFORTS,
    defaultEffort: 'high',
    description: 'Fast, capable Claude model for everyday coding, on your Claude subscription',
    contextWindow: CLAUDE_DEFAULT_CONTEXT,
    maxContext: CLAUDE_CONTEXT,
    defaultContext: CLAUDE_DEFAULT_CONTEXT,
    vision: true,
    modes: ALL_MODES,
  },
  {
    id: 'fable',
    name: 'Claude Fable 5.2',
    model: 'claude/claude-fable-5-2',
    provider: 'Claude',
    efforts: ALL_EFFORTS,
    defaultEffort: 'high',
    description: 'Claude Fable model, on your Claude subscription',
    contextWindow: CLAUDE_DEFAULT_CONTEXT,
    maxContext: CLAUDE_CONTEXT,
    defaultContext: CLAUDE_DEFAULT_CONTEXT,
    vision: true,
    modes: ALL_MODES,
  },
  {
    id: 'haiku',
    name: 'Claude Haiku 5.5',
    model: 'claude/claude-haiku-5-5',
    provider: 'Claude',
    efforts: ALL_EFFORTS,
    defaultEffort: 'high',
    description: 'Fastest, cheapest Claude model, on your Claude subscription',
    // The user's choice (10-16): 400k only, though the model takes 1M.
    contextWindow: CLAUDE_DEFAULT_CONTEXT,
    maxContext: CLAUDE_DEFAULT_CONTEXT,
    defaultContext: CLAUDE_DEFAULT_CONTEXT,
    vision: true,
    modes: ALL_MODES,
  },
  {
    id: 'sol',
    name: 'GPT-6.1 Sol',
    model: 'codex/gpt-6.1-sol',
    provider: 'OpenAI',
    efforts: ALL_EFFORTS,
    defaultEffort: 'medium',
    description: 'OpenAI GPT-6.1 Sol through the gateway',
    contextWindow: 500_000,
    maxContext: 872_000,
    defaultContext: 500_000,
    vision: true,
    modes: GATEWAY_MODES,
    fastNote: 'About 1.6x faster (measured), uses more ChatGPT allowance',
    fast: false,
  },
  {
    id: 'terra',
    name: 'GPT-6.1 Terra',
    model: 'codex/gpt-6.1-terra',
    provider: 'OpenAI',
    efforts: ALL_EFFORTS,
    defaultEffort: 'medium',
    description: 'OpenAI GPT-6.1 Terra through the gateway',
    contextWindow: 400_000,
    maxContext: 872_000,
    defaultContext: 400_000,
    vision: true,
    modes: GATEWAY_MODES,
    fastNote: 'Priority tier, uses more ChatGPT allowance',
    fast: false,
  },
  {
    id: 'astra',
    name: 'GPT-6 Astra',
    model: 'codex/gpt-6-astra',
    provider: 'OpenAI',
    efforts: ALL_EFFORTS,
    defaultEffort: 'medium',
    description: 'OpenAI GPT-6 Astra through the gateway',
    contextWindow: 400_000,
    maxContext: 872_000,
    defaultContext: 400_000,
    vision: true,
    modes: GATEWAY_MODES,
    fastNote: 'About 2x faster (OpenAI), uses more ChatGPT allowance',
    fast: false,
  },
  {
    id: 'luna',
    name: 'GPT-6 Luna',
    model: 'codex/gpt-6-luna',
    provider: 'OpenAI',
    efforts: ALL_EFFORTS,
    defaultEffort: 'medium',
    description: 'OpenAI GPT-6 Luna through the gateway',
    contextWindow: 400_000,
    maxContext: 872_000,
    defaultContext: 400_000,
    vision: true,
    modes: GATEWAY_MODES,
    fastNote: 'Up to 1.5x faster (OpenAI); no gain measured',
    fast: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek V4.1 Flash',
    model: 'litellm/DeepSeek-V4-Flash',
    provider: 'DeepSeek',
    efforts: ['high', 'max'],
    defaultEffort: 'high',
    description: 'DeepSeek model through the gateway',
    contextWindow: 400_000,
    maxContext: 1_000_000,
    defaultContext: 400_000,
    vision: true,
    modes: GATEWAY_MODES,
  },
  {
    id: 'grok',
    name: 'Grok 4.7',
    model: 'xai/grok-4.7',
    provider: 'xAI',
    // One variant, fixed, so there is no effort to choose.
    efforts: [],
    defaultEffort: null,
    description: 'xAI Grok 4.7 through the gateway',
    contextWindow: 400_000,
    maxContext: 400_000,
    defaultContext: 400_000,
    vision: true,
    modes: GATEWAY_MODES,
  },
  {
    id: 'kimi',
    name: 'Kimi K3',
    model: 'litellm/SGLang-Kimi-K3',
    provider: 'SGLang',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    description: 'Open-weight Kimi model served by SGLang through the gateway',
    contextWindow: 524_288,
    maxContext: 524_288,
    defaultContext: 524_288,
    vision: true,
    modes: GATEWAY_MODES,
  },
  // OpenRouter through the gateway, which forces zero data retention (only ZDR endpoints
  // answer). Any other ZDR model is offered as `or:<id>` (openrouter.mjs).
  {
    id: 'kimi31',
    name: 'Kimi K3.1 Pro',
    model: 'openrouter/moonshotai/kimi-k3.1-pro',
    provider: 'OpenRouter',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    description: 'Moonshot AI Kimi K3.1 Pro through OpenRouter (zero data retention)',
    contextWindow: 1_048_576,
    maxContext: 1_048_576,
    defaultContext: 1_048_576,
    vision: true,
    modes: GATEWAY_MODES,
  },
  {
    id: 'argon',
    name: 'Gemini 4 Argon',
    model: 'openrouter/google/gemini-4-argon',
    provider: 'OpenRouter',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    description: 'Google Gemini 4 Argon through OpenRouter (zero data retention)',
    contextWindow: 1_048_576,
    maxContext: 1_048_576,
    defaultContext: 1_048_576,
    vision: true,
    modes: GATEWAY_MODES,
  },
];


// What each model is good for, in the delegate tool description and the Agents view.
const BASE_AGENT_HINTS = {
  opus: 'strongest Claude model: the hardest design, debugging and refactoring work; slowest and most expensive',
  sonnet: 'fast, strong Claude coder for most implementation work',
  fable: 'Claude Fable: capable general Claude model',
  haiku: 'fastest, cheapest Claude model for quick, well-specified chores',
  sol: "OpenAI's strongest (GPT-6.1): hard implementation, algorithms, deep debugging",
  terra: 'GPT-6.1 generation OpenAI model: solid implementation work, faster than Sol',
  astra: 'strong OpenAI generalist for solid implementation work',
  luna: 'fast, cheaper OpenAI model for routine edits, tests and grunt work',
  deepseek: 'fast, cheap open model for simple, well-specified chores',
  kimi: 'open model with vision, good at agentic coding chores',
  kimi31: 'Kimi K3.1 Pro on OpenRouter: strong open model with vision for agentic coding, 1M context',
  argon: 'Google Gemini 4 Argon on OpenRouter: strong generalist with vision and 1M context',
};

/**
 * The catalog with a deployment's changes (see the top of this file) from the JSON file
 * at `file`; the base catalog without one. Throws when the file is unreadable or wrong.
 */
export function withCatalogFile(models, hints, file) {
  if (!file) return { models, hints };
  let extra;
  try {
    extra = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`WORKBENCH_CATALOG_FILE: cannot read ${file} (${error.message})`);
  }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('WORKBENCH_CATALOG_FILE: expected an object');
  const list = models.map((model) => ({ ...model }));
  for (const entry of extra.models ?? []) {
    if (typeof entry?.id !== 'string') throw new Error('WORKBENCH_CATALOG_FILE: every model needs an id');
    const { before, ...fields } = entry;
    const known = list.find((model) => model.id === fields.id);
    if (known) {
      Object.assign(known, fields);
      continue;
    }
    const at = before === undefined ? list.length : list.findIndex((model) => model.id === before);
    if (at < 0) throw new Error(`WORKBENCH_CATALOG_FILE: ${fields.id} goes before unknown model "${before}"`);
    list.splice(at, 0, fields);
  }
  return { models: list, hints: { ...hints, ...extra.agentHints } };
}

const catalog = withCatalogFile(BASE_MODELS, BASE_AGENT_HINTS, process.env.WORKBENCH_CATALOG_FILE?.trim());
export const MODELS = catalog.models;
export const AGENT_HINTS = catalog.hints;
