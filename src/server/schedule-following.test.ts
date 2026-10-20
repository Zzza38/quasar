import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cycleDaySlots, diffCycleDaySlots, emptyPersonalSchedule, personalScheduleSchema, PERSONAL_SCHEDULE_CLIENT_VERSION, type Schedule } from '@/domain/schedule';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { BetaService } from './betas';
import { SCHEDULE_FOLLOWING_BETA } from '@/domain/betas';
import { ProposalService } from './proposals';
import { appRouter, OUTDATED_CLIENT_MESSAGE } from './router';

const schedule: Schedule = {
  version: 1, timeZone: 'America/New_York', periods: [{ id: 'A', label: 'A', kind: 'class' }, { id: 'B', label: 'B', kind: 'class' }],
  cycleDays: [{ id: 'day1', label: 'Day 1', slots: [{ id: 'a', periodId: 'A', start: '08:00', end: '09:00' }, { id: 'b', periodId: 'B', start: '10:00', end: '11:00' }] }],
  anchorDate: '2026-09-08', anchorCycleDayId: 'day1', schoolWeekdays: [1, 2, 3, 4, 5], advanceWeekdays: [1, 2, 3, 4, 5], exceptions: [],
};
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(enrolled = true) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = (email = `${randomUUID()}@example.com`) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
    return id;
  };
  const owner = user('owner@example.com'), student = user();
  const betas = new BetaService(service);
  betas.create(owner, { key: SCHEDULE_FOLLOWING_BETA, name: 'Schedule following', description: '', code: 'FOLLOW2026', maxMembers: null });
  const enroll = (id: string) => betas.join(id, { code: 'FOLLOW2026' });
  const school = service.createSchool(student, { name: 'Following High', location: 'Boston', schedule });
  service.join(student, { schoolId: school.id, choice: 'community', grade: '10' });
  if (enrolled) enroll(student);
  const read = () => personalScheduleSchema.parse(service.entity(student, 'personal')!.data);
  const publish = (draft: Schedule, version: number) => service.updateSchool(owner, { schoolId: school.id, expectedVersion: version, schedule: draft, approved: true, supportLocked: false }, true);
  return { db, service, owner, student, school, user, read, publish, betas, enroll };
}
const moved = (start: string) => ({ ...schedule, cycleDays: [{ ...schedule.cycleDays[0], slots: schedule.cycleDays[0].slots.map(slot => slot.id === 'a' ? { ...slot, start } : slot) }] });

