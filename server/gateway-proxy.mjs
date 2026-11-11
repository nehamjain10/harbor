// A local proxy between Claude Code and the model gateway for non-Claude models. It
// repairs tool-call inputs in the model's response (see normalize.mjs) before the CLI
// validates them; everything else passes through byte for byte.
//
// This host is a shared multi-user login node, so the proxy listens on 127.0.0.1 with a
// random port and only serves requests carrying its per-boot secret as the API key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { normalizeToolInput } from './normalize.mjs';

// Headers that describe one hop, not the message, and are never forwarded.
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function apiError(type, message) {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

function sendError(res, status, type, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(apiError(type, message));
}

function safeEqual(given, secret) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Carries the proxy secret from callers that need to keep their own auth headers (the
// Claude relay below). It is never forwarded upstream, only stripped.
const HARBOR_KEY_HEADER = 'x-harbor-key';
// What a Claude Code on another cluster sends as its OAuth token (CLAUDE_CODE_OAUTH_TOKEN):
// no credential at all. The proxy swaps it for the gateway's relay key, and the gateway's
// relay serves the request on the Claude accounts it holds; the cluster holds none.
export const RELAY_PLACEHOLDER = 'harbor-relay';

/** Which header carried the caller's key ('x-harbor-key', 'x-api-key' or 'authorization'), or null. */
function authenticate(req, secret) {
  if (safeEqual(req.headers[HARBOR_KEY_HEADER], secret)) return HARBOR_KEY_HEADER;
  if (safeEqual(req.headers['x-api-key'], secret)) return 'x-api-key';
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (bearer && safeEqual(bearer[1].trim(), secret)) return 'authorization';
  return null;
}

function requestPath(req) {
  return new URL(req.url, 'http://proxy').pathname;
}

/**
 * The Claude relay passes the caller's own OAuth token through to the gateway, so a request
 * that proved itself with `x-harbor-key` keeps its Authorization/x-api-key untouched.
 * Every other request has them replaced by `upstreamKey`.
 */
function forwardHeaders(incoming, authHeader, upstreamKey, { passAuth = false } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (HOP_HEADERS.has(name) || name === HARBOR_KEY_HEADER) continue;
    if (!passAuth && (name === 'x-api-key' || name === 'authorization')) continue;
    headers[name] = value;
  }
  if (passAuth) return headers;
  if (authHeader === 'authorization') headers.authorization = `Bearer ${upstreamKey}`;
  else headers['x-api-key'] = upstreamKey;
  return headers;
}

function responseHeaders(upstreamHeaders, { dropLength = false } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (HOP_HEADERS.has(name) || (dropLength && name === 'content-length')) continue;
    headers[name] = value;
  }
  return headers;
}

/** tool name -> input_schema from a Messages API request body (empty when unparsable). */
export function toolSchemas(body) {
  const schemas = new Map();
  for (const tool of body?.tools || []) {
    if (tool?.name && tool.input_schema) schemas.set(tool.name, tool.input_schema);
  }
  return schemas;
}

// Schema keywords whose value is a schema, or a list or map of schemas.
const SUB_SCHEMA = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'];
const SUB_SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const SUB_SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
// A regex escape some providers' validators reject (DeepSeek: `"^[^\\0]*$" is not a "regex"`,
// which fails the whole request; Claude Code's Artifact tool has it).
const REJECTED_PATTERN = /\\0/;

/** Drops `pattern`s with escapes providers reject from one schema, in place; true when it did. */
function dropRejectedPatterns(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  let changed = false;
  if (typeof schema.pattern === 'string' && REJECTED_PATTERN.test(schema.pattern)) {
    delete schema.pattern;
    changed = true;
  }
  for (const key of SUB_SCHEMA) changed = dropRejectedPatterns(schema[key]) || changed;
  for (const key of SUB_SCHEMA_LISTS) {
    if (Array.isArray(schema[key])) for (const sub of schema[key]) changed = dropRejectedPatterns(sub) || changed;
  }
  if (Array.isArray(schema.items)) for (const sub of schema.items) changed = dropRejectedPatterns(sub) || changed;
  for (const key of SUB_SCHEMA_MAPS) {
    const map = schema[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) for (const sub of Object.values(map)) changed = dropRejectedPatterns(sub) || changed;
  }
  return changed;
}

/** Drops tool schema `pattern`s providers reject from a parsed request body, in place; true when it did. */
export function sanitizeToolSchemas(body) {
  let changed = false;
  for (const tool of body?.tools || []) changed = dropRejectedPatterns(tool?.input_schema) || changed;
  return changed;
}

const ANTHROPIC_TOOL_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Some providers mint tool call ids the Anthropic API rejects (Kimi: `functions.Bash:0`,
 * reused every turn). The CLI keeps whatever id it is given, so a later switch to a
 * Claude model would fail on the replayed history. Such ids are replaced by a
 * `toolu_` id unique to this response (`salt`: the upstream message id).
 */
