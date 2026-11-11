// Schema-driven repair of tool inputs produced by non-Claude models. Claude Code
// validates tool input against the tool's JSON Schema before any hook runs, so common
// near-misses (`pages: ""`, `limit: "10"`, `replace_all: "false"`, `todos` sent as a JSON
// string) fail as tool errors. This module fixes exactly those shapes and nothing else:
// it never invents a value, never removes a required key and never alters a value the
// schema already accepts.

const CLEAN_NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const unchanged = (value) => ({ value, changed: false });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchema(value) {
  return isPlainObject(value);
}

/** The JSON types a schema declares, or null when it does not constrain the type. */
function declaredTypes(schema) {
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === 'string') return [schema.type];
  if (isSchema(schema.properties)) return ['object'];
  if (isSchema(schema.items)) return ['array'];
  return null;
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(value, type) {
  const actual = jsonType(value);
  if (type === 'integer') return actual === 'number' && Number.isInteger(value);
  return actual === type;
}

/** True when the value already satisfies the schema's type, enum and const. */
function accepts(value, schema) {
  if (!isSchema(schema)) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) return false;
  if ('const' in schema && schema.const !== value) return false;
  const branches = schema.anyOf || schema.oneOf;
  if (Array.isArray(branches) && !branches.some((branch) => accepts(value, branch))) return false;
  const types = declaredTypes(schema);
  if (schema.nullable && value === null) return true;
  return !types || types.some((type) => typeMatches(value, type));
}

function allowsNull(schema) {
  if (!isSchema(schema)) return false;
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  if ('const' in schema) return schema.const === null;
  const branches = schema.anyOf || schema.oneOf;
  if (Array.isArray(branches)) return branches.some(allowsNull);
  const types = declaredTypes(schema);
  return Boolean(types?.includes('null'));
}

/** An empty string only counts as a real value when the schema lists it explicitly. */
function allowsEmptyString(schema) {
  if (!isSchema(schema)) return false;
  if (Array.isArray(schema.enum)) return schema.enum.includes('');
  if ('const' in schema) return schema.const === '';
  const branches = schema.anyOf || schema.oneOf;
  if (Array.isArray(branches)) return branches.some(allowsEmptyString);
  return false;
}

/** `""` and `null` sent for an optional parameter mean "not given". */
function isEmptyPlaceholder(value, schema) {
  if (value === '') return !allowsEmptyString(schema);
  if (value === null) return !allowsNull(schema);
  return false;
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Converts a value to `type` when that is unambiguous; returns undefined otherwise. */
function coerceTo(value, type) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((type === 'number' || type === 'integer') && CLEAN_NUMBER.test(trimmed)) {
      const number = Number(trimmed);
      if (Number.isFinite(number) && (type === 'number' || Number.isInteger(number))) return number;
    }
    if (type === 'boolean') {
      const lower = trimmed.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
    }
    if (type === 'array' || type === 'object') {
      const parsed = parseJson(trimmed);
      if (parsed.ok && typeMatches(parsed.value, type === 'array' ? 'array' : 'object')) return parsed.value;
    }
  }
  if (type === 'string' && typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeObject(value, schema) {
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const extra = schema.additionalProperties;
  let changed = false;
  const result = {};

  for (const [key, child] of Object.entries(value)) {
    const declared = Object.hasOwn(properties, key);
    const childSchema = declared ? properties[key] : isSchema(extra) ? extra : undefined;
    // Undeclared keys are only dropped where the schema forbids them anyway; open maps
    // (metadata, answers) may use null on purpose.
    if (!required.has(key) && (declared || extra === false) && isEmptyPlaceholder(child, childSchema)) {
      changed = true;
      continue;
    }
    if (childSchema) {
      const normalized = normalizeValue(child, childSchema);
      result[key] = normalized.value;
      changed ||= normalized.changed;
    } else {
      result[key] = child;
    }
  }
  return changed ? { value: result, changed } : unchanged(value);
}

function normalizeArray(value, schema) {
  if (!isSchema(schema.items)) return unchanged(value);
  let changed = false;
  const result = value.map((item) => {
    const normalized = normalizeValue(item, schema.items);
    changed ||= normalized.changed;
    return normalized.value;
  });
  return changed ? { value: result, changed } : unchanged(value);
}

/** Normalizes nested structure of a value whose own type is already acceptable. */
function normalizeChildren(value, schema) {
  if (Array.isArray(value)) return normalizeArray(value, schema);
  if (isPlainObject(value)) return normalizeObject(value, schema);
  return unchanged(value);
}

function normalizeValue(value, schema) {
  if (!isSchema(schema)) return unchanged(value);

  const branches = schema.anyOf || schema.oneOf;
  if (Array.isArray(branches) && branches.length) {
    // Leave the value alone when any branch takes it; otherwise use the first branch
    // that a single coercion satisfies.
    const accepting = branches.find((branch) => accepts(value, branch));
    if (accepting) return normalizeChildren(value, { ...schema, ...accepting });
    for (const branch of branches) {
      const attempt = normalizeValue(value, branch);
      if (attempt.changed && accepts(attempt.value, branch)) return attempt;
    }
    return unchanged(value);
  }

  if (accepts(value, schema)) return normalizeChildren(value, schema);

  for (const type of declaredTypes(schema) || []) {
    const coerced = coerceTo(value, type);
    if (coerced === undefined || !accepts(coerced, schema)) continue;
    const nested = normalizeChildren(coerced, schema);
    return { value: nested.value, changed: true };
  }
  return unchanged(value);
}

/**
 * Repairs a tool call's input against the tool's JSON Schema (`tools[].input_schema`).
 * Returns the (possibly new) input and whether anything changed; the argument is
 * never mutated.
 */
export function normalizeToolInput(input, schema) {
  if (!isSchema(schema)) return { input, changed: false };
  const { value, changed } = normalizeValue(input, schema);
  return { input: value, changed };
}
