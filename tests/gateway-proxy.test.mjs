import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { anthropicToolId, createSseTransformer, normalizeMessage, sanitizeToolSchemas, startGatewayProxy, toolSchemas } from '../server/gateway-proxy.mjs';

const READ_SCHEMA = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    offset: { type: 'integer' },
    limit: { type: 'integer' },
    pages: { type: 'string' },
  },
  required: ['file_path'],
  additionalProperties: false,
};
const REQUEST_BODY = {
  model: 'codex/gpt-6-luna',
  stream: true,
  tools: [{ name: 'Read', description: 'Read a file', input_schema: READ_SCHEMA }],
  messages: [{ role: 'user', content: 'read it' }],
};

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

// A recorded-style stream: text, then a Read call whose JSON is split across three deltas
// with a ping in the middle, then a second (valid) Read call that must pass unchanged.
const BAD_INPUT = '{"file_path":"/w/a.txt","pages":"","offset":"10","limit":""}';
const GOOD_INPUT = '{"file_path":"/w/b.txt"}';
const STREAM = [
  sse('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }),
  sse('ping', {}),
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Reading ' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'the file.' } }),
  sse('content_block_stop', { index: 0 }),
  sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }),
  sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: BAD_INPUT.slice(0, 20) } }),
  sse('ping', {}),
  sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: BAD_INPUT.slice(20, 41) } }),
  sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: BAD_INPUT.slice(41) } }),
  sse('content_block_stop', { index: 1 }),
  sse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} } }),
  sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: GOOD_INPUT.slice(0, 10) } }),
  sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: GOOD_INPUT.slice(10) } }),
  sse('content_block_stop', { index: 2 }),
  sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }),
  sse('message_stop', {}),
];
const FIXED_DELTA = sse('content_block_delta', {
  index: 1,
  delta: { type: 'input_json_delta', partial_json: '{"file_path":"/w/a.txt","offset":10}' },
});
const EXPECTED = [...STREAM.slice(0, 7), STREAM[8], FIXED_DELTA, ...STREAM.slice(11)].join('');

function transform(chunks, schemas = toolSchemas(REQUEST_BODY)) {
  let output = '';
  const transformer = createSseTransformer(schemas, (text) => (output += text));
  for (const chunk of chunks) transformer.push(chunk);
  transformer.end();
  return output;
}

describe('createSseTransformer', () => {
  test('replaces held tool deltas with one normalized delta, passes the rest through', () => {
    assert.equal(transform(STREAM), EXPECTED);
  });

  test('is independent of how the bytes are chunked', () => {
    const whole = STREAM.join('');
    assert.equal(transform([...whole]), EXPECTED, 'one character at a time');
    assert.equal(transform([whole.slice(0, 333), whole.slice(333, 334), whole.slice(334)]), EXPECTED);
  });

  test('handles CRLF framing', () => {
    const crlf = STREAM.join('').replace(/\n/g, '\r\n');
    const output = transform([crlf]);
    assert.ok(output.includes('"partial_json":"{\\"file_path\\":\\"/w/a.txt\\",\\"offset\\":10}"'));
    assert.ok(output.includes('text_delta'));
  });

  test('unknown tools, unparsable JSON and unfinished blocks pass through unchanged', () => {
    const unknown = STREAM.join('').replace(/"name":"Read"/g, '"name":"Other"');
    assert.equal(transform([unknown]), unknown);

    const broken = [
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/a", "pages": "' } }),
      sse('content_block_stop', { index: 0 }),
    ];
    assert.equal(transform(broken), broken.join(''));

    const cutOff = broken.slice(0, 2);
    assert.equal(transform(cutOff), cutOff.join(''), 'held deltas are released when upstream ends');
  });

  test('normalizes input given up front in content_block_start', () => {
    const upFront = sse('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a', pages: '' } },
    });
    const output = transform([upFront, sse('content_block_stop', { index: 0 })]);
    assert.ok(output.includes('"input":{"file_path":"/a"}'));
    assert.ok(!output.includes('pages'));
  });

  test('error events and comments are forwarded verbatim', () => {
    const events = [': keep-alive\n\n', sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })];
    assert.equal(transform(events), events.join(''));
  });
});

