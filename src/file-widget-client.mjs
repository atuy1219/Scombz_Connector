import { App } from '@modelcontextprotocol/ext-apps';

// This is a one-time action in the conversation; support/prefer inline only.
const app = new App(
  { name: 'ScombZ教材', version: '1.0.0' },
  { availableDisplayModes: ['inline'] },
);
const el = (id) => document.getElementById(id);
let result,
  transfer,
  uploaded,
  busy = false,
  connected = false,
  cachedFile,
  linkingPromise,
  closingPromise,
  widgetClosed = false;
// Deliberately record fixed codes, never arbitrary host messages, URLs or file contents.
const diagnosticEvents = [];
const diagnosticStarted = Date.now();
const waitingOperations = new Set();
function capabilities() {
  return Object.fromEntries(
    ['uploadFile', 'getFileDownloadUrl', 'setWidgetState', 'requestClose'].map((name) => [
      name,
      typeof window.openai?.[name] === 'function',
    ]),
  );
}
function diagnosticSnapshot() {
  return {
    version: 1,
    capabilities: capabilities(),
    connected,
    upload_status: uploaded?.upload_status ?? 'not_started',
    handoff_status: uploaded?.handoff_status ?? 'not_started',
    handoff_attempts: uploaded?.handoff_attempts ?? 0,
    library_status: uploaded?.library_status ?? 'unverified',
    model_readability: uploaded?.model_readability ?? 'unverified',
    events: diagnosticEvents.slice(),
  };
}
function diagnostic(stage, outcome, extra = {}) {
  diagnosticEvents.push({ elapsed_ms: Date.now() - diagnosticStarted, stage, outcome, ...extra });
  if (diagnosticEvents.length > 80) diagnosticEvents.shift();
  el('diagnostic-log').value = JSON.stringify(diagnosticSnapshot(), null, 2);
}
function safeError(error) {
  const known = new Set([
    'expired',
    'too_large',
    'download_failed',
    'invalid_metadata',
    'empty',
    'invalid_pdf',
    'invalid_download_url',
    'upload_failed',
    'message_resource_link_rejected',
    'message_rejected',
    'context_rejected',
    'refresh_failed',
  ]);
  const names = new Set([
    'Error',
    'TypeError',
    'AbortError',
    'TimeoutError',
    'NotAllowedError',
    'SecurityError',
  ]);
  const message = typeof error?.message === 'string' ? error.message : '';
  const category = /permission|denied|not allowed|approval/i.test(message)
    ? 'permission_denied'
    : /unsupported|not supported|not implemented/i.test(message)
      ? 'unsupported'
      : /network|failed to fetch/i.test(message)
        ? 'network_error'
        : /timed? ?out|timeout/i.test(message)
          ? 'timeout'
          : 'host_error';
  return {
    ...(Number.isSafeInteger(error?.code) ? { rpc_code: error.code } : {}),
    error_name: names.has(error?.name) ? error.name : 'HostError',
    error_code: known.has(error?.message) ? error.message : category,
  };
}
async function observe(stage, operation) {
  const started = Date.now();
  const operationId = {};
  diagnostic(stage, 'started');
  // This is a watchdog, not cancellation: never start a duplicate upload after a slow host call.
  const watchdog = setTimeout(() => {
    waitingOperations.add(operationId);
    diagnostic(stage, 'waiting', { duration_ms: Date.now() - started });
    el('diagnostics').open = true;
    el('diagnostic-notice').textContent =
      'ホストまたはネットワークの応答待ちです。処理は継続中です。診断ログで停止箇所を確認できます。';
    persistUploadedState();
  }, 15000);
  try {
    const value = await operation();
    diagnostic(stage, 'completed', { duration_ms: Date.now() - started });
    return value;
  } catch (error) {
    diagnostic(stage, 'failed', { duration_ms: Date.now() - started, ...safeError(error) });
    el('diagnostics').open = true;
    throw error;
  } finally {
    clearTimeout(watchdog);
    waitingOperations.delete(operationId);
    if (
      !waitingOperations.size &&
      el('diagnostic-notice').textContent.startsWith('ホストまたはネットワーク')
    )
      el('diagnostic-notice').textContent =
        '応答待ちが終了しました。結果は診断ログで確認できます。';
  }
}
const status = (text) => {
  el('status').textContent = text;
};
const supported = () => typeof window.openai?.uploadFile === 'function';
const canResolveUploadedFile = () => typeof window.openai?.getFileDownloadUrl === 'function';
const canCloseWidget = () => typeof window.openai?.requestClose === 'function';
// Closing on upload alone can discard the only recovery UI when the model handoff fails.
async function closeCompletedWidget() {
  if (
    !uploaded ||
    uploaded.upload_status !== 'completed' ||
    !uploaded.model_context_linked ||
    !uploaded.followup_sent ||
    widgetClosed ||
    !canCloseWidget() ||
    el('keep-open').checked
  )
    return;
  if (closingPromise) return closingPromise;
  closingPromise = (async () => {
    try {
      await observe('widget_close', () => window.openai.requestClose());
      widgetClosed = true;
    } catch {
      // A host may not support closing; the uploaded file is still usable.
    } finally {
      closingPromise = null;
    }
  })();
  return closingPromise;
}

