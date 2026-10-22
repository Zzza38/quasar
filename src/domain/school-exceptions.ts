import { GRADES, scheduleForGrade, type Grade, type Schedule, type ScheduleSlot } from './schedule';

type SchoolException = Schedule['exceptions'][number];

/** A rotation day or another special-schedule date whose periods an exception can copy. */
export type SlotCopySource = { key: string; kind: 'day' | 'date'; name: string; grades?: Grade[]; slots: ScheduleSlot[] };

/**
 * The periods an exception on `date` can copy, rotation days first and then other special dates. Grades with the
 * same times share one entry; `grades` is set only when that day or date has different times for different grades.
 * Sources that use a period missing from any target schedule are left out, since the copy would not validate there.
 */
export function slotCopySources(sources: Array<{ schedule: Schedule; grade?: Grade }>, targets: Schedule[], date: string): SlotCopySource[] {
  const found = new Map<string, { kind: 'day' | 'date'; name: string; variants: Map<string, { slots: ScheduleSlot[]; grades: Grade[] }> }>();
  const add = (kind: 'day' | 'date', name: string, slots: ScheduleSlot[], grade?: Grade) => {
    if (!slots.length) return;
    const id = `${kind}:${name}`;
    let entry = found.get(id);
    if (!entry) found.set(id, entry = { kind, name, variants: new Map() });
    const times = JSON.stringify(slots.map(({ periodId, start, end }) => [periodId, start, end]));
    let variant = entry.variants.get(times);
    if (!variant) entry.variants.set(times, variant = { slots, grades: [] });
    if (grade && !variant.grades.includes(grade)) variant.grades.push(grade);
  };
  for (const { schedule, grade } of sources) {
    for (const day of schedule.cycleDays) add('day', day.label, day.slots, grade);
    for (const exception of schedule.exceptions) {
      if (exception.date !== date && 'slots' in exception && exception.slots) add('date', exception.date, exception.slots, grade);
    }
  }
  const usable = (slots: ScheduleSlot[]) => targets.every(target => slots.every(slot => target.periods.some(period => period.id === slot.periodId)));
  const entries = [...found.values()];
  const days = entries.filter(entry => entry.kind === 'day');
  const dates = entries.filter(entry => entry.kind === 'date').sort((left, right) => left.name.localeCompare(right.name));
  return [...days, ...dates].flatMap(entry => {
    const variants = [...entry.variants.values()].filter(variant => usable(variant.slots));
    return variants.map((variant, index) => ({
      key: `${entry.kind}:${entry.name}:${index}`, kind: entry.kind, name: entry.name, slots: variant.slots,
      ...(entry.variants.size > 1 && variant.grades.length ? { grades: [...variant.grades].sort((left, right) => GRADES.indexOf(left) - GRADES.indexOf(right)) } : {}),
    }));
  });
}

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
  const removedDays = new Set(current.cycleDays.filter(day => !draft.cycleDays.some(nextDay => nextDay.id === day.id)).map(day => day.id));
  const removedPeriods = new Set(current.periods.filter(period => !draft.periods.some(nextPeriod => nextPeriod.id === period.id)).map(period => period.id));
  const gradeSchedules = { ...draft.gradeSchedules };
  for (const grade of GRADES) {
    const prior = current.gradeSchedules?.[grade];
    const variant = gradeSchedules[grade];
    if (prior && variant && JSON.stringify(regular(prior)) === before) {
      const exceptions = variant.exceptions
        .filter(exception => exception.kind !== 'reset' || !removedDays.has(exception.cycleDayId))
        .map(exception => 'slots' in exception && exception.slots
          ? { ...exception, slots: exception.slots.filter(slot => !removedPeriods.has(slot.periodId)) }
          : exception);
      gradeSchedules[grade] = { ...next, exceptions };
    }
  }
  return { ...draft, gradeSchedules };
}
