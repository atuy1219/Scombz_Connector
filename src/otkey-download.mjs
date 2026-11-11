import { resolveMaterialDownloadUrl, ScombError, validateReadUrl } from './client.mjs';
import { MOBILE_WEB_HOST } from './mobile-auth.mjs';

const MAX_TEMPORARY_BYTES = 2048;

// Read an untrusted temporary-ID response without buffering an unbounded body.
async function temporaryId(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!/^text\/plain(?:\s*;|$)/i.test(type)) {
    await response.body?.cancel().catch(() => {});
    throw new ScombError('parse_error', '一時ファイルIDの形式がテキストではありません。');
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_TEMPORARY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ScombError('parse_error', '一時ファイルIDが長すぎます。');
  }
  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new ScombError('parse_error', '一時ファイルIDの応答が空です。');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TEMPORARY_BYTES)
        throw new ScombError('parse_error', '一時ファイルIDが長すぎます。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const token = new TextDecoder().decode(bytes).trim();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(token))
    throw new ScombError('parse_error', '一時ファイルIDの形式を確認できません。');
  return token;
}

// Build a short-lived OTKEY URL without exposing the cached SESSION or Bearer token.
// Only PDFs from the course material list have a verified ASCII basename flow.
export async function prepareOtkeyFileUrl(client, courseId, fileId) {
  const plan = await client.materialDownloadPlan(courseId, fileId);
  if (!plan.prepare_request || !/\.pdf$/i.test(plan.file.filename))
    throw new ScombError(
      'unsupported_file_type',
      'OTKEY付きURLの検証済み経路は教材PDFのみです。ほかの原本はprepare_file_downloadを使用してください。',
    );

  const response = await client.request(plan.prepare_request.url, true);
  const temporary = await temporaryId(response);
  const ordinary = validateReadUrl(resolveMaterialDownloadUrl(plan, temporary), true);
  if (!ordinary.pathname.startsWith('/lms/course/material/setfiledown/'))
    throw new ScombError('forbidden_operation', '教材以外の取得経路は使用しません。');

  if (!client.mobile)
    throw new ScombError('auth_required', 'Mobile APIへの認証が必要です。');
  const otkey = await client.mobile.getOtkey(); // Must be fresh: OTKEY is a session bootstrap credential.
  const url = new URL('https://' + MOBILE_WEB_HOST);
  url.pathname =
    '/' + encodeURIComponent(otkey) + '/lms/course/material/setfiledown/download.pdf';
  url.search = ordinary.search;
  return {
    protocol: 'scombz-otkey-file-url-v1',
    file: plan.file,
    url: url.href,
    mime_type: 'application/pdf',
    redirects: '302 to scombz.shibaura-it.ac.jp, issuing a SESSION cookie',
    cookie_handling: 'The HTTP client must retain Set-Cookie during the redirect.',
    expires: 'short_lived_not_guaranteed',
    security: 'The URL contains a login-equivalent OTKEY. Do not log, cache, repost or share it.',
  };
}
