import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cycleDaySlots, diffCycleDaySlots, emptyPersonalSchedule, personalScheduleSchema, PERSONAL_SCHEDULE_CLIENT_VERSION, type Schedule } from '@/domain/schedule';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { ProposalService } from './proposals';
import { appRouter, OUTDATED_CLIENT_MESSAGE } from './router';

const schedule: Schedule = {
  version: 1, timeZone: 'America/New_York', periods: [{ id: 'A', label: 'A', kind: 'class' }, { id: 'B', label: 'B', kind: 'class' }],
  cycleDays: [{ id: 'day1', label: 'Day 1', slots: [{ id: 'a', periodId: 'A', start: '08:00', end: '09:00' }, { id: 'b', periodId: 'B', start: '10:00', end: '11:00' }] }],
  anchorDate: '2026-09-08', anchorCycleDayId: 'day1', schoolWeekdays: [1, 2, 3, 4, 5], advanceWeekdays: [1, 2, 3, 4, 5], exceptions: [],
};
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = (email = `${randomUUID()}@example.com`) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
    return id;
  };
  const owner = user('owner@example.com'), student = user();
  const school = service.createSchool(student, { name: 'Following High', location: 'Boston', schedule });
  service.join(student, { schoolId: school.id, choice: 'community', grade: '10' });
  const read = () => personalScheduleSchema.parse(service.entity(student, 'personal')!.data);
  const publish = (draft: Schedule, version: number) => service.updateSchool(owner, { schoolId: school.id, expectedVersion: version, schedule: draft, approved: true, supportLocked: false }, true);
  return { db, service, owner, student, school, user, read, publish };
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
    const proposals = new ProposalService(f.service);
    const proposal = proposals.create(f.student, { schoolId: f.school.id, baseVersion: 1, schedule: moved('08:05'), summary: 'Correct the first bell time for our school.' });
    proposals.vote(members[1], { proposalId: proposal.id, vote: 'for' });
    expect(proposals.vote(members[2], { proposalId: proposal.id, vote: 'for' }).status).toBe('passed');
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
