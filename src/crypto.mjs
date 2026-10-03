const encoder = new TextEncoder();
export const bytes = (value) => encoder.encode(value);
export const base64url = (data) =>
  btoa(String.fromCharCode(...new Uint8Array(data)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
export function decode64(value) {
  if (!/^[\w-]+$/.test(value)) throw new Error('invalid encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
}
export const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (value) =>
  base64url(await crypto.subtle.digest('SHA-256', bytes(value)));
export function configured(env) {
  return (
    /^[A-Za-z0-9_-]{43,128}$/.test(env.ADMIN_TOKEN ?? '') &&
    /^[a-fA-F0-9]{64}$/.test(env.SESSION_ENCRYPTION_KEY ?? '') &&
    !!env.DB
  );
}
async function key(env, usage) {
  const raw = Uint8Array.from((env.SESSION_ENCRYPTION_KEY ?? '').match(/../g) ?? [], (v) =>
    parseInt(v, 16),
  );
  return crypto.subtle.importKey(
    'raw',
    raw,
    usage === 'aes' ? 'AES-GCM' : { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage === 'aes' ? ['encrypt', 'decrypt'] : ['sign', 'verify'],
  );
}
export async function equalSecret(a, b) {
  if (!a || !b) return false;
  return (await digest(a)) === (await digest(b));
}
export async function sign(env, payload) {
  const body = base64url(bytes(JSON.stringify(payload)));
  const signature = base64url(
    await crypto.subtle.sign('HMAC', await key(env, 'hmac'), bytes(body)),
  );
  return body + '.' + signature;
}
export async function verify(env, value, kind) {
  try {
    const [body, signature, extra] = (value ?? '').split('.');
    if (extra || !body || !signature || value.length > 8000) return null;
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await key(env, 'hmac'),
        decode64(signature),
        bytes(body),
      ))
    )
      return null;
    const data = JSON.parse(new TextDecoder().decode(decode64(body)));
    if (data.kind !== kind || (data.exp && data.exp < Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}
export async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: bytes('scombz-session-v1') },
    await key(env, 'aes'),
    bytes(text),
  );
  return JSON.stringify({ v: 1, iv: base64url(iv), data: base64url(encrypted) });
}
export async function decrypt(env, text) {
  const envelope = JSON.parse(text);
  if (envelope.v !== 1) throw new Error('unknown session version');
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode64(envelope.iv), additionalData: bytes('scombz-session-v1') },
      await key(env, 'aes'),
      decode64(envelope.data),
    ),
  );
}