function persistUploadedState() {
  if (!uploaded) return;
  el('diagnostic-log').value = JSON.stringify(diagnosticSnapshot(), null, 2);
  try {
    window.openai?.setWidgetState?.({
      modelContent: uploaded,
      privateContent: { diagnostics: diagnosticSnapshot() },
    });
  } catch (error) {
    diagnostic('widget_state', 'failed', safeError(error));
  }
}

function receive(value) {
  if (!value?.structuredContent?.file || !value?._meta?.file_transfer) {
    diagnostic('tool_metadata', 'waiting');
    return;
  }
  if (busy) return;
  const next = value.structuredContent;
  const nextTransfer = value._meta.file_transfer;
  let url;
  try {
    url = new URL(nextTransfer.download_url);
  } catch {
    el('upload').disabled = true;
    diagnostic('tool_metadata', 'failed', { error_code: 'invalid_metadata' });
    status('教材の取得リンクを確認できません。');
    return;
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== nextTransfer.origin ||
    !url.pathname.startsWith('/files/') ||
    !url.searchParams.get('ticket') ||
    !Number.isSafeInteger(nextTransfer.max_bytes) ||
    nextTransfer.max_bytes < 1 ||
    !Number.isFinite(Date.parse(nextTransfer.expires_at))
  ) {
    el('upload').disabled = true;
    diagnostic('tool_metadata', 'failed', { error_code: 'invalid_metadata' });
    status('教材の取得リンクを確認できません。');
    return;
  }
  if (
    next.file.file_id !== result?.file?.file_id ||
    next.file.course_id !== result?.file?.course_id
  ) {
    uploaded = null;
    cachedFile = null;
    widgetClosed = false;
  }
  diagnostic('tool_metadata', 'received');
  result = next;
  transfer = nextTransfer;
  const previous = window.openai?.widgetState?.modelContent;
  if (
    !uploaded &&
    previous?.upload_status === 'completed' &&
    previous?.file_id &&
    previous.source_file_id === result.file.file_id &&
    previous.course_id === result.file.course_id
  )
    uploaded = previous;
  el('filename').textContent = uploaded?.filename ?? result.file.filename ?? '教材原本';
  el('download').href = url.href;
  el('download').hidden = false;
  el('refresh').hidden = true;
  el('upload').disabled = busy || !!uploaded || !supported();
  el('upload').hidden = true;
  el('verify').hidden = !uploaded;
  if (!uploaded) {
    if (!supported()) diagnostic('upload_api', 'unavailable');
    status(
      supported()
        ? '教材を自動取得してChatGPTへアップロードします…'
        : 'この画面ではアップロード機能を利用できません。原本をダウンロードし、会話に添付してください。',
    );
    void maybeAutoUpload();
  } else {
    status('アップロード完了。PDF本文を読めるかは未確認です。');
    if (connected) void linkUploadedFile();
  }
}

