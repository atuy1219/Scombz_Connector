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
  cachedFile;
const status = (text) => {
  el('status').textContent = text;
};
const supported = () => typeof window.openai?.uploadFile === 'function';

function receive(value) {
  if (!value?.structuredContent?.file || !value?._meta?.file_transfer) return;
  if (busy) return;
  const next = value.structuredContent;
  const nextTransfer = value._meta.file_transfer;
  let url;
  try {
    url = new URL(nextTransfer.download_url);
  } catch {
    el('upload').disabled = true;
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
    status('教材の取得リンクを確認できません。');
    return;
  }
  if (next.file.file_id !== result?.file?.file_id) {
    uploaded = null;
    cachedFile = null;
  }
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
  el('filename').textContent = result.file.filename;
  el('download').href = url.href;
  el('download').hidden = false;
  el('refresh').hidden = true;
  el('upload').disabled = busy || !!uploaded || !supported();
  el('verify').hidden = !uploaded;
  el('library').disabled = !!uploaded || busy || !supported();
  if (!uploaded)
    status(
      supported()
        ? '教材をChatGPTへアップロードできます。'
        : 'この画面ではアップロード機能を利用できません。原本をダウンロードし、会話に添付してください。',
    );
  else status('アップロード完了。PDF本文を読めるかは未確認です。');
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
  if (response.status === 401) throw new Error('expired');
  if (!response.ok) throw new Error(response.status === 413 ? 'too_large' : 'download_failed');
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
  const blob = new Blob(chunks, { type: result.mime_type });
  if (result.mime_type === 'application/pdf' && (await blob.slice(0, 5).text()) !== '%PDF-')
    throw new Error('invalid_pdf');
  cachedFile = new File([blob], result.file.filename, { type: result.mime_type });
  return cachedFile;
}

el('upload').onclick = async () => {
  if (busy || uploaded || !result || !supported()) return;
  busy = true;
  el('upload').disabled = true;
  el('library').disabled = true;
  try {
    const file = await downloadFile();
    status('ChatGPTへアップロード中…');
    const value = await window.openai.uploadFile(file, { library: el('library').checked });
    if (typeof value?.fileId !== 'string' || !value.fileId) throw new Error('upload_failed');
    uploaded = {
      file_id: value.fileId,
      filename: file.name,
      bytes: file.size,
      source_file_id: result.file.file_id,
      course_id: result.file.course_id,
      upload_status: 'completed',
      model_readability: 'unverified',
    };
    status('アップロード完了。PDF本文を読めるかは未確認です。');
    el('verify').hidden = false;
    el('file-id').textContent = `ファイルID: ${value.fileId}`;
    el('file-id').hidden = false;
    // A file ID in text is not an attachment. Do not mislabel a PDF as an imageId.
    try {
      window.openai?.setWidgetState?.({ modelContent: uploaded, privateContent: {} });
    } catch {}
    if (connected) await app.updateModelContext({ structuredContent: uploaded }).catch(() => {});
    cachedFile = null;
  } catch (error) {
    const messages = {
      expired: '取得リンクの期限が切れました。リンクを更新してください。',
      too_large: '教材が取得上限を超えています。',
      empty: '教材の本文が空でした。',
      invalid_pdf: '取得したファイルはPDF原本ではありません。',
      download_failed: '教材を取得できませんでした。再試行してください。',
    };
    status(
      messages[error.message] ??
        'アップロードを完了できませんでした。再試行するか、原本を会話に添付してください。',
    );
    el('refresh').hidden = error.message !== 'expired';
  } finally {
    busy = false;
    el('upload').disabled = !!uploaded || !supported();
    el('library').disabled = !!uploaded || !supported();
  }
};
el('refresh').onclick = async () => {
  if (busy || !connected || !result) return;
  el('refresh').disabled = true;
  try {
    const next = await app.callServerTool({
      name: 'open_file_in_chat',
      arguments: { course_id: result.file.course_id, file_id: result.file.file_id },
    });
    if (next.isError) throw new Error('refresh_failed');
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
  const prompt =
    `教材「${uploaded.filename}」をアップロードしました（fileId: ${uploaded.file_id}）。` +
    'PDF原本にアクセスできる場合は、2ページ目の内容をページ番号付きで説明してください。' +
    'ファイルIDや名前だけでは本文を確認したことになりません。アクセスできなければ、その旨を明示してください。';
  try {
    if (connected) {
      const sent = await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      });
      if (sent?.isError) throw new Error('rejected');
    } else if (window.openai?.sendFollowUpMessage)
      await window.openai.sendFollowUpMessage({ prompt });
    else throw new Error('unsupported');
  } catch {
    status('確認メッセージを送れませんでした。会話でPDFの読み取りを依頼してください。');
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
app
  .connect()
  .then(() => {
    connected = true;
  })
  .catch(() => {
    if (!result) status('教材情報を受け取れませんでした。教材をもう一度開いてください。');
  });
