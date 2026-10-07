import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { FILE_WIDGET_HTML } from '../src/file-widget.mjs';

// Exercise the browser pipeline, mocking only host APIs and the MCP bridge.
// Actual ChatGPT PDF ingestion remains an explicit manual acceptance test.
const compiled = await build({
  entryPoints: ['src/file-widget-client.mjs'],
  bundle: true,
  write: false,
  format: 'iife',
  plugins: [
    {
      name: 'host-fixture',
      setup(b) {
        b.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({
          path: 'host',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          loader: 'js',
          contents: `
      export class App {
        constructor(info, capabilities) { globalThis.bridge = this; this.capabilities = capabilities; }
        async connect() {}
        async updateModelContext(value) {
          if (globalThis.rejectModelContext) throw new Error('context rejected');
          globalThis.contexts.push(value);
        }
        async sendMessage(value) {
          if (globalThis.rejectResourceMessages && value.content.some(x => x.type === 'resource_link'))
            return { isError: true };
          globalThis.messages.push(value); return {};
        }
        async callServerTool(value) { globalThis.toolCalls.push(value); return globalThis.refreshResult; }
      }`,
        }));
      },
    },
  ],
});
const script = compiled.outputFiles[0].text;
const response = () => ({
  structuredContent: {
    file: { filename: '講義.pdf', course_id: 'c', file_id: 'material:m:r' },
    mime_type: 'application/pdf',
  },
  _meta: {
    file_transfer: {
      origin: 'https://fixture.workers.dev',
      download_url:
        'https://fixture.workers.dev/files/c?file_id=material%3Am%3Ar&ticket=private-link',
      expires_at: new Date(Date.now() + 600000).toISOString(),
      max_bytes: 100 * 1048576,
    },
  },
});

async function settle(predicate, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function screen({
  body = '%PDF-1.7 fixture',
  api = true,
  upload,
  globals = {},
  fetcher,
  toolResult = response(),
  rejectResourceMessages = false,
  rejectModelContext = false,
} = {}) {
  const elements = new Map(
    [...FILE_WIDGET_HTML.matchAll(/id="([^"]+)"/g)].map(([, id]) => [
      id,
      {
        hidden: /^(upload|verify|refresh|download|file-id)$/.test(id),
        disabled: id === 'upload',
        textContent: '',
        checked: false,
      },
    ]),
  );
  const calls = { uploads: [], fetches: [], states: [], downloadUrls: [], closes: 0 };
  const listeners = new Map();
  const openai = {
    ...globals,
    setWidgetState(value) {
      calls.states.push(value);
      this.widgetState = value;
    },
    ...(api
      ? {
          async uploadFile(file, options) {
            calls.uploads.push({ file, options });
            return upload ? upload(file, options) : { fileId: 'file-host-123' };
          },
          async getFileDownloadUrl({ fileId }) {
            calls.downloadUrls.push(fileId);
            return { downloadUrl: `https://files.oaiusercontent.test/${fileId}` };
          },
          async requestClose() {
            calls.closes += 1;
          },
        }
      : {}),
  };
  const context = vm.createContext({
    URL,
    Blob,
    File,
    Response,
    AbortSignal,
    document: { getElementById: (id) => elements.get(id), documentElement: { style: {} } },
    window: {
      openai,
      addEventListener(name, listener) {
        listeners.set(name, listener);
      },
    },
    fetch: async (url, options) => {
      calls.fetches.push({ url, options });
      return fetcher ? fetcher(url, options) : new Response(body);
    },
    contexts: [],
    messages: [],
    toolCalls: [],
    rejectResourceMessages,
    rejectModelContext,
    console,
  });
  vm.runInContext(script, context);
  await Promise.resolve();
  await Promise.resolve();
  context.bridge.ontoolresult(toolResult);
  await settle(() => calls.uploads.length > 0 || !api || elements.get('upload').hidden === false);
  await settle(
    () =>
      context.messages.length > 0 ||
      calls.uploads.length === 0 ||
      elements.get('verify').hidden === false,
  );
  return { elements, calls, context, listeners, openai };
}

test('whole 7.19 and 50 MiB PDFs auto-upload and are linked into model context', async () => {
  for (const bytes of [7536336, 50 * 1048576]) {
    const body = new Uint8Array(bytes);
    body.set(new TextEncoder().encode('%PDF-1.7'));
    const s = await screen({ body });
    assert.deepEqual(Array.from(s.context.bridge.capabilities.availableDisplayModes), ['inline']);
    assert.equal(s.calls.uploads.length, 1);
    assert.equal(s.calls.uploads[0].file.size, bytes);
    assert.equal(s.calls.uploads[0].file.name, '講義.pdf');
    assert.equal(s.calls.uploads[0].file.type, 'application/pdf');
    assert.equal(s.calls.uploads[0].options.library, true);
    assert.equal(s.calls.fetches[0].options.credentials, 'omit');
    assert.equal(s.calls.fetches[0].options.redirect, 'error');
    assert.equal(s.calls.downloadUrls[0], 'file-host-123');
    assert.equal(s.context.contexts.length, 0);
    assert.equal(s.context.messages.length, 1);
    assert.ok(s.context.messages[0].content[0].text.includes('元の依頼を続行'));
    assert.ok(!s.context.messages[0].content[0].text.includes('2ページ目'));
    assert.ok(s.context.messages[0].content[0].text.includes('file-host-123') === false);
    assert.ok(s.context.messages[0].content[0].text.includes('source_file_ref') === false);
    const link = s.context.messages[0].content.find((x) => x.type === 'resource_link');
    assert.equal(link.name, '講義.pdf');
    assert.equal(link.mimeType, 'application/pdf');
    assert.equal(link.uri, 'https://files.oaiusercontent.test/file-host-123');
    assert.equal(s.calls.states.at(-1).modelContent.library_saved, true);
    assert.equal(s.calls.states.at(-1).modelContent.model_readability, 'verification_requested');
    assert.equal(s.calls.states.at(-1).modelContent.model_context_linked, true);
    assert.equal(s.calls.states.at(-1).modelContent.delivery_mode, 'ui_message_resource_link');
    assert.equal(s.calls.states.at(-1).modelContent.library_handoff, 'resource_link');
    assert.ok(!JSON.stringify(s.calls.states).includes('private-link'));
    assert.ok(!JSON.stringify(s.calls.states).includes('files.oaiusercontent.test'));
    assert.equal(s.elements.get('upload').hidden, true);
    assert.equal(s.calls.closes, 1);
  }
});

