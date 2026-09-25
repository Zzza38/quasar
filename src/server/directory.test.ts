import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { DirectoryService } from './directory';
import { appRouter } from './router';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
    return id;
  }
  const student = user(), owner = user('owner@example.com'), outsider = user();
  const school = service.createSchool(student, { name: 'Directory High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(student, { schoolId: school.id, choice: 'community', grade: '9' });
  return { db, service, directory: new DirectoryService(service), user, student, owner, outsider, school };
}
const details = { name: 'Algebra', teacher: 'Teacher', room: '101', grades: ['9' as const] };

describe('adding reviewed scans to the directory', () => {
  it('reuses listed classes, adds new classes once, and keeps grade and section boundaries', () => {
    const f = fixture();
    const entry = f.directory.save(f.student, { schoolId: f.school.id, details });
    const input = { schoolId: f.school.id, grade: '9' as const, rows: [{ name: 'Algebra' }, { name: 'Biology', teacher: 'Ms. Chen' }] };
    const first = f.directory.importClasses(f.student, input);
    expect(first.rows[0]).toMatchObject({ directoryId: entry.id, teacher: 'Teacher', room: '101' });
    expect(first.rows[1].directoryId).toBeTruthy();
    expect(f.directory.importClasses(f.student, input).rows).toEqual(first.rows);
    expect(f.directory.list(f.student, f.school.id).classes).toHaveLength(2);
    f.directory.importClasses(f.student, { ...input, rows: [{ name: 'Algebra', teacher: 'Another teacher' }] });
    f.directory.importClasses(f.student, { ...input, grade: '10', rows: [{ name: 'Algebra' }] });
    expect(f.directory.list(f.student, f.school.id).classes).toHaveLength(4);
  });
  it('requires a decision for typos and only corrects the explicitly confirmed name', () => {
    const f = fixture();
    const entry = f.directory.save(f.student, { schoolId: f.school.id, details: { ...details, name: 'Algebar' } });
    const input = { schoolId: f.school.id, grade: '9' as const, rows: [{ name: 'Algebra' }] };
    expect(() => f.directory.importClasses(f.student, input)).toThrow('possible match');
    expect(f.directory.list(f.student, f.school.id).classes[0].name).toBe('Algebar');
    const confirmed = { ...input, rows: [{ name: 'Algebra', directoryId: entry.id, correctName: true, expectedVersion: entry.version }] };
    expect(f.directory.importClasses(f.student, confirmed).rows[0]).toMatchObject({ directoryId: entry.id, name: 'Algebra' });
    expect(f.directory.importClasses(f.student, confirmed).rows[0].directoryId).toBe(entry.id);
    expect(f.directory.list(f.student, f.school.id).classes).toEqual([{ ...entry, name: 'Algebra', version: 2 }]);
    expect(() => f.directory.importClasses(f.student, { ...confirmed, rows: [{ ...confirmed.rows[0], name: 'Physics' }] })).toThrow('spelling correction');
  });
  it('allows an explicitly separate class and rolls back the batch when another row needs review', () => {
    const f = fixture();
    f.directory.save(f.student, { schoolId: f.school.id, details });
    const input = { schoolId: f.school.id, grade: '9' as const, rows: [{ name: 'Biology' }, { name: 'Algebar' }] };
    expect(() => f.directory.importClasses(f.student, input)).toThrow('possible match');
    expect(f.directory.list(f.student, f.school.id).classes).toHaveLength(1);
    const result = f.directory.importClasses(f.student, { ...input, rows: [{ name: 'Algebar', separate: true }] });
    expect(result.rows[0].directoryId).toBeTruthy();
    expect(f.directory.list(f.student, f.school.id).classes).toHaveLength(2);
  });
  it('checks current locks and leaves new classes and confirmed corrections personal when locked', () => {
    const f = fixture();
    const entry = f.directory.save(f.student, { schoolId: f.school.id, details: { ...details, name: 'Algebar' } });
    f.db.prepare('UPDATE schools SET support_locked=1 WHERE id=?').run(f.school.id);
    const result = f.directory.importClasses(f.student, { schoolId: f.school.id, grade: '9', rows: [
      { name: 'Algebra', directoryId: entry.id, correctName: true, expectedVersion: entry.version }, { name: 'Biology' },
    ] });
    expect(result).toMatchObject({ canEdit: false, skipped: 2, rows: [{ name: 'Algebra', directoryId: entry.id }, { name: 'Biology' }] });
    expect(result.rows[1].directoryId).toBeUndefined();
    expect(f.directory.list(f.student, f.school.id).classes).toEqual([entry]);
    f.db.prepare('UPDATE schools SET support_locked=0,member_locked=1 WHERE id=?').run(f.school.id);
    expect(f.directory.importClasses(f.student, { schoolId: f.school.id, rows: [{ name: 'Biology' }] }).skipped).toBe(1);
  });
  it('rejects stale corrections, foreign class IDs, and mutations from another account', async () => {
    const f = fixture();
    const entry = f.directory.save(f.student, { schoolId: f.school.id, details: { ...details, name: 'Algebar' } });
    f.directory.save(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: entry.version, details: { ...details, name: 'Algebar', room: '202' } });
    const input = { schoolId: f.school.id, rows: [{ name: 'Algebra', directoryId: entry.id, correctName: true, expectedVersion: entry.version }] };
    expect(() => f.directory.importClasses(f.student, input)).toThrow('changed');
    expect(() => f.directory.importClasses(f.student, { ...input, rows: [{ name: 'Algebra', directoryId: randomUUID() }] })).toThrow('removed');
    expect(() => f.directory.importClasses(f.outsider, input)).toThrow('Only school members');
    const caller = appRouter.createCaller({ service: f.service, userId: f.student });
    await expect(caller.directory.importClasses({ ...input, accountId: f.outsider })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('school class directory', () => {
  it('requires membership, authenticates mutations against the original account, and rejects unsupported grades', async () => {
    const f = fixture();
    expect(() => f.directory.list(f.outsider, f.school.id)).toThrow('Only school members');
    expect(() => f.directory.save(f.outsider, { schoolId: f.school.id, details })).toThrow('Only school members');
    const caller = appRouter.createCaller({ service: f.service, userId: f.student });
    await expect(caller.directory.save({ accountId: f.outsider, schoolId: f.school.id, details })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.directory.save({ accountId: f.student, schoolId: f.school.id, details: { ...details, grades: ['8' as '9'] } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.directory.list(f.student, f.school.id).classes).toEqual([]);
  });

  it('lets members edit before ten members and keeps the lock after membership falls', () => {
    const f = fixture();
    const entry = f.directory.save(f.student, { schoolId: f.school.id, details });
    for (let n = 1; n < 10; n++) f.service.join(f.user(), { schoolId: f.school.id, choice: 'community' });
    expect(f.directory.list(f.student, f.school.id).canEdit).toBe(false);
    expect(() => f.directory.save(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: 1, details })).toThrow('locked');
    expect(() => f.directory.remove(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: 1 })).toThrow('locked');
    f.db.prepare('UPDATE users SET school_id=NULL WHERE id<>?').run(f.student);
    expect(() => f.directory.save(f.student, { schoolId: f.school.id, details })).toThrow('locked');
    expect(f.directory.save(f.owner, { schoolId: f.school.id, id: entry.id, expectedVersion: 1, details: { ...details, room: '202' } }).version).toBe(2);
  });

  it('honors support locks and prevents stale updates and cross-school edits', () => {
    const f = fixture();
    const entry = f.directory.save(f.student, { schoolId: f.school.id, details });
    const next = f.directory.save(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: 1, details: { ...details, room: '202' } });
    expect(() => f.directory.save(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: 1, details })).toThrow('changed');
    expect(() => f.directory.remove(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: 1 })).toThrow('changed');
    const another = f.service.createSchool(f.owner, { name: 'Another school', location: 'Boston', schedule: exampleSchedule });
    expect(() => f.directory.save(f.owner, { schoolId: another.id, id: entry.id, expectedVersion: 2, details })).toThrow('removed');
    f.db.prepare('UPDATE schools SET support_locked=1 WHERE id=?').run(f.school.id);
    expect(() => f.directory.save(f.student, { schoolId: f.school.id, details })).toThrow('locked');
    f.directory.remove(f.owner, { schoolId: f.school.id, id: next.id, expectedVersion: next.version });
    expect(f.directory.list(f.student, f.school.id).classes).toEqual([]);
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action LIKE 'directory.%'").get()).toEqual({ n: 3 });
  });

  it('preserves personal copies and records the selected grade through normal sync', () => {
    const f = fixture();
    const entry = f.directory.save(f.student, { schoolId: f.school.id, details });
    const base = f.service.entity(f.student, 'personal')!;
    expect(base.data.grade).toBe('9');
    const copy = { id: entry.id, directoryId: entry.id, name: entry.name, room: entry.room, teacher: entry.teacher };
    const saved = f.service.sync(f.student, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: { ...base.data, classes: [copy] } });
    expect(saved.status).toBe('applied');
    f.directory.save(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: 1, details: { ...details, name: 'Advanced Algebra' } });
    f.directory.remove(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: 2 });
    expect(f.service.entity(f.student, 'personal')!.data.classes).toEqual([copy]);
    f.service.join(f.student, { schoolId: f.school.id, choice: 'community', grade: '10' });
    expect(f.service.entity(f.student, 'personal')!.data).toMatchObject({ grade: '10', classes: [copy] });
  });
});
