import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { digest, random, sign } from '../src/crypto.mjs';
import { SessionStore } from '../src/storage.mjs';
import { MobileAuthStore } from '../src/mobile-auth.mjs';
import { ScombClient } from '../src/client.mjs';

const origin = 'https://fixture.workers.dev';
const bindings = {
  ADMIN_TOKEN: 'a'.repeat(64),
  SESSION_ENCRYPTION_KEY: 'b'.repeat(64),
};
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
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
  });
const adminHeaders = {
  Origin: origin,
  Authorization: 'Bearer ' + bindings.ADMIN_TOKEN,
};
const rpc = (name, args = {}, headers = {}) =>
  post(
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
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
    cf: false,
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
      assert.equal(request.headers.get('user-agent'), 'Mozilla/5.0');
      assert.ok(request.headers.get('cookie').includes('SESSION=private-fixture-cookie'));
      if (upstreamMode === 'login') return new Response('<form id="loginForm"></form>');
      if (upstreamMode === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.example/steal' },
        });
      const path = new URL(request.url).pathname;
      if (path === '/lms/timetable')
        return new Response(
          page(
            '<input id="displayMode1" checked><div class="div-table-data-row"><span class="div-table-colomn-period">２時限</span><div class="3-yobicol"><div><button class="timetable-course-top-btn" id="c">データ構造</button></div></div></div>',
          ),
        );
      if (path === '/lms/course') return new Response(course);
      if (path === '/lms/course/make/tempfile') return new Response('temporary-id');
      if (path.startsWith('/lms/course/material/setfiledown/')) {
        if (upstreamMode === 'embedded-large')
          return new Response('%PDF-1.7 fixture', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Length': String(6 * 1024 * 1024),
            },
          });
        if (upstreamMode === 'large')
          return new Response('%PDF-1.7 fixture', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Length': String(100 * 1024 * 1024 + 1),
            },
          });
        return new Response('%PDF-1.7 fixture', {
          headers: { 'Content-Type': 'application/pdf' },
        });
      }
      return new Response(page('home'));
    },
  });
  db = await mf.getD1Database('DB');
  for (const name of [
    '0001_initial.sql',
    '0002_mobile_auth.sql',
    '0003_write_drafts.sql',
    '0004_session_export_scope.sql',
    '0005_remove_write_support.sql',
  ]) {
    const migration = await readFile('migrations/' + name, 'utf8');
    await db.exec(migration.replaceAll('\n', ' '));
  }
  const env = { ...bindings, DB: db };
  const auth = new MobileAuthStore(env);
  await auth.save({ token: 'fixture-mobile-token' });
  await auth.load();
  const cache = new SessionStore(env);
  cache.bindAuthentication(
    await digest('fixture-mobile-token' + bindings.SESSION_ENCRYPTION_KEY),
    auth.original,
  );
  await cache.save({ cookies: state.cookies.slice(0, 1), origins: [] }, { replace: true });
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
  assert.ok(uiText.includes('再ログイン'));
  assert.ok(uiText.includes('id="login-form"'));
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
    {
      'oai-authenticated-user-id': 'owner',
      'oai-authenticated-user-email': 'owner@example.test',
    },
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
  const auth = new MobileAuthStore(env);
  await auth.load();
  restored.bindAuthentication(
    await digest('fixture-mobile-token' + bindings.SESSION_ENCRYPTION_KEY),
    auth.original,
  );
  await restored.save({ cookies: state.cookies.slice(0, 1), origins: [] }, { replace: true });
});
test('SESSION cache expires, is reused across clients, and is bound to the bearer', async () => {
  const env = { ...bindings, DB: db };
  const auth = new MobileAuthStore(env);
  await auth.load();
  const generation = await digest('fixture-mobile-token' + bindings.SESSION_ENCRYPTION_KEY);
  const cache = new SessionStore(env);
  const old = await cache.load();
  await cache.save({ ...old, cache_expires_at: 1 }, { replace: true });
  const expired = new SessionStore(env);
  expired.bindAuthentication(generation, auth.original);
  assert.equal(await expired.load(), null);
  let exchanges = 0;
  const mobile = {
    store: auth,
    async token() {
      return (await auth.load()).token;
    },
    async exchangeOtkey() {
      exchanges++;
      return { session: state.cookies[0] };
    },
  };
  const options = { mobileClient: mobile, fetch: async () => new Response(page('home')) };
  assert.equal((await new ScombClient(env, options).connection()).connected, true);
  assert.equal((await new ScombClient(env, options).connection()).connected, true);
  assert.equal(exchanges, 1);
  const wrongAuth = new SessionStore(env);
  wrongAuth.bindAuthentication('another-bearer-generation', auth.original);
  assert.equal(await wrongAuth.load(), null);
  const live = new SessionStore(env);
  live.bindAuthentication(generation, auth.original);
  assert.ok((await live.load()).cache_expires_at > Date.now() / 1000);
});