test('deferred metadata comes from download headers and still validates PDF bytes', async () => {
  const deferred = response();
  deferred.structuredContent.file.filename = null;
  deferred.structuredContent.mime_type = null;
  const headers = {
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent("講義 資料'2.pdf")}`,
    'content-type': 'application/octet-stream',
  };
  const s = await screen({
    toolResult: deferred,
    fetcher: () => new Response('%PDF-1.7 fixture', { headers }),
  });
  assert.equal(s.calls.uploads[0].file.name, "講義 資料'2.pdf");
  assert.equal(s.calls.uploads[0].file.type, 'application/pdf');
  assert.equal(s.context.messages[0].content[1].name, "講義 資料'2.pdf");
  for (const fetcher of [
    () => new Response('<html>login</html>', { headers }),
    () => new Response('%PDF-1.7 fixture'),
  ]) {
    const failed = await screen({ toolResult: deferred, fetcher });
    assert.equal(failed.calls.uploads.length, 0);
  }
});

test('resource link rejection uses model context without verbose follow-up', async () => {
  const s = await screen({ rejectResourceMessages: true });
  assert.equal(s.context.contexts[0].content[1].type, 'resource_link');
  assert.equal(s.context.messages.length, 1);
  assert.ok(!s.context.messages[0].content[0].text.includes('file-host-123'));
  assert.equal(s.calls.states.at(-1).modelContent.delivery_mode, 'update_model_context_fallback');
});

test('fileId instructions are sent only after both resource link paths fail', async () => {
  const s = await screen({ rejectResourceMessages: true, rejectModelContext: true });
  await settle(() => s.calls.states.at(-1)?.modelContent.file_id_fallback_sent);
  assert.equal(s.context.messages.length, 1);
  assert.ok(s.context.messages[0].content[0].text.includes('file-host-123'));
  assert.ok(s.context.messages[0].content[0].text.includes('source_file_ref.file_id'));
  assert.ok(!s.context.messages[0].content[0].text.includes('2ページ目'));
  assert.equal(s.calls.states.at(-1).modelContent.model_context_linked, false);
  assert.equal(s.calls.uploads.length, 1);
});

test('empty, HTML, over-limit and failed downloads never reach uploadFile and expose retry', async () => {
  for (const fetcher of [
    () => new Response(''),
    () => new Response('<html>login</html>'),
    () => new Response('%PDF-', { headers: { 'content-length': String(100 * 1048576 + 1) } }),
    () => new Response('failed', { status: 422 }),
  ]) {
    const s = await screen({ fetcher });
    assert.equal(s.calls.uploads.length, 0);
    assert.equal(s.elements.get('verify').hidden, true);
    assert.equal(s.elements.get('upload').hidden, false);
    assert.equal(s.elements.get('upload').disabled, false);
    assert.equal(s.calls.closes, 0);
  }
});

test('expired link refreshes through its scoped tool and auto-retries', async () => {
  const expired = response();
  expired._meta.file_transfer.expires_at = '2000-01-01T00:00:00Z';
  const s = await screen({ toolResult: expired });
  assert.equal(s.calls.fetches.length, 0);
  assert.equal(s.calls.uploads.length, 0);
  assert.equal(s.elements.get('refresh').hidden, false);
  s.context.refreshResult = response();
  await s.elements.get('refresh').onclick();
  await settle(() => s.calls.uploads.length === 1);
  assert.equal(s.context.toolCalls[0].name, 'open_file_in_chat');
  assert.equal(s.context.toolCalls[0].arguments.file_id, 'material:m:r');
  assert.equal(s.calls.uploads.length, 1);
});

test('upload rejection exposes manual retry; restored uploads do not refetch original', async () => {
  let rejected = true;
  const s = await screen({
    upload: async () => {
      if (rejected) {
        rejected = false;
        throw new Error('host rejected');
      }
      return { fileId: 'file-host-123' };
    },
  });
  assert.equal(s.calls.states.length, 0);
  assert.equal(s.elements.get('verify').hidden, true);
  assert.equal(s.elements.get('upload').hidden, false);
  assert.ok(s.elements.get('status').textContent.includes('失敗箇所: ChatGPTアップロード'));
  assert.ok(s.elements.get('status').textContent.includes('例外: Error: host rejected'));
  await s.elements.get('upload').onclick();
  await settle(() => s.context.messages.length === 1);
  assert.equal(s.calls.fetches.length, 1);
  assert.equal(s.calls.uploads.length, 2);

  const restoredState = s.calls.states.at(-1);
  const restored = await screen({ globals: { widgetState: restoredState } });
  assert.equal(restored.calls.fetches.length, 0);
  assert.equal(restored.calls.uploads.length, 0);

  const missing = await screen({ api: false });
  assert.equal(missing.calls.fetches.length, 0);
  assert.equal(missing.elements.get('download').hidden, false);
  assert.ok(missing.elements.get('status').textContent.includes('会話に添付'));
});
