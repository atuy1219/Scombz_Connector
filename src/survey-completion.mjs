import { document, detailFields, BASE } from './parsers.mjs';
import { ScombError } from './errors.mjs';
const text = (x) =>
  String(x ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const fail = () => {
  throw new ScombError(
    'unsupported_write_form',
    'アンケートの回答確認・結果画面を検証できません。',
  );
};
const unique = (xs) => [...new Set(xs)].sort();

export function surveyInputContract($, form) {
  return form
    .find('.question_itme')
    .map((i, e) => {
      const q = $(e),
        title = text(q.find('[id^="surveyTakeItemBodyEditor"]').text());
      if (!title) fail();
      const controls = (root) =>
        root
          .find('input:not([type="hidden"]),textarea')
          .map((_, n) => {
            const el = $(n),
              name = el.attr('name');
            if (!name?.startsWith('answerDetail')) fail();
            const label =
              text(el.closest('.surveys-contents-quetison-area').find('.break').text()) ||
              text(
                q
                  .find('.survey-question-table-line')
                  .first()
                  .children()
                  .eq(Number(name.match(/answerItem\[(\d+)\]/)?.[1]) + 1)
                  .text(),
              );
            return { name, value: el.attr('value') ?? '', label, type: el.attr('type') ?? 'text' };
          })
          .get();
      const rows = q
        .find('.survey-question-table-line')
        .filter((_, row) => $(row).find('input:not([type="hidden"])').length);
      if (rows.length)
        return {
          title,
          type: 'matrix',
          rows: rows
            .map((_, row) => ({
              title: text($(row).children('.break').first().text()),
              controls: controls($(row)),
            }))
            .get(),
        };
      const items = controls(q);
      if (!items.length) fail();
      const type = items.every((c) => ['radio', 'checkbox'].includes(c.type))
        ? 'choices'
        : items.every((c) => c.type === 'text')
          ? 'text'
          : null;
      if (!type || items.some((c) => type === 'choices' && !c.label)) fail();
      return { title, type, controls: items };
    })
    .get();
}
export function selectedSurveySummary(contract, entries) {
  const vals = (name) => entries.filter(([n]) => n === name).map(([, v]) => v);
  const selected = (controls) =>
    unique(controls.filter((c) => vals(c.name).includes(c.value)).map((c) => c.label));
  return contract.map((q) =>
    q.type === 'matrix'
      ? {
          title: q.title,
          type: q.type,
          rows: q.rows.map((r) => ({ title: r.title, answers: selected(r.controls) })),
        }
      : {
          title: q.title,
          type: q.type,
          answers:
            q.type === 'choices'
              ? selected(q.controls)
              : q.controls.map((c) => text(vals(c.name)[0] ?? '')),
        },
  );
}
export function surveyPageSummary($, root, mode) {
  const prefix =
    mode === 'confirm' ? 'surveyTakeConfirmItemBodyEditor' : 'surveyTakeResultItemBodyEditor';
  const questions = root.find('.question_itme');
  if (!questions.length || questions.length > 200) fail();
  return questions
    .map((_, e) => {
      const q = $(e),
        title = text(q.find('[id^="' + prefix + '"]').text());
      if (!title || q.find('input:not([type="hidden"]),textarea,select').length) fail();
      const rows = q.find('.surveysCheckboxoReslutList');
      if (rows.length)
        return {
          title,
          type: 'matrix',
          rows: rows
            .map((_, n) => ({
              title: text($(n).find('.contents-header .break').text()),
              answers: unique(
                $(n)
                  .find('.contents-input-area .break')
                  .map((_, a) => text($(a).text()))
                  .get()
                  .filter(Boolean),
              ),
            }))
            .get(),
        };
      const choices = q.find(
        '.result-list [id^="answerRadioBodyEditor_"],.result-list [id^="answerCheckBodyEditor_"]',
      );
      if (choices.length)
        return {
          title,
          type: 'choices',
          answers: unique(choices.map((_, n) => text($(n).text())).get()),
        };
      if (q.find('.result-list').length) {
        const remainder = q.find('.result-list').clone();
        remainder.find('.comma').remove();
        if (text(remainder.text())) fail();
        return { title, type: 'choices', answers: [] };
      }
      const comments = q.find('.contents-display-flex.break > span');
      if (!comments.length) fail();
      return { title, type: 'text', answers: comments.map((_, n) => text($(n).text())).get() };
    })
    .get();
}
export async function surveyReceipt(client, target) {
  // Only a route advertised by the authenticated course is read; never follow a POST redirect.
  if (!target.course_id) fail();
  const item = (await client.course(target.course_id)).contents.find(
    (x) => x.kind === 'survey' && x.content_id === target.content_id,
  );
  if (!item) fail();
  const route = item.routes.find(
    (x) => new URL(x, BASE).pathname === '/lms/course/surveys/takeresult',
  );
  if (!route) return null;
  const u = new URL(route, BASE);
  if (
    u.origin !== BASE ||
    u.searchParams.get('idnumber') !== target.course_id ||
    u.searchParams.get('surveyId') !== target.content_id
  )
    fail();
  const { $ } = document(await client.html(u.pathname + u.search)),
    root = $('#surveysTakeResultForm');
  if (root.length !== 1) fail();
  for (const [name, expected] of [
    ['idnumber', target.course_id],
    ['surveyId', target.content_id],
  ]) {
    const el = root.find('input').filter((_, n) => $(n).attr('name') === name);
    if (el.length !== 1 || el.attr('value') !== expected) fail();
  }
  const answeredAt = detailFields($, root).find((x) => /^(回答日|回答日時)$/.test(x.label))?.value;
  if (!answeredAt) fail();
  return {
    answered_at: answeredAt,
    summary: surveyPageSummary($, root, 'result'),
    source_url: u.href,
  };
}
export function receiptMatches(receipt, verification) {
  if (!receipt || JSON.stringify(receipt.summary) !== JSON.stringify(verification.expected))
    return false;
  const m = receipt.answered_at.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return false;
  const stamp = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] ?? 0));
  // Minute precision is acceptable only within the minute of the request or later.
  const earliest = m[6]
    ? Math.floor(verification.started_at / 1000) * 1000
    : Math.floor(verification.started_at / 60000) * 60000;
  if (stamp < earliest || stamp > Date.now() + 60000) return false;
  return (
    !verification.before ||
    receipt.answered_at !== verification.before.answered_at ||
    JSON.stringify(receipt.summary) !== JSON.stringify(verification.before.summary)
  );
}
export async function verifySurvey(client, verification) {
  try {
    const receipt = await surveyReceipt(client, verification);
    if (receiptMatches(receipt, verification))
      return {
        status: 'completed',
        answered_at: receipt.answered_at,
        source_url: receipt.source_url,
        message: '回答結果・回答日時・今回の回答内容を照合し、アンケートの提出を確認しました。',
      };
  } catch {}
  return {
    status: 'verification_required',
    message:
      '最終送信の結果をまだ確認できません。状態確認はGETだけで再確認し、最終送信を再実行しません。',
  };
}