async function downloadFile() {
  if (cachedFile) return cachedFile;
  if (Date.parse(transfer.expires_at) <= Date.now()) throw new Error('expired');
  const response = await fetch(transfer.download_url, {
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(180000),
  });
  diagnostic('download_http', 'received', { http_status: response.status });
  if (response.status === 401) throw new Error('expired');
  if (!response.ok) throw new Error(response.status === 413 ? 'too_large' : 'download_failed');
  // The server resolves the real name/type only when it streams the original.
  const disposition = response.headers.get('content-disposition');
  const encodedName = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const filename = encodedName ? decodeURIComponent(encodedName) : result.file.filename;
  if (!filename) throw new Error('invalid_metadata');
  const mime = filename.toLowerCase().endsWith('.pdf')
    ? 'application/pdf'
    : (response.headers.get('content-type')?.split(';')[0].trim() ??
      result.mime_type ??
      'application/octet-stream');
  el('filename').textContent = filename;
  const maximum = Math.min(transfer.max_bytes, 100 * 1024 * 1024);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximum) throw new Error('too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('too_large');
      chunks.push(value);
      status(`教材を取得中… ${(size / 1048576).toFixed(1)} MiB`);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (!size) throw new Error('empty');
  const blob = new Blob(chunks, { type: mime });
  if (mime === 'application/pdf' && (await blob.slice(0, 5).text()) !== '%PDF-')
    throw new Error('invalid_pdf');
  cachedFile = new File([blob], filename, { type: mime });
  return cachedFile;
}

async function sendFileIdFallback() {
  if (!uploaded || !connected || uploaded.file_id_fallback_sent) return;
  try {
    await observe('file_id_fallback', async () => {
      const sent = await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `ScombZ教材「${uploaded.filename}」はアップロード済みですが、ファイル参照を渡せませんでした。` +
              `fileId: ${uploaded.file_id}。Files/Library機能が利用できる場合は、このfileIdをsource_file_ref.file_idとして保存・読取を試し、本文を確認して元の依頼を続行してください。`,
          },
        ],
      });
      if (sent?.isError) throw new Error('message_rejected');
    });
    uploaded.file_id_fallback_sent = true;
    uploaded.library_handoff = 'model_file_id';
    uploaded.handoff_status = 'file_id_fallback';
    persistUploadedState();
  } catch (error) {
    diagnostic('file_id_fallback', 'rejected', safeError(error));
    persistUploadedState();
  }
}

// Multiple host notifications can arrive while the same attachment is being sent.
async function linkUploadedFile() {
  if (linkingPromise) return linkingPromise;
  linkingPromise = performLinkUploadedFile();
  try {
    return await linkingPromise;
  } finally {
    linkingPromise = null;
    await closeCompletedWidget();
  }
}

