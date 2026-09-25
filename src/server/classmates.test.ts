import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { exampleSchedule } from '@/domain/example';
import { resolveDay, type Schedule, type StudentClass } from '@/domain/schedule';
import { classmatesFor, withLabel } from '@/lib/classmates';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
const date = '2026-09-08';
const period = (periodId: string, cls?: StudentClass) => {
  const slot = resolveDay(exampleSchedule, date).periods.find((entry) => entry.periodId === periodId)!;
  return { ...slot, ...(cls ? { class: cls } : {}) };
};
const mates = (community: ReturnType<CommunityService['summary']>, entry: ReturnType<typeof period>, schedule: Schedule = exampleSchedule) => classmatesFor({ community }, schedule, date, entry);

describe('classmates on the timetable', () => {
  it('tags a period only when an accepted friend has the same class in the same period', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const add = (name: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} P`, new Date().toISOString()); return id; };
    const me = add('Me'), evan = add('Evan'), maya = add('Maya');
    const school = service.createSchool(me, { name: 'Example High', location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, evan, maya]) service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const setClasses = (id: string, byPeriod: Record<string, string>) => {
      const names = [...new Set(Object.values(byPeriod))];
      const classes = names.map((name, index) => ({ id: `c${index}`, name }));
      const assignments = Object.fromEntries(Object.entries(byPeriod).map(([periodId, name]) => [periodId, classes.find(cls => cls.name === name)!.id]));
      service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: { grade: '9', classes, assignments, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    };
    setClasses(evan, { A: 'Pre-AP Computer Science', B: 'Biology' });
    setClasses(maya, { B: 'pre-ap computer science' });
    const community = new CommunityService(service);
    community.request(me, evan); community.respond(evan, me, true);
    community.request(me, maya);
    const summary = community.summary(me);
    expect(summary.classmates).toMatchObject([{ id: evan, displayName: 'Evan', personal: { grade: '9', assignments: { A: 'c0', B: 'c1' } } }]);
    const cs = { id: 'x', name: 'Pre-AP Computer Science ' };
    expect(mates(summary, period('A', cs))).toEqual([{ id: evan, displayName: 'Evan' }]);
    // The same course typed in another word order or with an honors suffix still counts (Evan's "Spanish 2 Honors" vs Parker's "Honors Spanish 2").
    setClasses(evan, { A: 'Pre-AP Computer Science', B: 'Honors Spanish 2' });
    expect(mates(community.summary(me), period('B', { id: 'z', name: 'Spanish 2 Honors' }))).toEqual([{ id: evan, displayName: 'Evan' }]);
    expect(mates(community.summary(me), period('B', { id: 'z', name: 'Spanish 2H' }))).toEqual([{ id: evan, displayName: 'Evan' }]);
    expect(mates(community.summary(me), period('B', { id: 'z', name: 'Spanish 3 Honors' }))).toEqual([]);
    setClasses(evan, { A: 'Pre-AP Computer Science', B: 'Biology' });
    // Same class name in a different period is not a shared class.
    expect(mates(summary, period('B', cs))).toEqual([]);
    expect(mates(summary, period('A', { id: 'y', name: 'Chemistry' }))).toEqual([]);
    expect(mates(summary, period('A'))).toEqual([]);
    community.respond(maya, me, true);
    // Maya takes the same class but in period B, so only Evan shares period A with me.
    expect(mates(community.summary(me), period('A', cs))).toEqual([{ id: evan, displayName: 'Evan' }]);
    expect(mates(community.summary(me), period('B', cs))).toEqual([{ id: maya, displayName: 'Maya' }]);
  });
  it('never tags a friend who has moved to another school, even when the period ids collide', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const add = (name: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} P`, new Date().toISOString()); return id; };
    const me = add('Me'), maya = add('Maya');
    const first = service.createSchool(me, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
    const second = service.createSchool(maya, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, maya]) service.join(id, { schoolId: first.id, choice: 'community', grade: '9' });
    const classes = [{ id: 'c0', name: 'Biology' }];
    service.sync(maya, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(maya, 'personal'), data: { grade: '9', classes, assignments: { A: 'c0' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    const community = new CommunityService(service);
    community.request(me, maya); community.respond(maya, me, true);
    const biology = period('A', { id: 'b', name: 'Biology' });
    expect(mates(community.summary(me), biology)).toEqual([{ id: maya, displayName: 'Maya' }]);
    // Maya moves; the friendship and her period A Biology survive, but Other High's period A is not mine.
    service.join(maya, { schoolId: second.id, choice: 'community', grade: '9' });
    const summary = community.summary(me);
    expect(summary.friendCount).toBe(1);
    expect(summary.classmates).toEqual([]);
    expect(mates(summary, biology)).toEqual([]);
    expect(community.summary(maya).classmates).toEqual([]);
  });
  it('does not tag the same course and period ID when grade schedules meet at different times', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const add = (name: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} P`, new Date().toISOString()); return id; };
    const me = add('Me'), ian = add('Ian');
    const later = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map((day) => ({ ...day, slots: day.slots.map((slot) => ({ ...slot, start: `${String(Number(slot.start.slice(0, 2)) + 1).padStart(2, '0')}${slot.start.slice(2)}`, end: `${String(Number(slot.end.slice(0, 2)) + 1).padStart(2, '0')}${slot.end.slice(2)}` })) })) };
    const school = service.createSchool(me, { name: 'Example High', location: 'Boston, MA', schedule: { ...exampleSchedule, gradeSchedules: { '10': later } } });
    service.join(me, { schoolId: school.id, choice: 'community', grade: '9' });
    service.join(ian, { schoolId: school.id, choice: 'community', grade: '10' });
    const personal = { grade: '10' as const, classes: [{ id: 'chem', name: 'Honors Chemistry' }], assignments: { A: 'chem' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null };
    service.sync(ian, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(ian, 'personal'), data: personal });
    const community = new CommunityService(service);
    community.request(me, ian); community.respond(ian, me, true);
    const chemistry = period('A', { id: 'mine', name: 'Honors Chemistry' });
    expect(mates(community.summary(me), chemistry, { ...exampleSchedule, gradeSchedules: { '10': later } })).toEqual([]);

    // Once Ian's actual meeting moves to the same time, the badge becomes accurate.
    service.sync(ian, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(ian, 'personal'), data: { ...personal, grade: '9' } });
    expect(mates(community.summary(me), chemistry, { ...exampleSchedule, gradeSchedules: { '10': later } })).toEqual([{ id: ian, displayName: 'Ian' }]);

    service.sync(ian, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(ian, 'personal'), data: { ...personal, grade: '9', dateOverrides: [{ date, shiftMinutes: 15 }] } });
    expect(mates(community.summary(me), chemistry, { ...exampleSchedule, gradeSchedules: { '10': later } })).toEqual([]);
  });
  it('phrases the label naturally', () => {
    expect(withLabel([])).toBeNull();
    expect(withLabel(['Evan'])).toBe('With Evan');
    expect(withLabel(['Evan', 'Maya'])).toBe('With Evan and Maya');
    expect(withLabel(['Evan', 'Maya', 'Sam', 'Lee'])).toBe('With Evan, Maya and 2 more');
    expect(withLabel([{ displayName: 'Evan' }, { displayName: 'Maya' }])).toBe('With Evan and Maya');
  });
});
