import { load } from 'cheerio/slim';
import { BASE, document, parseDetail } from './parsers.mjs';
import { ScombError } from './errors.mjs';
import { nativeForms, saveDraft, resumeDraft } from './writes.mjs';
export const WRITE_TOOLS = new Set([
  'prepare_assignment_submission',
  'prepare_quiz_start',
  'prepare_quiz_answers',
  'prepare_survey_answers',
  'get_quiz_answer_form',
  'get_submission_status',
]);

const unsupported = (message) => {
  throw new ScombError('unsupported_write_form', message);
};
const text = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const value = ($, form, name) =>
  form
    .find('input')
    .filter((_, e) => $(e).attr('name') === name)
    .first()
    .attr('value');
function identities($, form, target) {
  if (
    value(
      $,
      form,
      target.kind === 'assignment'
        ? 'reportId'
        : target.kind === 'quiz'
          ? 'examinationId'
          : 'surveyId',
    ) !== target.content_id ||
    (target.course_id && value($, form, 'idnumber') !== target.course_id)
  )
    unsupported('画面内の提出先IDが一覧と一致しません。');
  if (!value($, form, '_csrf')) unsupported('CSRFトークンを確認できません。');
}

// Adapt only observed student forms. Scripts are parsed as text, never evaluated.
export function submissionForms(html, source, target, phase = 'initial') {
  if (phase === 'continuation' && target.kind !== 'quiz')
    unsupported('最終確認画面の送信契約は未検証です。原画面で内容と提出状態を確認してください。');
  const { $ } = document(html);
  const formId =
    target.kind === 'assignment'
      ? 'reportSubmissionForm'
      : target.kind === 'quiz'
        ? 'examinationTakeForm'
        : target.course_id
          ? 'surveysTakeForm'
          : 'portalSurveysTakeForm';
  const form = $('#' + formId);
  if (form.length !== 1) unsupported('対応する学生用フォームがありません。');
  identities($, form, target);
  const route = new URL(form.attr('action') ?? '', source);
  const expected =
    target.kind === 'assignment'
      ? '/lms/course/report/submission'
      : target.kind === 'quiz'
        ? '/lms/course/examination/take'
        : target.course_id
          ? '/lms/course/surveys/take'
          : '/portal/surveys/take';
  if (
    route.origin !== BASE ||
    route.pathname !== expected ||
    (route.search &&
      !(target.kind === 'quiz' && phase === 'continuation' && route.search === '?confirm')) ||
    route.hash ||
    (form.attr('method') ?? '').toLowerCase() !== 'post'
  )
    unsupported('確認できた送信先・HTTPメソッドと異なります。');

  if (target.kind === 'quiz' && phase === 'initial') {
    if (
      !$('#takebtn').length ||
      form.find('[name^="answerDetail"]').length ||
      form.find('input[name="waitTimeType"]').attr('value') === '1'
    )
      unsupported('受験開始ボタンが利用できないか、既に問題画面です。');
    const scripts = load(html)('script:not([src])').text();
    if (!/\$\(["']#examinationTakeForm["']\)\.submit\(\)/.test(scripts))
      unsupported('受験開始の処理を確認できません。');
    form.find('#takebtn').remove();
    form.append('<button type="submit">受験を開始する</button>');
  }
  if (target.kind === 'quiz' && phase === 'continuation' && route.search === '?confirm') {
    const scripts = load(html)('script:not([src])').text();
    if (
      !form.find('.takeConfirm').length ||
      !/function\s+confirmBtn\s*\(/.test(scripts) ||
      !/\$\(["']#examinationTakeForm["']\)\.submit\(\)/.test(scripts)
    )
      unsupported('回答確認画面への処理を確認できません。');
    for (const e of form.find('[onchange]').toArray()) {
      if ($(e).attr('onchange') !== 'checkLog(this)') unsupported('未対応の回答変更処理です。');
      // Logging and autosave are intentionally never executed.
      $(e).removeAttr('onchange');
    }
    const buttons = form.find('.takeConfirm');
    if (
      buttons
        .toArray()
        .some((e) => !/^confirmBtn\(\);?$/.test($(e).attr('onclick')?.replace(/\s/g, '') ?? ''))
    )
      unsupported('未対応の回答確認ボタンです。');
    buttons.remove();
    form.append('<button type="submit">回答の確認画面へ進む（まだ最終提出しない）</button>');
  }
  if (target.kind === 'quiz' && phase === 'continuation' && route.search !== '?confirm')
    unsupported('検証した小テスト回答フォームではありません。原画面をご利用ください。');
  if (target.kind === 'assignment' && phase === 'initial') {
    if (!$('#report_submission_btn').length) unsupported('課題の確認画面ボタンが利用できません。');
    const scripts = load(html)('script:not([src])').text();
    if (
      !scripts.includes('/lms/course/report/upload') ||
      !scripts.includes('reportSubmissionForm') ||
      !scripts.includes('uploadFiles')
    )
      unsupported('実画面で確認したupload→確認画面の処理がありません。');
    if ($('#submissionArea [name="fileId"],#dad_file_area [name="fileId"]').length)
      unsupported('保存済みの添付下書きがあります。原画面で確認してください。');
    const template = $('#dad_add_block');
    if (form.find('textarea[name="submissionText"]').length && !template.length) {
      if (!/\$\(["']#reportSubmissionForm["']\)\.submit\(\)/.test(scripts))
        unsupported('本文の確認画面処理を確認できません。');
      form.find('#report_submission_btn').remove();
      form.find('[name="deleteFile"]').remove();
      form.append('<button type="submit">課題本文の確認画面へ進む（まだ最終提出しない）</button>');
      const parsed = nativeForms(form.toString(), source, 'assignment')[0];
      if (!parsed || parsed.fields.some((f) => f.type === 'file'))
        unsupported('本文課題の入力形式を確認できません。');
      parsed.phase = 'assignment_preview';
      parsed.fields.forEach((f) => {
        if (f.name === 'creationTime') f.required = true;
      });
      return [parsed];
    }
    for (const name of ['originalFileName', 'fileId', 'rowCounter', 'fileName', 'comment'])
      if (!template.find('input').filter((_, e) => $(e).attr('name') === name).length)
        unsupported('ファイルのテンプレートを確認できません。');
    form.find('#report').remove();
    form.find('[name="dragAndDrop"]').attr('value', 'true');
    form.find('[name="deleteFile"]').remove();
    const duplicate = new Set();
    form.find('input:not([type="hidden"]),textarea').each((_, e) => {
      const name = $(e).attr('name');
      if (duplicate.has(name)) $(e).remove();
      else duplicate.add(name);
    });
    form.append(
      '<input type="file" name="uploadFiles" multiple required><button type="submit">添付をアップロードする（まだ提出しない）</button>',
    );
    const parsed = nativeForms(form.toString(), source, 'assignment')[0];
    if (!parsed) unsupported('課題入力の形式を確認できません。');
    const cid = value($, form, '_cid');
    if (!cid || !/^[A-Za-z0-9_-]{1,100}$/.test(cid))
      unsupported('アップロードの画面IDを確認できません。');
    parsed.action = BASE + '/lms/course/report/upload?' + new URLSearchParams({ _cid: cid });
    parsed.phase = 'assignment_upload';
    parsed.file_template = ['originalFileName', 'fileId', 'rowCounter', 'fileName', 'comment'].map(
      (name) => [name, value($, template, name) ?? ''],
    );
    parsed.fields.forEach((f) => {
      if (f.name === 'creationTime') {
        f.required = true;
        f.label = '作成時間（分）';
      }
    });
    return [parsed];
  }
  if (target.kind === 'survey') {
    if (
      form.find('input[name="_method"]').length ||
      !form.find('input:not([type="hidden"])[name^="answerDetail"],textarea[name^="answerDetail"]')
        .length
    )
      unsupported('アンケート回答入力画面ではありません。最終送信は行いません。');
    if (
      form
        .find('.branchNo')
        .toArray()
        .some((e) => $(e).attr('data-nextno') !== '0')
    )
      unsupported('設問を飛ばす分岐は未対応です。');
    if (
      form
        .find('.enableSurveyItem')
        .toArray()
        .some((e) => !['true', 'false', '1', '0'].includes($(e).attr('value') ?? ''))
    ) {
      const questions = form.find('.question_itme');
      const scripts = load(html)('script:not([src])').text();
      if (
        !questions.length ||
        questions.length !== form.find('.enableSurveyItem').length ||
        !scripts.includes('function setBranch()') ||
        !scripts.includes('function loadSetBranch()') ||
        !scripts.includes('$("#takeFlag").val("0")') ||
        value($, form, 'takeFlag') !== '1'
      )
        unsupported('設問の有効化処理を検証できません。');
      questions.each((i, e) => {
        const q = $(e),
          flag = q.find('.enableSurveyItem');
        if (
          !q.hasClass('survey_itme_' + (i + 1)) ||
          flag.length !== 1 ||
          flag.attr('name') !== 'surveyDetail[' + i + '].enableSurveyItem' ||
          flag.attr('value') !== '' ||
          q.find('.branchFlag').length !== 1 ||
          q.find('.branchFlag').attr('data-branchflag') !== 'true' ||
          !q.find('.branchNo').length ||
          q
            .find('.branchNo')
            .toArray()
            .some((n) => $(n).attr('data-no') !== String(i + 1)) ||
          q
            .find('.branchType')
            .toArray()
            .some((n) => !['radio', 'check', 'multCheck'].includes($(n).attr('value')))
        )
          unsupported('検証した順番表示のアンケート形式と異なります。');
        // Reproduce the observed sequential setBranch/loadSetBranch result; never evaluate JS.
        flag.attr('value', '1');
      });
      form.find('input[name="takeFlag"]').attr('value', '0');
    }
    const expectedClick = "$('#" + formId + "').submit();";
    const anchors = form.find('a[onclick]');
    if (!anchors.length || anchors.toArray().some((e) => !text($(e).text()).includes('確認')))
      unsupported('アンケートの確認画面への操作を確認できません。');
    if (anchors.toArray().some((e) => $(e).attr('onclick')?.replace(/\s/g, '') !== expectedClick))
      unsupported('未対応のアンケート送信スクリプトがあります。');
    if (anchors.length) {
      const label = text(anchors.first().text());
      anchors.remove();
      form.append(
        '<button type="submit">' +
          (label.includes('確認') ? '回答の確認画面へ進む' : '回答を送信する') +
          '</button>',
      );
    }
  }
  const forms = nativeForms(form.toString(), source, target.kind);
  if (!forms.length) unsupported('未検証の入力・送信形式です。原画面をご利用ください。');
  forms.forEach((f) => {
    f.phase =
      target.kind === 'quiz'
        ? phase === 'initial'
          ? 'quiz_start'
          : 'quiz_answers'
        : target.kind + '_form';
    f.required_groups = [];
    form.find('.block').each((_, block) => {
      if (!text($(block).find('.block-title,.highlight-txt').text()).includes('[必須]')) return;
      const matrixRows = $(block)
        .find('.survey-question-table-line')
        .filter((_, row) => $(row).find('input:not([type="hidden"])').length);
      if (matrixRows.length) {
        matrixRows.each((_, row) =>
          f.required_groups.push([
            ...new Set(
              $(row)
                .find('input:not([type="hidden"])')
                .map((_, n) => $(n).attr('name'))
                .get(),
            ),
          ]),
        );
        return;
      }
      const names = [
        ...new Set(
          $(block)
            .find('input:not([type="hidden"]),textarea,select')
            .map((_, e) => $(e).attr('name'))
            .get()
            .filter(Boolean),
        ),
      ];
      if (names.length) f.required_groups.push(names);
    });
  });
  return forms;
}

export async function submissionForm(client, courseId, contentId, kind) {
  let item;
  if (kind === 'survey' && !courseId)
    item = (await client.surveys()).find((x) => x.survey_id === contentId && !x.course_id);
  else
    item = (await client.course(courseId)).contents.find(
      (x) => x.kind === kind && x.content_id === contentId,
    );
  if (!item) throw new ScombError('not_found', '本人の一覧で対象を確認できません。');
  const suffix = kind === 'assignment' ? '/submission' : kind === 'quiz' ? '/taketop' : '/take';
  const route = item.routes.find((x) => new URL(x, BASE).pathname.endsWith(suffix));
  if (!route) unsupported('現在利用できる入力画面がありません。');
  const source = new URL(route, BASE).href;
  const html = await client.html(route);
  const target = {
    course_id: courseId ?? null,
    content_id: contentId,
    kind,
    title: item.title ?? contentId,
    source_url: source,
  };
  let forms = [],
    limitation = null;
  try {
    forms = submissionForms(html, source, target);
  } catch (e) {
    if (e.code !== 'unsupported_write_form') throw e;
    limitation = e.message;
  }
  const detail = parseDetail(html, kind === 'quiz' ? 'quiz_overview' : kind, courseId, contentId);
  return { ...target, forms, detail, supported: forms.length > 0, limitation };
}
export function publicSubmissionForm(snapshot) {
  return {
    course_id: snapshot.course_id,
    content_id: snapshot.content_id,
    kind: snapshot.kind,
    title: snapshot.title,
    source_url: snapshot.source_url,
    supported: snapshot.supported,
    limitation: snapshot.limitation,
    detail: snapshot.detail,
    forms: snapshot.forms.map(({ fields, buttons, phase }) => ({ fields, buttons, phase })),
    confirmation_required: true,
    end_to_end_verified: false,
  };
}
export async function prepareSpecific(env, client, target, fields, origin, previousId) {
  const snapshot = previousId
    ? await resumeDraft(env, client, previousId)
    : await submissionForm(client, target.course_id, target.content_id, target.kind);
  if (
    snapshot.kind !== target.kind ||
    snapshot.content_id !== target.content_id ||
    (snapshot.course_id ?? null) !== (target.course_id ?? null)
  )
    unsupported('前の操作と今回の対象が一致しません。');
  if (!snapshot.forms.length) unsupported(snapshot.limitation ?? '入力フォームを確認できません。');
  if (target.kind === 'quiz' && previousId && snapshot.forms[0].phase === 'quiz_start')
    unsupported('受験開始の下書きを回答送信用として使うことはできません。');
  return saveDraft(env, client, snapshot, 0, 0, fields, origin);
}