async function performLinkUploadedFile() {
  if (!uploaded || !connected || uploaded.model_context_linked) return;
  uploaded.handoff_attempts = (uploaded.handoff_attempts ?? 0) + 1;
  uploaded.handoff_status = 'pending';
  persistUploadedState();
  if (!canResolveUploadedFile()) {
    diagnostic('resolve_file_url', 'unavailable');
    el('verify').hidden = false;
    status(
      'アップロード完了。ただし、このホストではPDFをモデルへ渡すための一時URLを取得できません。',
    );
    uploaded.handoff_status = 'retry_required';
    persistUploadedState();
    await sendFileIdFallback();
    return;
  }

  let downloadUrl;
  try {
    const resolved = await observe('resolve_file_url', async () => {
      const value = await window.openai.getFileDownloadUrl({ fileId: uploaded.file_id });
      if (!value?.downloadUrl || new URL(value.downloadUrl).protocol !== 'https:')
        throw new Error('invalid_download_url');
      return value;
    });
    downloadUrl = resolved?.downloadUrl;
    const parsed = new URL(downloadUrl);
    if (parsed.protocol !== 'https:') throw new Error('invalid_download_url');
  } catch {
    el('verify').hidden = false;
    status('アップロード完了。ただし、PDFのモデル向け参照URLを取得できませんでした。');
    uploaded.handoff_status = 'retry_required';
    persistUploadedState();
    await sendFileIdFallback();
    return;
  }

  const resourceLink = {
    type: 'resource_link',
    uri: downloadUrl,
    name: uploaded.filename,
    mimeType: uploaded.mime_type,
  };
  const verificationText =
    `ScombZ教材「${uploaded.filename}」をアップロードしました。` +
    '本文を実際に確認してから取得成功と判断し、元の依頼を続行してください。';

  try {
    // Prefer attaching the uploaded PDF directly to the follow-up turn. In ChatGPT,
    // ui/message resource links are model-visible file attachments on supported hosts.
    await observe('resource_message', async () => {
      const sent = await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: verificationText }, resourceLink],
      });
      if (sent?.isError) throw new Error('message_resource_link_rejected');
    });
    uploaded.model_context_linked = true;
    uploaded.followup_sent = true;
    uploaded.delivery_mode = 'ui_message_resource_link';
    uploaded.library_handoff = 'resource_link';
    uploaded.handoff_status = 'linked';
  } catch {
    try {
      // Fallback for hosts that accept resource links in model context but not ui/message.
      await observe('model_context', async () => {
        const contextResult = await app.updateModelContext({
          content: [
            {
              type: 'text',
              text: `ScombZ教材「${uploaded.filename}」をChatGPTへアップロード済みです。PDF原本の本文を実際に読んで利用してください。`,
            },
            resourceLink,
          ],
        });
        if (contextResult?.isError) throw new Error('context_rejected');
      });
      await observe('followup_message', async () => {
        const sent = await app.sendMessage({
          role: 'user',
          content: [{ type: 'text', text: verificationText }],
        });
        if (sent?.isError) throw new Error('message_rejected');
      });
      uploaded.model_context_linked = true;
      uploaded.followup_sent = true;
      uploaded.delivery_mode = 'update_model_context_fallback';
      uploaded.library_handoff = 'resource_link';
      uploaded.handoff_status = 'linked';
    } catch {
      uploaded.model_context_linked = false;
      uploaded.followup_sent = false;
      uploaded.delivery_mode = 'failed';
      uploaded.handoff_status = 'retry_required';
      persistUploadedState();
      el('verify').hidden = false;
      status(
        'アップロード完了。ただし、PDFをモデルへ渡せませんでした。確認ボタンで再試行できます。',
      );
      await sendFileIdFallback();
      return;
    }
  }

  uploaded.model_readability = 'verification_requested';
  persistUploadedState();
  el('verify').hidden = true;
  status('アップロード完了。PDFを会話へ添付し、読み取り確認を開始しました。');
}

