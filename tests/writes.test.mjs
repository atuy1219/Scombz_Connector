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
import {
  submissionForms,
  prepareSpecific,
  publicSubmissionForm,
} from '../src/submission-adapters.mjs';

const origin = 'https://fixture.workers.dev';
const session = {
  cookies: [
    {
      name: 'SESSION',
      value: 'fixture',
      domain: 'scombz.shibaura-it.ac.jp',
      path: '/',
      expires: -1,
    },
  ],
};
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
    assert.equal(options.headers.Cookie, 'SESSION=fixture');
    lastBody = options.body;
    if (mode === 'unknown') throw new Error('network lost');
    if (mode === 'redirect')
      return new Response(null, { status: 303, headers: { Location: '/login' } });
    if (mode === 'next')
      return new Response(
        '<form id="examinationTakeForm" method="post" action="/lms/course/examination/take?confirm"><input type="hidden" name="_csrf" value="private-token"><input type="hidden" name="idnumber" value="c"><input type="hidden" name="examinationId" value="r"><label for="a">問題1</label><input id="a" name="answer" required><a class="takeConfirm" onclick="confirmBtn()">確認</a></form><script>function confirmBtn(){ $("#examinationTakeForm").submit(); }</script>',
      );
    if (mode === 'upload') return Response.json([101, 102]);
    if (mode === 'upload-error') return Response.json({ error: 'rejected' });
    return new Response('受付画面');
  },
};
const source =
  'https://scombz.shibaura-it.ac.jp/lms/course/report/submission?idnumber=c&reportId=r';
const native =
  '<form method="post" action="/lms/course/report/submission"><input name="csrf" type="hidden" value="private-token"><label for="a">本文</label><textarea id="a" name="answer" required></textarea><button name="submit" value="register">登録する</button></form>';
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
    cf: false,
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
      native.replace('/lms/course/report/submission', 'https://evil.example/upload'),
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

// Synthetic fixtures retain only the observed DOM contract, not university content or credentials.
const target = {
  kind: 'assignment',
  course_id: 'c',
  content_id: 'r',
  title: '合成課題',
  source_url: source,
};
const assignmentHtml =
  '<form id="reportSubmissionForm" action="/lms/course/report/submission" method="post" enctype="multipart/form-data"><input type="hidden" name="_csrf" value="private-token"><input type="hidden" name="_cid" value="private-cid"><input type="hidden" name="idnumber" value="c"><input type="hidden" name="reportId" value="r"><input type="hidden" name="method" value="confirm"><input type="hidden" name="dragAndDrop" value="false"><div id="report"><input name="creationTime" value="0"></div><div id="report_dad"><input name="creationTime" value="0"></div><a id="report_submission_btn">確認画面に進む</a></form><div id="dad_add_block"><input name="originalFileName" type="hidden" value=""><input name="fileId" type="hidden" value="0"><input name="rowCounter" type="hidden" value="0"><input name="fileName"><input name="comment"></div><script>var paramUrl="/lms/course/report/upload"; var formData=new FormData($("#reportSubmissionForm").get()[0]); formData.append("uploadFiles", files); $("#reportSubmissionForm").submit();</script>';
const quizHtml =
  '<form id="examinationTakeForm" action="/lms/course/examination/take" method="post"><input name="_csrf" type="hidden" value="private-token"><input name="_TRANSACTION_TOKEN" type="hidden" value="private-transaction"><input name="idnumber" type="hidden" value="c"><input name="examinationId" type="hidden" value="r"><input name="answerStatus" type="hidden" value="0"><input name="reanswerFlag" type="hidden" value="1"><a id="takebtn" onclick="takebtn()">受験する</a></form><script>function takebtn(){ $("#examinationTakeForm").submit(); }</script>';