test('stale refreshes and token failures cannot undo logout or overwrite a new login', async () => {
  const env = { ...bindings, DB: db };
  const staleAuth = new MobileAuthStore(env);
  await staleAuth.load();
  const staleCache = new SessionStore(env);
  staleCache.bindAuthentication(
    await digest('fixture-mobile-token' + bindings.SESSION_ENCRYPTION_KEY),
    staleAuth.original,
  );
  const session = await staleCache.load();
  await db.batch([db.prepare('DELETE FROM session'), db.prepare('DELETE FROM mobile_auth')]);
  await staleCache.save(session, { replace: true });
  assert.equal(await db.prepare('SELECT id FROM session').first(), null);
  const fresh = new MobileAuthStore(env);
  await fresh.save({ token: 'fixture-mobile-token' });
  await staleAuth.clear({ onlyLoaded: true });
  assert.equal((await fresh.load()).token, 'fixture-mobile-token');
  const cache = new SessionStore(env);
  cache.bindAuthentication(
    await digest('fixture-mobile-token' + bindings.SESSION_ENCRYPTION_KEY),
    fresh.original,
  );
  await cache.save({ cookies: state.cookies.slice(0, 1), origins: [] }, { replace: true });
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
async function codeForClient(extra = {}) {
  const { response, verifier, params } = await authorize(extra);
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
    { scope: 'scombz:read scombz:write' },
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
    (
      await req('/api/status', {
        headers: { Authorization: 'Bearer ' + accessToken },
      })
    ).status,
    401,
  );
  const rows = await db.prepare('SELECT hash FROM oauth_tokens').all();
  assert.ok(!JSON.stringify(rows).includes(accessToken));
});
test('scope migration preserves legacy OAuth inserts without granting SESSION export', async () => {
  const token = random();
  await db
    .prepare('INSERT INTO oauth_tokens VALUES(?,?,?,?,?)')
    .bind(
      await digest(token + bindings.SESSION_ENCRYPTION_KEY),
      'access',
      clientId,
      origin + '/mcp',
      Math.floor(Date.now() / 1000) + 60,
    )
    .run();
  const before = upstream;
  assert.equal(
    (await rpc('get_web_session', {}, { Authorization: 'Bearer ' + token })).status,
    401,
  );
  assert.equal(upstream, before);
  assert.equal(
    (await rpc('get_connection_status', {}, { Authorization: 'Bearer ' + token })).status,
    200,
  );
});
test('existing read grants cannot export authentication or escalate through refresh', async () => {
  const before = upstream;
  const denied = await rpc('get_web_session', {}, { Authorization: 'Bearer ' + accessToken });
  assert.equal(denied.status, 401);
  assert.ok(denied.headers.get('www-authenticate').includes('scope="scombz:session"'));
  assert.equal(upstream, before);
  const code = await codeForClient();
  const read = await (await form('/oauth/token', code)).json();
  const rotated = await (
    await form('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      resource: origin + '/mcp',
      refresh_token: read.refresh_token,
      scope: 'scombz:read scombz:session',
    })
  ).json();
  assert.equal(rotated.scope, 'scombz:read');
  assert.equal(
    (await rpc('get_web_session', {}, { Authorization: 'Bearer ' + rotated.access_token })).status,
    401,
  );
});
test('explicit session consent exports only SESSION without fetching or parsing HTML', async () => {
  const { response } = await authorize({ scope: 'scombz:read scombz:session' });
  const consent = await response.text();
  assert.ok(consent.includes('SESSION CookieをChatGPTへ渡す権限'));
  assert.ok(consent.includes('読み取り専用には制限できません'));
  const code = await codeForClient({ scope: 'scombz:read scombz:session' });
  const tokens = await (await form('/oauth/token', code)).json();
  assert.equal(tokens.scope, 'scombz:read scombz:session');
  const before = upstream;
  const exported = await rpc(
    'get_web_session',
    {},
    { Authorization: 'Bearer ' + tokens.access_token },
  );
  assert.equal(exported.status, 200);
  const body = await exported.json();
  const result = body.result.structuredContent;
  assert.equal(result.cookie.name, 'SESSION');
  assert.equal(result.cookie.value, state.cookies[0].value);
  assert.equal(result.origin, 'https://scombz.shibaura-it.ac.jp');
  assert.equal(result.permissions, 'full_web_session_not_read_only');
  assert.equal(result.cookie.expires_at, null);
  assert.equal(upstream, before, 'session transfer must not retrieve HTML');
  assert.ok(!JSON.stringify(body).includes('fixture-mobile-token'));
  assert.ok(!JSON.stringify(body).includes(bindings.ADMIN_TOKEN));
  assert.ok(!JSON.stringify(body).includes('do-not-store'));
  const rotated = await (
    await form('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      resource: origin + '/mcp',
      refresh_token: tokens.refresh_token,
    })
  ).json();
  assert.equal(rotated.scope, 'scombz:read scombz:session');
  assert.equal(
    (await rpc('get_web_session', {}, { Authorization: 'Bearer ' + rotated.access_token })).status,
    200,
  );
});
test('read_file returns a direct HTTP plan without loading file bytes and keeps a scoped proxy fallback', async () => {
  const beforeRead = upstream;
  const response = await rpc(
    'read_file',
    { course_id: 'c', file_id: 'material:m:r' },
    { Authorization: 'Bearer ' + accessToken },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  const value = payload.result.structuredContent;
  assert.equal(value.format, 'pdf');
  assert.equal(value.text, null);
  assert.equal(Object.hasOwn(value, 'requested_pages'), false);
  assert.equal(value.bytes, null);
  assert.equal(value.download_limit_bytes, 100 * 1024 * 1024);
  assert.equal(value.download_limit_scope, 'connector_proxy_only');
  assert.equal(value.retention, 'not_stored_by_connector');
  assert.equal(value.delivery, 'direct_authenticated_http');
  assert.equal(
    payload.result.content.some((x) => x.type === 'resource' || x.type === 'resource_link'),
    false,
  );
  assert.equal(value.direct_download.authentication.required_scope, 'scombz:session');
  assert.equal(value.direct_download.same_session_for_prepare_and_download, true);
  assert.equal(
    new URL(value.direct_download.prepare_request.url).searchParams.get('objectName'),
    'o',
  );
  assert.equal(
    new URL(value.direct_download.prepare_request.url).pathname,
    '/lms/course/make/tempfile',
  );
  assert.ok(
    value.direct_download.download_request.url_template.endsWith('fileId={temporary_file_id}'),
  );
  assert.equal(
    upstream,
    beforeRead + 1,
    'read_file only retrieves material metadata, not a temp ID or original',
  );
  assert.ok(!JSON.stringify(payload).includes('private-fixture-cookie'));
  assert.ok(value.download_url);
  assert.ok(!value.download_url.includes('private-fixture-cookie'));

  const url = new URL(value.download_url);
  const beforeDownload = upstream;
  const result = await req(url.pathname + url.search);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), '%PDF-1.7 fixture');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(
    upstream,
    beforeDownload + 3,
    'download resolves metadata, tempfile and original once',
  );

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
test('chat widget keeps scoped links private, serves its UI and authenticates before reading', async () => {
  const before = upstream;
  const payload = await (
    await rpc(
      'open_file_in_chat',
      { course_id: 'c', file_id: 'material:m:r' },
      { Authorization: 'Bearer ' + accessToken },
    )
  ).json();
  assert.equal(payload.result.isError, undefined);
  assert.equal(payload.result.structuredContent.delivery, 'chatgpt_widget_upload');
  assert.equal(payload.result.structuredContent.upload_status, 'not_started');
  assert.equal(payload.result.structuredContent.model_readability, 'unverified');
  assert.equal(payload.result.structuredContent.size_bytes, null);
  assert.equal(upstream, before, 'opening the Widget does not fetch ScombZ metadata');
  assert.equal(payload.result.structuredContent.file.filename, null);
  assert.equal(payload.result.structuredContent.mime_type, null);
  assert.ok(!payload.result.content[0].text.includes('file_id'));
  assert.ok(!payload.result.structuredContent._summary);
  assert.ok(!JSON.stringify(payload.result.content).includes('ticket='));
  assert.ok(!JSON.stringify(payload.result.structuredContent).includes('ticket='));
  assert.ok(!JSON.stringify(payload).includes('private-fixture-cookie'));
  const transfer = payload.result._meta.file_transfer;
  assert.equal(transfer.max_bytes, 100 * 1024 * 1024);
  const ui = await (
    await post(
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'ui://scombz/file-upload-v1.html' },
      },
      { Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + accessToken },
    )
  ).json();
  const resource = ui.result.contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource._meta.ui.csp.connectDomains, [origin]);
  assert.ok(resource.text.includes('教材は自動取得・アップロードされ'));
  assert.ok(resource.text.includes('model_readability'));
  const beforeRead = upstream;
  const unauthenticated = await post(
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: 'ui://scombz/file-upload-v1.html' },
    },
    { Accept: 'application/json, text/event-stream' },
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(upstream, beforeRead);
});