describe('following school corrections', () => {
  it('migrates a legacy copy against the member\'s reviewed revision and inherits later untouched blocks', () => {
    const f = fixture();
    const legacy = { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slots: moved('08:05').cycleDays[0].slots }] };
    // Simulate a copy saved before granular overrides, while two newer revisions have not been reviewed.
    const newer = { ...schedule, cycleDays: [{ ...schedule.cycleDays[0], slots: schedule.cycleDays[0].slots.map(slot => slot.id === 'b' ? { ...slot, start: '10:10' } : slot) }] };
    f.publish(newer, 1);
    f.db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(JSON.stringify(legacy), f.student);
    f.publish({ ...newer, exceptions: [{ date: '2026-12-25', kind: 'closure', advanceCycle: false }] }, 2);
    expect(f.read().cycleDayOverrides[0].slotChanges).toEqual({ a: { start: '08:05', base: schedule.cycleDays[0].slots[0] } });
    expect(cycleDaySlots(newer.cycleDays[0], f.read()).map(slot => slot.start)).toEqual(['08:05', '10:10']);
    const adopted = { ...newer, cycleDays: [{ ...newer.cycleDays[0], slots: newer.cycleDays[0].slots.map(slot => slot.id === 'a' ? { ...slot, start: '08:05' } : slot) }] };
    f.publish(adopted, 3);
    expect(f.read().cycleDayOverrides).toEqual([]);
    const version = f.service.entity(f.student, 'personal')!.version;
    f.service.workspace(f.student);
    expect(f.service.entity(f.student, 'personal')!.version).toBe(version);
  });

  it('accepts a queued legacy class edit after migration without pinning newly corrected school times', () => {
    const f = fixture();
    const old = f.service.entity(f.student, 'personal')!;
    const legacy = { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slots: moved('08:05').cycleDays[0].slots }] };
    const first = f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: old, data: legacy });
    expect(first.status).toBe('applied');
    const recorded = f.service.entity(f.student, 'personal')!;
    const newer = { ...moved('08:05'), cycleDays: [{ ...schedule.cycleDays[0], slots: moved('08:05').cycleDays[0].slots.map(slot => slot.id === 'b' ? { ...slot, start: '10:10' } : slot) }] };
    f.publish(newer, 1);
    const result = f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: recorded, data: { ...recorded.data, classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' } } });
    expect(result.status).toBe('applied');
    expect(f.read()).toMatchObject({ classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' }, cycleDayOverrides: [], customSchedule: null });
    expect(cycleDaySlots(newer.cycleDays[0], f.read())[1].start).toBe('10:10');
  });

  it('removes adopted edits when a proposal passes while retaining classes and date adjustments', () => {
    const f = fixture();
    const members = [f.student, ...Array.from({ length: 9 }, () => f.user())];
    for (const id of members) {
      if (id !== f.student) f.service.join(id, { schoolId: f.school.id, choice: 'community', grade: '10' });
      f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(id, f.school.id, 'support', new Date().toISOString());
    }
    const base = f.service.entity(f.student, 'personal')!;
    const personal = { ...f.read(), classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' }, dateOverrides: [{ date: '2026-10-19', shiftMinutes: 15 }], cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: personal });
    const nonmember = members[1];
    const nonmemberBase = f.service.entity(nonmember, 'personal')!;
    f.service.sync(nonmember, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: nonmemberBase, data: { ...nonmemberBase.data, cycleDayOverrides: [{ cycleDayId: 'day1', slots: moved('08:05').cycleDays[0].slots }] } });
    const nonmemberSaved = f.service.entity(nonmember, 'personal');
    const proposals = new ProposalService(f.service);
    const proposal = proposals.create(f.student, { schoolId: f.school.id, baseVersion: 1, schedule: moved('08:05'), summary: 'Correct the first bell time for our school.' });
    proposals.vote(members[1], { proposalId: proposal.id, vote: 'for' });
    expect(proposals.vote(members[2], { proposalId: proposal.id, vote: 'for' }).status).toBe('passed');
    expect(f.service.entity(nonmember, 'personal')).toEqual(nonmemberSaved);
    expect(f.read()).toMatchObject({ classes: personal.classes, assignments: personal.assignments, dateOverrides: personal.dateOverrides, cycleDayOverrides: [] });
  });

  it('asks old bundles to reload before writing and sends new overrides only to clients that read them', async () => {
    const f = fixture();
    const caller = appRouter.createCaller({ service: f.service, userId: f.student });
    const base = f.service.entity(f.student, 'personal')!;
    await expect(caller.sync({ accountId: f.student, mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: emptyPersonalSchedule() })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: OUTDATED_CLIENT_MESSAGE });
    await caller.sync({ accountId: f.student, personalVersion: PERSONAL_SCHEDULE_CLIENT_VERSION, mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: { ...f.read(), cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] } });
    await expect(caller.workspace()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: OUTDATED_CLIENT_MESSAGE });
    await expect(caller.workspace({ personalVersion: PERSONAL_SCHEDULE_CLIENT_VERSION })).resolves.toMatchObject({ entities: [{ data: { cycleDayOverrides: [{ slotChanges: { a: { start: '08:05' } } }] } }] });
  });

  it('reports concurrent time edits that produce an invalid interval instead of hiding the block', () => {
    const f = fixture();
    const base = f.service.entity(f.student, 'personal')!;
    const before = f.read();
    const change = (fields: { start?: string; end?: string }) => ({ ...before, cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], schedule.cycleDays[0].slots.map(slot => slot.id === 'a' ? { ...slot, ...fields } : slot))!] });
    const first = f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: change({ start: '08:50' }) });
    expect(first.status).toBe('applied');
    const second = f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: change({ end: '08:40' }) });
    expect(second).toMatchObject({ status: 'conflict', paths: ['/cycleDayOverrides/day1'] });
    expect(cycleDaySlots(schedule.cycleDays[0], f.read())[0]).toMatchObject({ start: '08:50', end: '09:00' });
  });

  it('migrates legacy adjustments before acknowledging a newer school revision', () => {
    const f = fixture();
    f.publish(moved('08:05'), 1);
    const legacy = { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slots: schedule.cycleDays[0].slots }] };
    f.db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(JSON.stringify(legacy), f.student);
    f.service.acknowledge(f.student, 2);
    expect(f.read().cycleDayOverrides).toEqual([]);
    expect(cycleDaySlots(moved('08:05').cycleDays[0], f.read())[0].start).toBe('08:05');
  });
});