test('real quiz top contract prepares a POST start without entering the question page', async () => {
  const forms = submissionForms(quizHtml, source, { ...target, kind: 'quiz' });
  assert.equal(forms[0].action, 'https://scombz.shibaura-it.ac.jp/lms/course/examination/take');
  assert.equal(forms[0].phase, 'quiz_start');
  assert.ok(
    forms[0].hidden.some(([n, v]) => n === '_TRANSACTION_TOKEN' && v === 'private-transaction'),
  );
  for (const html of [
    quizHtml.replace('value="c"', 'value="foreign"'),
    quizHtml.replace('/examination/take"', '/examination/delete"'),
    quizHtml.replace('id="takebtn"', 'id="disabled"'),
  ])
    assert.throws(() => submissionForms(html, source, { ...target, kind: 'quiz' }));
  calls = 0;
  await prepare({ ...target, kind: 'quiz', forms }, {});
  assert.equal(calls, 0);
});
test('assignment upload and preview require separate approvals and preserve confirmed file metadata', async () => {
  calls = 0;
  mode = 'upload';
  const forms = submissionForms(assignmentHtml, source, target);
  assert.equal(forms[0].fields.filter((f) => f.name === 'creationTime').length, 1);
  assert.equal(forms[0].phase, 'assignment_upload');
  const d = await prepare({ ...target, forms }, { creationTime: '15' });
  assert.equal(calls, 0);
  const result = await (
    await confirmWrite(
      req(d.draft_id, { files: [new File(['a'], 'A.java'), new File(['b'], 'B,2.java')] }),
      env,
      client,
      d.draft_id,
      origin,
    )
  ).json();
  assert.equal(calls, 1);
  assert.equal(result.status, 'next_confirmation_required');
  assert.deepEqual(lastBody.getAll('originalFileName'), ['A.java', 'B,2.java']);
  assert.deepEqual(lastBody.getAll('fileId'), ['0', '0']);
  const s = await resumeDraft(env, client, result.next.draft_id);
  assert.equal(s.form.phase, 'assignment_preview');
  assert.deepEqual(
    s.form.hidden.filter(([n]) => n === 'fileId').map(([, v]) => v),
    ['101', '102'],
  );
  assert.ok(s.form.hidden.some(([n, v]) => n === 'originalFileName' && v === 'B&sbquo;2.java'));
  const redacted = JSON.stringify(result);
  assert.ok(!redacted.includes('private-token'));
  assert.ok(!redacted.includes('private-cid'));
  mode = 'ok';
  await confirmWrite(req(result.next.draft_id), env, client, result.next.draft_id, origin);
  assert.equal(calls, 2);
  assert.equal(lastBody.get('creationTime'), '15');
  assert.equal(
    (await submissionStatus(env, client, result.next.draft_id)).status,
    'verification_required',
  );
});
test('upload JSON errors never advance, retry or claim final submission', async () => {
  calls = 0;
  mode = 'upload-error';
  const d = await prepare(
    { ...target, forms: submissionForms(assignmentHtml, source, target) },
    { creationTime: '1' },
  );
  const result = await (
    await confirmWrite(
      req(d.draft_id, { files: [new File(['a'], 'A.java')] }),
      env,
      client,
      d.draft_id,
      origin,
    )
  ).json();
  assert.equal(result.status, 'verification_required');
  assert.equal(calls, 1);
  await assert.rejects(confirmWrite(req(d.draft_id), env, client, d.draft_id, origin));
  assert.equal(calls, 1);
  mode = 'ok';
});
test('survey adapter preserves array names and checkbox markers and blocks unresolved JavaScript flags', () => {
  const html =
    '<form id="surveysTakeForm" action="/lms/course/surveys/take" method="post"><input name="_csrf" type="hidden" value="secret"><input name="idnumber" type="hidden" value="c"><input name="surveyId" type="hidden" value="r"><input name="answerDetail[0].surveyNo" type="hidden" value="1"><label><input name="answerDetail[0].answerItem[0].answer" type="checkbox" value="1">選択肢A</label><input type="hidden" name="!answerDetail[0].answerItem[0].answer" value="on"><input name="answerDetail[1].commentText"><a onclick="$(&apos;#surveysTakeForm&apos;).submit();">確認画面に進む</a></form>';
  const forms = submissionForms(html, source, { ...target, kind: 'survey' });
  assert.equal(forms.length, 1);
  assert.ok(forms[0].hidden.some(([n]) => n === '!answerDetail[0].answerItem[0].answer'));
  assert.deepEqual(validateValues(forms[0], { 'answerDetail[0].answerItem[0].answer': '1' }), [
    ['answerDetail[0].answerItem[0].answer', '1'],
  ]);
  assert.throws(() =>
    submissionForms(
      html.replace('<a onclick=', '<input class="enableSurveyItem" value=""><a onclick='),
      source,
      { ...target, kind: 'survey' },
    ),
  );
  assert.throws(() =>
    submissionForms(html.replace('submit();', 'submit();evil();'), source, {
      ...target,
      kind: 'survey',
    }),
  );
});
test('cross-target drafts and stale status never reveal another authentication generation', async () => {
  const d = await prepare();
  await assert.rejects(
    prepareSpecific(
      env,
      client,
      { kind: 'survey', course_id: 'c', content_id: 'r' },
      {},
      origin,
      d.draft_id,
    ),
  );
  client.authentication = 'another-generation';
  await assert.rejects(submissionStatus(env, client, d.draft_id), { code: 'not_found' });
  client.authentication = 'generation';
});
test('exact operation routes reject speculative paths, queries and unknown content kinds', () => {
  for (const [url, kind] of [
    ['/lms/course/report/submissionconfirm', 'assignment'],
    ['/lms/course/report/submission?method=delete', 'assignment'],
    ['/lms/course/examination/takeconfirm', 'quiz'],
    ['/lms/course/surveys/delete', 'survey'],
    ['/portal/surveys/take', 'unrecognized'],
  ])
    assert.throws(() => writeUrl(url, kind));
});