export function anthropicToolId(id, salt) {
  if (typeof id === 'string' && ANTHROPIC_TOOL_ID.test(id)) return id;
  return 'toolu_' + crypto.createHash('sha256').update(`${salt}\0${id}`).digest('hex').slice(0, 24);
}

/** Normalizes every tool_use block of a non-streaming Messages API response. */
export function normalizeMessage(message, schemas) {
  let changed = false;
  const salt = message?.id || crypto.randomUUID();
  const content = (message?.content || []).map((block) => {
    if (block?.type !== 'tool_use') return block;
    let next = block;
    const id = anthropicToolId(block.id, salt);
    if (id !== block.id) next = { ...next, id };
    if (schemas.has(block.name)) {
      const result = normalizeToolInput(block.input, schemas.get(block.name));
      if (result.changed) next = { ...next, input: result.input };
    }
    if (next !== block) changed = true;
    return next;
  });
  return changed ? { message: { ...message, content }, changed } : { message, changed };
}

function parseEvent(raw) {
  let event = null;
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return { event, data: null };
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return { event, data: null };
  }
}

function formatEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Rewrites an Anthropic SSE stream: tool_use input deltas are held back per content
 * block and replaced, at that block's content_block_stop, by one delta carrying the
 * normalized JSON. All other events (text, thinking, ping, error, ...) pass through
 * untouched and immediately. `write` receives output text as soon as it is ready.
 */
export function createSseTransformer(schemas, write) {
  let buffer = '';
  let salt = crypto.randomUUID(); // replaced by the upstream message id once known
  const toolBlocks = new Map(); // content block index -> { name, json, rawEvents }

  function finishToolBlock(index, stopRaw) {
    const block = toolBlocks.get(index);
    toolBlocks.delete(index);
    let replacement = null;
    if (block.json) {
      try {
        const result = normalizeToolInput(JSON.parse(block.json), schemas.get(block.name));
        if (result.changed) replacement = JSON.stringify(result.input);
      } catch {
        // Not valid JSON: hand the CLI exactly what the model sent.
      }
    }
    if (replacement === null) write(block.rawEvents.join(''));
    else {
      const delta = { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: replacement } };
      write(formatEvent('content_block_delta', delta));
    }
    write(stopRaw);
  }

  function handleEvent(raw) {
    const { event, data } = parseEvent(raw);
    const type = data?.type;
    if (type === 'message_start' && data.message?.id) salt = data.message.id;
    if (type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      let block = data.content_block;
      const id = anthropicToolId(block.id, salt);
      if (id !== block.id) block = { ...block, id };
      const hasInput = block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0;
      // Some gateways send the whole input up front instead of as deltas.
      if (hasInput && schemas.has(block.name)) {
        const result = normalizeToolInput(block.input, schemas.get(block.name));
        if (result.changed) block = { ...block, input: result.input };
      }
      if (block !== data.content_block) raw = formatEvent(event || type, { ...data, content_block: block });
      // Only calls to tools with a known schema are held back; the rest stream as usual.
      if (schemas.has(block.name)) toolBlocks.set(data.index, { name: block.name, json: '', rawEvents: [] });
      return write(raw);
    }
    if (type === 'content_block_delta' && data.delta?.type === 'input_json_delta' && toolBlocks.has(data.index)) {
      const block = toolBlocks.get(data.index);
      block.json += data.delta.partial_json ?? '';
      block.rawEvents.push(raw);
      return;
    }
    if (type === 'content_block_stop' && toolBlocks.has(data.index)) return finishToolBlock(data.index, raw);
    write(raw);
  }

  return {
    push(text) {
      buffer += text;
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const end = match.index + match[0].length;
        handleEvent(buffer.slice(0, end));
        buffer = buffer.slice(end);
      }
    },
    /** Upstream ended: release anything still held, unchanged. */
    end() {
      for (const block of toolBlocks.values()) write(block.rawEvents.join(''));
      toolBlocks.clear();
      if (buffer) write(buffer);
      buffer = '';
    },
  };
}

