import { resolveDayInRange, type PersonalSchedule, type Schedule } from './schedule';
import { addDays, daysBetween, formatDate } from '@/lib/format';

/**
 * Plan my week and time estimates (README "Quasar AI Plus"), shared by src/server/plan.ts and the Today and Tasks
 * views. The server offers the model only real places to put a study block: periods in the student's own timetable
 * with no class in them, and an after-school slot on each school day. It checks every block against those slots and
 * the task's due date, so a block never lands in a class, on a closed day or after the work is due.
 */

/** How many days a plan covers, today included. */
export const PLAN_DAYS = 7;
/** Work due this far ahead can get blocks this week (a test in ten days gets its first review now). */
export const PLAN_LOOKAHEAD_DAYS = 14;
/** Tasks one plan or estimate request carries at most, soonest due first. */
export const PLAN_TASKS_MAX = 40;
export const PLAN_BLOCKS_MAX = 40;
/** Blocks are between these lengths; a free period shorter than the minimum is not offered. */
export const BLOCK_MIN_MINUTES = 10;
export const BLOCK_MAX_MINUTES = 120;
/** The after-school slot starts this long after the last period, holds this much work and ends by AFTER_SCHOOL_LATEST. */
export const AFTER_SCHOOL_GAP_MINUTES = 15;
export const AFTER_SCHOOL_MINUTES = 150;
export const AFTER_SCHOOL_LATEST = '21:00';
/** When a school day has no periods at all, after school starts here. */
export const AFTER_SCHOOL_DEFAULT_START = '15:30';
/** A day whose estimated work is over this many minutes gets a crunch warning. */
export const CRUNCH_MINUTES = 150;
/** Estimates are between these, in steps of five minutes. */
export const ESTIMATE_MIN_MINUTES = 5;
export const ESTIMATE_MAX_MINUTES = 600;

export type PlanSlot = { id: string; date: string; kind: 'free' | 'after'; label: string; start: string; end: string; minutes: number };
export type PlanBlockStatus = 'planned' | 'done' | 'skipped';
export type PlanBlock = { id: string; date: string; start: string; end: string; slotKind: 'free' | 'after'; slotLabel: string; taskId: string; title: string; kind: 'review' | 'work'; minutes: number; status: PlanBlockStatus };

export const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** "Free period 3" from a period called "3", "Period 3" or "P3"; private blocks with no class read "Free block". */
export function freeLabel(label: string): string {
  const trimmed = label.trim();
  if (/^unassigned block$/i.test(trimmed)) return 'Free block';
  const period = trimmed.match(/^(?:period|per\.?|p)\s*(.+)$/i);
  return `Free period ${period ? period[1] : trimmed}`;
}

/**
 * Where study blocks can go over the PLAN_DAYS from `today`: every class-kind period with no class in it (lunch
 * stays lunch), and an after-school slot on each open school day. On `today` only slots still ahead of `nowTime` are
 * offered, and after school starts no earlier than now. Closed days offer nothing.
 */
export function planSlots(school: Schedule, personal: PersonalSchedule, today: string, nowTime: string, days = PLAN_DAYS): PlanSlot[] {
  const slots: PlanSlot[] = [];
  const now = toMinutes(nowTime);
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(today, offset);
    let day;
    try { day = resolveDayInRange(school, date, personal); } catch { day = null; }
    if (!day || day.closed) continue;
    for (const period of day.periods) {
      if (period.class || period.kind !== 'class') continue;
      const minutes = toMinutes(period.end) - toMinutes(period.start);
      if (minutes < BLOCK_MIN_MINUTES || (offset === 0 && toMinutes(period.start) < now)) continue;
      slots.push({ id: `${date}~${period.slotId}`, date, kind: 'free', label: freeLabel(period.label), start: period.start, end: period.end, minutes });
    }
    const last = day.periods.length ? Math.max(...day.periods.map((period) => toMinutes(period.end))) : toMinutes(AFTER_SCHOOL_DEFAULT_START) - AFTER_SCHOOL_GAP_MINUTES;
    let start = Math.ceil((last + AFTER_SCHOOL_GAP_MINUTES) / 5) * 5;
    if (offset === 0) start = Math.max(start, Math.ceil((now + 5) / 5) * 5);
    const end = Math.min(start + AFTER_SCHOOL_MINUTES, toMinutes(AFTER_SCHOOL_LATEST));
    if (end - start >= BLOCK_MIN_MINUTES) slots.push({ id: `${date}~after`, date, kind: 'after', label: 'After school', start: toTime(start), end: toTime(end), minutes: end - start });
  }
  return slots;
}

