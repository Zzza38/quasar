import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyPersonalSchedule, scheduleSchema, type Grade, type PersonalSchedule } from '@/domain/schedule';
import { exampleSchedule } from '@/domain/example';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { ScheduleSignalsService } from './schedule-signals';
import { SCHEDULE_FOLLOWING_BETA } from '@/domain/betas';
import { BetaService } from './betas';
import { appRouter } from './router';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = (email?: string) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email ?? `${id}@example.com`, `Private name ${id}`, 'Private full name', new Date().toISOString());
    return id;
  };
  const owner = user('owner@example.com');
  const betas = new BetaService(service);
  betas.create(owner, { key: SCHEDULE_FOLLOWING_BETA, name: 'Schedule following', description: '', code: 'FOLLOW2026', maxMembers: null });
  const viewer = user();
  const school = service.createSchool(viewer, { name: 'Signals High', location: 'Boston, MA', schedule: exampleSchedule });
  const join = (id: string, grade: Grade = '9', schoolId = school.id) => { service.join(id, { schoolId, grade, choice: 'community' }); betas.join(id, { code: 'FOLLOW2026' }); };
  join(viewer);
  const save = (id: string, changes: Partial<PersonalSchedule> = {}) => {
    const data = { ...emptyPersonalSchedule(), grade: '9', classes: [{ id: 'secret', name: 'Private class', teacher: 'Private teacher' }], assignments: { A: 'secret' },
      periods: [{ id: 'private-period', label: 'Private activity', kind: 'other' }],
      cycleDayOverrides: [{ cycleDayId: 'day-1', slotChanges: { first: { start: '08:10', end: '09:05' } } }], ...changes };
    db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(JSON.stringify(data), id);
  };
  const member = (changes: Partial<PersonalSchedule> = {}) => { const id = user(); join(id); save(id, changes); return id; };
  return { db, service, user, viewer, school, join, save, member, signals: new ScheduleSignalsService(service), betas };
}

