import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { exampleSchedule } from '@/domain/example';
import { resolveDay, type Schedule, type StudentClass } from '@/domain/schedule';
import { classmatesFor, DONE_FOR_TODAY, FREE_PERIOD, nextStops, withLabel } from '@/lib/classmates';

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
    expect(mates(summary, period('A', cs))).toEqual([{ id: evan, displayName: 'Evan', avatar: null }]);
    // The same course typed in another word order or with an honors suffix still counts (Evan's "Spanish 2 Honors" vs Parker's "Honors Spanish 2").
    setClasses(evan, { A: 'Pre-AP Computer Science', B: 'Honors Spanish 2' });
    expect(mates(community.summary(me), period('B', { id: 'z', name: 'Spanish 2 Honors' }))).toEqual([{ id: evan, displayName: 'Evan', avatar: null }]);
    expect(mates(community.summary(me), period('B', { id: 'z', name: 'Spanish 2H' }))).toEqual([{ id: evan, displayName: 'Evan', avatar: null }]);
    expect(mates(community.summary(me), period('B', { id: 'z', name: 'Spanish 3 Honors' }))).toEqual([]);
    setClasses(evan, { A: 'Pre-AP Computer Science', B: 'Biology' });
    // Same class name in a different period is not a shared class.
    expect(mates(summary, period('B', cs))).toEqual([]);
    expect(mates(summary, period('A', { id: 'y', name: 'Chemistry' }))).toEqual([]);
    expect(mates(summary, period('A'))).toEqual([]);
    community.respond(maya, me, true);
    // Maya takes the same class but in period B, so only Evan shares period A with me.
    expect(mates(community.summary(me), period('A', cs))).toEqual([{ id: evan, displayName: 'Evan', avatar: null }]);
    expect(mates(community.summary(me), period('B', cs))).toEqual([{ id: maya, displayName: 'Maya', avatar: null }]);
  });
  it('tags a friend whose spelling is a confirmed alias of my linked directory class', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const add = (name: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} P`, new Date().toISOString()); return id; };
    const me = add('Me'), sami = add('Sami');
    const school = service.createSchool(me, { name: 'Example High', location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, sami]) service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const entryId = randomUUID();
    db.prepare('INSERT INTO school_classes(id,school_id,data,version,deleted,updated_at) VALUES(?,?,?,1,0,?)').run(entryId, school.id, JSON.stringify({
      name: 'Foundations in Literature: Inquiry and Analysis', teacher: 'Polly Duke', room: '406', grades: ['9'],
      aliases: [{ name: 'Foundations in Literature: Inquiry and Analysis E', teacher: 'Polly Duke', room: '406' }],
    }), new Date().toISOString());
    const classes = [{ id: 'c0', name: 'Foundations in Literature: Inquiry and Analysis E', teacher: 'Polly Duke', room: '406' }];
    service.sync(sami, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(sami, 'personal'), data: { grade: '9', classes, assignments: { A: 'c0' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    const community = new CommunityService(service);
    community.request(me, sami); community.respond(sami, me, true);
    const summary = community.summary(me);
    expect(summary.classDirectory).toEqual([expect.objectContaining({ id: entryId, aliases: [expect.objectContaining({ name: 'Foundations in Literature: Inquiry and Analysis E' })] })]);
    const lit = { id: 'x', name: 'Foundations in Literature: Inquiry and Analysis', teacher: 'Polly Duke', room: '406', directoryId: entryId };
    expect(mates(summary, period('A', lit))).toEqual([{ id: sami, displayName: 'Sami', avatar: null }]);
    expect(mates({ ...summary, classDirectory: [] }, period('A', lit))).toEqual([]);
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
    expect(mates(community.summary(me), biology)).toEqual([{ id: maya, displayName: 'Maya', avatar: null }]);
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
    expect(mates(community.summary(me), chemistry, { ...exampleSchedule, gradeSchedules: { '10': later } })).toEqual([{ id: ian, displayName: 'Ian', avatar: null }]);

    service.sync(ian, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(ian, 'personal'), data: { ...personal, grade: '9', dateOverrides: [{ date, shiftMinutes: 15 }] } });
    expect(mates(community.summary(me), chemistry, { ...exampleSchedule, gradeSchedules: { '10': later } })).toEqual([]);
  });
  it('groups classmates by where they go after class', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const add = (name: string) => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} P`, new Date().toISOString()); return id; };
    const me = add('Me'), evan = add('Evan'), maya = add('Maya'), ian = add('Ian');
    const school = service.createSchool(me, { name: 'Example High', location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, evan, maya, ian]) service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const setClasses = (id: string, classes: StudentClass[], assignments: Record<string, string>) =>
      service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: { grade: '9', classes, assignments, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    const art = { id: 'art', name: 'Digital Design' };
    setClasses(evan, [art, { id: 'bio', name: 'Biology', room: 'STU 2' }], { A: 'art', B: 'bio' });
    // Same next class and room in other casing joins Evan's group; Ian has nothing in B, so B is a free period for him.
    setClasses(maya, [art, { id: 'b', name: 'biology', room: 'stu 2 ' }], { A: 'art', B: 'b' });
    setClasses(ian, [art, { id: 'chem', name: 'Chemistry' }], { A: 'art', C: 'chem' });
    db.prepare('UPDATE users SET avatar_version=3 WHERE id=?').run(maya);
    const community = new CommunityService(service);
    for (const id of [evan, maya, ian]) { community.request(me, id); community.respond(id, me, true); }
    const summary = community.summary(me);
    const first = period('A', { id: 'mine', name: 'Digital Design' });
    const found = mates(summary, first);
    expect(found.map((mate) => mate.displayName)).toEqual(['Evan', 'Ian', 'Maya']);
    expect(found.find((mate) => mate.id === maya)?.avatar).toBe(`/api/avatars/${maya}?v=3`);
    const stops = nextStops({ community: summary }, exampleSchedule, date, first, found);
    expect(stops.map((stop) => [stop.title, stop.room, stop.classmates.map((mate) => mate.displayName)])).toEqual([
      ['Biology', 'STU 2', ['Evan', 'Maya']],
      [FREE_PERIOD, null, ['Ian']],
    ]);
    // After the last period of the day everyone is done.
    const last = period('C', { id: 'mine', name: 'Chemistry' });
    expect(nextStops({ community: summary }, exampleSchedule, date, last, found).map((stop) => [stop.title, stop.classmates.length])).toEqual([[DONE_FOR_TODAY, 3]]);
  });
  it('phrases the label naturally', () => {
    expect(withLabel([])).toBeNull();
    expect(withLabel(['Evan'])).toBe('With Evan');
    expect(withLabel(['Evan', 'Maya'])).toBe('With Evan and Maya');
    expect(withLabel(['Evan', 'Maya', 'Sam', 'Lee'])).toBe('With Evan, Maya and 2 more');
    expect(withLabel([{ displayName: 'Evan' }, { displayName: 'Maya' }])).toBe('With Evan and Maya');
  });
});
