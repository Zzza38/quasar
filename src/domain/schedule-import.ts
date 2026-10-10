import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { slugId } from '@/lib/format';
import type { FeedItem } from './ical';
import { classSchema, effectiveSchedule, resolveDay, type PersonalSchedule, type Schedule } from './schedule';

/**
 * Filling a student's timetable from a class-schedule calendar feed (Veracross "Class Schedules" and similar), where
 * every class meeting is its own event. Each meeting is placed on the school block it overlaps on that date, and each
 * block takes the class that meets in it most of the time. Only class blocks are filled; lunch and other periods, and
 * meetings that line up with no block, are left alone.
 */

/** How many days around today are read. Enough for every day of a long rotation to come up a few times. */
export const IMPORT_DAYS_BEFORE = 28;
export const IMPORT_DAYS_AFTER = 42;

/** What one sync last wrote, so a later sync can tell the source's changes from the student's own edits. */
export const importStateSchema = z.object({
  /** By class key (normalized feed title): the class it became, the room it last gave, and whether the student removed it. */
  classes: z.record(z.string(), z.object({ classId: z.string(), room: z.string().optional(), removed: z.boolean().optional() })),
  /** By period: the class the feed placed there. */
  assignments: z.record(z.string(), z.string()),
});
export type ImportState = z.infer<typeof importStateSchema>;

export interface ImportedClass {
  key: string;
  name: string;
  room?: string;
  /** Blocks this class wins: it is the majority of the matched meetings there. */
  periodIds: string[];
  meetings: number;
}

export interface FeedReading {
  classes: ImportedClass[];
  /** Class blocks that came up on days the feed covers but held no meeting: free blocks. */
  freePeriodIds: string[];
  /** Blocks whose meetings split between classes with no majority; left as they are. */
  unsettledPeriodIds: string[];
  matched: number;
  unmatched: number;
}

export interface ImportSummary {
  classes: number;
  blocks: number;
  added: string[];
  /** Blocks the student set to something else after an earlier sync; left as the student set them. */
  kept: number;
  cleared: number;
  unmatched: number;
}

/** The key that identifies a feed class across syncs: its title, case and spacing ignored. */
export const classKey = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Places the feed's meetings from `windowStart` to `windowEnd` on the student's blocks. A meeting belongs to the class
 * block it overlaps for at least half of the shorter of the two, so a bell schedule a few minutes off still matches.
 */
