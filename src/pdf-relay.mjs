import { sign, verify } from './crypto.mjs';
import { resolveMaterialDownloadUrl, ScombError, validateReadUrl } from './client.mjs';

const TOKEN_KIND = 'scombz-pdf-relay-v1';
const TTL_SECONDS = 120;
const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_ID_BYTES = 2048;
const COURSE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const FILE_ID_RE = /^material:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

function ensurePdfPlan(plan) {
  if (
    plan.file?.kind !== 'material' ||
    !/\.pdf$/i.test(plan.file?.filename ?? '') ||
    !plan.prepare_request?.url ||
    !plan.download_request?.url_template
  )
    throw new ScombError(
      'unsupported_file_type',
      'この方式は科目の教材PDFのみ対応しています。',
    );
  validateReadUrl(plan.prepare_request.url, true);
  validateReadUrl(plan.download_request.url_template.replace('{temporary_file_id}', 'dummy'), true);
  return plan;
}

async function boundedBytes(response, maximum) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new ScombError('file_too_large', 'PDFまたは一時IDが取得上限を超えています。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ScombError('parse_error', 'ScombZから空の応答を受け取りました。');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new ScombError('file_too_large', 'PDFまたは一時IDが取得上限を超えています。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function createPdfRelayUrl(client, env, origin, courseId, fileId) {
  if (!COURSE_ID_RE.test(courseId) || !FILE_ID_RE.test(fileId))
    throw new ScombError('invalid_request', '指定した授業ID・教材IDを確認できません。');
  const plan = ensurePdfPlan(await client.materialDownloadPlan(courseId, fileId));
  const token = await sign(env, {
    kind: TOKEN_KIND,
    course_id: courseId,
    file_id: fileId,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  });
  return {
    protocol: TOKEN_KIND,
    file: plan.file,
    url: new URL('/file/pdf/' + token, origin).href,
    mime_type: 'application/pdf',
    expires_in_seconds: TTL_SECONDS,
    max_bytes: MAX_PDF_BYTES,
    redirects: false,
    authentication: 'short_lived_signed_url',
    security: 'This URL is temporarily a credential: never log, publish, or forward it to third parties.',
  };
}

export async function servePdfRelay(request, env, options = {}) {
  if (request.method !== 'GET')
    return new Response('Method Not Allowed', { status: 405, headers: { ...NO_STORE, Allow: 'GET' } });
  const url = new URL(request.url);
  const token = url.pathname.slice('/file/pdf/'.length);
  // No user-provided fetch URL: only allow a signed pair of IDs, then resolve metadata from ScombZ.
  if (url.search || !/^[A-Za-z0-9_.-]{1,8000}$/.test(token))
    return new Response('Forbidden', { status: 403, headers: NO_STORE });
  const data = await verify(env, token, TOKEN_KIND);
  if (
    !data ||
    !Number.isSafeInteger(data.exp) ||
    data.exp < Math.floor(Date.now() / 1000) ||
    data.exp > Math.floor(Date.now() / 1000) + TTL_SECONDS ||
    !COURSE_ID_RE.test(data.course_id ?? '') ||
    !FILE_ID_RE.test(data.file_id ?? '')
  )
    return new Response('Forbidden', { status: 403, headers: NO_STORE });

  // The Worker already holds encrypted ScombZ authorization and can refresh it internally.
  // No SESSION, OTKEY, or cross-domain redirect is ever exposed to the recipient.
  const client = options.client ?? new (await import('./client.mjs')).ScombClient(env, options);
  const plan = ensurePdfPlan(await client.materialDownloadPlan(data.course_id, data.file_id));
  const temporaryResponse = await client.request(plan.prepare_request.url, true);
  if (!/^text\/plain(?:\s*;|$)/i.test(temporaryResponse.headers.get('content-type') ?? '')) {
    await temporaryResponse.body?.cancel().catch(() => {});
    throw new ScombError('parse_error', '一時IDの応答を確認できません。');
  }
  const temporaryId = new TextDecoder()
    .decode(await boundedBytes(temporaryResponse, MAX_ID_BYTES))
    .trim();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(temporaryId))
    throw new ScombError('parse_error', '一時ファイルIDの形式を確認できません。');

  const downloadUrl = new URL(resolveMaterialDownloadUrl(plan, temporaryId));
  // Validated ASCII path avoids Japanese filename double-encoding on intermediate redirects.
  downloadUrl.pathname = '/lms/course/material/setfiledown/download.pdf';
  const fileResponse = await client.request(downloadUrl.href, true);
  if (!/^application\/pdf(?:\s*;|$)/i.test(fileResponse.headers.get('content-type') ?? '')) {
    await fileResponse.body?.cancel().catch(() => {});
    throw new ScombError('parse_error', 'ScombZからPDF以外の応答が返りました。');
  }
  const pdf = await boundedBytes(fileResponse, MAX_PDF_BYTES);
  if (pdf.byteLength < 5 || new TextDecoder('ascii').decode(pdf.subarray(0, 5)) !== '%PDF-')
    throw new ScombError('parse_error', 'PDFの署名が一致しません。');
  return new Response(pdf, {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.byteLength),
      'Content-Disposition': 'inline; filename="scombz-material.pdf"',
    },
  });
}
