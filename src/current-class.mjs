import { publicFile } from './parsers.mjs';

// https://www.shibaura-it.ac.jp/campus_life/class/schedule.html
export const PERIODS = [
  [540, 640],
  [650, 750],
  [800, 900],
  [910, 1010],
  [1020, 1120],
  [1130, 1230],
];
export function termAt(date) {
  const local = new Date(date.getTime() + 9 * 3600000);
  const month = local.getUTCMonth() + 1;
  return {
    year: local.getUTCFullYear() - (month <= 3 ? 1 : 0),
    semester: month <= 3 || month >= 9 ? 'second' : 'first',
  };
}
export function currentSlots(courses, date, margin = 0) {
  const local = new Date(date.getTime() + 9 * 3600000);
  const day = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60;
  const active = PERIODS.flatMap(([start, end], index) =>
    minute >= start && minute < end ? [index + 1] : [],
  );
  const periods = active.length
    ? active
    : PERIODS.flatMap(([start, end], index) =>
        minute >= start - margin && minute < end + margin ? [index + 1] : [],
      );
  const matches = courses.filter((course) => {
    const label = String(course.period ?? '')
      .normalize('NFKC')
      .trim();
    const match = label.match(/^(?:第)?([1-6])(?:時限|限)?$/);
    return course.day_of_week === day && match && periods.includes(Number(match[1]));
  });
  const unique = [...new Map(matches.map((c) => [c.course_id, c])).values()];
  return { day_of_week: day, periods, in_class_time: active.length > 0, matches: unique };
}
export async function currentContext(client, args = {}, scope = 'context') {
  const date = args.at ? new Date(args.at) : new Date();
  const term = termAt(date);
  const timetable = await client.courses(args.year ?? term.year, args.semester ?? term.semester);
  const slots = currentSlots(timetable.courses, date, args.margin_minutes ?? 0);
  const result = {
    at: date.toISOString(),
    timezone: 'Asia/Tokyo',
    year: timetable.year,
    semester: timetable.semester,
    ...slots,
    status:
      slots.matches.length === 1 ? 'matched' : slots.matches.length ? 'ambiguous' : 'no_class',
    course: slots.matches.length === 1 ? slots.matches[0] : null,
    schedule_basis: 'weekly_timetable',
    warnings: [
      '曜日・時限に基づく候補です。休講・祝日・授業期間外・補講は未確認です。教材の該当回は自動で断定しません。',
    ],
  };
  if (!result.course || scope === 'course') return result;
  const course = await client.course(result.course.course_id);
  const contents = course.contents.map(({ routes, ...item }) => ({
    ...item,
    source_urls: routes.map((p) => 'https://scombz.shibaura-it.ac.jp' + p),
  }));
  return {
    ...result,
    ...(scope !== 'tasks'
      ? {
          materials: course.files.map(publicFile),
          material_sections: course.material_sections,
        }
      : {}),
    ...(scope !== 'materials'
      ? {
          assignments: contents.filter((c) => c.kind === 'assignment'),
          quizzes: contents.filter((c) => c.kind === 'quiz'),
          surveys: contents.filter((c) => c.kind === 'survey'),
        }
      : {}),
    warnings: [...result.warnings, ...(course.warnings ?? [])],
    completeness:
      '科目トップで公開されている一覧。該当回・最新教材は名称と公開情報から選択してください。',
  };
}
