import { encrypt, decrypt } from './crypto.mjs';
export class SessionStore {
  constructor(env) {
    this.env = env;
    this.original = undefined;
    this.plain = null;
  }
  async load() {
    const row = await this.env.DB.prepare('SELECT data FROM session WHERE id=1').first();
    this.original = row?.data ?? null;
    this.plain = row ? await decrypt(this.env, row.data) : null;
    return this.plain ? JSON.parse(this.plain) : null;
  }
  async save(session, { replace = false } = {}) {
    const plain = JSON.stringify(session);
    if (!replace && plain === this.plain) return;
    const encrypted = await encrypt(this.env, plain),
      now = new Date().toISOString();
    if (replace)
      await this.env.DB.prepare(
        'INSERT INTO session(id,data,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      )
        .bind(encrypted, now)
        .run();
    else if (this.original)
      await this.env.DB.prepare('UPDATE session SET data=?,updated_at=? WHERE id=1 AND data=?')
        .bind(encrypted, now, this.original)
        .run();
    // Do not overwrite a concurrently uploaded/revoked session with an old Cookie.
    this.original = encrypted;
    this.plain = plain;
  }
}