test('observed quiz answer names and log handlers allow only the confirmation route', () => {
  const html = `<form id="examinationTakeForm" action="/lms/course/examination/take?confirm" method="post"><input type="hidden" name="_csrf" value="secret"><input type="hidden" name="idnumber" value="c"><input type="hidden" name="examinationId" value="r"><input type="hidden" name="answer[0].examinationNo" value="1"><input type="hidden" name="!answer[0].answerItem[0].answer" value="on"><label><input type="radio" name="answer[0].answerItem[0].answer" value="1" onchange="checkLog(this)">選択肢A</label><a class="takeConfirm" onclick="confirmBtn()">確認</a></form><script>function confirmBtn(){ $("#examinationTakeForm").submit(); }</script>`;
  const forms = submissionForms(html, source, { ...target, kind: 'quiz' }, 'continuation');
  assert.equal(forms[0].phase, 'quiz_answers');
  assert.equal(forms[0].action.endsWith('?confirm'), true);
  assert.deepEqual(validateValues(forms[0], { 'answer[0].answerItem[0].answer': '1' }), [
    ['answer[0].answerItem[0].answer', '1'],
  ]);
  for (const changed of [
    html.replace('checkLog(this)', 'sendAnsdata()'),
    html.replace('take?confirm', 'complete'),
    html.replace('type="radio"', 'type="hidden"'),
  ])
    assert.throws(() =>
      submissionForms(changed, source, { ...target, kind: 'quiz' }, 'continuation'),
    );
});
test('text assignments require explicit new text and stop at unverified final pages', async () => {
  const html = `<form id="reportSubmissionForm" action="/lms/course/report/submission" method="post"><input type="hidden" name="_csrf" value="secret"><input type="hidden" name="idnumber" value="c"><input type="hidden" name="reportId" value="r"><input name="creationTime" value="0"><textarea name="submissionText">前回の本文</textarea><a id="report_submission_btn">確認</a></form><script>var url="/lms/course/report/upload"; var name="uploadFiles"; $("#reportSubmissionForm").submit();</script>`;
  const forms = submissionForms(html, source, target);
  assert.equal(forms[0].phase, 'assignment_preview');
  calls = 0;
  const d = await prepare(
    { ...target, forms },
    { submissionText: '今回の本文', creationTime: '5' },
  );
  assert.equal(calls, 0);
  assert.deepEqual(d.answers, [
    ['submissionText', '今回の本文'],
    ['creationTime', '5'],
  ]);
  assert.throws(() => submissionForms(html, source, target, 'continuation'));
});

