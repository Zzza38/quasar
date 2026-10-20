import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBeta, EMPTY_BETA_REGISTRY, readBetaRegistry, removeBeta, writeBetaRegistry } from './beta-registry';
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
let directory = '';
let previousPath: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'quasar-schedule-beta-'));
  previousPath = process.env.BETAS_PATH;
  process.env.BETAS_PATH = join(directory, 'betas.json');
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  rmSync(directory, { recursive: true, force: true });
  if (previousPath === undefined) delete process.env.BETAS_PATH; else process.env.BETAS_PATH = previousPath;
});
function fixture(enrolled = false) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = (email = `${randomUUID()}@example.com`) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
    return id;
  };
  const owner = user('owner@example.com'), student = user();
  const betas = new BetaService(service);
  if (enrolled) writeBetaRegistry(createBeta(EMPTY_BETA_REGISTRY, { key: SCHEDULE_FOLLOWING_BETA, name: 'Schedule following', description: '', code: 'FOLLOW2026', maxMembers: null }));
  const school = service.createSchool(student, { name: 'Following High', location: 'Boston', schedule });
  service.join(student, { schoolId: school.id, choice: 'community', grade: '10' });
  if (enrolled) betas.join(student, { code: 'FOLLOW2026' });
  const read = () => personalScheduleSchema.parse(service.entity(student, 'personal')!.data);
  const publish = (draft: Schedule, version: number) => service.updateSchool(owner, { schoolId: school.id, expectedVersion: version, schedule: draft, approved: true, supportLocked: false }, true);
  return { db, service, owner, student, school, user, read, publish, betas };
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
    const proposals = new ProposalService(f.service);
    const proposal = proposals.create(f.student, { schoolId: f.school.id, baseVersion: 1, schedule: moved('08:05'), summary: 'Correct the first bell time for our school.' });
    proposals.vote(members[1], { proposalId: proposal.id, vote: 'for' });
    expect(proposals.vote(members[2], { proposalId: proposal.id, vote: 'for' }).status).toBe('passed');
    expect(personalScheduleSchema.parse(f.service.entity(nonmember, 'personal')!.data).cycleDayOverrides).toEqual([]);
    expect(f.read()).toMatchObject({ classes: personal.classes, assignments: personal.assignments, dateOverrides: personal.dateOverrides, cycleDayOverrides: [] });
  });

  it('lets old bundles edit compatible data and reloads before saving an unsupported timing format', async () => {
    const f = fixture();
    const caller = appRouter.createCaller({ service: f.service, userId: f.student });
    const base = f.service.entity(f.student, 'personal')!;
    const renamed = await caller.sync({ accountId: f.student, mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: { ...f.read(), classes: [{ id: 'art', name: 'Art' }] } });
    expect(renamed.status).toBe('applied');
    await expect(caller.workspace()).resolves.toMatchObject({ entities: [{ data: { classes: [{ id: 'art', name: 'Art' }] } }] });
    const saved = f.service.entity(f.student, 'personal')!;
    const queued = { accountId: f.student, mutationId: randomUUID(), id: 'personal', kind: 'personal' as const, base: saved, data: { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slots: moved('08:05').cycleDays[0].slots }] } };
    await expect(caller.sync(queued)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: OUTDATED_CLIENT_MESSAGE });
    expect(f.service.entity(f.student, 'personal')).toEqual(saved);
    expect(f.db.prepare('SELECT 1 FROM mutation_receipts WHERE owner_id=? AND mutation_id=?').get(f.student, queued.mutationId)).toBeUndefined();
    await expect(caller.sync({ ...queued, personalVersion: PERSONAL_SCHEDULE_CLIENT_VERSION })).resolves.toMatchObject({ status: 'applied' });
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

