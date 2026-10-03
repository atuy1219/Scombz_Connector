import { load } from 'cheerio/slim';

export const BASE = 'https://scombz.shibaura-it.ac.jp';
export const clean = (value) =>
  String(value ?? '')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
const inline = (value) => clean(value).replace(/\s+/g, ' ');
const url = (value) => {
  try {
    return new URL(value, BASE);
  } catch {
    return null;
  }
};

// Only literal strings and decimal integers joined with '+' are interpreted.
// This does not evaluate JavaScript, functions, property access or expressions.
export function literalEditorId(expression) {
  const tokens = expression.match(/'(?:[A-Za-z0-9_-]*)'|"(?:[A-Za-z0-9_-]*)"|\d+/g) ?? [];
  if (
    !tokens.length ||
    expression.replace(/'(?:[A-Za-z0-9_-]*)'|"(?:[A-Za-z0-9_-]*)"|\d+/g, '').replace(/[\s+]/g, '')
  )
    return null;
  return tokens.map((t) => (/^\d+$/.test(t) ? t : t.slice(1, -1))).join('');
}

export function document(html) {
  const $ = load(html);
  const bindings = new Map();
  const hydrated = [];
  const warnings = [];
  $('script:not([src])').each((_, script) => {
    const source = $(script).text();
    const events =
      /([\w.$]+)\s*(?:=|:)\s*\(function\s*\(\)\s*\{\s*return\s+new\s+QuillUtil\(([^,]{1,240}),\s*true\)|([\w.$]+)\.setJsonData\(\s*("(?:\\.|[^"\\])*")/g;
    for (const m of source.matchAll(events)) {
      if (m[1]) {
        const id = literalEditorId(m[2]);
        if (id) bindings.set(m[1].split('.').pop(), id);
      } else {
        const id = bindings.get(m[3].split('.').pop());
        if (!id) continue;
        try {
          const delta = JSON.parse(JSON.parse(m[4]));
          if (!Array.isArray(delta.ops)) continue;
          const text = delta.ops
            .map((op) =>
              typeof op.insert === 'string'
                ? op.insert
                : op.insert?.image
                  ? '[画像]'
                  : op.insert?.formula
                    ? String(op.insert.formula)
                    : '',
            )
            .join('');
          const target = $('[id]')
            .filter((_, el) => $(el).attr('id') === id)
            .first();
          target.text(text); // text(), never html(); scripts cannot execute.
          hydrated.push({
            id,
            text: clean(text),
            images: delta.ops
              .filter((op) => op.insert?.image)
              .map((op) => String(op.insert.image))
              .filter((x) => /^https?:\/\//.test(x)),
          });
        } catch {
          warnings.push('一部のリッチテキストを解析できませんでした。');
        }
      }
    }
  });
  $('script,style,noscript').remove();
  return { $, hydrated, warnings: [...new Set(warnings)] };
}

export function pageState(html) {
  const $ = load(html);
  return {
    login: $('#loginForm').length > 0,
    maintenance: $('meta[http-equiv="refresh"]').length > 0,
    header: $('#page_head').length > 0,
  };
}

export function parseTerms(html) {
  const { $ } = document(html);
  if (!$('select[name="risyunen"]').length) throw new Error('時間割の年度選択を確認できません。');
  return {
    years: $('select[name="risyunen"] option')
      .map((_, e) => ({ year: Number($(e).attr('value')), label: inline($(e).text()) }))
      .get(),
    semesters: $('select[name="kikanCd"] option')
      .map((_, e) => ({ code: $(e).attr('value'), label: inline($(e).text()) }))
      .get(),
  };
}

export function parseTimetable(html) {
  const { $ } = document(html);
  if (!$('#displayMode1').length || !$('#displayMode1').attr('checked'))
    throw new Error('時間割表示の構造を確認できません。');
  const result = [];
  $('.timetable-course-top-btn').each((_, e) => {
    const el = $(e),
      courseId = el.attr('id');
    if (!courseId) return;
    const cell = el.closest('[class*="-yobicol"]');
    const day = (cell.attr('class') ?? '').match(/(?:^|\s)([1-6])-yobicol(?:\s|$)/)?.[1];
    const period = inline(
      cell.closest('.div-table-data-row').find('.div-table-colomn-period').first().text(),
    );
    const details = el.parent().find('.div-table-cell-detail');
    const teachers = details
      .find('span')
      .map((_, x) => inline($(x).text()))
      .get()
      .filter(Boolean);
    result.push({
      course_id: courseId,
      title: inline(el.text()),
      day_of_week: day ? Number(day) : null,
      period: period || null,
      classroom: details.find('[title]').first().attr('title') ?? null,
      teachers: [...new Set(teachers)],
      source_url: `${BASE}/lms/course?idnumber=${encodeURIComponent(courseId)}`,
    });
  });
  return result;
}

export function parseFiles($, root, courseId, reportId = null) {
  const files = [],
    seen = new Set();
  root.find('.fileName').each((_, e) => {
    const parent = $(e).parent(),
      name = clean($(e).text());
    const objectName = clean(parent.find('.objectName').text());
    if (!name || !objectName) return;
    const resourceId = clean(parent.find('.resource_Id').text());
    const contentId = parent.find('#dlMaterialId').attr('value');
    const category = clean(parent.find('.fileCategory').text());
    if (!reportId && (!resourceId || !contentId)) return;
    const kind = reportId ? 'assignment_attachment' : 'material';
    const key = reportId
      ? `assignment:${reportId}:${files.length}`
      : `material:${contentId}:${resourceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({
      file_id: key,
      kind,
      course_id: courseId,
      assignment_id: reportId,
      filename: name,
      resource_id: resourceId,
      content_id: contentId,
      object_name: objectName,
      end_date: clean(parent.find('.openEndDate').text()),
      download_mode: category,
      scan_status: clean(parent.find('.scanStatus').text()),
    });
  });
  return files;
}

export function publicFile(file) {
  const { object_name, resource_id, content_id, end_date, download_mode, scan_status, ...result } =
    file;
  return result;
}

export function parseCourse(html, courseId) {
  const { $, hydrated, warnings } = document(html);
  if (!$('#courseTopForm').length) throw new Error('科目トップの構造を確認できません。');
  const contentMap = new Map();
  const type = {
    '/lms/course/report/submission': 'assignment',
    '/lms/course/examination/taketop': 'quiz',
    '/lms/course/examination/takeresult': 'quiz',
    '/lms/course/surveys/take': 'survey',
    '/lms/course/surveys/takeresult': 'survey',
  };
  $('.course-result-list a[href]').each((_, e) => {
    const u = url($(e).attr('href'));
    const kind = u && type[u.pathname];
    if (!kind || u.origin !== BASE || u.searchParams.get('idnumber') !== courseId) return;
    const contentId = u.searchParams.get(
      kind === 'assignment' ? 'reportId' : kind === 'quiz' ? 'examinationId' : 'surveyId',
    );
    if (!contentId) return;
    const row = $(e).closest('.course-result-list');
    const key = `${kind}:${contentId}`;
    const primary =
      $(e).hasClass('course-view-report-name') ||
      $(e).hasClass('course-view-examination-name') ||
      $(e).hasClass('course-view-questionnaire-name');
    const record = contentMap.get(key) ?? {
      kind,
      content_id: contentId,
      course_id: courseId,
      title: primary ? inline($(e).text()) : null,
      status: inline(row.find('.submitStatus,.course-view-report-status').text()) || null,
      period:
        inline(
          row
            .find(
              '.course-view-report-time-start,.course-view-report-time-end,.course-view-examination-period,.course-view-questionnaire-period',
            )
            .text(),
        ) || null,
      routes: [],
    };
    if (primary) record.title = inline($(e).text());
    if (!record.routes.includes(u.pathname + u.search)) record.routes.push(u.pathname + u.search);
    contentMap.set(key, record);
  });
  const files = parseFiles($, $('#materialContents'), courseId);
  const materialSections = $('#materialContents .contents-detail .material-sub-color label')
    .map((_, x) => inline($(x).text()))
    .get();
  return {
    course_id: courseId,
    title: inline($('.course-title-txt').first().text()),
    contents: [...contentMap.values()],
    files,
    material_sections: materialSections,
    rich_text: hydrated.filter((x) => !/^answer/.test(x.id)),
    warnings,
  };
}

export function detailFields($, root) {
  return root
    .find('.contents-detail')
    .map((_, e) => {
      const row = $(e),
        label = inline(row.children('.contents-header').first().text());
      const value = clean(row.children('.contents-input-area').text());
      return label && value && !/学生証番号|ユーザID|氏名/.test(label) ? { label, value } : null;
    })
    .get();
}

export function parseDetail(html, kind, courseId, contentId) {
  const { $, hydrated, warnings } = document(html);
  const selectors = {
    assignment: '#report_view',
    quiz_overview: '#examinationTakeForm',
    quiz_result: '#examinationTakeResultForm',
    survey: '#surveysTakeForm,#portalSurveysTakeForm',
    survey_result: '#surveysTakeResultForm,#portalSurveysTakeResultForm',
  };
  const root = $(selectors[kind]);
  if (!root.length) throw new Error('内容画面の構造を確認できません。');
  const fields = detailFields($, root);
  const questions = hydrated
    .filter((x) => /^examinationTextBodyEditor_|^surveyTake(?:Result)?ItemBodyEditor/.test(x.id))
    .map((question) => {
      const el = $('[id]')
        .filter((_, e) => $(e).attr('id') === question.id)
        .first();
      const block = el.closest('.block');
      return {
        text: question.text,
        images: question.images,
        details: block.length ? detailFields($, block) : [],
        visible_choices: block
          .find('[id^="answer"]')
          .map((_, e) => clean($(e).text()))
          .get()
          .filter(Boolean),
      };
    });
  const files = kind === 'assignment' ? parseFiles($, root, courseId, contentId) : [];
  const bodyText =
    hydrated.find((x) => x.id === 'bodyEditor')?.text ?? clean(root.find('#bodyEditor').text());
  root.find('.contents-detail').each((_, e) => {
    if (/学生証番号|ユーザID|氏名/.test(inline($(e).children('.contents-header').first().text())))
      $(e).remove();
  });
  return {
    kind,
    course_id: courseId,
    content_id: contentId,
    title:
      fields.find((x) => /^(タイトル|アンケート名)$/.test(x.label))?.value ??
      inline(root.find('.contents-title-txt').first().text()),
    body: bodyText || null,
    fields,
    questions,
    files: files.map(publicFile),
    page_text: clean(root.text()).slice(0, 60000),
    warnings: [
      ...warnings,
      ...(kind === 'quiz_overview'
        ? ['受験を開始していません。要項に含まれない問題文は取得しません。']
        : []),
      ...(kind.startsWith('survey') && !questions.length
        ? ['公開期間または回答状態により、設問が表示されない場合があります。']
        : []),
    ],
  };
}

export function parseCurrentTasks(html) {
  const { $ } = document(html);
  if (!$('#taskList').length) throw new Error('タスク一覧の構造を確認できません。');
  return $('#taskList .result_list_line')
    .map((_, e) => {
      const row = $(e),
        link = row.find('.tasklist-title.online-mobile-hide a').first().length
          ? row.find('.tasklist-title.online-mobile-hide a').first()
          : row.find('.tasklist-title a').first();
      const u = url(link.attr('href'));
      return {
        title: inline(link.text()),
        course: inline(row.find('.tasklist-course').text()),
        kind: inline(row.find('.tasklist-contents.online-mobile-hide').text()),
        deadline_raw: inline(row.find('.tasklist-deadline .deadline').text()),
        course_id: u?.searchParams.get('idnumber') ?? null,
        content_id:
          u?.searchParams.get('reportId') ??
          u?.searchParams.get('examinationId') ??
          u?.searchParams.get('surveyId') ??
          null,
        source_url: u?.origin === BASE ? u.href : null,
      };
    })
    .get();
}

export function parseAnnouncements(html) {
  const { $ } = document(html),
    result = new Map();
  $('a.link-txt[data1]').each((_, e) => {
    const el = $(e),
      id = el.attr('data1'),
      row = el.closest('.contents-display-flex');
    if (!id || result.has(id)) return;
    result.set(id, {
      announcement_id: id,
      title: inline(el.text()),
      category_code: el.attr('data2'),
      category: inline(row.find('.portal-information-list-type').first().text()),
      from: inline(row.find('.portal-information-list-division').first().text()),
      published_at_raw: inline(row.find('.portal-information-list-date').first().text()),
      tags: [
        ...new Set(
          row
            .find('.portal-information-priority')
            .not('.contents-hidden')
            .map((_, x) => inline($(x).text()))
            .get(),
        ),
      ],
    });
  });
  return [...result.values()];
}

export function parseSurveys(html) {
  const { $ } = document(html);
  if (!$('#portalSurveysForm').length) throw new Error('アンケート一覧の構造を確認できません。');
  return $('#portalSurveysForm .result-list')
    .map((_, e) => {
      const row = $(e),
        surveyId = row.find('#listSurveyId').attr('value'),
        courseId = row.find('#listIdnumber').attr('value') || null;
      if (!surveyId) return null;
      const prefix = courseId ? '/lms/course/surveys' : '/portal/surveys';
      const params = new URLSearchParams({ surveyId, ...(courseId ? { idnumber: courseId } : {}) });
      const routes = [];
      if (row.find('.takeBtn').length) routes.push(`${prefix}/take?${params}`);
      if (row.find('.takeResultBtn').length) routes.push(`${prefix}/takeresult?${params}`);
      return {
        survey_id: surveyId,
        course_id: courseId,
        title:
          inline(row.find('.template-name').text()) ||
          inline(row.find('.survey-list-title').text()),
        period_raw: inline(row.find('.survey-list-update').text()),
        address: inline(row.find('.survey-list-address').text()),
        status: inline(row.find('.survey-list-btn').text()),
        routes,
      };
    })
    .get();
}
