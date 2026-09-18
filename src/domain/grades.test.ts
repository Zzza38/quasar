import { describe, expect, it } from 'vitest';
import { exampleSchedule } from './example';
import { applyScheduleToGrades, emptyPersonalSchedule, GRADES, gradesSchema, resolveDay, scheduleForGrade, scheduleSchema } from './schedule';

describe('grade schedules', () => {
  const changed = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map((day) => ({ ...day, label: `Junior ${day.label}` })) };
  it('applies one schedule to multiple grades without changing other grades', () => {
    const result = applyScheduleToGrades(exampleSchedule, changed, ['9', '10']);
    expect(scheduleForGrade(result, '9').cycleDays).toEqual(changed.cycleDays);
    expect(scheduleForGrade(result, '10').cycleDays).toEqual(changed.cycleDays);
    expect(scheduleForGrade(result, '11').cycleDays).toEqual(exampleSchedule.cycleDays);
    const revised = applyScheduleToGrades(result, exampleSchedule, ['9']);
    expect(scheduleForGrade(revised, '10').cycleDays).toEqual(changed.cycleDays);
    expect(scheduleSchema.parse(JSON.parse(JSON.stringify(revised)))).toEqual(revised);
  });
  it('uses the student grade and gives private schedules precedence', () => {
    const school = applyScheduleToGrades(exampleSchedule, changed, ['9']);
    const personal = { ...emptyPersonalSchedule(), grade: '9' as const };
    expect(resolveDay(school, '2026-09-08', personal)).toEqual(resolveDay(changed, '2026-09-08'));
    expect(resolveDay(school, '2026-09-08', { ...personal, customSchedule: exampleSchedule })).toEqual(resolveDay(exampleSchedule, '2026-09-08'));
  });
  it('applies all grades to the default and replaces previous grade schedules', () => {
    const school = applyScheduleToGrades(exampleSchedule, changed, ['9']);
    expect(applyScheduleToGrades(school, exampleSchedule, [...GRADES])).toEqual(exampleSchedule);
  });
  it('rejects empty, duplicate and unsupported grades and invalid grade schedules', () => {
    for (const grades of [[], ['9', '9'], ['K'], ['1'], ['8'], ['13']]) expect(gradesSchema.safeParse(grades).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...exampleSchedule, gradeSchedules: { '9': { ...changed, periods: [] } } }).success).toBe(false);
  });
});


it('uses grade-nine lunch on Days 6–10 even when the old default has no lunch', () => {
  const fallback = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, slots: day.slots.filter(slot => slot.periodId !== 'lunch') })) };
  const school = applyScheduleToGrades(fallback, exampleSchedule, ['9']);
  const dates = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21'];
  dates.forEach((date, index) => {
    const day = resolveDay(school, date, { ...emptyPersonalSchedule(), grade: '9' });
    expect(day.cycleDayId).toBe(`day-${index + 6}`);
    expect(day.periods.filter(period => period.kind === 'lunch')).toHaveLength(1);
    expect(resolveDay(school, date).periods.some(period => period.kind === 'lunch')).toBe(false);
  });
});