function isMessagesRoute(req) {
  return req.method === 'POST' && requestPath(req) === '/v1/messages';
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Starts the proxy. Requests must carry `secret` as `x-api-key` (or a Bearer token, or the
 * `x-harbor-key` header); they are forwarded to `upstream` with `upstreamKey` instead.
 * @returns {Promise<{url: string, port: number, secret: string, close: () => Promise<void>}>}
 */
/**
 * `port` and `secret` let a restarted server take over the address Claude Code processes
 * that outlived it were given (the CLI host); 0 and a fresh secret otherwise.
 */
export async function startGatewayProxy({ upstream, upstreamKey = 'harbor', port: wantedPort = 0, secret = crypto.randomBytes(32).toString('hex'), relayKey = () => null, log = console.error }) {
  const target = new URL(upstream);
  const transport = target.protocol === 'https:' ? https : http;
  const basePath = target.pathname.replace(/\/+$/, '');

  function forward(req, res, { body, authHeader, schemas }) {
    // Only an x-harbor-key caller on the Claude relay keeps its own auth headers; the CLI's
    // OAuth token is exactly what the gateway's relay expects to see.
    const passAuth = authHeader === HARBOR_KEY_HEADER && requestPath(req).startsWith('/claude-relay/');
    const headers = forwardHeaders(req.headers, authHeader, upstreamKey, { passAuth });
    if (passAuth && headers.authorization === `Bearer ${RELAY_PLACEHOLDER}`) {
      const key = relayKey();
      if (key) headers.authorization = `Bearer ${key}`;
    }
    if (body) {
      headers['content-length'] = String(body.length);
      // The SSE rewrite needs plain text from upstream.
      headers['accept-encoding'] = 'identity';
    }
    const upstreamReq = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: basePath + req.url,
      headers,
    });

    // The CLI hangs up when a turn is interrupted; stop the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });

    upstreamReq.on('error', (error) => {
      if (res.writableEnded || res.destroyed) return;
      log(`Gateway proxy: upstream request failed: ${error.message}`);
      sendError(res, 502, 'api_error', `The model gateway is unreachable (${error.code || error.message}).`);
    });

    upstreamReq.on('response', (upstreamRes) => {
      const type = String(upstreamRes.headers['content-type'] || '');
      const encoded = upstreamRes.headers['content-encoding'] && upstreamRes.headers['content-encoding'] !== 'identity';
      const transform = schemas?.size && upstreamRes.statusCode === 200 && !encoded;

      if (transform && type.includes('text/event-stream')) {
        res.writeHead(upstreamRes.statusCode, responseHeaders(upstreamRes.headers, { dropLength: true }));
        res.flushHeaders();
        const decoder = new StringDecoder('utf8');
        const transformer = createSseTransformer(schemas, (text) => res.write(text));
        upstreamRes.on('data', (chunk) => transformer.push(decoder.write(chunk)));
        upstreamRes.on('end', () => {
          transformer.push(decoder.end());
          transformer.end();
          res.end();
        });
        upstreamRes.on('error', () => res.destroy());
        return;
      }

      if (transform && type.includes('application/json')) {
        readBody(upstreamRes)
          .then((raw) => {
            let output = raw;
            try {
              const { message, changed } = normalizeMessage(JSON.parse(raw.toString('utf8')), schemas);
              if (changed) output = Buffer.from(JSON.stringify(message));
            } catch {
              // Unparsable: pass it on as received.
            }
            const headers = responseHeaders(upstreamRes.headers, { dropLength: true });
            headers['content-length'] = String(output.length);
            res.writeHead(upstreamRes.statusCode, headers);
            res.end(output);
          })
          .catch(() => res.destroy());
        return;
      }

      res.writeHead(upstreamRes.statusCode, responseHeaders(upstreamRes.headers));
      // pipeline() (unlike pipe) tears the response down when upstream drops mid-stream,
      // so the CLI sees an error at once instead of waiting for its own API timeout.
      pipeline(upstreamRes, res, (error) => {
        if (error) res.destroy();
      });
    });

    if (body) upstreamReq.end(body);
    else req.pipe(upstreamReq);
  }

  const server = http.createServer((req, res) => {
    const authHeader = authenticate(req, secret);
    if (!authHeader) return sendError(res, 401, 'authentication_error', 'Invalid API key for the Harbor gateway proxy.');

    if (!isMessagesRoute(req)) return forward(req, res, { authHeader });

    readBody(req)
      .then((body) => {
        let schemas = new Map();
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          if (sanitizeToolSchemas(parsed)) body = Buffer.from(JSON.stringify(parsed));
          schemas = toolSchemas(parsed);
        } catch {
          // Not JSON: forward untouched and let upstream answer.
        }
        forward(req, res, { body, authHeader, schemas });
      })
      .catch(() => res.destroy());
  });

  const listen = (at) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(at, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  // The previous server may still be letting go of the port for a moment.
  let bound = false;
  for (let attempt = 0; wantedPort && attempt < 20 && !bound; attempt++) {
    try {
      await listen(wantedPort);
      bound = true;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!bound) {
    if (wantedPort) log(`Gateway proxy port ${wantedPort} is taken; Claude Code processes from before this restart lose the gateway.`);
    await listen(0);
  }
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    secret,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * The gateway's relay key, read from `file` (WORKBENCH_RELAY_KEY_FILE; the gateway makes
 * it) at every call, or null without a file or a key.
 */
export function readRelayKey(file) {
  if (!file) return null;
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    return key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}
