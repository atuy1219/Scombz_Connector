import test from 'node:test';
import assert from 'node:assert/strict';
import { ScombClient } from '../src/client.mjs';
import { prepareOtkeyFileUrl } from '../src/otkey-download.mjs';

const material = {
  filename: 'プレゼミ研究紹介_杉本.pdf',
  object_name: '2026/1c/21/e7/id',
  resource_id: '20230072',
  content_id: '20243306',
  end_date: '2099-03-31 00:00:00.0',
  kind: 'material',
  file_id: 'material:20243306:20230072',
};

async function fixture(options = {}) {
  const stub = new ScombClient({});
  stub.materialRecord = async () => ({ ...material, ...options.material });
  const plan = await stub.materialDownloadPlan('202601SU0421982001', material.file_id);
  let requestCount = 0;
  let otkeyCount = 0;
  return {
    counts: () => ({ requestCount, otkeyCount }),
    client: {
      materialDownloadPlan: async () => plan,
      request: async (url, binary) => {
        requestCount++;
        assert.equal(binary, true);
        assert.equal(new URL(url).pathname, '/lms/course/make/tempfile');
        return (
          options.response ??
          new Response('a'.repeat(21), { headers: { 'content-type': 'text/plain;charset=UTF-8' } })
        );
      },
      mobile: {
        getOtkey: async () => {
          otkeyCount++;
          return 'otkey-test:+/';
        },
      },
    },
  };
}

test('fresh OTKEY URL uses a verified ASCII download path and preserves the original query', async () => {
  const x = await fixture();
  const result = await prepareOtkeyFileUrl(
    x.client,
    '202601SU0421982001',
    material.file_id,
  );
  const u = new URL(result.url);
  assert.equal(u.hostname, 'mobile.scombz.shibaura-it.ac.jp');
  assert.equal(
    u.pathname,
    '/otkey-test%3A%2B%2F/lms/course/material/setfiledown/download.pdf',
  );
  assert.equal(u.searchParams.get('fileId'), 'a'.repeat(21));
  assert.equal(u.searchParams.get('fileName'), material.filename);
  assert.equal(u.searchParams.get('resourceId'), material.resource_id);
  assert.equal(u.searchParams.get('contentId'), material.content_id);
  assert.equal(u.searchParams.get('idnumber'), '202601SU0421982001');
  assert.equal(result.protocol, 'scombz-otkey-file-url-v1');
  assert.equal(result.mime_type, 'application/pdf');
  assert.deepEqual(x.counts(), { requestCount: 1, otkeyCount: 1 });
});

test('do not request an OTKEY when the temporary ID is malformed or response is HTML', async () => {
  for (const response of [
    new Response('<html>login</html>', { headers: { 'content-type': 'text/plain' } }),
    new Response('a'.repeat(2049), { headers: { 'content-type': 'text/plain' } }),
    new Response('a'.repeat(21), { headers: { 'content-type': 'text/html' } }),
  ]) {
    const x = await fixture({ response });
    await assert.rejects(
      prepareOtkeyFileUrl(x.client, '202601SU0421982001', material.file_id),
      { code: 'parse_error' },
    );
    assert.equal(x.counts().otkeyCount, 0);
  }
});

test('OTKEY route rejects unverified attachment and non-PDF file types', async () => {
  for (const materialOverride of [
    { filename: 'file.docx' },
    { kind: 'assignment_attachment', assignment_id: 'a', download_mode: '1' },
  ]) {
    const x = await fixture({ material: materialOverride });
    await assert.rejects(
      prepareOtkeyFileUrl(x.client, '202601SU0421982001', material.file_id),
      { code: 'unsupported_file_type' },
    );
    assert.deepEqual(x.counts(), { requestCount: 0, otkeyCount: 0 });
  }
});
