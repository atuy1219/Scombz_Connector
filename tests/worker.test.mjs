import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { digest, random, sign } from '../src/crypto.mjs';
import { SessionStore } from '../src/storage.mjs';

const origin = 'https://fixture.workers.dev';
const bindings = { ADMIN_TOKEN: 'a'.repeat(64), SESSION_ENCRYPTION_KEY: 'b'.repeat(64) };
const state = {
  cookies: [
    {
      name: 'SESSION',
      value: 'private-fixture-cookie',
      domain: 'scombz.shibaura-it.ac.jp',
      path: '/',
      secure: true,
      expires: -1,
    },
    { name: 'OTHER', value: 'do-not-store', domain: 'unrelated.example' },
  ],
  origins: [
    {
      origin: 'https://unrelated.example',
      localStorage: [{ name: 'password', value: 'never-store' }],
    },
  ],
};
const page = (body) => `<html><div id="page_head"></div>${body}</html>`;
let mf,
  db,
  upstream = 0,
  clientId,
  accessToken,
  refreshToken;
let upstreamMode = 'ok';
const course = page(
  '<form id="courseTopForm"><div id="materialContents"><div><span class="fileName">first.pdf</span><span class="objectName">o</span><span class="resource_Id">r</span><input id="dlMaterialId" value="m"></div></div></form>',
);
const req = (path, options = {}) =>
  mf.dispatchFetch(origin + path, { redirect: 'manual', ...options });
const post = (path, body, headers = {}) =>
  req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const form = (path, body, headers = {}) =>
  req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
const adminHeaders = { Origin: origin, Authorization: 'Bearer ' + bindings.ADMIN_TOKEN };
const rpc = (name, args = {}, headers = {}) =>
  post(
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { Accept: 'application/json, text/event-stream', ...headers },
  );
before(async () => {
  await build({
    entryPoints: ['src/worker.mjs'],
    outfile: '.wrangler/test-worker.mjs',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['node:*'],
  });
  mf = new Miniflare({
    modules: true,
    scriptPath: '.wrangler/test-worker.mjs',
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings,
    outboundService: async (request) => {
      upstream++;
      assert.equal(request.method, 'GET');
      assert.equal(new URL(request.url).origin, 'https://scombz.shibaura-it.ac.jp');
      assert.ok(request.headers.get('cookie').includes('SESSION=private-fixture-cookie'));
      if (upstreamMode === 'login') return new Response('<form id="loginForm"></form>');
      if (upstreamMode === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.example/steal' },
        });
      const path = new URL(request.url).pathname;
      if (path === '/lms/course') return new Response(course);
      if (path === '/lms/course/make/tempfile') return new Response('temporary-id');
      if (path.startsWith('/lms/course/material/setfiledown/')) {
        if (upstreamMode === 'large')
          return new Response('%PDF-1.7 fixture', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Length': String(100 * 1024 * 1024 + 1),
            },
          });
        return new Response('%PDF-1.7 fixture', { headers: { 'Content-Type': 'application/pdf' } });
      }
      return new Response(page('home'));
    },
  });
  db = await mf.getD1Database('DB');
  for (const name of ['0001_initial.sql', '0002_mobile_auth.sql']) {
    const migration = await readFile('migrations/' + name, 'utf8');
    await db.exec(migration.replaceAll('\n', ' '));
  }
  await new SessionStore({ ...bindings, DB: db }).save(
    { cookies: state.cookies.slice(0, 1), origins: [] },
    { replace: true },
  );
});
after(async () => {
  await mf?.dispose();
});