describe('schedule-following beta gate', () => {
  it('keeps nonmember data and version unchanged across workspace, acknowledgments and school revisions', () => {
    const f = fixture(false);
    const base = f.service.entity(f.student, 'personal')!;
    const data = { ...f.read(), classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' }, cycleDayOverrides: [{ cycleDayId: 'day1', slots: moved('08:05').cycleDays[0].slots }] };
    expect(f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data }, { legacyPersonal: true }).status).toBe('applied');
    const saved = f.service.entity(f.student, 'personal')!;
    expect(saved.data).toEqual(data);
    const newer = { ...schedule, cycleDays: [{ ...schedule.cycleDays[0], slots: schedule.cycleDays[0].slots.map(slot => slot.id === 'b' ? { ...slot, start: '10:10' } : slot) }] };
    f.publish(newer, 1);
    f.service.workspace(f.student, { legacyPersonal: true });
    f.service.acknowledge(f.student, 2);
    f.publish(moved('08:05'), 2);
    expect(f.service.entity(f.student, 'personal')).toEqual(saved);
    expect(f.service.scheduleFollowingEnabled(f.student)).toBe(false);
  });

  it('migrates only after actual enrollment, including an old unreviewed revision', () => {
    const f = fixture(false);
    const old = f.service.entity(f.student, 'personal')!;
    const legacy = { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slots: moved('08:05').cycleDays[0].slots }] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: old, data: legacy });
    const next = { ...schedule, cycleDays: [{ ...schedule.cycleDays[0], slots: schedule.cycleDays[0].slots.map(slot => slot.id === 'b' ? { ...slot, start: '10:10' } : slot) }] };
    f.publish(next, 1);
    expect(f.read().cycleDayOverrides[0].slots).toEqual(legacy.cycleDayOverrides[0].slots);
    f.enroll(f.student);
    expect(f.service.scheduleFollowingEnabled(f.student)).toBe(true);
    expect(f.read().cycleDayOverrides[0].slotChanges).toMatchObject({ a: { start: '08:05' } });
    expect(cycleDaySlots(next.cycleDays[0], f.read())[1].start).toBe('10:10');
  });

  it('accepts an unacknowledged queued sparse class edit after leaving and keeps legacy timing snapshots', () => {
    const f = fixture();
    const base = f.service.entity(f.student, 'personal')!;
    const sparse = { ...f.read(), cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: sparse });
    const queuedBase = f.service.entity(f.student, 'personal')!;
    const queued = { mutationId: randomUUID(), id: 'personal', kind: 'personal' as const, base: queuedBase, data: { ...queuedBase.data, classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' } } };
    f.betas.leave(f.student, SCHEDULE_FOLLOWING_BETA);
    expect(f.read().cycleDayOverrides[0].slots).toEqual(moved('08:05').cycleDays[0].slots);
    expect(f.service.sync(f.student, queued)).toMatchObject({ status: 'applied' });
    expect(f.read()).toMatchObject({ classes: queued.data.classes, assignments: queued.data.assignments });
    expect(f.read().cycleDayOverrides[0]).not.toHaveProperty('slotChanges');
    const saved = f.service.entity(f.student, 'personal')!;
    f.publish(moved('08:10'), 1);
    f.service.workspace(f.student);
    expect(f.service.entity(f.student, 'personal')).toEqual(saved);
  });

  it('keeps receipt replays unchanged when an applied sparse response was lost before leaving', () => {
    const f = fixture();
    const mutation = { mutationId: randomUUID(), id: 'personal', kind: 'personal' as const, base: f.service.entity(f.student, 'personal')!, data: { ...f.read(), cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] } };
    const first = f.service.sync(f.student, mutation);
    f.betas.leave(f.student, SCHEDULE_FOLLOWING_BETA);
    expect(f.service.sync(f.student, mutation)).toEqual(first);
    expect(f.read().cycleDayOverrides[0]).toHaveProperty('slots');
  });

  it('materializes personal period metadata only when a private timetable is needed to keep it', () => {
    const f = fixture();
    const before = f.read();
    const data = { ...before, periods: [{ id: 'studio', label: 'Studio', kind: 'other' as const }], cycleDayOverrides: [{ cycleDayId: 'day1', slotChanges: { studio: { periodId: 'studio', start: '13:00', end: '14:00' } } }] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data });
    f.betas.leaveAll(f.student);
    expect(f.read().periods).toBeUndefined();
    expect(f.read().customSchedule?.periods).toContainEqual(data.periods[0]);
    expect(f.read().cycleDayOverrides[0].slots).toContainEqual({ id: 'studio', periodId: 'studio', start: '13:00', end: '14:00' });
  });

  it.each(['leave', 'leaveAll', 'removeMember', 'close'] as const)('preserves classes and ordinary times on %s', (method) => {
    const f = fixture();
    const data = { ...f.read(), classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' }, cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data });
    if (method === 'leave') f.betas.leave(f.student, SCHEDULE_FOLLOWING_BETA);
    if (method === 'leaveAll') f.betas.leaveAll(f.student);
    if (method === 'removeMember') f.betas.removeMember(f.owner, { key: SCHEDULE_FOLLOWING_BETA, userId: f.student });
    if (method === 'close') f.betas.close(f.owner, SCHEDULE_FOLLOWING_BETA);
    expect(f.service.scheduleFollowingEnabled(f.student)).toBe(false);
    expect(f.read()).toMatchObject({ classes: data.classes, assignments: data.assignments, customSchedule: null });
    expect(f.read().cycleDayOverrides[0].slots).toEqual(moved('08:05').cycleDays[0].slots);
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action=?").get(`beta.${method === 'leaveAll' ? 'leave' : method}`)).toMatchObject({ n: 1 });
  });

  it('retains removed-day sparse edits and invalid combinations when the beta is left', () => {
    const f = fixture();
    const data = { ...f.read(), cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!, { cycleDayId: 'removed', slotChanges: { removed: null, extra: { periodId: 'A', start: '13:00', end: '14:00' } } }] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data });
    const invalid = moved('08:00');
    invalid.cycleDays[0].slots[0].end = '08:03';
    f.publish(invalid, 1);
    const saved = f.read();
    f.betas.leaveAll(f.student);
    expect(f.read().cycleDayOverrides).toEqual(saved.cycleDayOverrides);
    expect(personalScheduleSchema.safeParse(f.read()).success).toBe(true);
    expect(f.service.scheduleFollowingEnabled(f.student)).toBe(false);
    expect(f.read().customSchedule?.cycleDays[0].slots[0].end).toBe('08:03');
    f.publish(schedule, 2);
    f.service.workspace(f.student);
    expect(f.read().customSchedule?.cycleDays[0].slots[0].end).toBe('08:03');
    expect(f.read().cycleDayOverrides).toEqual(saved.cycleDayOverrides);
  });

  it('freezes sparse slots against the old school before switching to a school with matching IDs', () => {
    const f = fixture();
    const data = { ...f.read(), cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data });
    const other = f.service.createSchool(f.owner, { name: 'Other school', location: 'Boston', schedule: { ...moved('08:20'), cycleDays: [{ ...schedule.cycleDays[0], slots: schedule.cycleDays[0].slots.map(slot => ({ ...slot, end: slot.id === 'a' ? '09:30' : slot.end })) }] } });
    f.service.join(f.student, { schoolId: other.id, choice: 'community' });
    f.service.workspace(f.student);
    expect(cycleDaySlots(other.schedule.cycleDays[0], f.read())[0]).toMatchObject({ start: '08:05', end: '09:00' });
  });
});