describe('anonymous recurring schedule signals', () => {
  it('exposes only thresholded matching timing aggregates and public valid drafts', () => {
    const f = fixture();
    const members = [f.member(), f.member()];
    expect(f.signals.list(f.viewer).signals).toEqual([]);
    members.push(f.member());
    const board = f.signals.list(f.viewer);
    expect(board.signals).toHaveLength(1);
    expect(board.signals[0]).toMatchObject({ cycleDayId: 'day-1', slotId: 'first', start: '08:10', end: '09:05', count: 3 });
    const draft = scheduleSchema.parse(board.signals[0].draft);
    expect(draft.cycleDays[0].slots[0]).toMatchObject({ start: '08:10', end: '09:05' });
    expect(draft.cycleDays.slice(1)).toEqual(exampleSchedule.cycleDays.slice(1));
    const response = JSON.stringify(board);
    for (const secret of ['Private', 'secret', 'private-period', ...members]) expect(response).not.toContain(secret);
    expect(f.db.prepare('SELECT count(*) n FROM schedule_proposals').get()).toEqual({ n: 0 });
  });

  it('counts each current member once and excludes private copies, grades, suspensions, and both block directions', () => {
    const f = fixture();
    const a = f.member(); f.member();
    f.member({ grade: '10' });
    f.member({ customSchedule: exampleSchedule });
    const suspended = f.member();
    f.db.prepare('UPDATE users SET suspended_at=? WHERE id=?').run(new Date().toISOString(), suspended);
    const blocked = f.member(), blocker = f.member();
    f.db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(f.viewer, blocked, new Date().toISOString());
    f.db.prepare('INSERT INTO blocks VALUES(?,?,?)').run(blocker, f.viewer, new Date().toISOString());
    f.save(f.viewer);
    expect(f.signals.list(f.viewer).signals).toEqual([]);
    const c = f.member();
    expect(f.signals.list(f.viewer).signals[0].count).toBe(3);
    f.save(a);
    expect(f.signals.list(f.viewer).signals[0].count).toBe(3);
    f.db.prepare('UPDATE users SET school_id=NULL WHERE id=?').run(c);
    expect(f.signals.list(f.viewer).signals).toEqual([]);
  });

  it('does not mix schools or expose a read without authenticated school membership', async () => {
    const f = fixture();
    f.member(); f.member();
    const outsider = f.user();
    const otherSchool = f.service.createSchool(outsider, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
    f.join(outsider, '9', otherSchool.id); f.save(outsider);
    expect(f.signals.list(f.viewer).signals).toEqual([]);
    const unjoined = f.user();
    expect(() => f.signals.list(unjoined)).toThrow('Join a school');
    await expect(appRouter.createCaller({ service: f.service, userId: null }).scheduleSignals.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(appRouter.createCaller({ service: f.service, userId: f.viewer }).scheduleSignals.list()).resolves.toMatchObject({ signals: [] });
  });

  it('stops suggesting adopted times and rejects drafts that overlap another school block', () => {
    const f = fixture();
    f.member(); f.member(); f.member();
    expect(f.signals.list(f.viewer).signals).toHaveLength(1);
    const updated = structuredClone(exampleSchedule);
    updated.cycleDays[0].slots[0] = { ...updated.cycleDays[0].slots[0], start: '08:10', end: '09:05' };
    f.db.prepare('UPDATE schools SET schedule=? WHERE id=?').run(JSON.stringify(updated), f.school.id);
    expect(f.signals.list(f.viewer).signals).toEqual([]);
    f.db.prepare('UPDATE schools SET schedule=? WHERE id=?').run(JSON.stringify(exampleSchedule), f.school.id);
    for (const row of f.db.prepare('SELECT id FROM users WHERE school_id=? AND id<>?').all(f.school.id, f.viewer) as { id: string }[]) {
      f.save(row.id, { cycleDayOverrides: [{ cycleDayId: 'day-1', slotChanges: { first: { start: '08:10', end: '09:15' } } }] });
    }
    expect(f.signals.list(f.viewer).signals).toEqual([]);
  });

  it('keeps separate matching alternatives below threshold and hides signals from private-copy viewers', () => {
    const f = fixture();
    f.member(); f.member();
    f.member({ cycleDayOverrides: [{ cycleDayId: 'day-1', slotChanges: { first: { start: '08:15', end: '09:05' } } }] });
    expect(f.signals.list(f.viewer).signals).toEqual([]);
    f.member();
    expect(f.signals.list(f.viewer).signals).toHaveLength(1);
    f.save(f.viewer, { customSchedule: exampleSchedule });
    expect(f.signals.list(f.viewer).signals).toEqual([]);
  });

  it('builds a correction from the viewer grade schedule without copying other grade variants', () => {
    const f = fixture();
    const variant = structuredClone(exampleSchedule);
    variant.cycleDays[0].label = 'Freshman day';
    variant.cycleDays[0].slots[0].start = '07:30';
    variant.cycleDays[0].slots[0].end = '08:30';
    f.db.prepare('UPDATE schools SET schedule=? WHERE id=?').run(JSON.stringify({ ...exampleSchedule, gradeSchedules: { '9': variant } }), f.school.id);
    f.member(); f.member(); f.member();
    const signal = f.signals.list(f.viewer).signals[0];
    expect(signal.cycleDayLabel).toBe('Freshman day');
    expect(signal.draft.gradeSchedules).toBeUndefined();
    expect(signal.draft.cycleDays[0].label).toBe('Freshman day');
    expect(f.service.school(f.school.id).schedule.cycleDays[0].slots[0].start).toBe('08:00');
  });

  it('migrates legacy copies against acknowledged revisions before comparing school timings', () => {
    const f = fixture();
    const members = [f.member(), f.member(), f.member()];
    for (const id of members) {
      f.save(id, { cycleDayOverrides: [{ cycleDayId: 'day-1', slots: exampleSchedule.cycleDays[0].slots.map(slot => slot.id === 'first' ? { ...slot, start: '08:10' } : slot) }] });
    }
    const current = structuredClone(exampleSchedule);
    current.cycleDays[0].slots[0].end = '09:05';
    current.cycleDays[0].slots[1].start = '09:08';
    f.db.prepare('UPDATE schools SET schedule=?,version=2 WHERE id=?').run(JSON.stringify(current), f.school.id);
    const signal = f.signals.list(f.viewer).signals[0];
    expect(signal).toMatchObject({ start: '08:10', end: '09:05', count: 3 });
    expect(signal.draft.cycleDays[0].slots[1].start).toBe('09:08');
    expect(f.signals.list(f.viewer).signals).toHaveLength(1);
  });
});

it('requires actual beta enrollment and counts only opted-in contributors', () => {
  const f = fixture();
  const a = f.member(); f.member(); f.member();
  expect(f.signals.list(f.viewer).signals[0].count).toBe(3);
  f.betas.leave(a, SCHEDULE_FOLLOWING_BETA);
  expect(f.signals.list(f.viewer).signals).toEqual([]);
  // A persisted sparse adjustment cannot stand in for beta membership.
  f.save(a);
  expect(f.signals.list(f.viewer).signals).toEqual([]);
  f.betas.leave(f.viewer, SCHEDULE_FOLLOWING_BETA);
  expect(() => f.signals.list(f.viewer)).toThrow('Join the schedule-following beta');
});
