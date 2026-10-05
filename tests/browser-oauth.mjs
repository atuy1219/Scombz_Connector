import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { chromium } from 'playwright';
import { digest, random } from '../src/crypto.mjs';

test('browser OAuth form preserves Origin, follows the callback, and exchanges its code', async () => {
  const origin = 'https://fixture.workers.dev';
  const redirect = 'https://chatgpt.com/connector/oauth/browser-fixture';
  const bindings = { ADMIN_TOKEN: 'a'.repeat(64), SESSION_ENCRYPTION_KEY: 'b'.repeat(64) };
  let browser, mf;
  try {
    await build({
      entryPoints: ['src/worker.mjs'],
      outfile: '.wrangler/browser-test-worker.mjs',
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external: ['node:*'],
    });
    mf = new Miniflare({
      modules: true,
      scriptPath: '.wrangler/browser-test-worker.mjs',
      compatibilityDate: '2026-08-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      bindings,
      outboundService: async () => assert.fail('OAuth fixture must not call an upstream service'),
    });
    const db = await mf.getD1Database('DB');
    for (const file of [
      '0001_initial.sql',
      '0003_write_drafts.sql',
      '0004_session_export_scope.sql',
    ])
      await db.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
    const registration = await mf.dispatchFetch(origin + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Browser fixture',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(registration.status, 201);
    const { client_id } = await registration.json();
    const verifier = random();
    const params = new URLSearchParams({
      client_id,
      redirect_uri: redirect,
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: await digest(verifier),
      resource: origin + '/mcp',
      scope: 'scombz:read',
      state: 'browser-state',
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? ['--no-sandbox', '--disable-dev-shm-usage']
        : undefined,
    });
    const page = await browser.newPage();
    const consoleErrors = [],
      approvals = [],
      networkErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Content Security Policy'))
        consoleErrors.push(message.text());
    });
    // CDP intercepts each redirect hop too, so no real external service is contacted.
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error' && entry.text.includes('Content Security Policy'))
        consoleErrors.push(entry.text);
    });
    await cdp.send('Log.enable');
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      try {
        const url = new URL(request.url);
        let response;
        if (url.origin === origin) {
          const headers = new Headers(request.headers);
          if (url.pathname === '/oauth/approve') approvals.push(headers.get('origin'));
          response = await mf.dispatchFetch(request.url, {
            method: request.method,
            headers,
            body: request.postData ?? undefined,
            redirect: 'manual',
          });
        } else if (
          url.origin === new URL(redirect).origin &&
          url.pathname === new URL(redirect).pathname
        ) {
          assert.equal(request.method, 'GET', 'admin key must not be POSTed to the callback');
          response = new Response('<h1>OAuth callback</h1>', {
            headers: { 'Content-Type': 'text/html' },
          });
        } else {
          assert.fail('Unexpected browser destination: ' + url.origin + url.pathname);
        }
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: response.status,
          responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
          body: Buffer.from(await response.arrayBuffer()).toString('base64'),
        });
      } catch (error) {
        networkErrors.push(error.message);
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await page.goto(origin + '/oauth/authorize?' + params);
    await page.getByLabel('管理キー').fill(bindings.ADMIN_TOKEN);
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.origin === new URL(redirect).origin && url.pathname === new URL(redirect).pathname,
      ),
      page.getByRole('button', { name: '接続を承認' }).click(),
    ]);
    assert.deepEqual(approvals, [origin]);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(networkErrors, []);
    const callback = new URL(page.url());
    assert.equal(callback.searchParams.get('state'), 'browser-state');
    assert.ok(callback.searchParams.get('code'));
    const token = await mf.dispatchFetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        redirect_uri: redirect,
        code: callback.searchParams.get('code'),
        code_verifier: verifier,
        resource: origin + '/mcp',
      }).toString(),
    });
    assert.equal(token.status, 200);
    assert.equal((await token.json()).scope, 'scombz:read');
  } finally {
    await browser?.close();
    await mf?.dispose();
  }
});