it('accepts an ordinary nonmember legacy replacement without combining it with shared blocks', () => {
  const f = fixture(false);
  const data = { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slots: [{ id: 'own', periodId: 'A', start: '08:30', end: '10:30' }] }] };
  const result = f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data }, { legacyPersonal: true });
  expect(result.status).toBe('applied');
  expect(f.read()).toEqual(data);
  expect(cycleDaySlots(schedule.cycleDays[0], f.read())).toEqual(data.cycleDayOverrides[0].slots);
});

it('keeps a sparse orphan day available for restoration without making a private timetable', () => {
  const f = fixture();
  const orphan = { cycleDayId: 'removed', slotChanges: { gone: null, extra: { periodId: 'A', start: '13:00', end: '14:00' } } };
  f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data: { ...f.read(), cycleDayOverrides: [orphan] } });
  f.betas.leaveAll(f.student);
  expect(f.read().customSchedule).toBeNull();
  expect(f.read().cycleDayOverrides).toEqual([orphan]);
  const restored = { id: 'removed', label: 'Restored day', slots: [{ id: 'gone', periodId: 'A', start: '08:00', end: '09:00' }, { id: 'kept', periodId: 'B', start: '10:00', end: '11:00' }] };
  f.publish({ ...schedule, cycleDays: [...schedule.cycleDays, restored] }, 1);
  expect(cycleDaySlots(restored, f.read()).map(slot => slot.id)).toEqual(['kept', 'extra']);
});

it('materializes opt-out snapshots against the student grade rather than the school default', () => {
  const f = fixture();
  const grade = { ...schedule, cycleDays: [{ ...schedule.cycleDays[0], slots: schedule.cycleDays[0].slots.map(slot => slot.id === 'a' ? { ...slot, start: '09:00', end: '10:00' } : slot) }] };
  f.publish({ ...schedule, gradeSchedules: { '10': grade } }, 1);
  const data = { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slotChanges: { a: { start: '09:05' } } }] };
  f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data });
  f.betas.leaveAll(f.student);
  expect(f.read().cycleDayOverrides[0].slots?.[0]).toMatchObject({ start: '09:05', end: '10:00' });
  expect(f.read().customSchedule).toBeNull();
});
