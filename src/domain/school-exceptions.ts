import { GRADES, scheduleForGrade, type Grade, type Schedule } from './schedule';

type SchoolException = Schedule['exceptions'][number];

export type SchoolExceptionGroup = {
  exception: SchoolException;
  grades: Grade[];
  schoolDefault: boolean;
  schedule: Schedule;
};

/** One editor row for each distinct exception shared by the default and grade schedules. */
export function schoolExceptionGroups(schedule: Schedule): SchoolExceptionGroup[] {
  const groups = new Map<string, SchoolExceptionGroup>();
  const add = (source: Schedule, grade?: Grade) => {
    for (const exception of source.exceptions) {
      const key = JSON.stringify(exception);
      let group = groups.get(key);
      if (!group) {
        group = { exception, grades: [], schoolDefault: false, schedule: source };
        groups.set(key, group);
      }
      if (grade) group.grades.push(grade);
      else group.schoolDefault = true;
    }
  };
  add(schedule);
  for (const grade of GRADES) add(scheduleForGrade(schedule, grade), grade);
  return [...groups.values()].sort((left, right) => left.exception.date.localeCompare(right.exception.date));
}

/** Update a single editor row without replacing the selected grades' rotation or bell times. */
export function setSchoolExceptionForGrades(
  schedule: Schedule,
  previous: SchoolException | null,
  exception: SchoolException | null,
  grades: Grade[],
  includeDefault = GRADES.every(grade => grades.includes(grade)),
): Schedule {
  const previousKey = previous && JSON.stringify(previous);
  const update = (source: Schedule, include: boolean): Schedule => {
    const { gradeSchedules: _variants, ...base } = source;
    const exceptions = base.exceptions.filter(entry => !previousKey || JSON.stringify(entry) !== previousKey);
    if (exception && include) {
      const at = exceptions.findIndex(entry => entry.date === exception.date);
      if (at < 0) exceptions.push(exception);
      else exceptions[at] = exception;
    }
    return { ...base, exceptions };
  };
  // Read every effective schedule before changing the default, so an excluded grade retains its old calendar.
  const gradeSchedules = Object.fromEntries(GRADES.map(grade => [grade, update(scheduleForGrade(schedule, grade), grades.includes(grade))]));
  return { ...update(schedule, includeDefault), gradeSchedules };
}

/** Exception-only grade variants continue to follow edits to the school's regular timetable. */
export function applySchoolDefaultEdits(current: Schedule, draft: Schedule): Schedule {
  const regular = (schedule: Schedule) => {
    const { exceptions: _exceptions, gradeSchedules: _variants, ...fields } = schedule;
    return fields;
  };
  const before = JSON.stringify(regular(current));
  const next = regular(draft);
  if (JSON.stringify(next) === before || !draft.gradeSchedules) return draft;
  const gradeSchedules = { ...draft.gradeSchedules };
  for (const grade of GRADES) {
    const prior = current.gradeSchedules?.[grade];
    const variant = gradeSchedules[grade];
    if (prior && variant && JSON.stringify(regular(prior)) === before) {
      gradeSchedules[grade] = { ...next, exceptions: variant.exceptions };
    }
  }
  return { ...draft, gradeSchedules };
}
