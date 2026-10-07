import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { FILE_WIDGET_HTML } from '../src/file-widget.mjs';

// Real Chromium + real MCP Apps SDK; ChatGPT file/follow-up APIs are fixtures.
// Actual ChatGPT Files/Library ingestion remains an explicit acceptance test.
test('inline widget auto-uploads a PDF and hands its file ID to a ChatGPT follow-up', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const bytes = Buffer.alloc(7536336);
    bytes.write('%PDF-1.7');
    const result = {
      structuredContent: {
        file: { course_id: 'c', file_id: 'material:m:r', filename: '講義.pdf' },
        mime_type: 'application/pdf',
      },
      _meta: {
        file_transfer: {
          origin: 'https://fixture.workers.dev',
          download_url:
            'https://fixture.workers.dev/files/c?file_id=material%3Am%3Ar&ticket=fixture',
          expires_at: new Date(Date.now() + 600000).toISOString(),
          max_bytes: 100 * 1048576,
        },
      },
    };

    await page.addInitScript(() => {
      if (location.pathname !== '/widget') return;
      window.uploads = [];
      window.savedStates = [];
      window.followups = [];
      window.openai = {
        async uploadFile(file, options) {
          window.uploads.push({
            bytes: file.size,
            name: file.name,
            mime: file.type,
            signature: await file.slice(0, 5).text(),
            library: options.library,
          });
          return { fileId: 'sediment://file-browser-fixture' };
        },
        async sendFollowUpMessage(value) {
          window.followups.push(value);
        },
        setWidgetState(state) {
          window.savedStates.push(state);
        },
      };
    });

    const host = `<!doctype html><meta charset="utf-8"><iframe src="/widget" style="width:460px;height:440px;border:0"></iframe>
      <script>
      window.initializations=[];
      addEventListener('message', e => {
        const m=e.data; if(m?.jsonrpc!=='2.0')return;
        const reply=result=>e.source.postMessage({jsonrpc:'2.0',id:m.id,result},e.origin);
        if(m.method==='ui/initialize') {
          window.initializations.push(m.params);
          reply({protocolVersion:m.params.protocolVersion,hostInfo:{name:'browser-fixture',version:'1'},
            hostCapabilities:{serverTools:{}},
            hostContext:{displayMode:'inline',availableDisplayModes:['inline'],theme:'light'}});
        } else if(m.method==='ui/notifications/initialized') {
          e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:${JSON.stringify(result)}},e.origin);
        }
      });</script>`;

    await page.route('https://host.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: new URL(route.request().url()).pathname === '/widget' ? FILE_WIDGET_HTML : host,
      }),
    );
    await page.route('https://fixture.workers.dev/files/**', (route) =>
      route.fulfill({
        contentType: 'application/pdf',
        body: bytes,
        headers: { 'Access-Control-Allow-Origin': '*' },
      }),
    );

    await page.goto('https://host.test/');
    const frame = page.frameLocator('iframe');
    await page.waitForFunction(() => {
      const iframe = document.querySelector('iframe');
      return !!iframe?.contentWindow?.uploads?.length;
    });
    await page.waitForFunction(() => {
      const iframe = document.querySelector('iframe');
      return !!iframe?.contentWindow?.followups?.length;
    });

    const ui = page.frames().find((f) => f.url().endsWith('/widget'));
    const uploads = await ui.evaluate(() => window.uploads);
    assert.deepEqual(uploads, [
      {
        bytes: 7536336,
        name: '講義.pdf',
        mime: 'application/pdf',
        signature: '%PDF-',
        library: true,
      },
    ]);

    const followup = await ui.evaluate(() => window.followups[0]);
    assert.ok(followup.prompt.includes('file-browser-fixture'));
    assert.ok(followup.prompt.includes('source_file_ref.file_id'));
    assert.ok(followup.prompt.includes('/ScombZ/講義.pdf'));
    assert.ok(followup.prompt.includes('2ページ目'));

    assert.equal(await frame.locator('#filename').textContent(), '講義.pdf');
    assert.ok((await frame.locator('#status').textContent()).includes('ライブラリ保存'));

    assert.deepEqual(
      await page.evaluate(() => window.initializations[0].appCapabilities.availableDisplayModes),
      ['inline'],
    );

    const state = await ui.evaluate(() => window.savedStates.at(-1));
    assert.equal(state.modelContent.file_id, 'sediment://file-browser-fixture');
    assert.equal(state.modelContent.files_source_file_id, 'file-browser-fixture');
    assert.equal(state.modelContent.library_saved, true);
    assert.equal(state.modelContent.handoff_ready, true);
    assert.equal(state.modelContent.followup_sent, true);
    assert.equal(state.modelContent.model_readability, 'verification_requested');
    assert.equal(state.modelContent.delivery_mode, 'chatgpt_follow_up_file_id');
    assert.equal(state.modelContent.library_handoff, 'model_file_id');
    assert.ok(!JSON.stringify(state).includes('ticket='));
    assert.equal(await frame.locator('#upload').isHidden(), true);
  } finally {
    await browser.close();
  }
});