test('sequential survey initialization sets flags without executing scripts and rejects branch jumps', () => {
  const html = `<form id="surveysTakeForm" action="/lms/course/surveys/take" method="post"><input name="_csrf" type="hidden" value="secret"><input name="idnumber" type="hidden" value="c"><input name="surveyId" type="hidden" value="r"><input name="takeFlag" type="hidden" value="1"><div class="block"><div class="question_itme survey_itme_1"><div id="surveyTakeItemBodyEditor0">合成設問</div><div class="highlight-txt">[必須]</div><div class="branchFlag" data-branchflag="true"></div><input class="enableSurveyItem" name="surveyDetail[0].enableSurveyItem" value="" type="hidden"><input class="branchType" value="radio" type="hidden"><div class="surveys-contents-quetison-area"><label class="branchNo" data-nextno="0" data-no="1"></label><input name="answerDetail[0].answerItem[0].answer" type="radio" value="1"><div class="break">合成の選択肢</div></div></div></div><a onclick="$(&apos;#surveysTakeForm&apos;).submit();">確認画面へ</a></form><script>function setBranch(){} function loadSetBranch(){} $("#takeFlag").val("0"); throw new Error('must not execute');</script>`;
  const forms = submissionForms(html, source, { ...target, kind: 'survey' });
  assert.ok(
    forms[0].hidden.some(([n, v]) => n === 'surveyDetail[0].enableSurveyItem' && v === '1'),
  );
  assert.ok(forms[0].hidden.some(([n, v]) => n === 'takeFlag' && v === '0'));
  assert.equal(forms[0].fields[0].label, '合成の選択肢');
  assert.throws(() => validateValues(forms[0], {}));
  for (const changed of [
    html.replace('data-nextno="0"', 'data-nextno="3"'),
    html.replace('survey_itme_1', 'survey_itme_2'),
    html.replace('data-branchflag="true"', 'data-branchflag="false"'),
    html.replace('function setBranch()', 'function unfamiliar()'),
    html.replace('確認画面へ', '提出する'),
    html.replace('<a onclick=', '<input name="_method" type="hidden" value="put"><a onclick='),
  ])
    assert.throws(() => submissionForms(changed, source, { ...target, kind: 'survey' }));
});
test('required survey matrix rows require an answer in every row and retain row/column labels', () => {
  const html = `<form id="surveysTakeForm" action="/lms/course/surveys/take" method="post"><input name="_csrf" type="hidden" value="secret"><input name="idnumber" type="hidden" value="c"><input name="surveyId" type="hidden" value="r"><div class="block"><div class="highlight-txt">[必須]</div><div class="survey-question-table"><div class="survey-question-table-line"><div>行</div><div>列A</div></div><div class="survey-question-table-line"><div class="break">行A</div><div><input type="checkbox" name="answerDetail[0].answerItem[0].answer" value="1"></div></div><div class="survey-question-table-line"><div class="break">行B</div><div><input type="checkbox" name="answerDetail[1].answerItem[0].answer" value="1"></div></div></div></div><a onclick="$(&apos;#surveysTakeForm&apos;).submit();">確認画面へ</a></form>`;
  const form = submissionForms(html, source, { ...target, kind: 'survey' })[0];
  assert.equal(form.fields[0].label, '行A / 列A');
  assert.equal(form.fields[1].label, '行B / 列A');
  assert.equal(form.required_groups.length, 2);
  assert.throws(() => validateValues(form, { 'answerDetail[0].answerItem[0].answer': '1' }));
  assert.equal(
    validateValues(form, {
      'answerDetail[0].answerItem[0].answer': '1',
      'answerDetail[1].answerItem[0].answer': '1',
    }).length,
    2,
  );
});

