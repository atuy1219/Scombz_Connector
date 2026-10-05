import { encrypt, decrypt } from './crypto.mjs';
import { ScombError } from './client.mjs';

export const MOBILE_API_BASE = 'https://smob.sic.shibaura-it.ac.jp/smob/api/';
export const MOBILE_WEB_HOST = 'mobile.scombz.shibaura-it.ac.jp';
export const SCOMBZ_HOST = 'scombz.shibaura-it.ac.jp';

const MAX_JSON_BYTES = 1024 * 1024;
const ALLOWED_BRIDGE_HOSTS = new Set([MOBILE_WEB_HOST, SCOMBZ_HOST]);
const FALLBACK_BRIDGE_PATHS = ['/portal/home', '/lms/timetable?selectDisplayMode=0', '/lms/task'];

async function readJson(response) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_JSON_BYTES)
    throw new ScombError('mobile_response_too_large', 'Mobile APIの応答が大きすぎます。');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES)
    throw new ScombError('mobile_response_too_large', 'Mobile APIの応答が大きすぎます。');
  try {
    return JSON.parse(text);
  } catch {
    throw new ScombError('mobile_parse_error', 'Mobile APIの応答をJSONとして確認できません。');
  }
}

function validSecret(value, maximum = 8192) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/.test(value) &&
    !/[\r\n]/.test(value)
  );
}

function cookieFrom(response) {
  const lines = response.headers.getSetCookie?.() ?? [];
  for (const line of lines) {
    const match = line.match(/^SESSION=([^;]+)/i);
    if (!match || !validSecret(match[1])) continue;
    let expires = -1;
    const maxAge = line.match(/;\s*max-age=(-?\d+)/i);
    const expiry = line.match(/;\s*expires=([^;]+)/i);
    if (maxAge) expires = Date.now() / 1000 + Number(maxAge[1]);
    else if (expiry && Number.isFinite(Date.parse(expiry[1]))) expires = Date.parse(expiry[1]) / 1000;
    return {
      name: 'SESSION',
      value: match[1],
      domain: SCOMBZ_HOST,
      path: '/',
      secure: true,
      httpOnly: /;\s*httponly(?:;|$)/i.test(line),
      sameSite: undefined,
      expires,
    };
  }
  return null;
}

function safeRedirect(location, current) {
  if (!location) return null;
  try {
    const target = new URL(location, current);
    return { host: target.host, path: target.pathname };
  } catch {
    return null;
  }
}

export class MobileAuthStore {
  constructor(env) {
    this.env = env;
  }
  async load() {
    const row = await this.env.DB.prepare('SELECT data FROM mobile_auth WHERE id=1').first();
    if (!row) return null;
    return JSON.parse(await decrypt(this.env, row.data));
  }
  async save(value) {
    const encrypted = await encrypt(this.env, JSON.stringify(value));
    await this.env.DB.prepare(
      'INSERT INTO mobile_auth(id,data,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
    )
      .bind(encrypted, new Date().toISOString())
      .run();
  }
  async clear() {
    await this.env.DB.prepare('DELETE FROM mobile_auth WHERE id=1').run();
  }
  async exists() {
    return !!(await this.env.DB.prepare('SELECT id FROM mobile_auth WHERE id=1').first());
  }
}