test('ticketed file CORS follows the browser Origin without opening admin or MCP routes', async () => {
  const payload = await (
    await rpc(
      'open_file_in_chat',
      { course_id: 'c', file_id: 'material:m:r' },
      { Authorization: 'Bearer ' + accessToken },
    )
  ).json();
  const url = new URL(payload.result._meta.file_transfer.download_url);
  const path = url.pathname + url.search;
  const browserOrigins = [
    'https://web-sandbox.oaiusercontent.com',
    'https://chatgpt.com',
    'https://future-sandbox.example',
  ];
  const before = upstream;
  for (const browserOrigin of browserOrigins) {
    const headers = { Origin: browserOrigin };
    const preflight = await req(path, { method: 'OPTIONS', headers });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), browserOrigin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);

    const body = await req(path, { headers });
    assert.equal(body.status, 200);
    assert.equal(body.headers.get('access-control-allow-origin'), browserOrigin);
    assert.equal(body.headers.get('access-control-allow-credentials'), null);
    assert.equal(body.headers.get('vary'), 'Origin');
    assert.equal(await body.text(), '%PDF-1.7 fixture');
  }
  assert.equal(upstream, before + browserOrigins.length * 3);

  const widgetOrigin = browserOrigins[0];
  const headers = { Origin: widgetOrigin };
  assert.equal(
    (await req('/api/status', { headers: { ...adminHeaders, Origin: widgetOrigin } })).status,
    403,
  );
  assert.equal(
    (await post('/mcp', {}, { ...headers, Authorization: 'Bearer ' + accessToken })).status,
    403,
  );

  const stripped = url.pathname + '?file_id=material%3Am%3Ar';
  const beforeInvalid = upstream;
  for (const browserOrigin of browserOrigins) {
    for (const method of ['GET', 'OPTIONS']) {
      const denied = await req(stripped, {
        method,
        headers: {
          Origin: browserOrigin,
          Authorization: 'Bearer ' + bindings.ADMIN_TOKEN,
        },
      });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('access-control-allow-origin'), browserOrigin);
    }
  }
  assert.equal(upstream, beforeInvalid);

  const opaque = await req(path, { headers: { Origin: 'null' } });
  assert.equal(opaque.status, 403);
  assert.equal(opaque.headers.get('access-control-allow-origin'), null);

  upstreamMode = 'large';
  try {
    const tooLarge = await req(path, { headers });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.headers.get('access-control-allow-origin'), widgetOrigin);
  } finally {
    upstreamMode = 'ok';
  }
});

