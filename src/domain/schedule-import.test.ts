import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { exampleSchedule } from './example';
import type { FeedItem } from './ical';
import { emptyPersonalSchedule, resolveDay, type PersonalSchedule } from './schedule';
import { applyScheduleImport, classKey, previewScheduleImport, readScheduleFeed } from './schedule-import';

const TITLES: Record<string, { title: string; room: string }> = {
  A: { title: 'Algebra II - 3', room: 'Room 101' }, B: { title: 'English 10', room: 'Room 204' },
  C: { title: 'Biology', room: 'Lab 2' }, D: { title: 'US History', room: 'Room 305' },
};
const START = '2026-09-14', END = '2026-10-23';
const pad = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const shift = (time: string, by: number) => pad(Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + by);

/** One event per class meeting, as a Veracross class schedule feed has, a few minutes off the school's bell times. */
function feed(titles = TITLES, options: { skip?: (date: string, periodId: string) => boolean; extra?: FeedItem[] } = {}): FeedItem[] {
  const items: FeedItem[] = [];
  for (let date = Temporal.PlainDate.from(START); Temporal.PlainDate.compare(date, Temporal.PlainDate.from(END)) <= 0; date = date.add({ days: 1 })) {
    const day = resolveDay(exampleSchedule, date.toString());
    for (const period of day.periods) {
      const meeting = titles[period.periodId];
      if (!meeting || options.skip?.(day.date, period.periodId)) continue;
      items.push(item(day.date, shift(period.start, 5), shift(period.end, -5), meeting.title, meeting.room));
    }
  }
  return [...items, ...options.extra ?? []];
}
function item(date: string, startTime: string, endTime: string, title: string, location?: string): FeedItem {
  return { uid: `${date}-${startTime}-${title}`, recurrenceId: null, title, notes: '', startDate: date, startTime, endDate: date, endTime, dueDate: date, dueTime: startTime,
    timeZone: 'America/New_York', allDay: false, cancelled: false, url: null, ...(location ? { location } : {}) };
}
const read = (items: FeedItem[], personal: PersonalSchedule = emptyPersonalSchedule()) => readScheduleFeed(items, exampleSchedule, personal, START, END);

describe('reading a class schedule feed', () => {
  it('places each class on the block it meets in, with its usual room', () => {
    const reading = read(feed());
    expect(reading.classes.map(cls => [cls.name, cls.room, cls.periodIds])).toEqual(expect.arrayContaining([
      ['Algebra II - 3', 'Room 101', ['A']], ['English 10', 'Room 204', ['B']], ['Biology', 'Lab 2', ['C']], ['US History', 'Room 305', ['D']],
    ]));
    expect(reading.classes).toHaveLength(4);
    expect(reading.unmatched).toBe(0);
  });

  it('ignores lunch and meetings that line up with no block, and calls a block with no meetings free', () => {
    const extra = [item('2026-09-15', '10:15', '10:45', 'Lunch'), item('2026-09-15', '15:00', '16:00', 'Soccer practice')];
    const reading = read(feed({ A: TITLES.A, B: TITLES.B, C: TITLES.C }, { extra }));
    expect(reading.classes.map(cls => cls.name).sort()).toEqual(['Algebra II - 3', 'Biology', 'English 10']);
    expect(reading.freePeriodIds).toEqual(['D']);
    expect(reading.unmatched).toBe(2);
  });

  it('keeps the majority when a special day puts another class in a block', () => {
    const extra = [item('2026-09-16', '08:05', '08:55', 'Assembly')];
    const reading = read(feed(TITLES, { skip: (date, periodId) => date === '2026-09-16' && periodId === exampleSchedule.cycleDays[6].slots[0].periodId, extra }));
    expect(reading.classes.find(cls => cls.name === 'Assembly')).toBeUndefined();
  });

  it('leaves a block alone when its meetings split evenly between classes', () => {
    let flip = false;
    const titles = { ...TITLES };
    const items = feed(titles).map(entry => entry.title === 'Biology' ? { ...entry, title: (flip = !flip) ? 'Biology' : 'Chemistry' } : entry);
    const reading = read(items);
    expect(reading.unsettledPeriodIds).toEqual(['C']);
    expect(reading.classes.map(cls => cls.name)).not.toContain('Biology');
  });
});

