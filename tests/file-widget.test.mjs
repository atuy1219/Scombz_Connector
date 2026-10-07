import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { FILE_WIDGET_HTML } from '../src/file-widget.mjs';

// Exercise the browser pipeline, mocking only host APIs and the MCP bridge.
// This is not evidence that ChatGPT attaches uploaded PDFs to model context.
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
        async updateModelContext(value) { globalThis.contexts.push(value); }
        async sendMessage(value) { globalThis.messages.push(value); return {}; }
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

async function screen({
  body = '%PDF-1.7 fixture',
  api = true,
  upload,
  globals = {},
  fetcher,
} = {}) {
  const elements = new Map(
    [...FILE_WIDGET_HTML.matchAll(/id="([^"]+)"/g)].map(([, id]) => [
      id,
      {
        hidden: /^(verify|refresh|download|file-id)$/.test(id),
        disabled: id === 'upload',
        textContent: '',
        checked: false,
      },
    ]),
  );
  const calls = { uploads: [], fetches: [], states: [] };
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
    console,
  });
  vm.runInContext(script, context);
  await Promise.resolve();
  await Promise.resolve();
  context.bridge.ontoolresult(response());
  return { elements, calls, context, listeners, openai };
}

test('whole 7.19 and 50 MiB PDFs upload outside MCP, stay unverified and require an explicit follow-up', async () => {
  for (const bytes of [7536336, 50 * 1048576]) {
    const body = new Uint8Array(bytes);
    body.set(new TextEncoder().encode('%PDF-1.7'));
    const s = await screen({ body });
    assert.deepEqual(Array.from(s.context.bridge.capabilities.availableDisplayModes), ['inline']);
    s.elements.get('library').checked = true;
    await s.elements.get('upload').onclick();
    assert.equal(s.calls.uploads.length, 1);
    assert.equal(s.calls.uploads[0].file.size, bytes);
    assert.equal(s.calls.uploads[0].file.name, '講義.pdf');
    assert.equal(s.calls.uploads[0].file.type, 'application/pdf');
    assert.equal(s.calls.uploads[0].options.library, true);
    assert.equal(s.calls.fetches[0].options.credentials, 'omit');
    assert.equal(s.calls.fetches[0].options.redirect, 'error');
    assert.equal(s.calls.states[0].modelContent.model_readability, 'unverified');
    assert.ok(!JSON.stringify(s.calls.states).includes('private-link'));
    assert.equal(s.context.messages.length, 0);
    await s.elements.get('upload').onclick();
    assert.equal(s.calls.uploads.length, 1, 'repeated click cannot create another upload');
    await s.elements.get('verify').onclick();
    assert.equal(s.context.messages.length, 1);
    assert.ok(s.context.messages[0].content[0].text.includes('2ページ目'));
    assert.ok(s.context.messages[0].content[0].text.includes('アクセスできなければ'));
  }
});

test('empty, HTML, over-limit and failed downloads never reach uploadFile', async () => {
  for (const fetcher of [
    () => new Response(''),
    () => new Response('<html>login</html>'),
    () => new Response('%PDF-', { headers: { 'content-length': String(100 * 1048576 + 1) } }),
    () => new Response('failed', { status: 422 }),
  ]) {
    const s = await screen({ fetcher });
    await s.elements.get('upload').onclick();
    assert.equal(s.calls.uploads.length, 0);
    assert.equal(s.elements.get('verify').hidden, true);
    assert.equal(s.elements.get('upload').disabled, false);
  }
});

test('expired link refreshes through its scoped tool and reuses material identity', async () => {
  const s = await screen();
  const expired = response();
  expired._meta.file_transfer.expires_at = '2000-01-01T00:00:00Z';
  s.context.bridge.ontoolresult(expired);
  await s.elements.get('upload').onclick();
  assert.equal(s.calls.fetches.length, 0);
  assert.equal(s.calls.uploads.length, 0);
  assert.equal(s.elements.get('refresh').hidden, false);
  s.context.refreshResult = response();
  await s.elements.get('refresh').onclick();
  assert.equal(s.context.toolCalls[0].name, 'open_file_in_chat');
  assert.equal(s.context.toolCalls[0].arguments.file_id, 'material:m:r');
  await s.elements.get('upload').onclick();
  assert.equal(s.calls.uploads.length, 1);
});

test('upload rejection retries cached bytes; missing API and restored uploads do not fetch', async () => {
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
  await s.elements.get('upload').onclick();
  assert.equal(s.calls.states.length, 0);
  assert.equal(s.elements.get('verify').hidden, true);
  await s.elements.get('upload').onclick();
  assert.equal(s.calls.fetches.length, 1);
  assert.equal(s.calls.uploads.length, 2);
  const restored = await screen({ globals: { widgetState: s.calls.states[0] } });
  await restored.elements.get('upload').onclick();
  assert.equal(restored.calls.fetches.length, 0);
  assert.equal(restored.elements.get('verify').hidden, false);
  const missing = await screen({ api: false });
  await missing.elements.get('upload').onclick();
  assert.equal(missing.calls.fetches.length, 0);
  assert.equal(missing.elements.get('download').hidden, false);
  assert.ok(missing.elements.get('status').textContent.includes('会話に添付'));
});
