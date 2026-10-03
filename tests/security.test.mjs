import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReadUrl, normalizeSession, ScombClient } from '../src/client.mjs';
import {
  document,
  literalEditorId,
  parseCurrentTasks,
  parseDetail,
  parseSurveys,
} from '../src/parsers.mjs';
import { handle } from '../src/worker.mjs';

const state = {
  cookies: [
    {
      name: 'SESSION',
      value: 'fixture-session',
      domain: 'scombz.shibaura-it.ac.jp',
      path: '/',
      secure: true,
      expires: -1,
    },
  ],
};
const env = { SITE_ORIGIN: 'https://fixture.workers.dev' };
const page = (body) => `<html><div id="page_head"></div>${body}</html>`;
const rpcRequest = (body, headers = {}) =>
  new Request(env.SITE_ORIGIN + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });

test('blocks exam start, submit/complete modifiers and foreign origins', () => {
  for (const path of [
    '/lms/course/examination/take?idnumber=x',
    '/lms/course/examination/taketop?confirm',
    '/lms/course/surveys/take?complete',
    '/lms/course/report/submission?method=submit',
    'https://evil.example/lms/course',
  ])
    assert.throws(() => validateReadUrl(path));
  assert.equal(
    validateReadUrl('/lms/course/examination/taketop?idnumber=x&examinationId=y').pathname,
    '/lms/course/examination/taketop',
  );
});
test('filters unrelated cookies and rejects header injection', () => {
  assert.equal(
    normalizeSession({
      ...state,
      cookies: [
        ...state.cookies,
        { name: 'ADFS', value: 'irrelevant', domain: 'adfs.sic.shibaura-it.ac.jp' },
      ],
    }).cookies.length,
    1,
  );
  assert.throws(() =>
    normalizeSession({ cookies: [{ ...state.cookies[0], value: 'bad\r\nCookie: injected' }] }),
  );
});
test('literal-only Quill hydration preserves text without executing code', () => {
  assert.equal(literalEditorId("'question_'+1+'_'+2"), 'question_1_2');
  assert.equal(literalEditorId("'question_'+globalThis.owned()"), null);
  const data = JSON.stringify(
    JSON.stringify({ ops: [{ insert: '説明 <script>never()</script>\n' }] }),
  ).replaceAll('<', '\\u003c');
  const source = page(
    `<div id="bodyEditor"></div><script>var _QuillUtil={bodyText:(function(){return new QuillUtil('bodyEditor',true)})()};_QuillUtil.bodyText.setJsonData(${data},'reference');</script>`,
  );
  const { $, hydrated } = document(source);
  assert.equal(hydrated[0].text, '説明 <script>never()</script>');
  assert.equal($('#bodyEditor script').length, 0);
});
test('desktop/mobile duplicate links produce one task per row and preserve seconds', () => {
  const html = page(
    `<div id="taskList"><div class="result_list_line"><div class="tasklist-course course">授業</div><div class="tasklist-title online-mobile-hide"><a href="/lms/course/report/submission?idnumber=c&reportId=r">課題</a></div><div class="tasklist-title"><a href="/lms/course/report/submission?idnumber=c&reportId=r">課題</a></div><div class="tasklist-deadline"><span class="deadline">2026/10/04 23:59:00</span></div></div></div>`,
  );
  const tasks = parseCurrentTasks(html);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].deadline_raw, '2026/10/04 23:59:00');
});
test('quiz overview reads advertised GET only and blocks redirects to taking page', async () => {
  const requests = [];
  const course = page(
    `<form id="courseTopForm"><div class="course-result-list"><a class="course-view-examination-name" href="/lms/course/examination/taketop?idnumber=c&examinationId=q">小テスト</a></div></form>`,
  );
  const client = new ScombClient(env, {
    session: state,
    fetch: async (url, init) => {
      requests.push({ path: new URL(url).pathname, method: init.method, redirect: init.redirect });
      return requests.length === 1
        ? new Response(course)
        : new Response(null, {
            status: 302,
            headers: { Location: '/lms/course/examination/take?idnumber=c&examinationId=q' },
          });
    },
  });
  await assert.rejects(
    () => client.detail('c', 'q', 'quiz', 'overview'),
    (e) => e.code === 'redirect_blocked',
  );
  assert.deepEqual(
    requests.map((x) => x.path),
    ['/lms/course', '/lms/course/examination/taketop'],
  );
  assert.ok(requests.every((x) => x.method === 'GET' && x.redirect === 'manual'));
});
test('quiz results omit identity rows and never expose hidden transaction tokens', () => {
  const html = page(
    `<form id="examinationTakeResultForm"><input type="hidden" name="_csrf" value="secret"><div class="contents-detail"><div class="contents-header">学生証番号</div><div class="contents-input-area">student-private</div></div><div class="contents-detail"><div class="contents-header">タイトル</div><div class="contents-input-area">テスト</div></div></form>`,
  );
  const detail = parseDetail(html, 'quiz_result', 'c', 'q');
  assert.equal(detail.page_text.includes('student-private'), false);
  assert.equal(JSON.stringify(detail).includes('secret'), false);
});
test('MCP discovery is private-data-free; unauthenticated data calls never fetch upstream', async () => {
  let calls = 0;
  const options = {
    fetch: async () => {
      calls++;
      throw new Error('must not fetch');
    },
  };
  const discovery = await handle(
    rpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    env,
    options,
  );
  assert.equal(discovery.status, 200);
  const data = await discovery.json();
  assert.ok(data.result.tools.some((x) => x.name === 'get_quiz'));
  assert.equal(calls, 0);
  const denied = await handle(
    rpcRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_connection_status', arguments: {} },
    }),
    env,
    options,
  );
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
});
test('forged Sites identity cannot authorize a private MCP call', async () => {
  let calls = 0;
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_connection_status', arguments: {} },
  };
  const denied = await handle(
    rpcRequest(body, {
      'oai-authenticated-user-id': 'owner',
      'oai-authenticated-user-email': 'owner@example.test',
    }),
    env,
    {
      fetch: async () => {
        calls++;
        throw Error('unexpected');
      },
    },
  );
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
});
test('cross-origin session replacement is denied before reading session', async () => {
  const response = await handle(
    new Request(env.SITE_ORIGIN + '/api/connection', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
        'oai-authenticated-user-id': 'owner',
        'oai-authenticated-user-email': 'owner@example.test',
      },
      body: JSON.stringify(state),
    }),
    env,
  );
  assert.equal(response.status, 403);
});

