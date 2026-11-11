// A stand-in for an OAuth-protected MCP server such as Slack's, on 127.0.0.1 (a test
// harness listener), for the sign-in tests: the real Claude Code CLI discovers the
// authorization server, registers itself, and exchanges the code for a token here. The
// test plays the browser with `approve(authUrl)`, which is what the user's "Allow" click
// does, and hands back the localhost callback address the browser would end on.
//
//   const oauth = await startOAuthMcpServer();
//   oauth.url                          the MCP address to put in a .mcp.json
//   oauth.approve(authUrl)             -> the callback address (with code and state)
//   oauth.tokens, oauth.requests       what the CLI did here
//   await oauth.close()
//
// The MCP side is one tool, `whoami`, over streamable HTTP with plain JSON replies; every
// request needs `Authorization: Bearer <a token this server issued>`.
import crypto from 'node:crypto';
import http from 'node:http';

const b64url = (buffer) => buffer.toString('base64url');

export async function startOAuthMcpServer({ clientId = 'test-client' } = {}) {
  const requests = [];
  const codes = new Map(); // code -> { challenge, redirectUri }
  const tokens = new Set();
  let origin = '';

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => resolve(text));
    });

  function mcp(message) {
    const { id, method, params } = message;
    if (id === undefined) return null; // notifications
    const result = (value) => ({ jsonrpc: '2.0', id, result: value });
    switch (method) {
      case 'initialize':
        return result({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oauthy', version: '1.0.0' } });
      case 'tools/list':
        return result({ tools: [{ name: 'whoami', description: 'Who the token belongs to.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] });
      case 'tools/call':
        return result({ content: [{ type: 'text', text: 'signed in as test-user' }] });
      case 'ping':
        return result({});
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const body = req.method === 'POST' ? await readBody(req) : '';
    requests.push({ method: req.method, path: url.pathname, authorized: tokens.has(String(req.headers.authorization || '').replace(/^Bearer /i, '')) });

    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      let redirectUris = [];
      try {
        redirectUris = JSON.parse(body).redirect_uris ?? [];
      } catch {
        // keep []
      }
      return json(res, 201, { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      const code = form.get('code');
      const issued = codes.get(code);
      const verified = issued && b64url(crypto.createHash('sha256').update(form.get('code_verifier') || '').digest()) === issued.challenge;
      if (form.get('grant_type') !== 'authorization_code' || !verified) return json(res, 400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
      codes.delete(code);
      const token = `token-${crypto.randomUUID()}`;
      tokens.add(token);
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${crypto.randomUUID()}` });
    }
    if (url.pathname === '/mcp') {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /i, '');
      if (!tokens.has(bearer)) {
        return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        return res.end();
      }
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      const messages = Array.isArray(message) ? message : [message];
      const replies = messages.map(mcp).filter(Boolean);
      if (!replies.length) {
        res.writeHead(202);
        return res.end();
      }
      return json(res, 200, Array.isArray(message) ? replies : replies[0]);
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    url: `${origin}/mcp`,
    origin,
    requests,
    tokens,
    /** The user clicking Allow on the authorization page: the callback address the browser ends on. */
    approve(authUrl) {
      const auth = new URL(authUrl);
      assertAuthRequest(auth, origin, clientId);
      const code = `code-${crypto.randomUUID()}`;
      codes.set(code, { challenge: auth.searchParams.get('code_challenge'), redirectUri: auth.searchParams.get('redirect_uri') });
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', auth.searchParams.get('state'));
      return callback.href;
    },
    /** Drops every token: the server then asks for a sign-in again. */
    revokeAll: () => tokens.clear(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function assertAuthRequest(auth, origin, clientId) {
  const problems = [];
  if (auth.origin !== origin || auth.pathname !== '/authorize') problems.push(`not this server's authorize endpoint: ${auth.origin}${auth.pathname}`);
  if (auth.searchParams.get('client_id') !== clientId) problems.push('client_id');
  if (auth.searchParams.get('response_type') !== 'code') problems.push('response_type');
  if (auth.searchParams.get('code_challenge_method') !== 'S256' || !auth.searchParams.get('code_challenge')) problems.push('PKCE');
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(auth.searchParams.get('redirect_uri') || '')) problems.push('redirect_uri');
  if (!auth.searchParams.get('state')) problems.push('state');
  if (problems.length) throw new Error(`Unexpected authorization request: ${problems.join(', ')}`);
}