describe('applying a class schedule to the timetable', () => {
  it('fills the blocks on the first sync, reusing a saved class with the same name', () => {
    const personal: PersonalSchedule = { ...emptyPersonalSchedule(), classes: [{ id: 'bio', name: 'biology', color: '#123456' }], assignments: { C: 'bio', D: 'bio' } };
    const { personal: next, summary, state } = applyScheduleImport(personal, read(feed()), null);
    expect(next.classes.find(cls => cls.id === 'bio')).toEqual({ id: 'bio', name: 'biology', color: '#123456', room: 'Lab 2' });
    expect(next.assignments.C).toBe('bio');
    expect(next.classes.find(cls => cls.id === next.assignments.D)?.name).toBe('US History');
    expect(summary).toMatchObject({ classes: 4, blocks: 4, added: ['Algebra II - 3', 'English 10', 'US History'], kept: 0 });
    expect(state.classes[classKey('Biology')]).toEqual({ classId: 'bio', room: 'Lab 2' });
  });

  it('keeps blocks and rooms the student changed after a sync, and follows the feed elsewhere', () => {
    const first = applyScheduleImport(emptyPersonalSchedule(), read(feed()), null);
    const algebra = first.personal.assignments.A, english = first.personal.assignments.B;
    // The student swaps A for English and renames a room; the school moves History to a new room.
    const edited: PersonalSchedule = { ...first.personal, assignments: { ...first.personal.assignments, A: english },
      classes: first.personal.classes.map(cls => cls.id === english ? { ...cls, room: 'Library' } : cls) };
    const moved = feed({ ...TITLES, D: { title: 'US History', room: 'Room 400' } });
    const second = applyScheduleImport(edited, read(moved), first.state);
    expect(second.personal.assignments.A).toBe(english);
    expect(second.summary.kept).toBe(1);
    expect(second.personal.classes.find(cls => cls.id === english)?.room).toBe('Library');
    expect(second.personal.classes.find(cls => cls.name === 'US History')?.room).toBe('Room 400');
    expect(second.personal.classes.some(cls => cls.id === algebra)).toBe(true);
  });

  it('clears a block the feed now leaves free, unless the student filled it themselves', () => {
    const first = applyScheduleImport(emptyPersonalSchedule(), read(feed()), null);
    const dropped = feed({ A: TITLES.A, B: TITLES.B, C: TITLES.C });
    expect(applyScheduleImport(first.personal, read(dropped), first.state).personal.assignments.D).toBeUndefined();
    const own = { ...first.personal, assignments: { ...first.personal.assignments, D: first.personal.assignments.A } };
    expect(applyScheduleImport(own, read(dropped), first.state).personal.assignments.D).toBe(first.personal.assignments.A);
  });

  it('does not bring back a class the student removed', () => {
    const first = applyScheduleImport(emptyPersonalSchedule(), read(feed()), null);
    const history = first.personal.assignments.D;
    const removed: PersonalSchedule = { ...first.personal, classes: first.personal.classes.filter(cls => cls.id !== history),
      assignments: Object.fromEntries(Object.entries(first.personal.assignments).filter(([, id]) => id !== history)) };
    const second = applyScheduleImport(removed, read(feed()), first.state);
    expect(second.personal.classes.some(cls => cls.name === 'US History')).toBe(false);
    expect(second.personal.assignments.D).toBeUndefined();
    const third = applyScheduleImport(second.personal, read(feed()), second.state);
    expect(third.personal.classes.some(cls => cls.name === 'US History')).toBe(false);
  });

  it('leaves out a class the student unticked, now and on later syncs, until they tick it again', () => {
    const history = classKey('US History');
    const first = applyScheduleImport(emptyPersonalSchedule(), read(feed()), null, { [history]: false });
    expect(first.personal.classes.map(cls => cls.name)).not.toContain('US History');
    expect(first.personal.assignments.D).toBeUndefined();
    const daily = applyScheduleImport(first.personal, read(feed()), first.state);
    expect(daily.personal.classes.map(cls => cls.name)).not.toContain('US History');
    expect(previewScheduleImport(daily.personal, read(feed()), daily.state).find(row => row.key === history)?.included).toBe(false);
    const ticked = applyScheduleImport(daily.personal, read(feed()), daily.state, { [history]: true });
    expect(ticked.personal.classes.find(cls => cls.id === ticked.personal.assignments.D)?.name).toBe('US History');
  });
});

describe('previewing a class schedule', () => {
  it('says which blocks each class takes, what it replaces, and saves nothing', () => {
    const personal: PersonalSchedule = { ...emptyPersonalSchedule(), classes: [{ id: 'bio', name: 'Biology' }, { id: 'art', name: 'Art' }], assignments: { A: 'art', C: 'bio' } };
    const rows = previewScheduleImport(personal, read(feed()), null);
    expect(rows.find(row => row.name === 'Algebra II - 3')).toMatchObject({ periodIds: ['A'], included: true, existing: false, replaces: [{ periodId: 'A', name: 'Art' }], kept: [] });
    expect(rows.find(row => row.name === 'Biology')).toMatchObject({ periodIds: ['C'], existing: true, replaces: [], room: 'Lab 2' });
    expect(rows.every(row => row.meetings > 5)).toBe(true);
    expect(personal.assignments).toEqual({ A: 'art', C: 'bio' });
  });

  it('marks blocks the student changed after a sync as kept', () => {
    const first = applyScheduleImport(emptyPersonalSchedule(), read(feed()), null);
    const edited = { ...first.personal, assignments: { ...first.personal.assignments, A: first.personal.assignments.B } };
    expect(previewScheduleImport(edited, read(feed()), first.state).find(row => row.name === 'Algebra II - 3')?.kept).toEqual(['A']);
  });
});