export function readScheduleFeed(items: FeedItem[], school: Schedule, personal: PersonalSchedule, windowStart: string, windowEnd: string): FeedReading {
  const schedule = effectiveSchedule(school, personal);
  const classPeriods = new Set(schedule.periods.filter(period => period.kind === 'class').map(period => period.id));
  const meetings = items.filter(item => !item.cancelled && !item.allDay && item.startTime && item.endTime && item.endDate === item.startDate
    && item.startDate >= windowStart && item.startDate <= windowEnd && classKey(item.title));
  const byDate = new Map<string, FeedItem[]>();
  for (const item of meetings) byDate.set(item.startDate, [...byDate.get(item.startDate) ?? [], item]);
  const votes = new Map<string, Map<string, number>>();
  const names = new Map<string, Map<string, number>>();
  const rooms = new Map<string, Map<string, number>>();
  const count = <K>(map: Map<string, Map<K, number>>, key: string, value: K) => {
    const inner = map.get(key) ?? new Map<K, number>();
    inner.set(value, (inner.get(value) ?? 0) + 1);
    map.set(key, inner);
  };
  let matched = 0;
  let unmatched = 0;
  for (const [date, dayItems] of byDate) {
    const day = resolveDay(school, date, personal);
    if (day.closed) { unmatched += dayItems.length; continue; }
    const blocks = day.periods.filter(period => classPeriods.has(period.periodId));
    const filled = new Set<string>();
    for (const item of dayItems) {
      const start = minutes(item.startTime!);
      const end = minutes(item.endTime!);
      let best: { periodId: string; overlap: number } | null = null;
      for (const block of blocks) {
        const overlap = Math.min(end, minutes(block.end)) - Math.max(start, minutes(block.start));
        if (overlap <= 0 || overlap * 2 < Math.min(end - start, minutes(block.end) - minutes(block.start))) continue;
        if (!best || overlap > best.overlap) best = { periodId: block.periodId, overlap };
      }
      if (!best) { unmatched += 1; continue; }
      matched += 1;
      const key = classKey(item.title);
      filled.add(best.periodId);
      count(votes, best.periodId, key);
      count(names, key, item.title.trim().replace(/\s+/g, ' '));
      if (item.location) count(rooms, key, item.location);
    }
    // A block with no meeting on a day the feed has meetings is free that day.
    for (const block of blocks) if (!filled.has(block.periodId)) count(votes, block.periodId, '');
  }
  const top = <K>(counts: Map<K, number> | undefined): [K, number] | undefined => counts && [...counts].sort((left, right) => right[1] - left[1])[0];
  const winners = new Map<string, string[]>();
  const freePeriodIds: string[] = [];
  const unsettledPeriodIds: string[] = [];
  for (const period of schedule.periods) {
    const counts = votes.get(period.id);
    if (!counts || counts.size === 0) continue;
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const [key, n] = top(counts)!;
    if (n * 2 <= total) { unsettledPeriodIds.push(period.id); continue; }
    if (key === '') { freePeriodIds.push(period.id); continue; }
    winners.set(key, [...winners.get(key) ?? [], period.id]);
  }
  const classes = [...winners].map(([key, periodIds]): ImportedClass => {
    const room = top(rooms.get(key))?.[0];
    return { key, name: top(names.get(key))![0].slice(0, 120).trim(), ...(room ? { room } : {}), periodIds, meetings: [...names.get(key)!.values()].reduce((sum, value) => sum + value, 0) };
  });
  return { classes, freePeriodIds, unsettledPeriodIds, matched, unmatched };
}

/**
 * The student's answer for each feed class on the review screen, by class key: true adds it (even one they removed
 * after an earlier sync), false leaves it out. Classes not listed follow the earlier state.
 */
export type ImportChoices = Record<string, boolean>;

/**
 * Writes a reading into the student's classes and blocks. With no earlier state (the first sync) every block the feed
 * settles is filled. After that a block only changes while it still holds what the last sync put there, so a block
 * the student reassigned keeps their choice. A class the student left out on the review screen, or removed after a
 * sync added it, stays out until they include it on a later review. Saved classes are reused by name; a reused class
 * keeps its colour and teacher, and its room follows the feed unless the student changed it.
 */
