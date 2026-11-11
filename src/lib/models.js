// Model catalog helpers (the catalog itself comes from GET /api/info).
import { formatTokens } from './format.js';

const FALLBACK_MODEL = { id: 'opus', name: 'Claude Opus 5.5', provider: 'Claude', efforts: [], defaultEffort: 'medium' };

export const EFFORT_NAMES = {
  default: 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export const EFFORT_LEVEL = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

export const EFFORT_DESCRIPTIONS = {
  low: 'Fastest responses for simple changes.',
  medium: 'Balanced speed and reasoning.',
  high: 'More reasoning for complex work.',
  xhigh: 'Deeper analysis for difficult tasks.',
  max: 'Most reasoning; usually takes longer.',
};

// A catalog model, an OpenRouter model (`or:<id>`), or for an id outside the catalog (e.g.
// an imported Codex reply's `gpt-…`) a stand-in named after the id with the provider its
// name suggests.
export function findModel(info, id) {
  const model = info?.models?.find((m) => m.id === id);
  if (model) return model;
  if (isOpenRouterId(id)) return openRouterModel(info, id);
  return id === FALLBACK_MODEL.id || !info ? FALLBACK_MODEL : { ...FALLBACK_MODEL, id, name: id, provider: guessProvider(id) };
}

export const OPENROUTER_PREFIX = 'or:';

export function isOpenRouterId(id) {
  return typeof id === 'string' && id.length > OPENROUTER_PREFIX.length && id.startsWith(OPENROUTER_PREFIX);
}

// Entries are made once per list and id, so a model keeps its identity between renders.
const openRouterCache = new WeakMap();
const NO_LIST = [];

/**
 * An `or:` model as the server runs it (models.mjs): from the fetched list
 * (`info.openrouterModels`, GET /api/openrouter-models) when it is there, else from the id
 * (a reasoning model, like the server assumes).
 */
function openRouterModel(info, id) {
  const list = info?.openrouterModels || NO_LIST;
  let byId = openRouterCache.get(list);
  if (!byId) openRouterCache.set(list, (byId = new Map()));
  if (byId.has(id)) return byId.get(id);
  const known = list.find((m) => m.id === id);
  const route = id.slice(OPENROUTER_PREFIX.length);
  const reasoning = known ? known.reasoning : true;
  const modes = (info?.modes || []).map((mode) => mode.id).filter((mode) => mode !== 'auto');
  const model = {
    id,
    name: known?.name || route.split('/').pop(),
    provider: 'OpenRouter',
    efforts: reasoning ? ['low', 'medium', 'high'] : [],
    defaultEffort: reasoning ? 'medium' : null,
    description: `${known?.vendor || route.split('/')[0]} model through OpenRouter (zero data retention)`,
    contextWindow: known?.contextWindow ? Math.min(known.contextWindow, 1_000_000) : undefined,
    vision: Boolean(known?.vision),
    ...(modes.length ? { modes } : {}),
  };
  byId.set(id, model);
  return model;
}

// "$0.95/$4 per M" for an OpenRouter model's price (USD per million tokens).
function formatPrice(price) {
  const usd = (value) => (value === 0 ? '0' : value < 1 ? String(Number(value.toPrecision(2))) : String(Number(value.toFixed(2))));
  if (price?.in == null || price?.out == null) return '';
  return `$${usd(price.in)}/$${usd(price.out)} per M`;
}

/** The side menu's line for an OpenRouter model: vendor · price · context. */
export function openRouterDescription(model) {
  return [model.vendor, formatPrice(model.price), model.contextWindow ? `${formatTokens(model.contextWindow)} context` : ''].filter(Boolean).join(' · ');
}

/** The OpenRouter models whose name, vendor or id contain every word of `query`. */
export function filterOpenRouterModels(models = [], query = '') {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models;
  return models.filter((model) => {
    const text = `${model.name} ${model.vendor} ${model.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

function guessProvider(id) {
  return /^(gpt|o\d|codex|openai)/i.test(String(id || '')) ? 'OpenAI' : FALLBACK_MODEL.provider;
}

/**
 * Whether a turn's cost figure means anything: Claude Code prices every turn at Claude
 * rates, so for gateway models it is a made-up number. Unknown models keep it.
 */
export function showsCost(info, id) {
  const model = id && info?.models?.find((candidate) => candidate.id === id);
  return !model || model.provider === 'Claude';
}

export function providerGroup(model) {
  return ['Claude', 'OpenAI', 'OpenRouter'].includes(model?.provider) ? model.provider : 'Gateway';
}

export function providerNote(model) {
  const group = providerGroup(model);
  if (group === 'Claude') return 'Claude subscription';
  if (group === 'OpenAI') return 'ChatGPT subscription';
  if (group === 'OpenRouter') return 'Zero data retention';
  return 'Gateway';
}

// Models grouped for the picker, keeping catalog order inside each group.
export function groupModels(models = []) {
  const order = ['Claude', 'OpenAI', 'Gateway', 'OpenRouter'];
  const groups = new Map(order.map((name) => [name, []]));
  for (const model of models) groups.get(providerGroup(model)).push(model);
  return order.map((name) => ({ name, models: groups.get(name) })).filter((g) => g.models.length);
}

/** The picker's line for a model: its description and how much context it uses. */
export function modelDescription(model) {
  if (!model?.contextWindow) return model?.description || '';
  return [model.description, `${formatTokens(model.contextWindow)} context`].filter(Boolean).join(' · ');
}

export function shortModelName(model) {
  return String(model?.name || '').replace(/^Claude /, '');
}

export function effortName(effort) {
  return EFFORT_NAMES[effort] || effort || 'Default';
}

// The effort actually in force: an explicit choice, else the model default.
export function effectiveEffort(model, chosen) {
  return !chosen || chosen === 'default' ? model?.defaultEffort || 'medium' : chosen;
}

export function effortOptions(model) {
  return ['default', ...(model?.efforts || [])];
}