const surveyInputHtml = `<form id="surveysTakeForm" action="/lms/course/surveys/take" method="post"><input type="hidden" name="_cid" value="private-cid"><input type="hidden" name="_csrf" value="private-token"><input type="hidden" name="idnumber" value="c"><input type="hidden" name="surveyId" value="r"><div class="question_itme"><div id="surveyTakeItemBodyEditor0">合成設問</div><div class="surveys-contents-quetison-area"><input name="answerDetail[0].answerItem[0].answer" type="radio" value="1"><div class="break">選択肢A</div></div><div class="surveys-contents-quetison-area"><input name="answerDetail[0].answerItem[0].answer" type="radio" value="2"><div class="break">選択肢B</div></div></div><a onclick="$(&apos;#surveysTakeForm&apos;).submit();">確認画面に進む</a></form>`;
const surveyFields = { 'answerDetail[0].answerItem[0].answer': '1' };
function finalSurveyHtml(answer = '選択肢A') {
  return `<form id="surveysTakeForm" action="/lms/course/surveys/take" method="post"><input type="hidden" name="_cid" value="private-cid"><input type="hidden" name="_csrf" value="private-token"><input type="hidden" name="_method" value="put"><input type="hidden" name="idnumber" value="c"><input type="hidden" name="surveyId" value="r"><div class="question_itme"><div id="surveyTakeConfirmItemBodyEditor0">合成設問</div><div class="result-list"><div id="answerRadioBodyEditor_0_0">${answer}</div></div></div><a onclick="$(&apos;#surveysTakeForm&apos;).submit();">提出する</a></form>`;
}
function receiptHtml(answer = '選択肢A', date = jstDate()) {
  return `<form id="surveysTakeResultForm"><input name="idnumber" value="c"><input name="surveyId" value="r"><div class="contents-detail"><div class="contents-header">回答日</div><div class="contents-input-area">${date}</div></div><div class="question_itme"><div id="surveyTakeResultItemBodyEditor0">合成設問</div><div class="result-list"><div id="answerRadioBodyEditor_0_0">${answer}</div></div></div></form>`;
}
function jstDate(ms = Date.now()) {
  return new Date(ms + 9 * 3600000)
    .toISOString()
    .slice(0, 19)
    .replaceAll('-', '/')
    .replace('T', ' ');
}
function surveyMock(outcome = 'ok', before = null) {
  let receipt = before,
    posts = 0,
    finals = 0,
    reads = 0;
  const mock = {
    ...client,
    course: async () => ({
      contents: [
        {
          kind: 'survey',
          content_id: 'r',
          routes: receipt ? ['/lms/course/surveys/takeresult?idnumber=c&surveyId=r'] : [],
        },
      ],
    }),
    html: async (path) => {
      reads++;
      return path.includes('takeresult') ? receipt : '<div id="page_head"></div>';
    },
    fetch: async (url, options) => {
      posts++;
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Cookie, 'SESSION=fixture');
      if (options.body.get('_method') !== 'put') return new Response(finalSurveyHtml());
      finals++;
      if (outcome === 'ok' || outcome === 'unknown-done') receipt = receiptHtml();
      if (outcome === 'wrong') receipt = receiptHtml('選択肢B');
      if (outcome.startsWith('unknown')) throw Error('connection interrupted');
      return new Response(null, {
        status: 303,
        headers: { Location: 'https://evil.example/no-follow' },
      });
    },
  };
  return {
    client: mock,
    setReceipt: (r) => {
      receipt = r;
    },
    counts: () => ({ posts, finals, reads }),
  };
}
async function preparedSurvey(mock) {
  const s = {
    ...target,
    kind: 'survey',
    forms: submissionForms(surveyInputHtml, source, { ...target, kind: 'survey' }),
  };
  return saveDraft(env, mock.client, s, 0, 0, surveyFields, origin);
}
test('survey confirmation matches the approved answers, CID and exact method before offering final approval', () => {
  const form = submissionForms(surveyInputHtml, source, { ...target, kind: 'survey' })[0];
  const data = { ...target, kind: 'survey', form, entries: Object.entries(surveyFields) };
  const final = submissionForms(finalSurveyHtml(), source, data, 'continuation')[0];
  assert.equal(final.phase, 'survey_final');
  assert.deepEqual(final.fields, []);
  assert.ok(final.hidden.some(([n, v]) => n === '_method' && v === 'put'));
  assert.equal(final.expected_summary[0].answers[0], '選択肢A');
  for (const html of [
    finalSurveyHtml('選択肢B'),
    finalSurveyHtml().replace('private-cid', 'different-cid'),
    finalSurveyHtml().replace('value="put"', 'value="delete"'),
    finalSurveyHtml().replace('<form ', '<form onsubmit="evil()" '),
    finalSurveyHtml().replace(
      '<a onclick=',
      '<input name="unknown" type="hidden" value="x"><a onclick=',
    ),
  ])
    assert.throws(() => submissionForms(html, source, data, 'continuation'));
  assert.throws(() =>
    submissionForms(finalSurveyHtml(), source, { ...data, course_id: null }, 'continuation'),
  );
});
test('survey preview cannot finalize; another approval submits once and verifies the public receipt', async () => {
  const mock = surveyMock(),
    draft = await preparedSurvey(mock);
  assert.equal(mock.counts().posts, 0);
  const preview = await (
    await confirmWrite(req(draft.draft_id), env, mock.client, draft.draft_id, origin)
  ).json();
  assert.equal(preview.status, 'next_confirmation_required');
  assert.equal(mock.counts().finals, 0);
  assert.equal(preview.next.confirmed_answers[0].answers[0], '選択肢A');
  assert.ok(!JSON.stringify(preview).includes('private-token'));
  await confirmWrite(
    req(preview.next.draft_id, { step: 'review' }),
    env,
    mock.client,
    preview.next.draft_id,
    origin,
  );
  assert.equal(mock.counts().finals, 0);
  const done = await (
    await confirmWrite(req(preview.next.draft_id), env, mock.client, preview.next.draft_id, origin)
  ).json();
  assert.equal(done.status, 'completed');
  assert.equal(mock.counts().finals, 1);
  assert.ok(done.answered_at);
  assert.ok(!done.verification);
  await assert.rejects(
    confirmWrite(req(preview.next.draft_id), env, mock.client, preview.next.draft_id, origin),
  );
  assert.equal(
    (await submissionStatus(env, mock.client, preview.next.draft_id)).status,
    'completed',
  );
  assert.equal(mock.counts().finals, 1);
});
test('old receipts, mismatched answers and unadvertised results cannot claim completion; status rechecks GET only', async () => {
  for (const outcome of ['pending', 'wrong', 'unchanged']) {
    const mock = surveyMock(
      outcome,
      outcome === 'unchanged' ? receiptHtml('選択肢A', jstDate(Date.now() - 86400000)) : null,
    );
    const draft = await preparedSurvey(mock);
    const preview = await (
      await confirmWrite(req(draft.draft_id), env, mock.client, draft.draft_id, origin)
    ).json();
    const id = preview.next.draft_id;
    const result = await (await confirmWrite(req(id), env, mock.client, id, origin)).json();
    assert.equal(result.status, 'verification_required');
    mock.setReceipt(receiptHtml());
    const done = await submissionStatus(env, mock.client, id);
    assert.equal(done.status, 'completed');
    assert.equal(mock.counts().finals, 1);
    assert.ok(!done.verification);
  }
});
test('unknown final network outcomes can be verified without replaying the final POST', async () => {
  for (const outcome of ['unknown-done', 'unknown-pending']) {
    const mock = surveyMock(outcome),
      draft = await preparedSurvey(mock);
    const preview = await (
      await confirmWrite(req(draft.draft_id), env, mock.client, draft.draft_id, origin)
    ).json();
    const id = preview.next.draft_id;
    const result = await (await confirmWrite(req(id), env, mock.client, id, origin)).json();
    assert.equal(result.status, outcome === 'unknown-done' ? 'completed' : 'verification_required');
    await assert.rejects(confirmWrite(req(id), env, mock.client, id, origin));
    mock.setReceipt(receiptHtml());
    assert.equal((await submissionStatus(env, mock.client, id)).status, 'completed');
    assert.equal(mock.counts().finals, 1);
  }
});
