import { encrypt, decrypt } from './crypto.mjs';
export const SESSION_CACHE_SECONDS = 6 * 60 * 60;
export class SessionStore {
  constructor(env) {
    this.env = env;
    this.original = undefined;
    this.plain = null;
  }
  bindAuthentication(generation, revision) {
    this.generation = generation;
    this.revision = revision;
  }
  async load() {
    const row = await this.env.DB.prepare('SELECT data FROM session WHERE id=1').first();
    this.original = row?.data ?? null;
    this.plain = row ? await decrypt(this.env, row.data) : null;
    const cached = this.plain ? JSON.parse(this.plain) : null;
    if (
      this.generation !== undefined &&
      (cached?.auth_generation !== this.generation ||
        cached?.cache_expires_at <= Date.now() / 1000 ||
        !cached?.cache_expires_at)
    )
      return null;
    this.expires = cached?.cache_expires_at;
    return cached;
  }
  async save(session, { replace = false } = {}) {
    const value =
      this.generation === undefined
        ? session
        : {
            ...session,
            auth_generation: this.generation,
            cache_expires_at:
              replace || !this.expires
                ? Math.floor(Date.now() / 1000) + SESSION_CACHE_SECONDS
                : this.expires,
          };
    const plain = JSON.stringify(value);
    if (!replace && plain === this.plain) return;
    const encrypted = await encrypt(this.env, plain),
      now = new Date().toISOString();
    if (replace && this.revision)
      await this.env.DB.prepare(
        'INSERT INTO session(id,data,updated_at) SELECT 1,?,? WHERE EXISTS(SELECT 1 FROM mobile_auth WHERE id=1 AND data=?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      )
        .bind(encrypted, now, this.revision)
        .run();
    else if (replace)
      await this.env.DB.prepare(
        'INSERT INTO session(id,data,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      )
        .bind(encrypted, now)
        .run();
    else if (this.original) {
      const guard = this.revision
        ? ' AND EXISTS(SELECT 1 FROM mobile_auth WHERE id=1 AND data=?)'
        : '';
      await this.env.DB.prepare(
        'UPDATE session SET data=?,updated_at=? WHERE id=1 AND data=?' + guard,
      )
        .bind(encrypted, now, this.original, ...(this.revision ? [this.revision] : []))
        .run();
    }
    // Do not overwrite a concurrently uploaded/revoked session with an old Cookie.
    this.original = encrypted;
    this.plain = plain;
    this.expires = value.cache_expires_at;
  }
}