export class MobileAuthClient {
  constructor(env, options = {}) {
    this.env = env;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.store = options.store ?? new MobileAuthStore(env);
  }
  async login(user, password) {
    if (typeof user !== 'string' || !user.trim() || user.length > 128)
      throw new ScombError('invalid_mobile_credentials', '学籍番号の形式を確認してください。');
    if (typeof password !== 'string' || !password || password.length > 1024)
      throw new ScombError('invalid_mobile_credentials', 'パスワードの形式を確認してください。');
    let response;
    try {
      response = await this.fetch(new URL('login', MOBILE_API_BASE), {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(25000),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'ScombZ-Connector/otkey-debug',
        },
        body: JSON.stringify({ user: user.trim(), pass: password }),
      });
    } catch {
      throw new ScombError('temporarily_unavailable', 'Mobile APIへの接続に失敗しました。');
    }
    if (response.status === 401 || response.status === 403)
      throw new ScombError('mobile_auth_failed', 'Mobile APIの認証に失敗しました。');
    if (!response.ok)
      throw new ScombError('mobile_upstream_error', `Mobile APIがHTTP ${response.status}を返しました。`);
    const body = await readJson(response);
    if (body?.status !== 'OK' || !validSecret(body?.token))
      throw new ScombError('mobile_auth_failed', 'Mobile APIから有効なトークンを取得できませんでした。');
    await this.store.save({ token: body.token });
    return {
      authenticated: true,
      user_type: typeof body.user_type === 'string' ? body.user_type : null,
      token_stored: true,
      password_stored: false,
    };
  }
  async token() {
    const saved = await this.store.load();
    if (!validSecret(saved?.token))
      throw new ScombError('mobile_auth_required', 'Mobile APIへのログインが必要です。');
    return saved.token;
  }
  async apiGet(path) {
    const token = await this.token();
    let response;
    try {
      response = await this.fetch(new URL(path.replace(/^\/+/, ''), MOBILE_API_BASE), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(25000),
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
          'User-Agent': 'ScombZ-Connector/otkey-debug',
        },
      });
    } catch {
      throw new ScombError('temporarily_unavailable', 'Mobile APIへの接続に失敗しました。');
    }
    if (response.status === 401 || response.status === 403) {
      await this.store.clear();
      throw new ScombError('mobile_auth_required', 'Mobile APIの認証期限が切れています。');
    }
    if (!response.ok)
      throw new ScombError('mobile_upstream_error', `Mobile APIがHTTP ${response.status}を返しました。`);
    return readJson(response);
  }
  async getOtkey() {
    const body = await this.apiGet('otkey');
    if (body?.status !== 'OK' || !validSecret(body?.otkey, 2048))
      throw new ScombError('otkey_unavailable', 'OTKEYを取得できませんでした。');
    return body.otkey;
  }
  async getSessionIdState() {
    const body = await this.apiGet('sessionid');
    return {
      available: validSecret(body?.sessionid),
      length: validSecret(body?.sessionid) ? body.sessionid.length : 0,
    };
  }
  async probeCoursePath() {
    const now = new Date(Date.now() + 9 * 3600000);
    const month = now.getUTCMonth() + 1;
    const year = now.getUTCFullYear() - (month <= 3 ? 1 : 0);
    const term = month >= 4 && month <= 8 ? '01' : '02';
    try {
      const rows = await this.apiGet(`timetable/${year}${term}`);
      const course = Array.isArray(rows)
        ? rows.find((row) => typeof row?.classId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.classId))
        : null;
      return course ? '/lms/course?idnumber=' + encodeURIComponent(course.classId) : null;
    } catch (error) {
      if (error instanceof ScombError && error.code === 'mobile_auth_required') throw error;
      return null;
    }
  }
  async exchangeOtkey() {
    const otkey = await this.getOtkey();
    const coursePath = await this.probeCoursePath();
    const candidates = coursePath ? [coursePath, ...FALLBACK_BRIDGE_PATHS] : FALLBACK_BRIDGE_PATHS;
    const diagnostics = [];
    const cookieJar = new Map();
    for (const candidate of candidates) {
      let current = new URL(
        '/' + encodeURIComponent(otkey) + candidate,
        'https://' + MOBILE_WEB_HOST,
      );
      for (let hop = 0; hop < 6; hop++) {
        if (!ALLOWED_BRIDGE_HOSTS.has(current.host))
          throw new ScombError('otkey_redirect_blocked', 'OTKEY経路が許可していないホストへ遷移しました。');
        let response;
        try {
          response = await this.fetch(current, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(25000),
            headers: {
              Accept: 'text/html,application/xhtml+xml',
              'Accept-Language': 'ja,en;q=0.8',
              'User-Agent': 'Mozilla/5.0',
              ...(cookieJar.size
                ? { Cookie: [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ') }
                : {}),
            },
          });
        } catch {
          throw new ScombError('temporarily_unavailable', 'OTKEY経路への接続に失敗しました。');
        }
        const setCookies = response.headers.getSetCookie?.() ?? [];
        for (const line of setCookies) {
          const pair = line.split(';', 1)[0];
          const index = pair.indexOf('=');
          if (index > 0 && validSecret(pair.slice(index + 1))) cookieJar.set(pair.slice(0, index), pair.slice(index + 1));
        }
        const session = cookieFrom(response);
        const redirect = safeRedirect(response.headers.get('location'), current);
        diagnostics.push({
          candidate: candidate.split('?')[0],
          hop,
          host: current.host,
          status: response.status,
          redirect,
          session_cookie_received: !!session,
        });
        if (session) return { session, diagnostics, otkey_received: true };
        if (response.status < 300 || response.status >= 400 || !redirect) break;
        const next = new URL(response.headers.get('location'), current);
        if (!ALLOWED_BRIDGE_HOSTS.has(next.host)) {
          diagnostics.push({
            candidate: candidate.split('?')[0],
            hop: hop + 1,
            host: next.host,
            status: null,
            redirect: null,
            session_cookie_received: false,
            blocked: true,
          });
          break;
        }
        current = next;
      }
    }
    return { session: null, diagnostics, otkey_received: true };
  }
}
