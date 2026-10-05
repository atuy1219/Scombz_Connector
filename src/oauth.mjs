import { configured, digest, random, sign, verify, equalSecret } from './crypto.mjs';
export const json = (value, status = 200, headers = {}) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
export const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function htmlResponse(html, formRedirectUri) {
  // Browsers also check form-action on the 303 OAuth callback after approval.
  // Only the validated, registered callback origin may join the Worker itself.
  const formRedirectOrigin = validRedirect(formRedirectUri)
    ? ' ' + new URL(formRedirectUri).origin
    : '';
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Preserve Origin on same-origin form POSTs while withholding referrers
      // from the external OAuth callback. no-referrer makes form Origin null.
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" +
        formRedirectOrigin,
    },
  });
}
export async function readBody(request, max = 65536) {
  if (Number(request.headers.get('content-length') ?? 0) > max) throw new Error('body too large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('body too large');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  const all = new Uint8Array(size);
  let i = 0;
  for (const c of chunks) {
    all.set(c, i);
    i += c.length;
  }
  return new TextDecoder().decode(all);
}
export async function admin(request, env) {
  return (
    configured(env) &&
    (await equalSecret(
      request.headers.get('authorization')?.replace(/^Bearer /, ''),
      env.ADMIN_TOKEN,
    ))
  );
}
function validRedirect(value) {
  try {
    const u = new URL(value);
    return (
      !u.hash &&
      !u.username &&
      !u.password &&
      ((u.protocol === 'https:' &&
        ['chatgpt.com', 'chat.openai.com'].includes(u.hostname) &&
        !u.port) ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
const oauthError = (error, description, status = 400) =>
  json({ error, error_description: description }, status);
export const resource = (origin) => origin + '/mcp';
async function client(env, id) {
  return verify(env, id, 'client');
}
const now = () => Math.floor(Date.now() / 1000);
async function clean(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now()),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').bind(now()),
  ]);
}
async function issue(env, clientId, audience) {
  const access = random(),
    refresh = random();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO oauth_tokens VALUES(?,?,?,?,?)').bind(
      await tokenHash(env, access),
      'access',
      clientId,
      audience,
      now() + 3600,
    ),
    env.DB.prepare('INSERT INTO oauth_tokens VALUES(?,?,?,?,?)').bind(
      await tokenHash(env, refresh),
      'refresh',
      clientId,
      audience,
      now() + 30 * 86400,
    ),
  ]);
  return json({
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
    scope: 'scombz:read',
  });
}
export const tokenHash = (env, token) => digest(token + env.SESSION_ENCRYPTION_KEY);
export async function access(request, env, origin) {
  if (!configured(env)) return false;
  const token = request.headers.get('authorization')?.match(/^Bearer ([\w-]{43})$/)?.[1];
  if (!token) return false;
  return !!(await env.DB.prepare(
    "SELECT hash FROM oauth_tokens WHERE hash=? AND kind='access' AND resource=? AND expires_at>?",
  )
    .bind(await tokenHash(env, token), resource(origin), now())
    .first());
}
export function challenge(origin) {
  return (
    'Bearer resource_metadata="' +
    origin +
    '/.well-known/oauth-protected-resource/mcp", scope="scombz:read"'
  );
}
export async function oauth(request, env, origin) {
  const url = new URL(request.url),
    path = url.pathname;
  if (
    path === '/.well-known/oauth-protected-resource' ||
    path === '/.well-known/oauth-protected-resource/mcp'
  )
    return json({
      resource: resource(origin),
      authorization_servers: [origin],
      scopes_supported: ['scombz:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'ScombZ Connector',
      resource_documentation: origin + '/',
    });
  if (path === '/.well-known/oauth-authorization-server')
    return json({
      issuer: origin,
      authorization_endpoint: origin + '/oauth/authorize',
      token_endpoint: origin + '/oauth/token',
      registration_endpoint: origin + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['scombz:read'],
    });
  if (!path.startsWith('/oauth/')) return null;
  if (!configured(env))
    return oauthError('temporarily_unavailable', 'Cloudflare SecretsとD1を設定してください。', 503);
  if (path === '/oauth/register' && request.method === 'POST') {
    let data;
    try {
      data = JSON.parse(await readBody(request, 8192));
    } catch {
      return oauthError('invalid_client_metadata', 'JSONの登録情報が必要です。');
    }
    if (
      !Array.isArray(data?.redirect_uris) ||
      !data.redirect_uris.length ||
      data.redirect_uris.length > 8 ||
      !data.redirect_uris.every(
        (u) => typeof u === 'string' && u.length <= 1024 && validRedirect(u),
      )
    )
      return oauthError(
        'invalid_redirect_uri',
        'ChatGPTまたはローカルMCPクライアントのリダイレクトURLが必要です。',
      );
    if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== 'none')
      return oauthError('invalid_client_metadata', 'public client (none) を使用してください。');
    const redirectUris = [...new Set(data.redirect_uris)],
      name = String(data.client_name ?? 'MCP client').slice(0, 80);
    // Signed client metadata avoids unauthenticated registration writes to D1.
    const clientId = await sign(env, { kind: 'client', redirect_uris: redirectUris, name });
    return json(
      {
        client_id: clientId,
        client_id_issued_at: now(),
        client_name: name,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  }
  if (path === '/oauth/authorize' && request.method === 'GET') {
    if (url.search.length > 12000) return oauthError('invalid_request', '入力が大きすぎます。');
    const p = url.searchParams,
      registration = await client(env, p.get('client_id'));
    if (!registration || !registration.redirect_uris.includes(p.get('redirect_uri')))
      return oauthError('invalid_request', '登録済みのclient_idとredirect_uriが必要です。');
    if (
      p.get('response_type') !== 'code' ||
      p.get('code_challenge_method') !== 'S256' ||
      !/^[-\w]{43}$/.test(p.get('code_challenge') ?? '')
    )
      return oauthError('invalid_request', 'S256 PKCEが必要です。');
    if (p.get('resource') !== resource(origin))
      return oauthError('invalid_target', 'resourceにこのサーバーの /mcp URLを指定してください。');
    if ((p.get('scope') ?? 'scombz:read').split(' ').some((x) => x !== 'scombz:read'))
      return oauthError('invalid_scope', 'scombz:read のみ対応しています。');
    const ticket = await sign(env, {
      kind: 'consent',
      exp: now() + 300,
      client_id: p.get('client_id'),
      redirect_uri: p.get('redirect_uri'),
      challenge: p.get('code_challenge'),
      resource: resource(origin),
      state: p.get('state') ?? '',
    });
    return htmlResponse(
      `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ScombZへの接続を承認</title><style>body{font:16px system-ui;max-width:560px;margin:60px auto;padding:24px;line-height:1.8}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:10px 0}code{overflow-wrap:anywhere}</style><h1>ScombZへの接続を承認</h1><p>${escape(registration.name)} に、あなたの時間割・教材・課題等を読み取る権限を与えます。提出内容の下書きを準備できますが、ScombZへの書き込みは毎回別の確認画面で本人の承認が必要です。</p><p>戻り先: <code>${escape(new URL(p.get('redirect_uri')).origin)}</code></p><p>このWorkerの管理キーを入力してください。ScombZのパスワードは入力しません。</p><form method="post" action="/oauth/approve"><input type="hidden" name="ticket" value="${escape(ticket)}"><input name="admin_token" type="password" autocomplete="off" required aria-label="管理キー"><button>接続を承認</button></form></html>`,
      p.get('redirect_uri'),
    );
  }
  if (path === '/oauth/approve' && request.method === 'POST') {
    if (request.headers.get('origin') !== origin)
      return oauthError('access_denied', '別サイトからの承認は受け付けません。', 403);
    let form;
    try {
      form = new URLSearchParams(await readBody(request, 16384));
    } catch {
      return oauthError('invalid_request', '入力が大きすぎます。');
    }
    if (!(await equalSecret(form.get('admin_token'), env.ADMIN_TOKEN)))
      return oauthError('access_denied', '管理キーを確認してください。', 401);
    const ticket = await verify(env, form.get('ticket'), 'consent');
    if (!ticket || ticket.resource !== resource(origin))
      return oauthError(
        'invalid_request',
        '承認ページの期限が切れました。接続をやり直してください。',
      );
    await clean(env);
    const code = random();
    await env.DB.prepare('INSERT INTO oauth_codes VALUES(?,?,?,?,?,?)')
      .bind(
        await digest(code),
        ticket.client_id,
        ticket.redirect_uri,
        ticket.challenge,
        ticket.resource,
        now() + 120,
      )
      .run();
    const target = new URL(ticket.redirect_uri);
    target.searchParams.set('code', code);
    if (ticket.state) target.searchParams.set('state', ticket.state);
    return new Response(null, {
      status: 303,
      headers: {
        Location: target.href,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }
  if (path === '/oauth/token' && request.method === 'POST') {
    let form;
    try {
      form = new URLSearchParams(await readBody(request, 16384));
    } catch {
      return oauthError('invalid_request', '入力が大きすぎます。');
    }
    const clientId = form.get('client_id'),
      audience = form.get('resource');
    if (!(await client(env, clientId)))
      return oauthError('invalid_client', 'クライアントを確認できません。');
    if (audience !== resource(origin))
      return oauthError('invalid_target', 'resourceを確認してください。');
    if (form.get('grant_type') === 'authorization_code') {
      const hash = await digest(form.get('code') ?? ''),
        row = await env.DB.prepare('SELECT * FROM oauth_codes WHERE hash=? AND expires_at>?')
          .bind(hash, now())
          .first();
      const verifier = form.get('code_verifier') ?? '';
      if (
        !row ||
        row.client_id !== clientId ||
        row.redirect_uri !== form.get('redirect_uri') ||
        row.resource !== audience ||
        !/^[-\w.~]{43,128}$/.test(verifier) ||
        row.challenge !== (await digest(verifier))
      )
        return oauthError('invalid_grant', '認証コードまたはPKCEを確認できません。');
      const result = await env.DB.prepare('DELETE FROM oauth_codes WHERE hash=?').bind(hash).run();
      if (!result.meta.changes) return oauthError('invalid_grant', '認証コードは使用済みです。');
    } else if (form.get('grant_type') === 'refresh_token') {
      const result = await env.DB.prepare(
        "DELETE FROM oauth_tokens WHERE hash=? AND kind='refresh' AND client_id=? AND resource=? AND expires_at>? RETURNING hash",
      )
        .bind(await tokenHash(env, form.get('refresh_token') ?? ''), clientId, audience, now())
        .first();
      if (!result) return oauthError('invalid_grant', '再接続してください。');
    } else
      return oauthError(
        'unsupported_grant_type',
        'authorization_code または refresh_token を使用してください。',
      );
    await clean(env);
    return issue(env, clientId, audience);
  }
  return oauthError(
    'invalid_request',
    'このOAuthエンドポイント・メソッドには対応していません。',
    405,
  );
}
