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
const canResolveUploadedFile = () =>
  typeof window.openai?.getFileDownloadUrl === 'function';

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
  el('upload').hidden = true;
  el('verify').hidden = !uploaded;
  if (!uploaded) {
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

async function linkUploadedFile() {
  if (!uploaded || !connected || uploaded.model_context_linked) return;
  if (!canResolveUploadedFile()) {
    el('verify').hidden = false;
    status(
      'アップロード完了。ただし、このホストではPDFをモデルへ渡すための一時URLを取得できません。',
    );
    return;
  }

  let downloadUrl;
  try {
    const resolved = await window.openai.getFileDownloadUrl({ fileId: uploaded.file_id });
    downloadUrl = resolved?.downloadUrl;
    const parsed = new URL(downloadUrl);
    if (parsed.protocol !== 'https:') throw new Error('invalid_download_url');
  } catch {
    el('verify').hidden = false;
    status('アップロード完了。ただし、PDFのモデル向け参照URLを取得できませんでした。');
    return;
  }

  const resourceLink = {
    type: 'resource_link',
    uri: downloadUrl,
    name: uploaded.filename,
    mimeType: uploaded.mime_type,
  };
  const verificationText =
    `教材「${uploaded.filename}」のPDF原本をChatGPTへアップロードしました。` +
    `アップロード済みfileIdは ${uploaded.file_id} です。` +
    'このfileIdのファイルが会話添付として直接読めない場合は、ChatGPTのFiles機能で' +
    'このアップロード済みファイルをファイルライブラリへ保存してから本文を読んでください。' +
    '保存時は可能ならsource_file_ref.file_idにこのfileIdを使い、/ScombZ/配下へ保存してください。' +
    'resource_linkやファイル名だけで読めたとは扱わず、まず2ページ目の内容をページ番号付きで確認してください。';

  try {
    // Prefer attaching the uploaded PDF directly to the follow-up turn. In ChatGPT,
    // ui/message resource links are model-visible file attachments on supported hosts.
    const sent = await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: verificationText }, resourceLink],
    });
    if (sent?.isError) throw new Error('message_resource_link_rejected');
    uploaded.model_context_linked = true;
    uploaded.followup_sent = true;
    uploaded.delivery_mode = 'ui_message_resource_link';
    uploaded.library_handoff = 'model_file_id';
  } catch {
    try {
      // Fallback for hosts that accept resource links in model context but not ui/message.
      await app.updateModelContext({
        content: [
          {
            type: 'text',
            text:
              `ScombZ教材「${uploaded.filename}」をChatGPTへアップロード済みです。PDF原本の本文を実際に読んで利用してください。`,
          },
          resourceLink,
        ],
      });
      const sent = await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: verificationText }],
      });
      if (sent?.isError) throw new Error('message_rejected');
      uploaded.model_context_linked = true;
      uploaded.followup_sent = true;
      uploaded.delivery_mode = 'update_model_context_fallback';
      uploaded.library_handoff = 'model_file_id';
    } catch {
      uploaded.model_context_linked = false;
      uploaded.followup_sent = false;
      uploaded.delivery_mode = 'failed';
      el('verify').hidden = false;
      status(
        'アップロード完了。ただし、PDFをモデルへ渡せませんでした。確認ボタンで再試行できます。',
      );
      return;
    }
  }

  uploaded.model_readability = 'verification_requested';
  try {
    window.openai?.setWidgetState?.({ modelContent: uploaded, privateContent: {} });
  } catch {}
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
    const file = await downloadFile();
    phase = 'upload';
    status(
      `原本取得成功: ${(file.size / 1048576).toFixed(2)} MiB\nChatGPTへ自動アップロードし、ファイルライブラリへ保存中…`,
    );
    const value = await window.openai.uploadFile(file, { library: true });
    if (typeof value?.fileId !== 'string' || !value.fileId) throw new Error('upload_failed');
    uploaded = {
      file_id: value.fileId,
      filename: file.name,
      mime_type: file.type,
      bytes: file.size,
      source_file_id: result.file.file_id,
      course_id: result.file.course_id,
      upload_status: 'completed',
      library_saved: true,
      model_readability: 'unverified',
      model_context_linked: false,
      followup_sent: false,
    };
    el('file-id').textContent = `ファイルID: ${value.fileId}`;
    el('file-id').hidden = false;
    try {
      window.openai?.setWidgetState?.({ modelContent: uploaded, privateContent: {} });
    } catch {}
    cachedFile = null;
    if (connected) await linkUploadedFile();
    else {
      status('アップロード完了。モデルコンテキストへの受け渡しを待っています…');
      el('verify').hidden = false;
    }
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
    const rawDetail =
      error instanceof Error
        ? `${error.name}: ${error.message || '(messageなし)'}`
        : String(error);
    const detail = rawDetail
      .replace(/https?:\/\/\S+/g, '[URL]')
      .replace(/ticket=[^\\s&]+/gi, 'ticket=[REDACTED]')
      .slice(0, 500);
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
app
  .connect()
  .then(() => {
    connected = true;
    if (uploaded) void linkUploadedFile();
    else void maybeAutoUpload();
  })
  .catch(() => {
    if (!result) status('教材情報を受け取れませんでした。教材をもう一度開いてください。');
  });
