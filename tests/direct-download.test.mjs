import test from 'node:test';
import assert from 'node:assert/strict';
import { ScombClient, resolveMaterialDownloadUrl, validateReadUrl } from '../src/client.mjs';
const material = {
  filename: '講義 資料.pdf',
  object_name: 'object / ?&',
  resource_id: 'r',
  content_id: 'm',
  end_date: '2099-03-31 00:00:00.0',
  kind: 'material',
  file_id: 'material:m:r',
};
const clientFor = (record) => {
  const client = new ScombClient({});
  client.materialRecord = async () => record;
  return client;
};
test('direct plan carries readonly ScombZ URLs and resolves a new ID safely for each download', async () => {
  const plan = await clientFor(material).materialDownloadPlan('c', 'material:m:r');
  const prepare = new URL(plan.prepare_request.url);
  assert.equal(prepare.origin, 'https://scombz.shibaura-it.ac.jp');
  assert.equal(prepare.searchParams.get('objectName'), material.object_name);
  assert.equal(plan.prepare_request.method, 'GET');
  assert.equal(plan.download_request.method, 'GET');
  assert.equal(Object.hasOwn(plan.file, 'object_name'), false);
  for (const token of ['first', ' second&?=token ']) {
    const url = new URL(resolveMaterialDownloadUrl(plan, token));
    assert.equal(url.searchParams.get('fileId'), token.trim());
    assert.equal(url.searchParams.get('fileName'), material.filename);
    assert.equal(url.searchParams.get('endDate'), material.end_date);
    assert.equal(url.searchParams.get('resourceId'), 'r');
    assert.equal(url.searchParams.get('contentId'), 'm');
    assert.equal(validateReadUrl(url.href, true).origin, plan.origin);
  }
  for (const token of ['', '  ', '<html>login</html>', 'a\nb', 'x'.repeat(2049)])
    assert.throws(() => resolveMaterialDownloadUrl(plan, token), { code: 'parse_error' });
});
test('assignment attachment uses a direct GET without a material temporary ID', async () => {
  const record = {
    ...material,
    kind: 'assignment_attachment',
    file_id: 'assignment:a:0',
    assignment_id: 'a',
    download_mode: '1',
  };
  const plan = await clientFor(record).materialDownloadPlan('c', record.file_id);
  assert.equal(plan.prepare_request, null);
  const url = new URL(resolveMaterialDownloadUrl(plan));
  assert.equal(
    url.pathname,
    '/lms/course/report/submission_download/%E8%AC%9B%E7%BE%A9_%E8%B3%87%E6%96%99.pdf',
  );
  assert.equal(url.searchParams.get('reportId'), 'a');
  assert.equal(url.searchParams.get('objectName'), material.object_name);
  assert.equal(validateReadUrl(url.href, true).origin, 'https://scombz.shibaura-it.ac.jp');
  await assert.rejects(
    clientFor({ ...record, download_mode: 'unexpected' }).materialDownloadPlan('c', record.file_id),
    { code: 'parse_error' },
  );
});

const cookie = {
  name: 'SESSION',
  value: 'same-session',
  domain: 'scombz.shibaura-it.ac.jp',
  path: '/',
  secure: true,
  expires: -1,
};
const session = { cookies: [cookie] };
const guardedFetch = async (url, options) => {
  const headers = new Headers(options.headers);
  assert.equal(headers.get('cookie'), 'SESSION=same-session');
  assert.equal(options.redirect, 'manual');
  if (headers.get('user-agent') !== 'Mozilla/5.0')
    return new Response('<meta content="Scomb_news">', { status: 403 });
  if (url.includes('/make/tempfile')) return new Response('new-id');
  if (url.includes('/setfiledown/') || url.includes('/submission_download/'))
    return new Response('%PDF-1.7 fixture');
  return new Response('<div id="page_head"></div>');
};
test('exported headers prevent the valid-SESSION Python User-Agent 403 regression at every stage', async () => {
  const client = new ScombClient({}, { session, fetch: guardedFetch });
  const auth = await client.exportWebSession();
  const html = 'https://scombz.shibaura-it.ac.jp/lms/course?idnumber=c';
  assert.equal(
    (
      await guardedFetch(html, {
        redirect: 'manual',
        headers: { Cookie: 'SESSION=same-session', 'User-Agent': 'Python-urllib/3.12' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await guardedFetch(html, {
        redirect: 'manual',
        headers: { ...auth.request_headers, Cookie: 'SESSION=same-session' },
      })
    ).status,
    200,
  );
  for (const record of [
    material,
    { ...material, kind: 'assignment_attachment', assignment_id: 'a', download_mode: '1' },
  ]) {
    const plan = await clientFor(record).materialDownloadPlan('c', record.file_id);
    let temporary;
    const get = (url, headers) =>
      guardedFetch(url, {
        redirect: 'manual',
        headers: { ...headers, Cookie: 'SESSION=same-session' },
      });
    if (plan.prepare_request) {
      const response = await get(plan.prepare_request.url, plan.prepare_request.headers);
      assert.equal(response.status, 200);
      temporary = await response.text();
    }
    const response = await get(
      resolveMaterialDownloadUrl(plan, temporary),
      plan.download_request.headers,
    );
    assert.equal(response.status, 200);
    assert.ok((await response.text()).startsWith('%PDF-'));
  }
  assert.equal((await client.request(html)).status, 200);
});
test('403 with browser headers does not refresh or invalidate an otherwise held session', async () => {
  const client = new ScombClient(
    {},
    { session, fetch: async () => new Response('Scomb_news', { status: 403 }) },
  );
  client.refreshSession = () => {
    throw new Error('must not refresh based on 403');
  };
  await assert.rejects(client.request('/portal/home'), { code: 'upstream_forbidden' });
  assert.equal((await client.exportWebSession()).cookie.value, 'same-session');
});
