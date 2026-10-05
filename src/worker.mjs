import { ScombClient, ScombError } from './client.mjs';
import { MobileAuthClient, MobileAuthStore } from './mobile-auth.mjs';
import { mcpResponse } from './mcp.mjs';
import { html, script } from './ui.mjs';
import { configured, verify } from './crypto.mjs';
import { oauth, admin, access, challenge, json, htmlResponse, readBody } from './oauth.mjs';

const discovery = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
]);
const fileIdentifier = /^(material|assignment):[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const identifier = /^[A-Za-z0-9_-]{1,100}$/;
export async function handle(request, env, options = {}) {
  const url = new URL(request.url),
    origin = url.origin;
  try {
    // Browser requests must come from this Worker; server-to-server MCP has no Origin.
    if (request.headers.has('origin') && request.headers.get('origin') !== origin)
      return json({ message: '別サイトからのリクエストは受け付けません。' }, 403);
    const authResponse = await oauth(request, env, origin);
    if (authResponse) return authResponse;
    if (url.pathname === '/' && request.method === 'GET') return htmlResponse(html);
    if (url.pathname === '/ui.js' && request.method === 'GET')
      return new Response(script, {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    if (url.pathname === '/health' && request.method === 'GET')
      return json({ name: 'scombz-connector', version: '1.0.0', configured: configured(env) });
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST')
        return json({ message: 'POST /mcp を使用してください。' }, 405, { Allow: 'POST' });
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return json({ message: 'JSONが必要です。' }, 415);
      let raw;
      try {
        raw = await readBody(request);
      } catch {
        return json({ message: 'Request too large' }, 413);
      }
      let rpc;
      try {
        rpc = JSON.parse(raw);
      } catch {
        return json({ message: 'Invalid JSON' }, 400);
      }
      if (
        !rpc ||
        typeof rpc !== 'object' ||
        Array.isArray(rpc) ||
        rpc.jsonrpc !== '2.0' ||
        typeof rpc.method !== 'string'
      )
        return json({ message: 'Invalid JSON-RPC request' }, 400);
      if (!discovery.has(rpc.method) && !(await access(request, env, origin))) {
        const hint = challenge(origin);
        return json(
          {
            jsonrpc: '2.0',
            id: rpc.id ?? null,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'OAuthでScombZ Connectorを接続してください。' }],
              _meta: { 'mcp/www_authenticate': [hint] },
            },
          },
          401,
          { 'WWW-Authenticate': hint },
        );
      }
      return mcpResponse(
        new Request(request.url, { method: 'POST', headers: request.headers, body: raw }),
        env,
        options,
      );
    }
    if (url.pathname.startsWith('/api/')) {
      if (!(await admin(request, env)))
        return json({ message: '管理キーまたはCloudflareの設定を確認してください。' }, 401);
      const client = new ScombClient(env, options);
      const mobileOptions = options.mobile ?? {};
      if (url.pathname === '/api/mobile/status' && request.method === 'GET')
        return json({ token_stored: await new MobileAuthStore(env).exists() });
      if (url.pathname === '/api/mobile/login' && request.method === 'POST') {
        if (request.headers.get('origin') !== origin)
          return json({ message: 'この管理画面から操作してください。' }, 403);
        if (!request.headers.get('content-type')?.startsWith('application/json'))
          return json({ message: 'JSONが必要です。' }, 415);
        let raw;
        try {
          raw = await readBody(request);
        } catch {
          return json({ message: 'Request too large' }, 413);
        }
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json({ message: 'JSONの形式を確認できません。' }, 400);
        }
        return json(await new MobileAuthClient(env, mobileOptions).login(body?.user, body?.password));
      }
      if (url.pathname === '/api/mobile/probe' && request.method === 'POST') {
        if (request.headers.get('origin') !== origin)
          return json({ message: 'この管理画面から操作してください。' }, 403);
        const mobile = new MobileAuthClient(env, mobileOptions);
        let sessionid_state = { available: false, length: 0 };
        try {
          sessionid_state = await mobile.getSessionIdState();
        } catch (error) {
          if (!(error instanceof ScombError) || error.code !== 'mobile_upstream_error') throw error;
          sessionid_state = { available: false, length: 0, unavailable: true };
        }
        const bridge = await mobile.exchangeOtkey();
        let connected = false;
        if (bridge.session) {
          await client.replaceSession({ cookies: [bridge.session], origins: [] });
          connected = true;
        }
        return json({
          mobile_authenticated: true,
          sessionid_state,
          otkey_received: bridge.otkey_received,
          web_session_acquired: !!bridge.session,
          connected,
          diagnostics: bridge.diagnostics,
          fallback_recommended: !connected,
        });
      }
      if (url.pathname === '/api/mobile' && request.method === 'DELETE') {
        if (request.headers.get('origin') !== origin)
          return json({ message: 'この管理画面から操作してください。' }, 403);
        await new MobileAuthStore(env).clear();
        return json({ deleted: true });
      }
      if (url.pathname === '/api/status' && request.method === 'GET')
        return json(await client.connection());
      if (url.pathname === '/api/connection' && request.method === 'POST') {
        if (request.headers.get('origin') !== origin)
          return json({ message: 'この管理画面から操作してください。' }, 403);
        if (!request.headers.get('content-type')?.startsWith('application/json'))
          return json({ message: 'JSONファイルを指定してください。' }, 415);
        let raw;
        try {
          raw = await readBody(request);
        } catch {
          return json({ message: 'File too large' }, 413);
        }
        let session;
        try {
          session = JSON.parse(raw);
        } catch {
          return json({ message: 'JSONの形式を確認できません。' }, 400);
        }
        return json(await client.replaceSession(session));
      }
      if (url.pathname === '/api/connection' && request.method === 'DELETE') {
        if (request.headers.get('origin') !== origin)
          return json({ message: 'この管理画面から操作してください。' }, 403);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM session'),
          env.DB.prepare('DELETE FROM oauth_codes'),
          env.DB.prepare('DELETE FROM oauth_tokens'),
        ]);
        return json({ deleted: true });
      }
      if (url.pathname === '/api/revoke' && request.method === 'POST') {
        if (request.headers.get('origin') !== origin)
          return json({ message: 'この管理画面から操作してください。' }, 403);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM oauth_codes'),
          env.DB.prepare('DELETE FROM oauth_tokens'),
        ]);
        return json({ revoked: true });
      }
      return json({ message: 'Not found' }, 404);
    }
    if (url.pathname.startsWith('/files/') && request.method === 'GET') {
      const courseId = decodeURIComponent(url.pathname.slice(7)),
        fileId = url.searchParams.get('file_id');
      if (!identifier.test(courseId) || !fileId || !fileIdentifier.test(fileId))
        return json({ message: 'Invalid file identifier' }, 400);
      const ticket = configured(env)
        ? await verify(env, url.searchParams.get('ticket'), 'file')
        : null;
      if (
        !(
          ticket &&
          ticket.resource === origin + '/mcp' &&
          ticket.course_id === courseId &&
          ticket.file_id === fileId
        ) &&
        !(await access(request, env, origin)) &&
        !(await admin(request, env))
      )
        return json(
          { message: 'ファイルリンクの期限が切れた場合はread_fileを再実行してください。' },
          401,
        );
      const file = await new ScombClient(env, options).materialStream(courseId, fileId);
      const headers = {
        'Content-Type': file.mime,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.metadata.filename).replace(/'/g, '%27')}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      };
      if (file.bytes !== null) headers['Content-Length'] = String(file.bytes);
      return new Response(file.body, { headers });
    }
    return json({ message: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ScombError)
      return json(
        { code: error.code, message: error.message },
        error.code === 'auth_required' ? 401 : error.code === 'file_too_large' ? 413 : 422,
      );
    return json(
      {
        code: 'internal_error',
        message:
          '処理を完了できませんでした。D1のマイグレーションとSecretsの設定を確認してください。',
      },
      500,
    );
  }
}
export default { fetch: handle };