test('portal and course surveys use advertised GET forms, never aggregate or submit', async () => {
  const source = page(
    `<form id="portalSurveysForm"><div class="result-list"><input id="listSurveyId" value="p"><input id="listIdnumber" value=""><div class="template-name">大学アンケート</div><a class="takeResultBtn">回答確認</a><a class="resultBtn">集計</a></div><div class="result-list"><input id="listSurveyId" value="s"><input id="listIdnumber" value="c"><a class="takeBtn">回答</a></div></form>`,
  );
  const surveys = parseSurveys(source);
  assert.equal(surveys.length, 2);
  assert.equal(surveys[0].routes.length, 1);
  assert.equal(surveys[1].course_id, 'c');
  const requests = [];
  const client = new ScombClient(env, {
    session: state,
    fetch: async (url, init) => {
      requests.push({ path: new URL(url).pathname, method: init.method });
      return new Response(
        requests.length === 1
          ? source
          : page('<form id="portalSurveysTakeResultForm">公開済み回答</form>'),
      );
    },
  });
  const detail = await client.survey('p', null);
  assert.equal(detail.kind, 'survey_result');
  assert.equal(detail.course_id, null);
  assert.deepEqual(requests, [
    { path: '/portal/surveys/list', method: 'GET' },
    { path: '/portal/surveys/takeresult', method: 'GET' },
  ]);
});
