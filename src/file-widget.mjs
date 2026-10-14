import browserScript from '../dist/file-widget-script.mjs';

export const FILE_WIDGET_URI = 'ui://scombz/file-upload-v1.html';
export const FILE_WIDGET_MIME = 'text/html;profile=mcp-app';
export const FILE_WIDGET_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;padding:20px;color:var(--color-text-primary,inherit);background:var(--color-background-primary,transparent)}
h1{font-size:17px;overflow-wrap:anywhere;margin:0 0 8px}p{font-size:14px;line-height:1.6}button,a{font:inherit}button{padding:10px 16px;border-radius:10px;border:1px solid #888;background:transparent;color:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:10px;flex-wrap:wrap}a{color:inherit}#status{min-height:24px;white-space:pre-wrap;overflow-wrap:anywhere}#file-id{overflow-wrap:anywhere;font-size:12px} [hidden]{display:none!important}
</style></head><body><h1 id="filename">教材を準備しています</h1>
<p id="status" role="status" aria-live="polite">接続中…</p>
<div class="actions"><button id="upload" hidden disabled>アップロードを再試行</button>
<button id="verify" hidden>PDFの受け渡しを再試行</button>
<button id="refresh" hidden>取得リンクを更新</button>
<a id="download" hidden rel="noreferrer noopener">原本をダウンロード</a></div>
<p id="note">教材は自動取得・アップロードされ、モデルコンテキストへ受け渡されます。失敗時だけ再試行操作を表示します。</p>
<p id="file-id" hidden></p>
<details id="diagnostics"><summary>診断情報</summary>
<p>各段階の結果を確認できます。送信成功後のPDF本文読取・保存完了・回答再開は、この画面からは確認できません。</p>
<label><input type="checkbox" id="keep-open"> デバッグ用に成功後もこの画面を残す</label>
<p id="diagnostic-notice" role="status"></p>
<button id="copy-diagnostics">診断ログをコピー</button>
<textarea id="diagnostic-log" readonly aria-label="診断ログ" rows="12" style="display:block;width:100%;box-sizing:border-box;margin-top:12px"></textarea>
</details><script>${browserScript.replaceAll('</script', '<\\/script')}</script></body></html>`;