export function applyScheduleImport(personal: PersonalSchedule, reading: FeedReading, previous: ImportState | null, choices: ImportChoices = {}): { personal: PersonalSchedule; state: ImportState; summary: ImportSummary } {
  const classes = [...personal.classes];
  const assignments = { ...personal.assignments };
  const state: ImportState = { classes: {}, assignments: {} };
  const summary: ImportSummary = { classes: 0, blocks: 0, added: [], kept: 0, cleared: 0, unmatched: reading.unmatched };
  // A block is the sync's while it holds what the last sync left there, empty included; a block the student filled,
  // changed or cleared since is theirs.
  const owns = (periodId: string) => !previous || assignments[periodId] === previous.assignments[periodId];
  for (const imported of reading.classes) {
    const earlier = previous?.classes[imported.key];
    const leaveOut = () => { state.classes[imported.key] = { classId: earlier?.classId ?? '', ...(earlier?.room ? { room: earlier.room } : {}), removed: true }; };
    if (choices[imported.key] === false || (earlier?.removed && choices[imported.key] !== true)) { leaveOut(); continue; }
    let index = earlier && !earlier.removed ? classes.findIndex(cls => cls.id === earlier.classId) : -1;
    if (index < 0) index = classes.findIndex(cls => classKey(cls.name) === imported.key);
    // The student removed this class after a sync added it: leave it and its blocks alone.
    if (index < 0 && earlier && !earlier.removed && choices[imported.key] !== true) { leaveOut(); continue; }
    if (index < 0) {
      classes.push(classSchema.parse({ id: slugId(imported.name, classes.map(cls => cls.id), 'class'), name: imported.name, ...(imported.room ? { room: imported.room } : {}) }));
      index = classes.length - 1;
      summary.added.push(imported.name);
    } else if (imported.room && classes[index].room !== imported.room && (!classes[index].room?.trim() || classes[index].room === earlier?.room)) {
      classes[index] = { ...classes[index], room: imported.room };
    }
    const classId = classes[index].id;
    state.classes[imported.key] = { classId, ...(imported.room ? { room: imported.room } : {}) };
    summary.classes += 1;
    for (const periodId of imported.periodIds) {
      state.assignments[periodId] = classId;
      if (owns(periodId)) { assignments[periodId] = classId; summary.blocks += 1; }
      else if (assignments[periodId] !== classId) summary.kept += 1;
      else summary.blocks += 1;
    }
  }
  // Removed classes stay remembered even when they no longer appear in the feed this time.
  for (const [key, entry] of Object.entries(previous?.classes ?? {})) if (entry.removed && !state.classes[key]) state.classes[key] = entry;
  for (const periodId of reading.freePeriodIds) {
    const earlier = previous?.assignments[periodId];
    if (earlier && assignments[periodId] === earlier) { delete assignments[periodId]; summary.cleared += 1; }
  }
  // Blocks the feed cannot settle this time keep whatever they hold, and keep counting as the sync's if they were.
  for (const periodId of reading.unsettledPeriodIds) {
    const earlier = previous?.assignments[periodId];
    if (earlier && assignments[periodId] === earlier) state.assignments[periodId] = earlier;
  }
  return { personal: { ...personal, classes, assignments }, state, summary };
}

/** The dates a sync reads, in the school's time zone. */
export function importWindow(timeZone: string, now: Date): { windowStart: string; windowEnd: string } {
  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone).toPlainDate();
  return { windowStart: today.subtract({ days: IMPORT_DAYS_BEFORE }).toString(), windowEnd: today.add({ days: IMPORT_DAYS_AFTER }).toString() };
}

/** One feed class on the review screen: where it goes and what that changes. */
export interface ImportPreviewRow {
  key: string;
  name: string;
  room?: string;
  meetings: number;
  periodIds: string[];
  /** Whether it starts ticked: false for a class the student left out or removed before. */
  included: boolean;
  /** A saved class with this name is reused instead of adding one. */
  existing: boolean;
  /** Blocks that now hold another class, which this one would replace. */
  replaces: { periodId: string; name: string }[];
  /** Blocks the student set to another class after an earlier sync; those keep the student's choice. */
  kept: string[];
}

/** What applyScheduleImport would do with every class included, for the student to confirm before anything is saved. */
export function previewScheduleImport(personal: PersonalSchedule, reading: FeedReading, previous: ImportState | null): ImportPreviewRow[] {
  const all = Object.fromEntries(reading.classes.map(imported => [imported.key, true]));
  const { personal: next } = applyScheduleImport(personal, reading, previous, all);
  const nameOf = (id: string | undefined) => personal.classes.find(cls => cls.id === id)?.name;
  return reading.classes.map(imported => {
    const earlier = previous?.classes[imported.key];
    const classId = next.classes.find(cls => cls.id === (earlier && !earlier.removed ? earlier.classId : undefined))?.id
      ?? next.classes.find(cls => classKey(cls.name) === imported.key)!.id;
    const replaces = imported.periodIds.flatMap(periodId => {
      const before = personal.assignments[periodId];
      const name = nameOf(before);
      return before && before !== classId && next.assignments[periodId] === classId && name ? [{ periodId, name }] : [];
    });
    return { key: imported.key, name: imported.name, ...(imported.room ? { room: imported.room } : {}), meetings: imported.meetings, periodIds: imported.periodIds,
      included: !earlier?.removed && !(earlier && !personal.classes.some(cls => cls.id === earlier.classId) && !personal.classes.some(cls => classKey(cls.name) === imported.key)),
      existing: personal.classes.some(cls => cls.id === classId),
      replaces, kept: imported.periodIds.filter(periodId => next.assignments[periodId] !== classId) };
  });
}
