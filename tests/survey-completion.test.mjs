import test from 'node:test';
import assert from 'node:assert/strict';
import { document } from '../src/parsers.mjs';
import { surveyPageSummary, receiptMatches, surveyReceipt } from '../src/survey-completion.mjs';
const date = (ms) =>
  new Date(ms + 9 * 3600000).toISOString().slice(0, 19).replaceAll('-', '/').replace('T', ' ');
const summary = [{ title: '合成設問', type: 'choices', answers: ['A'] }];
test('receipt freshness handles the displayed precision but does not accept old, future or identical previous receipts', () => {
  const now = Date.now(),
    v = { started_at: now, expected: summary, before: null };
  const r = { summary, answered_at: date(now) };
  assert.equal(receiptMatches(r, v), true);
  assert.equal(receiptMatches({ ...r, answered_at: r.answered_at.slice(0, 16) }, v), true);
  for (const receipt of [
    null,
    { ...r, summary: [] },
    { ...r, answered_at: date(now - 120000) },
    { ...r, answered_at: date(now + 120000) },
    { ...r, answered_at: 'invalid' },
  ])
    assert.equal(receiptMatches(receipt, v), false);
  assert.equal(receiptMatches(r, { ...v, before: r }), false);
  assert.equal(receiptMatches(r, { ...v, before: { ...r, summary: [] } }), true);
});
test('display summaries preserve optional blank text and matrix row identities', () => {
  const html = `<form id="f"><div class="question_itme"><div id="surveyTakeConfirmItemBodyEditor0">コメント</div><div class="contents-display-flex break"><span></span></div></div><div class="question_itme"><div id="surveyTakeConfirmItemBodyEditor1">行列</div><div class="surveysCheckboxoReslutList"><div class="contents-header"><div class="break">行A</div></div><div class="contents-input-area"><span class="comma">,</span><div class="break">列B</div></div></div></div></form>`;
  const { $ } = document(html);
  assert.deepEqual(surveyPageSummary($, $('#f'), 'confirm'), [
    { title: 'コメント', type: 'text', answers: [''] },
    { title: '行列', type: 'matrix', rows: [{ title: '行A', answers: ['列B'] }] },
  ]);
  assert.throws(() => surveyPageSummary($, $('#f'), 'result'));
});
test('receipt reads only advertised matching result routes and rejects wrong identity and incomplete evidence', async () => {
  const target = { course_id: 'c', content_id: 's' },
    path = '/lms/course/surveys/takeresult?idnumber=c&surveyId=s';
  let calls = 0,
    route = path,
    html = `<form id="surveysTakeResultForm"><input name="idnumber" value="c"><input name="surveyId" value="s"><div class="contents-detail"><div class="contents-header">回答日</div><div class="contents-input-area">${date(Date.now())}</div></div><div class="question_itme"><div id="surveyTakeResultItemBodyEditor0">合成設問</div><div class="result-list"><div id="answerRadioBodyEditor_0_0">A</div></div></div></form>`;
  const valid = html;
  const client = {
    course: async () => ({
      contents: [{ kind: 'survey', content_id: 's', routes: route ? [route] : [] }],
    }),
    html: async (p) => {
      calls++;
      assert.equal(p, path);
      return html;
    },
  };
  assert.deepEqual((await surveyReceipt(client, target)).summary, summary);
  route = null;
  assert.equal(await surveyReceipt(client, target), null);
  for (const bad of [
    'https://evil.example/lms/course/surveys/takeresult?idnumber=c&surveyId=s',
    path.replace('surveyId=s', 'surveyId=other'),
  ]) {
    route = bad;
    const before = calls;
    await assert.rejects(surveyReceipt(client, target));
    assert.equal(calls, before);
  }
  route = path;
  for (const bad of [
    valid.replace('value="s"', 'value="wrong"'),
    valid.replace('回答日', '説明'),
    valid.replace('surveysTakeResultForm', 'surveysTakeForm'),
  ]) {
    html = bad;
    await assert.rejects(surveyReceipt(client, target));
  }
});
