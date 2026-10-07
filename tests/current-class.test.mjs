import test from 'node:test';
import assert from 'node:assert/strict';
import { currentSlots, currentContext, termAt } from '../src/current-class.mjs';
const courses = [
  { course_id: 'a', day_of_week: 3, period: '１時限' },
  { course_id: 'b', day_of_week: 3, period: '2' },
  { course_id: 'async', day_of_week: null, period: null },
];
test('JST boundaries, margins, active period preference and duplicate entries', () => {
  const at = (s, margin = 0) => currentSlots(courses, new Date(`2026-10-07T${s}+09:00`), margin);
  assert.equal(at('09:00:00').matches[0].course_id, 'a');
  assert.equal(at('10:40:00').matches.length, 0);
  assert.equal(at('10:45:00', 10).matches.length, 2);
  assert.equal(at('10:50:00', 10).matches[0].course_id, 'b');
  assert.equal(at('12:30:00').matches.length, 0);
  assert.equal(at('13:00:00').matches.length, 0);
  assert.equal(
    currentSlots([...courses, courses[0]], new Date('2026-10-07T00:00:00Z')).matches.length,
    1,
  );
  assert.equal(currentSlots(courses, new Date('2026-10-11T00:00:00Z')).matches.length, 0);
});
test('academic year flips in April using JST, not host timezone', () => {
  assert.deepEqual(termAt(new Date('2026-03-31T14:59:59Z')), { year: 2025, semester: 'second' });
  assert.deepEqual(termAt(new Date('2026-03-31T15:00:00Z')), { year: 2026, semester: 'first' });
});
test('ambiguous timetable never fetches or guesses a course', async () => {
  const client = {
    courses: async () => ({ courses, year: 2026, semester: 'second' }),
    course: () => {
      throw Error('must not fetch');
    },
  };
  const value = await currentContext(client, {
    at: '2026-10-07T10:45:00+09:00',
    margin_minutes: 10,
  });
  assert.equal(value.status, 'ambiguous');
  assert.equal(value.course, null);
  assert.equal(value.matches.length, 2);
});