/**
 * Whether work in `slot` is done in time: on an earlier day, or on the due day itself only when the task has a due
 * time and the slot ends by it. Work due on a date with no time is due when that day starts (homework is handed in in
 * class), and a test is sat that day, so neither gets a block on its due day without a time.
 */
export function beforeDue(slot: Pick<PlanSlot, 'date' | 'end'>, dueDate: string, dueTime: string | null): boolean {
  if (slot.date < dueDate) return true;
  return slot.date === dueDate && dueTime !== null && slot.end <= dueTime;
}

/** "3 h 20 m", "45 m". */
export function formatLoad(minutes: number): string {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} m` : ''}` : `${rest} m`;
}

export type CrunchTask = { id: string; title: string; dueDate: string | null; completed: boolean; workLocation?: 'in-class' | 'out-of-class' };
export type Crunch = { date: string; minutes: number; taskId: string; title: string; startDate: string };

/**
 * Days in the coming week whose estimated work is over CRUNCH_MINUTES. A day's load is the work due on it, so the
 * advice is to start the biggest piece earlier: on the lightest day between today and the day before.
 */
export function crunchDays(tasks: CrunchTask[], minutesOf: (id: string) => number | undefined, today: string, days = PLAN_DAYS, threshold = CRUNCH_MINUTES): Crunch[] {
  const load = new Map<string, Array<{ task: CrunchTask; minutes: number }>>();
  for (const task of tasks) {
    const minutes = minutesOf(task.id);
    if (task.completed || task.workLocation === 'in-class' || !task.dueDate || minutes === undefined) continue;
    const offset = daysBetween(today, task.dueDate);
    if (offset < 0 || offset >= days) continue;
    load.set(task.dueDate, [...(load.get(task.dueDate) ?? []), { task, minutes }]);
  }
  const total = (date: string) => (load.get(date) ?? []).reduce((sum, entry) => sum + entry.minutes, 0);
  const crunches: Crunch[] = [];
  for (const [date, entries] of [...load.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const minutes = total(date);
    if (minutes <= threshold) continue;
    const biggest = [...entries].sort((left, right) => right.minutes - left.minutes)[0];
    let startDate = today;
    for (let day = today; day < date; day = addDays(day, 1)) if (total(day) < total(startDate)) startDate = day;
    crunches.push({ date, minutes, taskId: biggest.task.id, title: biggest.task.title, startDate });
  }
  return crunches;
}

const weekday = (date: string) => formatDate(date, { weekday: 'long' }).split(',')[0];
/** "Wednesday looks heavy: 3 h 20 m. Start “Essay draft” Monday." */
export function crunchMessage(crunch: Crunch, today: string): string {
  const day = crunch.date === today ? 'Today' : crunch.date === addDays(today, 1) ? 'Tomorrow' : weekday(crunch.date);
  const title = crunch.title.length > 60 ? `${crunch.title.slice(0, 57)}…` : crunch.title;
  const start = crunch.date === today ? `Start with “${title}”.` : `Start “${title}” ${crunch.startDate === today ? 'today' : crunch.startDate === addDays(today, 1) ? 'tomorrow' : weekday(crunch.startDate)}.`;
  return `${day} looks heavy: ${formatLoad(crunch.minutes)}. ${start}`;
}

/** A block the student didn't mark: still planned once its time has passed. */
export function isMissed(block: Pick<PlanBlock, 'status' | 'date' | 'end'>, today: string, nowTime: string): boolean {
  return block.status === 'planned' && (block.date < today || (block.date === today && block.end <= nowTime));
}