test('large PDFs return a small direct HTTP plan without embedding or downloading', async () => {
  upstreamMode = 'embedded-large';
  try {
    const response = await rpc(
      'read_file',
      {
        course_id: 'c',
        file_id: 'material:m:r',
        start_page: 100,
        end_page: 1,
        max_chars: 1,
      },
      { Authorization: 'Bearer ' + accessToken },
    );
    const payload = await response.json();
    assert.equal(payload.result.isError, undefined);
    assert.equal(payload.result.structuredContent.format, 'pdf');
    assert.equal(payload.result.structuredContent.delivery, 'direct_authenticated_http');
    assert.equal(Object.hasOwn(payload.result.structuredContent, 'requested_pages'), false);
    assert.equal(
      payload.result.content.some((item) => item.type === 'resource'),
      false,
    );
    assert.equal(
      payload.result.content.some((item) => item.type === 'resource_link'),
      false,
    );
    assert.ok(JSON.stringify(payload).length < 8192);
  } finally {
    upstreamMode = 'ok';
  }
});
test('current class context resolves JST timetable and returns public materials', async () => {
  const result = await (
    await rpc(
      'get_current_class_context',
      {
        at: '2026-10-07T11:00:00+09:00',
      },
      { Authorization: 'Bearer ' + accessToken },
    )
  ).json();
  const value = result.result.structuredContent;
  assert.equal(value.status, 'matched');
  assert.equal(value.course.course_id, 'c');
  assert.equal(value.materials[0].file_id, 'material:m:r');
  assert.equal(Object.hasOwn(value.materials[0], 'object_name'), false);
  assert.deepEqual(value.assignments, []);
  assert.equal(value.year, 2026);
  const empty = await (
    await rpc(
      'get_current_class_context',
      {
        at: '2026-10-07T12:45:00+09:00',
      },
      { Authorization: 'Bearer ' + accessToken },
    )
  ).json();
  assert.equal(empty.result.structuredContent.status, 'no_class');
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
    await sign(bindings, {
      kind: 'file',
      course_id: 'c',
      file_id: 'material:m:r',
      exp: 1,
    }),
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

test('removed write approval routes cannot fetch ScombZ', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await req('/write/' + 'a'.repeat(43), { method });
    assert.equal(response.status, 404);
  }
});

test('write removal migration deletes drafts and preserves read/session grants', async () => {
  await db.exec('CREATE TABLE write_drafts (id TEXT PRIMARY KEY, data TEXT)');
  await db.prepare('INSERT INTO write_drafts VALUES (?,?)').bind('obsolete', 'encrypted').run();
  await db
    .prepare('INSERT INTO oauth_scopes VALUES (?,?,?)')
    .bind('obsolete-scope', 'scombz:read scombz:session scombz:write', 9999999999)
    .run();
  await db.exec(
    (await readFile('migrations/0005_remove_write_support.sql', 'utf8')).replaceAll('\n', ' '),
  );
  assert.equal(
    (await db.prepare('SELECT scope FROM oauth_scopes WHERE hash=?').bind('obsolete-scope').first())
      .scope,
    'scombz:read scombz:session',
  );
  assert.equal(
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='write_drafts'")
      .first(),
    null,
  );
});
