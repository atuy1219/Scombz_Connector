import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfRelayUrl, servePdfRelay } from '../src/pdf-relay.mjs';
import { ScombClient } from '../src/client.mjs';
import { sign } from '../src/crypto.mjs';

const env = { SESSION_ENCRYPTION_KEY: 'a'.repeat(64) };
const origin = 'https://fixture.workers.dev';
const courseId = '202601SU0421982001';
const fileId = 'material:20243306:20230072';
const record = {
  file_id: fileId,
  kind: 'material',
  filename: 'プレゼミ研究紹介_杉本.pdf',
  object_name: '2026/1c/21/e7/1c21e71b-ac23-4fe0-b872-bb8e69e1dd0b',
  content_id: '20243306',
  resource_id: '20230072',
  end_date: '2099-03-31 00:00:00.0',
};
function fixture() {
  const underlying = new ScombClient({});
  underlying.materialRecord = async () => record;
  const requests = [];
  const client = {
    materialDownloadPlan: (...args) => underlying.materialDownloadPlan(...args),
    request: async (url, binary) => {
      const u = new URL(url);
      requests.push({ url: u, binary });
      assert.equal(u.origin, 'https://scombz.shibaura-it.ac.jp');
      assert.equal(binary, true);
      if (u.pathname === '/lms/course/make/tempfile')
        return new Response('a'.repeat(21), { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
      if (u.pathname === '/lms/course/material/setfiledown/download.pdf')
        return new Response('%PDF-1.7 sample', { headers: { 'Content-Type': 'application/pdf' } });
      throw new Error('unexpected upstream path ' + u.pathname);
    },
  };
  return { client, requests };
}

test('signed Worker relay returns PDF bytes without redirecting or leaking upstream SESSION', async () => {
  const { client, requests } = fixture();
  const signed = await createPdfRelayUrl(client, env, origin, courseId, fileId);
  assert.equal(signed.protocol, 'scombz-pdf-relay-v1');
  assert.ok(signed.url.startsWith(origin + '/file/pdf/'));
  assert.equal(signed.redirects, false);
  assert.equal(requests.length, 0);
  const response = await servePdfRelay(new Request(signed.url), env, { client });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), '%PDF-1.7 sample');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.searchParams.get('fileId'), 'a'.repeat(21));
  assert.equal(requests[1].url.searchParams.get('fileName'), record.filename);
});

test('relay rejects invalid, expired, and excessively long signatures without making ScombZ calls', async () => {
  const { client, requests } = fixture();
  const valid = await createPdfRelayUrl(client, env, origin, courseId, fileId);
  for (const url of [
    valid.url.slice(0, -3) + 'BAD',
    origin + '/file/pdf/' + 'x'.repeat(9000),
    origin + '/file/pdf/' + (await sign(env, {
      kind: 'scombz-pdf-relay-v1', course_id: courseId, file_id: fileId,
      exp: Math.floor(Date.now() / 1000) - 1,
    })),
  ]) {
    const response = await servePdfRelay(new Request(url), env, { client });
    assert.equal(response.status, 403);
  }
  assert.equal(requests.length, 0);
});

test('relay is limited to material PDF and never accepts an arbitrary upstream URL', async () => {
  const { client } = fixture();
  for (const file_id of ['assignment:20243306:20230072', 'not-an-id'])
    await assert.rejects(createPdfRelayUrl(client, env, origin, courseId, file_id), {
      code: 'invalid_request',
    });
  const underlying = new ScombClient({});
  underlying.materialRecord = async () => ({ ...record, filename: 'lecture.docx' });
  await assert.rejects(
    createPdfRelayUrl(
      { materialDownloadPlan: (...args) => underlying.materialDownloadPlan(...args) },
      env, origin, courseId, fileId,
    ),
    { code: 'unsupported_file_type' },
  );
});

test('relay rejects bad PDF signature, content type and oversized Content-Length', async () => {
  const x = fixture();
  const signed = await createPdfRelayUrl(x.client, env, origin, courseId, fileId);
  for (const response of [
    new Response('not a pdf', { headers: { 'Content-Type': 'application/pdf' } }),
    new Response('%PDF-1.7 sample', { headers: { 'Content-Type': 'text/html' } }),
    new Response('%PDF-1.7 sample', {
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(24 * 1024 * 1024 + 1) },
    }),
  ]) {
    const client = { ...x.client, request: async (url) =>
      url.includes('/make/tempfile')
        ? new Response('a'.repeat(21), { headers: { 'Content-Type': 'text/plain' } })
        : response };
    await assert.rejects(servePdfRelay(new Request(signed.url), env, { client }));
  }
});
