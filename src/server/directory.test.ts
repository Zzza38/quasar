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
