import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import {
  nativeForms,
  writeUrl,
  validateValues,
  saveDraft,
  confirmWrite,
  submissionStatus,
  resumeDraft,
} from '../src/writes.mjs';

const origin = 'https://fixture.workers.dev';
const session = { cookies: [{ name: 'SESSION', value: 'fixture', path: '/', expires: -1 }] };
let mf,
  env,
  calls = 0,
  mode = 'ok',
  lastBody;
const client = {
  authentication: 'generation',
  loadSession: async () => session,
  html: async () => '<div id="page_head"></div>',
  fetch: async (url, options) => {
    calls++;
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    lastBody = options.body;
    if (mode === 'unknown') throw new Error('network lost');
    if (mode === 'redirect')
      return new Response(null, { status: 303, headers: { Location: '/login' } });
    if (mode === 'next')
      return new Response(
        '<form method="post" action="/lms/course/examination/takeconfirm"><label for="a">問題1</label><input id="a" name="answer" required><button>解答を登録</button></form>',
      );
    return new Response('受付画面');
  },
};
const source =
  'https://scombz.shibaura-it.ac.jp/lms/course/report/submission?idnumber=c&reportId=r';
const native =
  '<form method="post" action="/lms/course/report/submissionconfirm"><input name="csrf" type="hidden" value="private-token"><label for="a">本文</label><textarea id="a" name="answer" required></textarea><button name="submit" value="register">登録する</button></form>';