test('runtime health, script CSP and OAuth discovery require no personal data', async () => {
  assert.deepEqual(await (await req('/health')).json(), {
    name: 'scombz-connector',
    version: '1.0.0',
    configured: true,
  });
  const ui = await req('/');
  assert.equal(ui.status, 200);
  assert.ok(ui.headers.get('content-security-policy').includes("script-src 'self';"));
  const uiText = await ui.text();
  assert.ok(!uiText.includes('chatgpt.site'));
  assert.ok(!uiText.includes('session.json'));
  assert.ok(uiText.includes('ScombZログイン'));
  const meta = await (await req('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(meta.resource, origin + '/mcp');
  assert.deepEqual(meta.authorization_servers, [origin]);
  assert.equal(meta.resource_documentation, origin + '/');
  const auth = await (await req('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
  assert.equal(upstream, 0);
});
test('admin routes reject forged identity, bearer access and missing Origin', async () => {
  for (const headers of [
    {},
    { 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.test' },
  ])
    assert.equal((await req('/api/mobile', { method: 'DELETE', headers })).status, 401);
  assert.equal(
    (
      await req('/api/mobile', {
        method: 'DELETE',
        headers: { Authorization: adminHeaders.Authorization },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await req('/api/mobile', {
        method: 'DELETE',
        headers: { ...adminHeaders, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal(upstream, 0);
});

test('legacy session.json upload API is removed without changing stored session', async () => {
  const previous = (await db.prepare('SELECT data FROM session').first()).data;
  const response = await post('/api/connection', state, adminHeaders);
  assert.equal(response.status, 404);
  assert.equal((await db.prepare('SELECT data FROM session').first()).data, previous);
});

test('a stale request cannot overwrite a newly registered session', async () => {
  const env = { ...bindings, DB: db };
  const stale = new SessionStore(env),
    fresh = new SessionStore(env);
  const original = await stale.load();
  const updated = await fresh.load();
  updated.cookies[0].value = 'newer-cookie';
  await fresh.save(updated, { replace: true });
  original.cookies[0].value = 'stale-cookie';
  await stale.save(original);
  const restored = new SessionStore(env);
  assert.equal((await restored.load()).cookies[0].value, 'newer-cookie');
  await restored.save({ cookies: state.cookies.slice(0, 1), origins: [] }, { replace: true });
});
test('stateless DCR refuses foreign/injected redirects and confidential clients', async () => {
  for (const uri of [
    'https://evil.example/callback',
    'https://chatgpt.com.evil.example/callback',
    'https://chatgpt.com/callback#fragment',
    'http://chatgpt.com/callback',
  ])
    assert.equal((await post('/oauth/register', { redirect_uris: [uri] })).status, 400);
  assert.equal(
    (
      await post('/oauth/register', {
        redirect_uris: ['https://chatgpt.com/connector_platform/oauth/callback'],
        token_endpoint_auth_method: 'client_secret_post',
      })
    ).status,
    400,
  );
  const r = await post('/oauth/register', {
    client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/connector_platform/oauth/callback'],
    token_endpoint_auth_method: 'none',
  });
  assert.equal(r.status, 201);
  clientId = (await r.json()).client_id;
});
async function authorize(extra = {}) {
  const verifier = random(),
    p = {
      client_id: clientId,
      redirect_uri: 'https://chatgpt.com/connector_platform/oauth/callback',
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: await digest(verifier),
      resource: origin + '/mcp',
      state: 'fixture-state',
      ...extra,
    };
  const response = await req('/oauth/authorize?' + new URLSearchParams(p));
  return { response, verifier, params: p };
}
async function codeForClient() {
  const { response, verifier, params } = await authorize();
  assert.equal(response.status, 200);
  const html = await response.text(),
    ticket = html.match(/name="ticket" value="([^"]+)"/)[1];
  assert.equal(
    (await form('/oauth/approve', { ticket, admin_token: 'wrong' }, { Origin: origin })).status,
    401,
  );
  const result = await form(
    '/oauth/approve',
    { ticket, admin_token: bindings.ADMIN_TOKEN },
    { Origin: origin },
  );
  assert.equal(result.status, 303);
  const target = new URL(result.headers.get('location'));
  assert.equal(target.searchParams.get('state'), 'fixture-state');
  return {
    code: target.searchParams.get('code'),
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: params.redirect_uri,
    resource: params.resource,
    grant_type: 'authorization_code',
  };
}
test('authorization binds redirect, resource, scope and S256 PKCE', async () => {
  for (const p of [
    { redirect_uri: 'https://evil.example/callback' },
    { resource: 'https://other.example/mcp' },
    { code_challenge_method: 'plain' },
    { scope: 'admin' },
  ])
    assert.equal((await authorize(p)).response.status, 400);
  assert.equal(
    (await req('/oauth/authorize?' + new URLSearchParams({ client_id: clientId + 'tampered' })))
      .status,
    400,
  );
});
test('OAuth consent preserves form Origin and rejects absent, opaque and foreign origins', async () => {
  const { response } = await authorize();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.equal(
    response.headers.get('content-security-policy').split('form-action ')[1],
    "'self' https://chatgpt.com",
  );
  assert.equal(
    (await req('/')).headers.get('content-security-policy').split('form-action ')[1],
    "'self'",
  );
  const ticket = (await response.text()).match(/name="ticket" value="([^"]+)"/)[1];
  const data = { ticket, admin_token: bindings.ADMIN_TOKEN };
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://evil.example' }]) {
    assert.equal((await form('/oauth/approve', data, headers)).status, 403);
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM oauth_codes').first()).n, 0);
  assert.equal((await form('/oauth/approve', data, { Origin: origin })).status, 303);
  await db.prepare('DELETE FROM oauth_codes').run();
});
test('PKCE exchange, code replay prevention and private MCP work in workerd', async () => {
  const data = await codeForClient();
  assert.equal((await form('/oauth/token', { ...data, code_verifier: random() })).status, 400);
  const exchanged = await form('/oauth/token', data);
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;
  assert.equal((await form('/oauth/token', data)).status, 400);
  assert.equal(
    (await rpc('get_connection_status', {}, { Authorization: 'Bearer ' + bindings.ADMIN_TOKEN }))
      .status,
    401,
  );
  const status = await rpc('get_connection_status', {}, { Authorization: 'Bearer ' + accessToken });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.result.structuredContent.connected, true);
  assert.equal(statusBody.result.structuredContent.management_url, origin + '/');
  const managementLink = statusBody.result.content.find((x) => x.type === 'resource_link');
  assert.equal(managementLink.uri, origin + '/');
  assert.equal(managementLink.mimeType, 'text/html');
  assert.equal(
    (await req('/api/status', { headers: { Authorization: 'Bearer ' + accessToken } })).status,
    401,
  );
  const rows = await db.prepare('SELECT hash FROM oauth_tokens').all();
  assert.ok(!JSON.stringify(rows).includes(accessToken));
});
test('read_file embeds normal PDFs and keeps a temporary scoped link fallback', async () => {
  const beforeRead = upstream;
  const response = await rpc(
    'read_file',
    { course_id: 'c', file_id: 'material:m:r', start_page: 1, end_page: 2 },
    { Authorization: 'Bearer ' + accessToken },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  const value = payload.result.structuredContent;
  assert.equal(value.format, 'pdf');
  assert.equal(value.text, null);
  assert.equal(value.bytes, new TextEncoder().encode('%PDF-1.7 fixture').length);
  assert.equal(value.download_limit_bytes, 100 * 1024 * 1024);
  assert.equal(value.retention, 'not_stored_by_connector');
  assert.equal(value.delivery, 'mcp_embedded_resource');
  const embedded = payload.result.content.find((x) => x.type === 'resource');
  assert.ok(embedded);
  assert.equal(embedded.resource.uri, value.download_url);
  assert.equal(embedded.resource.mimeType, 'application/pdf');
  assert.equal(atob(embedded.resource.blob), '%PDF-1.7 fixture');
  const resourceLink = payload.result.content.find((x) => x.type === 'resource_link');
  assert.ok(resourceLink);
  assert.equal(resourceLink.uri, value.download_url);
  assert.equal(resourceLink.name, 'first.pdf');
  assert.equal(resourceLink.mimeType, 'application/pdf');
  assert.ok(upstream > beforeRead, 'read_file must fetch the PDF body for embedding');
  assert.ok(value.download_url);
  assert.ok(!value.download_url.includes('private-fixture-cookie'));

  const url = new URL(value.download_url);
  const beforeDownload = upstream;
  const result = await req(url.pathname + url.search);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), '%PDF-1.7 fixture');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(upstream, beforeDownload + 3, 'download resolves metadata, tempfile and original once');

  upstreamMode = 'large';
  try {
    const tooLarge = await req(url.pathname + url.search);
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).code, 'file_too_large');
  } finally {
    upstreamMode = 'ok';
  }

  assert.equal(
    (await req(url.pathname + url.search.replace('material%3Am%3Ar', 'material%3Am%3As'))).status,
    401,
  );
});
test('refresh rotation cannot be replayed; tokens reject wrong audience and expiry', async () => {
  const data = {
    grant_type: 'refresh_token',
    client_id: clientId,
    resource: origin + '/mcp',
    refresh_token: refreshToken,
  };
  assert.equal(
    (await form('/oauth/token', { ...data, resource: origin + '/api/status' })).status,
    400,
  );
  const result = await form('/oauth/token', data);
  assert.equal(result.status, 200);
  const tokens = await result.json();
  assert.notEqual(tokens.refresh_token, refreshToken);
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;
  assert.equal((await form('/oauth/token', data)).status, 400);
  await db
    .prepare("UPDATE oauth_tokens SET resource='https://other.example/mcp' WHERE hash=?")
    .bind(await digest(accessToken + bindings.SESSION_ENCRYPTION_KEY))
    .run();
  assert.equal(
    (await rpc('get_connection_status', {}, { Authorization: 'Bearer ' + accessToken })).status,
    401,
  );
  await db
    .prepare('UPDATE oauth_tokens SET resource=?,expires_at=0 WHERE hash=?')
    .bind(origin + '/mcp', await digest(accessToken + bindings.SESSION_ENCRYPTION_KEY))
    .run();
  assert.equal(
    (await rpc('get_connection_status', {}, { Authorization: 'Bearer ' + accessToken })).status,
    401,
  );
});
test('file links reject expiry, changed identifiers and missing authentication without fetching', async () => {
  const count = upstream;
  for (const ticket of [
    '',
    await sign(bindings, { kind: 'file', course_id: 'c', file_id: 'material:m:r', exp: 1 }),
    await sign(bindings, {
      kind: 'file',
      course_id: 'different',
      file_id: 'material:m:r',
      exp: Date.now() / 1000 + 300,
    }),
  ])
    assert.equal((await req('/files/c?file_id=material:m:r&ticket=' + ticket)).status, 401);
  assert.equal(upstream, count);
});
test('oversized streamed RPC bodies fail before parsing or accessing ScombZ', async () => {
  assert.equal(
    (
      await req('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(65537),
      })
    ).status,
    413,
  );
});
test('revoke keeps the session; deletion removes session and OAuth grants', async () => {
  assert.equal((await req('/api/revoke', { method: 'POST', headers: adminHeaders })).status, 200);
  assert.ok(await db.prepare('SELECT id FROM session').first());
  assert.equal((await db.prepare('SELECT count(*) AS n FROM oauth_tokens').first()).n, 0);
  assert.equal(
    (
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        client_id: clientId,
        resource: origin + '/mcp',
        refresh_token: refreshToken,
      })
    ).status,
    400,
  );
  assert.equal(
    (await req('/api/connection', { method: 'DELETE', headers: adminHeaders })).status,
    200,
  );
  assert.equal(await db.prepare('SELECT id FROM session').first(), null);
  assert.equal(await db.prepare('SELECT id FROM mobile_auth').first(), null);
  assert.equal(
    (await (await req('/api/status', { headers: adminHeaders })).json()).connected,
    false,
  );
});