async function startUpload() {
  if (busy || uploaded || !result || !supported()) return;
  busy = true;
  el('upload').disabled = true;
  el('upload').hidden = true;
  let phase = 'download';
  try {
    const file = await observe('download', downloadFile);
    phase = 'upload';
    status(
      `原本取得成功: ${(file.size / 1048576).toFixed(2)} MiB\nChatGPTへ自動アップロードし、ファイルライブラリへ保存中…`,
    );
    const value = await observe('upload', async () => {
      const value = await window.openai.uploadFile(file, { library: true });
      if (typeof value?.fileId !== 'string' || !value.fileId) throw new Error('upload_failed');
      return value;
    });
    uploaded = {
      file_id: value.fileId,
      filename: file.name,
      mime_type: file.type,
      bytes: file.size,
      source_file_id: result.file.file_id,
      course_id: result.file.course_id,
      upload_status: 'completed',
      library_save_requested: true,
      library_status: 'unverified',
      model_readability: 'unverified',
      handoff_status: 'pending',
      handoff_attempts: 0,
      model_context_linked: false,
      followup_sent: false,
    };
    el('file-id').textContent = `ファイルID: ${value.fileId}`;
    el('file-id').hidden = false;
    persistUploadedState();
    cachedFile = null;
    if (connected) await linkUploadedFile();
    else {
      status('アップロード完了。モデルコンテキストへの受け渡しを待っています…');
      el('verify').hidden = false;
    }
    // linkUploadedFile closes only when the host acknowledges the handoff.
  } catch (error) {
    const messages = {
      expired: '取得リンクの期限が切れました。リンクを更新してください。',
      too_large: '教材が取得上限を超えています。',
      empty: '教材の本文が空でした。',
      invalid_pdf: '取得したファイルはPDF原本ではありません。',
      download_failed: '教材を取得できませんでした。再試行してください。',
    };
    const phaseLabels = {
      download: '原本取得',
      upload: 'ChatGPTアップロード',
    };
    const safe = safeError(error);
    const detail = `${safe.error_name}: ${safe.error_code}`;
    const known = messages[error?.message];
    status(
      `失敗箇所: ${phaseLabels[phase] ?? phase}\n` +
        (known ? `${known}\n` : '') +
        `例外: ${detail}\n` +
        (phase === 'upload'
          ? '原本取得は成功しています。ChatGPT側のアップロード処理で失敗しました。'
          : '再試行するか、原本をダウンロードして会話に添付してください。'),
    );
    el('upload').hidden = false;
    el('refresh').hidden = error?.message !== 'expired';
  } finally {
    busy = false;
    el('upload').disabled = !!uploaded || !supported();
  }
}

async function maybeAutoUpload() {
  if (!connected || busy || uploaded || !result || !supported()) return;
  await startUpload();
}

el('upload').onclick = startUpload;
el('refresh').onclick = async () => {
  if (busy || !connected || !result) return;
  el('refresh').disabled = true;
  try {
    const next = await observe('refresh_link', async () => {
      const next = await app.callServerTool({
        name: 'open_file_in_chat',
        arguments: { course_id: result.file.course_id, file_id: result.file.file_id },
      });
      if (next.isError) throw new Error('refresh_failed');
      return next;
    });
    receive(next);
  } catch {
    status('リンクを更新できませんでした。教材をもう一度開いてください。');
  } finally {
    el('refresh').disabled = false;
  }
};
el('verify').onclick = async () => {
  if (!uploaded) return;
  el('verify').disabled = true;
  try {
    uploaded.model_context_linked = false;
    await linkUploadedFile();
  } finally {
    el('verify').disabled = false;
  }
};
app.ontoolresult = receive;
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
};
window.addEventListener('openai:set_globals', (event) => {
  const globals = event.detail?.globals;
  if (globals?.toolResponseMetadata)
    receive(
      globals.toolResponseMetadata.call_tool_result ?? globals.toolResponseMetadata.mcp_tool_result,
    );
});
const metadata = window.openai?.toolResponseMetadata;
receive(metadata?.call_tool_result ?? metadata?.mcp_tool_result);
observe('host_connect', () => app.connect())
  .then(() => {
    connected = true;
    if (uploaded) void linkUploadedFile();
    else void maybeAutoUpload();
  })
  .catch(() => {
    status('ChatGPTホストに接続できませんでした。診断ログを確認し、教材をもう一度開いてください。');
  });

el('copy-diagnostics').onclick = async () => {
  const report = JSON.stringify(diagnosticSnapshot(), null, 2);
  el('diagnostic-log').value = report;
  try {
    await navigator.clipboard.writeText(report);
    el('diagnostic-notice').textContent = '診断ログをコピーしました。';
  } catch {
    el('diagnostic-log').focus();
    el('diagnostic-log').select();
    el('diagnostic-notice').textContent =
      '自動コピーが許可されていません。選択された診断ログを手動でコピーしてください。';
  }
};