const snapshot = () => ({
  course_id: 'c',
  content_id: 'r',
  kind: 'assignment',
  title: '課題',
  source_url: source,
  forms: nativeForms(native, source, 'assignment'),
});
before(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  });
  env = {
    ADMIN_TOKEN: 'a'.repeat(64),
    SESSION_ENCRYPTION_KEY: 'b'.repeat(64),
    DB: await mf.getD1Database('DB'),
  };
  await env.DB.exec(
    (await readFile('migrations/0003_write_drafts.sql', 'utf8')).replaceAll('\n', ' '),
  );
});
after(async () => {
  await mf.dispose();
});
async function prepare(s = snapshot(), fields = { answer: '私の回答' }) {
  return saveDraft(env, client, s, 0, 0, fields, origin);
}
const req = (
  id,
  { step = 'commit', approved = 'yes', key = env.ADMIN_TOKEN, site = origin, files = [] } = {},
) => {
  const body = new FormData();
  body.set('admin_token', key);
  body.set('step', step);
  body.set('approved', approved);
  for (const f of files) body.append('attachment_0', f, f.name);
  return new Request(origin + '/write/' + id, { method: 'POST', headers: { Origin: site }, body });
};
test('rejects foreign actions and nonstudent endpoints; does not execute scripted forms', () => {
  for (const value of [
    'https://evil.example/lms/course/report/submission',
    '/lms/course/report/delete',
    '/lms/course/examination/take',
    '/lms/course/report/submission/../../admin',
  ])
    assert.throws(() => writeUrl(value, 'assignment'));
  assert.equal(
    nativeForms(native.replace('method="post"', 'method="get"'), source, 'assignment').length,
    0,
  );
  assert.equal(
    nativeForms(native.replace('<form ', '<form onsubmit="evil()" '), source, 'assignment').length,
    0,
  );
  assert.equal(
    nativeForms(
      native.replace('/lms/course/report/submissionconfirm', 'https://evil.example/upload'),
      source,
      'assignment',
    ).length,
    0,
  );
  assert.throws(() => validateValues(snapshot().forms[0], { csrf: 'override', answer: 'a' }));
  assert.throws(() => validateValues(snapshot().forms[0], {}));
});
test('draft preparation encrypts answers and hidden fields without writing; review alone cannot send', async () => {
  calls = 0;
  const d = await prepare();
  assert.equal(calls, 0);
  const row = await env.DB.prepare('SELECT data FROM write_drafts WHERE id=?')
    .bind(d.draft_id)
    .first();
  assert.ok(!row.data.includes('私の回答'));
  assert.ok(!row.data.includes('private-token'));
  assert.ok(!JSON.stringify(d).includes('private-token'));
  const review = await confirmWrite(
    req(d.draft_id, { step: 'review' }),
    env,
    client,
    d.draft_id,
    origin,
  );
  const html = await review.text();
  assert.ok(html.includes('私の回答'));
  assert.ok(html.includes('登録する'));
  assert.equal(calls, 0);
  for (const options of [{ site: 'https://evil.example' }, { key: 'wrong' }, { approved: 'no' }])
    assert.equal(
      (await confirmWrite(req(d.draft_id, options), env, client, d.draft_id, origin)).status,
      options.key ? 401 : 403,
    );
  assert.equal(calls, 0);
});
test('atomic claim makes concurrent approval and replay send once', async () => {
  calls = 0;
  mode = 'ok';
  const d = await prepare();
  const results = await Promise.allSettled([
    confirmWrite(req(d.draft_id), env, client, d.draft_id, origin),
    confirmWrite(req(d.draft_id), env, client, d.draft_id, origin),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(calls, 1);
  assert.equal(lastBody.get('answer'), '私の回答');
  assert.equal(lastBody.get('csrf'), 'private-token');
  await assert.rejects(confirmWrite(req(d.draft_id), env, client, d.draft_id, origin));
  assert.equal(calls, 1);
});
test('unknown outcome and redirects never retry or falsely report submission success', async () => {
  for (const value of ['unknown', 'redirect']) {
    calls = 0;
    mode = value;
    const d = await prepare();
    const r = await confirmWrite(req(d.draft_id), env, client, d.draft_id, origin);
    const result = await r.json();
    assert.equal(result.status, value === 'unknown' ? 'unknown' : 'verification_required');
    assert.equal(calls, 1);
    await assert.rejects(confirmWrite(req(d.draft_id), env, client, d.draft_id, origin));
    assert.equal(calls, 1);
  }
  mode = 'ok';
});
test('expiry and changed authentication block writes', async () => {
  calls = 0;
  const d = await prepare();
  await env.DB.prepare('UPDATE write_drafts SET expires_at=1 WHERE id=?').bind(d.draft_id).run();
  await assert.rejects(confirmWrite(req(d.draft_id), env, client, d.draft_id, origin));
  const fresh = await prepare();
  client.authentication = 'changed';
  await assert.rejects(confirmWrite(req(fresh.draft_id), env, client, fresh.draft_id, origin));
  client.authentication = 'generation';
  assert.equal(calls, 0);
});
test('next quiz page needs separate answers and another approval; replacing a draft invalidates old contents', async () => {
  calls = 0;
  mode = 'next';
  const s = {
    ...snapshot(),
    kind: 'quiz',
    forms: nativeForms(
      '<form method="post" action="/lms/course/examination/take"><button>受験開始</button></form>',
      source,
      'quiz',
    ),
  };
  const start = await prepare(s, {});
  const result = await (
    await confirmWrite(req(start.draft_id), env, client, start.draft_id, origin)
  ).json();
  assert.equal(calls, 1);
  assert.equal(result.status, 'next_confirmation_required');
  assert.ok(result.next);
  await assert.rejects(
    confirmWrite(req(result.next.draft_id), env, client, result.next.draft_id, origin),
    { code: 'answers_required' },
  );
  assert.equal(calls, 1);
  const next = await resumeDraft(env, client, result.next.draft_id);
  const answered = await prepare(next, { answer: 'B' });
  await assert.rejects(
    confirmWrite(req(result.next.draft_id), env, client, result.next.draft_id, origin),
  );
  assert.equal(calls, 1);
  mode = 'ok';
  await confirmWrite(req(answered.draft_id), env, client, answered.draft_id, origin);
  assert.equal(calls, 2);
  assert.equal(lastBody.get('answer'), 'B');
  assert.ok((await submissionStatus(env, client, start.draft_id)).next);
});
test('attachments use native multipart fields and missing required files do not consume approval', async () => {
  calls = 0;
  mode = 'ok';
  const s = snapshot();
  s.forms[0].fields.push({ name: 'upload', label: '提出ファイル', type: 'file', required: true });
  const d = await prepare(s);
  await assert.rejects(confirmWrite(req(d.draft_id), env, client, d.draft_id, origin));
  assert.equal(calls, 0);
  const file = new File(['class A {}'], 'A.java', { type: 'text/plain' });
  await confirmWrite(req(d.draft_id, { files: [file] }), env, client, d.draft_id, origin);
  assert.equal(calls, 1);
  assert.equal(lastBody.get('upload').name, 'A.java');
  assert.equal(await lastBody.get('upload').text(), 'class A {}');
});