describe('school following for every account', () => {
  it('migrates saved legacy copies without enrollment and keeps receiving untouched school changes', () => {
    const f = fixture();
    const legacy = { ...f.read(), classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' }, cycleDayOverrides: [{ cycleDayId: 'day1', slots: moved('08:05').cycleDays[0].slots }] };
    f.db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(JSON.stringify(legacy), f.student);
    const next = { ...schedule, cycleDays: [{ ...schedule.cycleDays[0], slots: schedule.cycleDays[0].slots.map(slot => slot.id === 'b' ? { ...slot, start: '10:10' } : slot) }] };
    f.publish(next, 1);
    f.service.workspace(f.student);
    f.service.acknowledge(f.student, 2);
    expect(f.read()).toMatchObject({ classes: legacy.classes, assignments: legacy.assignments, customSchedule: null });
    expect(f.read().cycleDayOverrides[0].slotChanges).toMatchObject({ a: { start: '08:05' } });
    expect(cycleDaySlots(next.cycleDays[0], f.read())[1].start).toBe('10:10');
    f.publish({ ...next, cycleDays: [{ ...next.cycleDays[0], slots: next.cycleDays[0].slots.map(slot => slot.id === 'a' ? { ...slot, start: '08:05' } : slot) }] }, 2);
    expect(f.read().cycleDayOverrides).toEqual([]);
    expect(f.db.prepare('SELECT 1 FROM beta_members WHERE user_id=?').get(f.student)).toBeUndefined();
  });

  it('preserves queued legacy class edits across rollout reconciliation and school corrections', () => {
    const f = fixture();
    const legacy = { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slots: moved('08:05').cycleDays[0].slots }] };
    f.db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(JSON.stringify(legacy), f.student);
    const base = f.service.entity(f.student, 'personal')!;
    f.db.prepare('UPDATE entity_history SET entity=? WHERE owner_id=? AND id=? AND version=?').run(JSON.stringify(base), f.student, 'personal', base.version);
    const next = { ...moved('08:05'), cycleDays: [{ ...schedule.cycleDays[0], slots: moved('08:05').cycleDays[0].slots.map(slot => slot.id === 'b' ? { ...slot, start: '10:10' } : slot) }] };
    f.publish(next, 1);
    const queued = { mutationId: randomUUID(), id: 'personal', kind: 'personal' as const, base, data: { ...legacy, classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' } } };
    expect(f.service.sync(f.student, queued)).toMatchObject({ status: 'applied' });
    expect(f.read()).toMatchObject({ classes: queued.data.classes, assignments: queued.data.assignments, cycleDayOverrides: [] });
    expect(cycleDaySlots(next.cycleDays[0], f.read())[1].start).toBe('10:10');
  });

  it('keeps legacy replacement deletions while converting them into sparse edits', () => {
    const f = fixture();
    const slots = [{ id: 'own', periodId: 'A', start: '08:30', end: '10:30' }];
    const result = f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data: { ...f.read(), cycleDayOverrides: [{ cycleDayId: 'day1', slots }] } });
    expect(result.status).toBe('applied');
    expect(cycleDaySlots(schedule.cycleDays[0], f.read())).toEqual(slots);
    expect(f.read().cycleDayOverrides[0].slotChanges).toMatchObject({ a: null, b: null, own: { periodId: 'A', start: '08:30', end: '10:30' } });
  });

  it.each(['leave', 'leaveAll', 'removeMember', 'retire'] as const)('keeps sparse adjustments following school changes after %s', method => {
    const f = fixture(true);
    const data = { ...f.read(), classes: [{ id: 'art', name: 'Art' }], assignments: { A: 'art' }, periods: [{ id: 'studio', label: 'Studio', kind: 'other' as const }], cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data });
    const saved = f.service.entity(f.student, 'personal')!;
    if (method === 'leave') f.betas.leave(f.student, SCHEDULE_FOLLOWING_BETA);
    if (method === 'leaveAll') f.betas.leaveAll(f.student);
    if (method === 'removeMember') f.betas.removeMember(f.owner, { key: SCHEDULE_FOLLOWING_BETA, userId: f.student });
    if (method === 'retire') { writeBetaRegistry(removeBeta(readBetaRegistry(), SCHEDULE_FOLLOWING_BETA)); f.service.workspace(f.student); }
    expect(f.betas.joined(f.student)).toEqual([]);
    expect(f.service.entity(f.student, 'personal')).toEqual(saved);
    expect(f.read().periods).toEqual(data.periods);
    expect(f.read().customSchedule).toBeNull();
    const next = { ...moved('08:05'), cycleDays: [{ ...schedule.cycleDays[0], slots: moved('08:05').cycleDays[0].slots.map(slot => slot.id === 'b' ? { ...slot, start: '10:10' } : slot) }] };
    f.publish(next, 1);
    expect(f.read().cycleDayOverrides).toEqual([]);
    expect(cycleDaySlots(next.cycleDays[0], f.read())[1].start).toBe('10:10');
  });

  it('keeps receipt replays and queued sparse class edits after registry removal', () => {
    const f = fixture(true);
    const mutation = { mutationId: randomUUID(), id: 'personal', kind: 'personal' as const, base: f.service.entity(f.student, 'personal')!, data: { ...f.read(), cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] } };
    const original = f.service.sync(f.student, mutation);
    const base = f.service.entity(f.student, 'personal')!;
    writeBetaRegistry(removeBeta(readBetaRegistry(), SCHEDULE_FOLLOWING_BETA));
    expect(f.service.sync(f.student, mutation)).toEqual(original);
    const queued = { mutationId: randomUUID(), id: 'personal', kind: 'personal' as const, base, data: { ...base.data, classes: [{ id: 'art', name: 'Art' }] } };
    expect(f.service.sync(f.student, queued)).toMatchObject({ status: 'applied' });
    expect(f.read().cycleDayOverrides[0]).toHaveProperty('slotChanges');
    f.publish(moved('08:05'), 1);
    expect(f.read().cycleDayOverrides).toEqual([]);
  });

  it('keeps private timetables and orphan adjustments intact when the retired beta is left', () => {
    const f = fixture(true);
    const orphan = { cycleDayId: 'removed', slotChanges: { gone: null, extra: { periodId: 'A', start: '13:00', end: '14:00' } } };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data: { ...f.read(), customSchedule: moved('08:15'), cycleDayOverrides: [orphan] } });
    const saved = f.service.entity(f.student, 'personal')!;
    f.betas.leaveAll(f.student);
    f.publish(moved('08:25'), 1);
    expect(f.service.entity(f.student, 'personal')).toEqual(saved);
    expect(f.read().customSchedule?.cycleDays[0].slots[0].start).toBe('08:15');
  });

  it('preserves the previous school basis when changing schools after registry removal', () => {
    const f = fixture(true);
    const data = { ...f.read(), periods: [{ id: 'studio', label: 'Studio', kind: 'other' as const }], cycleDayOverrides: [diffCycleDaySlots(schedule.cycleDays[0], moved('08:05').cycleDays[0].slots)!] };
    f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(f.student, 'personal')!, data });
    const other = f.service.createSchool(f.owner, { name: 'Other school', location: 'Boston', schedule: moved('08:20') });
    writeBetaRegistry(removeBeta(readBetaRegistry(), SCHEDULE_FOLLOWING_BETA));
    f.service.join(f.student, { schoolId: other.id, choice: 'community' });
    expect(cycleDaySlots(other.schedule.cycleDays[0], f.read())[0]).toMatchObject({ start: '08:05', end: '09:00' });
    expect(f.read().periods).toEqual(data.periods);
  });
});