describe('tool call ids', () => {
  const VALID = /^toolu_[0-9a-f]{24}$/;

  test('valid ids are kept; invalid ones become unique toolu_ ids per response', () => {
    assert.equal(anthropicToolId('call_abc-12', 'msg_1'), 'call_abc-12');
    const first = anthropicToolId('functions.Bash:0', 'msg_1');
    assert.match(first, VALID);
    assert.equal(anthropicToolId('functions.Bash:0', 'msg_1'), first, 'stable within a response');
    assert.notEqual(anthropicToolId('functions.Bash:0', 'msg_2'), first, 'Kimi reuses ids every turn');
    assert.match(anthropicToolId(undefined, 'msg_1'), VALID);
  });

  test('a streamed Kimi-style id is rewritten in content_block_start', () => {
    const stream = [
      sse('message_start', { message: { id: 'chatcmpl-9', type: 'message', role: 'assistant', content: [] } }),
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'functions.Bash:0', name: 'Bash', input: {} } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }),
      sse('content_block_stop', { index: 0 }),
    ];
    const out = transform(stream);
    const start = out.split('\n\n').map((raw) => raw.split('data: ')[1]).filter(Boolean).map(JSON.parse).find((e) => e.type === 'content_block_start');
    assert.equal(start.content_block.id, anthropicToolId('functions.Bash:0', 'chatcmpl-9'));
    assert.match(out, /"partial_json":"\{\\"command\\":\\"ls\\"\}"/);
  });

  test('non-streaming responses get the same rewrite', () => {
    const message = { id: 'm1', content: [{ type: 'tool_use', id: 'functions.Read:1', name: 'Other', input: {} }] };
    const result = normalizeMessage(message, toolSchemas(REQUEST_BODY));
    assert.equal(result.changed, true);
    assert.equal(result.message.content[0].id, anthropicToolId('functions.Read:1', 'm1'));
  });
});

describe('normalizeMessage', () => {
  test('normalizes tool_use blocks of a non-streaming response', () => {
    const message = {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a', limit: '' } },
      ],
    };
    const result = normalizeMessage(message, toolSchemas(REQUEST_BODY));
    assert.equal(result.changed, true);
    assert.deepEqual(result.message.content[1].input, { file_path: '/a' });
    assert.equal(result.message.content[0], message.content[0]);
  });
});

describe('startGatewayProxy', () => {
  let upstream;
  let proxy;
  const seen = [];

  before(async () => {
    upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"data":[{"id":"codex/gpt-6-luna"}]}');
      }
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"input_tokens":7}');
      }
      if (req.url.startsWith('/v1/messages')) {
        const parsed = JSON.parse(body);
        if (!parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({ id: 'msg', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a', offset: '3' } }] }),
          );
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of STREAM) res.write(event);
        return res.end();
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"type":"error"}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    proxy = await startGatewayProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamKey: 'real-key', relayKey: () => 'gateway-relay-key-0123456789abcdef0123', log: () => {} });
  });

  after(async () => {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const call = (path, { method = 'GET', key, bearer, harbor, headers: extra, body } = {}) =>
    fetch(proxy.url + path, {
      method,
      headers: {
        ...(key ? { 'x-api-key': key } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(harbor ? { 'x-harbor-key': harbor } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  test('listens on loopback with a long random secret', () => {
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(proxy.secret, /^[0-9a-f]{64}$/);
  });

  test('refuses requests without the secret', async () => {
    const before = seen.length;
    for (const options of [{}, { key: 'harbor' }, { key: proxy.secret.slice(1) }, { bearer: 'nope' }]) {
      const response = await call('/v1/models', options);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.type, 'authentication_error');
    }
    assert.equal(seen.length, before, 'nothing reached upstream');
  });

  test('passes other routes through with the real key', async () => {
    const models = await call('/v1/models', { key: proxy.secret });
    assert.equal(models.status, 200);
    assert.deepEqual(await models.json(), { data: [{ id: 'codex/gpt-6-luna' }] });
    assert.equal(seen.at(-1).headers['x-api-key'], 'real-key');

    const count = await call('/v1/messages/count_tokens?beta=true', { method: 'POST', bearer: proxy.secret, body: REQUEST_BODY });
    assert.deepEqual(await count.json(), { input_tokens: 7 });
    assert.equal(seen.at(-1).headers.authorization, 'Bearer real-key');
    assert.equal(seen.at(-1).headers['x-api-key'], undefined);

    const missing = await call('/nowhere', { key: proxy.secret });
    assert.equal(missing.status, 404);
  });

  test('rewrites streamed tool input and forwards the request body unchanged', async () => {
    const response = await call('/v1/messages?beta=true', { method: 'POST', key: proxy.secret, body: REQUEST_BODY });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(await response.text(), EXPECTED);
    const forwarded = seen.at(-1);
    assert.equal(forwarded.url, '/v1/messages?beta=true');
    assert.equal(forwarded.body, JSON.stringify(REQUEST_BODY));
    assert.equal(forwarded.headers['accept-encoding'], 'identity');
    assert.equal(forwarded.headers['x-api-key'], 'real-key');
  });

  test('drops tool schema patterns DeepSeek rejects (\0) before forwarding', async () => {
    const artifact = {
      name: 'Artifact',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', pattern: '^[a-z]+$' },
          file_paths: { type: 'array', items: { type: 'string', pattern: '^[^\\0]*$' } },
          files: { anyOf: [{ type: 'object', additionalProperties: { type: 'string', pattern: '^[^\\0]*$' } }] },
        },
      },
    };
    const body = { ...REQUEST_BODY, stream: false, tools: [...REQUEST_BODY.tools, artifact] };
    const response = await call('/v1/messages', { method: 'POST', key: proxy.secret, body });
    assert.equal(response.status, 200);
    const sent = JSON.parse(seen.at(-1).body).tools.at(-1).input_schema.properties;
    assert.deepEqual(sent.file_paths.items, { type: 'string' });
    assert.deepEqual(sent.files.anyOf[0].additionalProperties, { type: 'string' });
    assert.equal(sent.pattern.pattern, '^[a-z]+$', 'other patterns and a property named pattern stay');
    assert.equal(sanitizeToolSchemas(JSON.parse(JSON.stringify(REQUEST_BODY))), false);
  });

  test('normalizes non-streaming JSON responses', async () => {
    const response = await call('/v1/messages', { method: 'POST', key: proxy.secret, body: { ...REQUEST_BODY, stream: false } });
    const message = await response.json();
    assert.deepEqual(message.content[0].input, { file_path: '/a', offset: 3 });
    assert.equal(Number(response.headers.get('content-length')), JSON.stringify(message).length);
  });

  test('accepts the secret in x-harbor-key and strips it upstream', async () => {
    const response = await call('/v1/messages', { method: 'POST', harbor: proxy.secret, body: { ...REQUEST_BODY, stream: false } });
    assert.equal(response.status, 200);
    const forwarded = seen.at(-1);
    assert.equal(forwarded.headers['x-api-key'], 'real-key');
    assert.equal(forwarded.headers.authorization, undefined);
    assert.equal(forwarded.headers['x-harbor-key'], undefined);
  });

  test('claude relay with x-harbor-key passes the caller OAuth headers through unchanged', async () => {
    const response = await call('/claude-relay/v1/messages', {
      method: 'POST',
      harbor: proxy.secret,
      body: { model: 'claude-opus-5-5', stream: false, messages: [] },
      headers: { authorization: 'Bearer oauth-abc', 'x-api-key': 'client-key' },
    });
    assert.equal(response.status, 404, 'the fake upstream knows no relay route');
    const forwarded = seen.at(-1);
    assert.equal(forwarded.url, '/claude-relay/v1/messages');
    assert.equal(forwarded.headers.authorization, 'Bearer oauth-abc');
    assert.equal(forwarded.headers['x-api-key'], 'client-key');
    assert.equal(forwarded.headers['x-harbor-key'], undefined);
  });

  test('a remote cluster’s placeholder OAuth token becomes the gateway’s relay key on the relay', async () => {
    await call('/claude-relay/v1/messages', {
      method: 'POST',
      harbor: proxy.secret,
      body: { model: 'claude-opus-5-5', stream: false, messages: [] },
      headers: { authorization: 'Bearer harbor-relay' },
    });
    assert.equal(seen.at(-1).headers.authorization, 'Bearer gateway-relay-key-0123456789abcdef0123');
    // only through x-harbor-key, and only on the relay
    await call('/v1/messages', { method: 'POST', harbor: proxy.secret, body: { ...REQUEST_BODY, stream: false }, headers: { authorization: 'Bearer harbor-relay' } });
    assert.notEqual(seen.at(-1).headers.authorization, 'Bearer gateway-relay-key-0123456789abcdef0123');
  });

  test('a wrong or missing x-harbor-key on the relay is still refused', async () => {
    const before = seen.length;
    for (const options of [{ harbor: 'nope' }, { harbor: proxy.secret.slice(1) }, {}]) {
      const response = await call('/claude-relay/v1/messages', { method: 'POST', body: {}, ...options });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.type, 'authentication_error');
    }
    assert.equal(seen.length, before, 'nothing reached upstream');
  });

  test('the old auth headers keep their old behaviour, including on the relay path', async () => {
    const bearer = await call('/claude-relay/v1/messages', { method: 'POST', bearer: proxy.secret, body: {} });
    assert.equal(bearer.status, 404);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer real-key');
    assert.equal(seen.at(-1).headers['x-api-key'], undefined);

    const key = await call('/claude-relay/v1/messages', { method: 'POST', key: proxy.secret, body: {} });
    assert.equal(key.status, 404);
    assert.equal(seen.at(-1).headers['x-api-key'], 'real-key');
    assert.equal(seen.at(-1).headers.authorization, undefined);
  });

  test('answers 502 with an Anthropic-style error when upstream is down', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const dead = await startGatewayProxy({ upstream: `http://127.0.0.1:${deadPort}`, log: () => {} });
    try {
      const response = await fetch(dead.url + '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': dead.secret, 'content-type': 'application/json' },
        body: JSON.stringify(REQUEST_BODY),
      });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.type, 'error');
      assert.equal(body.error.type, 'api_error');
    } finally {
      await dead.close();
    }
  });
});
