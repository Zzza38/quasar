import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_BETA_REGISTRY, createBeta, writeBetaRegistry } from './beta-registry';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { DirectoryService } from './directory';
import { readEntity } from './entities';
import { appRouter } from './router';
import { exampleSchedule } from '@/domain/example';
import { emptyPersonalSchedule } from '@/domain/schedule';

const databases: Db[] = [];
// Each test gets its own beta list holding the class-links beta, read the way the server reads it (BETAS_PATH).
let betaDirectory = '', previousBetas: string | undefined;
beforeEach(() => {
  betaDirectory = mkdtempSync(join(tmpdir(), 'quasar-directory-betas-')); previousBetas = process.env.BETAS_PATH;
  process.env.BETAS_PATH = join(betaDirectory, 'betas.json');
  writeBetaRegistry(createBeta(EMPTY_BETA_REGISTRY, { key: 'class-links', name: 'Class matching', code: 'LINK-2026' }));
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  if (previousBetas === undefined) delete process.env.BETAS_PATH; else process.env.BETAS_PATH = previousBetas;
  rmSync(betaDirectory, { recursive: true, force: true });
});
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
  const joinBeta = (id: string) => db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run('class-links', id, new Date().toISOString());
  return { db, service, directory: new DirectoryService(service), user, student, owner, outsider, school, joinBeta };
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
  it('adds new classes for class-links beta members but keeps confirmed corrections personal when locked', () => {
    const f = fixture();
    f.joinBeta(f.student);
    const entry = f.directory.save(f.student, { schoolId: f.school.id, details: { ...details, name: 'Algebar' } });
    f.db.prepare('UPDATE schools SET support_locked=1 WHERE id=?').run(f.school.id);
    const result = f.directory.importClasses(f.student, { schoolId: f.school.id, grade: '9', rows: [
      { name: 'Algebra', directoryId: entry.id, correctName: true, expectedVersion: entry.version }, { name: 'Biology' },
    ] });
    expect(result).toMatchObject({ canEdit: false, skipped: 1, rows: [{ name: 'Algebra', directoryId: entry.id }, { name: 'Biology' }] });
    expect(result.rows[1].directoryId).toBeTruthy();
    expect(f.directory.list(f.student, f.school.id).classes.map(entry => entry.name)).toEqual(['Algebar', 'Biology']);
    f.db.prepare('UPDATE schools SET support_locked=0,member_locked=1 WHERE id=?').run(f.school.id);
    expect(f.directory.importClasses(f.student, { schoolId: f.school.id, rows: [{ name: 'Chemistry' }] }).skipped).toBe(0);
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
    expect(f.directory.list(f.student, f.school.id)).toMatchObject({ canEdit: false, canAdd: false });
    f.joinBeta(f.student);
    expect(f.directory.list(f.student, f.school.id)).toMatchObject({ canEdit: false, canAdd: true });
    expect(() => f.directory.save(f.student, { schoolId: f.school.id, id: entry.id, expectedVersion: 1, details })).toThrow('locked');
    expect(f.directory.save(f.student, { schoolId: f.school.id, details: { ...details, name: 'Biology' } }).version).toBe(1);
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

describe('publishing personal classes', () => {
  const lit = { name: 'Foundations in Literature: Inquiry and Analysis', teacher: 'Polly Duke', room: '406' };
  const litE = { ...lit, name: 'Foundations in Literature: Inquiry and Analysis E' };
  function locked() {
    const f = fixture();
    f.db.prepare('UPDATE schools SET member_locked=1,support_locked=1 WHERE id=?').run(f.school.id);
    const friend = f.user();
    f.service.join(friend, { schoolId: f.school.id, choice: 'community', grade: '9' });
    f.joinBeta(f.student); f.joinBeta(friend);
    return { ...f, friend };
  }

  it('is only for class-links beta members', () => {
    const f = fixture();
    expect(() => f.directory.publish(f.student, { schoolId: f.school.id, classes: [{ id: 'bio', name: 'Biology', room: '210' }] })).toThrow('beta');
    expect(() => f.directory.confirmSame(f.student, { schoolId: f.school.id, mine: lit, theirs: litE })).toThrow('beta');
    expect(f.directory.list(f.student, f.school.id).classes).toEqual([]);
  });

  it('links listed classes, adds missing ones even when locked, and leaves typos, free periods and bare names alone', () => {
    const f = locked();
    const algebra = f.directory.save(f.owner, { schoolId: f.school.id, details });
    const result = f.directory.publish(f.student, { schoolId: f.school.id, grade: '9', classes: [
      { id: 'alg', name: 'Algebra', teacher: 'Teacher' }, { id: 'bio', name: 'Biology', teacher: 'Ms. Chen', room: '210' },
      { id: 'typo', name: 'Algebar', teacher: 'Teacher' }, { id: 'free', name: 'Free period' }, { id: 'bare', name: 'Assembly' }, { id: 'done', name: 'Algebra', directoryId: algebra.id },
    ] });
    const bio = f.directory.list(f.student, f.school.id).classes.find(entry => entry.name === 'Biology')!;
    expect(result.links).toEqual([{ id: 'alg', directoryId: algebra.id }, { id: 'bio', directoryId: bio.id }]);
    expect(bio).toMatchObject({ teacher: 'Ms. Chen', room: '210', grades: ['9'] });
    expect(f.directory.publish(f.friend, { schoolId: f.school.id, grade: '9', classes: [{ id: 'b', name: 'biology', room: '210' }] }).links).toEqual([{ id: 'b', directoryId: bio.id }]);
    expect(f.directory.list(f.student, f.school.id).classes).toHaveLength(2);
    expect(() => f.directory.publish(f.outsider, { schoolId: f.school.id, classes: [{ id: 'x', name: 'Physics' }] })).toThrow('Only school members');
  });

  it('confirming the same class links both spellings to one entry, which the other student then publishes into', () => {
    const f = locked();
    const mine = f.directory.publish(f.student, { schoolId: f.school.id, grade: '9', classes: [{ id: 'lit', ...lit }] }).links[0];
    const confirmed = f.directory.confirmSame(f.student, { schoolId: f.school.id, grade: '9', mine: { ...lit, directoryId: mine.directoryId }, theirs: litE });
    expect(confirmed.directoryId).toBe(mine.directoryId);
    expect(confirmed.entry.aliases).toEqual([litE]);
    expect(f.directory.publish(f.friend, { schoolId: f.school.id, grade: '9', classes: [{ id: 'theirs', ...litE }] }).links).toEqual([{ id: 'theirs', directoryId: mine.directoryId }]);
    // Repeating the confirmation adds nothing, and an edit by support keeps the confirmed spelling.
    f.directory.confirmSame(f.friend, { schoolId: f.school.id, grade: '9', mine: litE, theirs: { ...lit, directoryId: mine.directoryId } });
    const entry = f.directory.list(f.student, f.school.id).classes[0];
    expect(entry.aliases).toEqual([litE]);
    expect(f.directory.save(f.owner, { schoolId: f.school.id, id: entry.id, expectedVersion: entry.version, details: { ...lit, room: '407', grades: ['9'] } }).aliases).toEqual([litE]);
  });

  it('prefers the schoolmate’s entry, creates one when neither is listed, and refuses different classes', () => {
    const f = locked();
    const theirs = f.directory.save(f.owner, { schoolId: f.school.id, details: { ...litE, grades: ['9'] } });
    const other = f.directory.save(f.owner, { schoolId: f.school.id, details: { ...lit, name: 'Foundations of Literature', grades: ['9'] } });
    expect(f.directory.confirmSame(f.student, { schoolId: f.school.id, grade: '9', mine: { ...lit, directoryId: other.id }, theirs: { ...litE, directoryId: theirs.id } }).directoryId).toBe(theirs.id);
    const fresh = f.directory.confirmSame(f.student, { schoolId: f.school.id, grade: '9', mine: { name: 'Spanish 2', teacher: 'Ruth Lloves', room: '308' }, theirs: { name: 'Spanish II Conversation', teacher: 'Ruth Lloves', room: '308' } });
    expect(fresh.entry).toMatchObject({ name: 'Spanish II Conversation', aliases: [{ name: 'Spanish 2' }] });
    expect(() => f.directory.confirmSame(f.student, { schoolId: f.school.id, mine: lit, theirs: { ...lit, name: 'Chemistry' } })).toThrow('cannot be linked');
    expect(() => f.directory.confirmSame(f.student, { schoolId: f.school.id, mine: lit, theirs: { ...litE, room: '101' } })).toThrow('cannot be linked');
  });
});

describe('merge requests for support', () => {
  const lit = { name: 'Foundations in Literature: Inquiry and Analysis', teacher: 'Polly Duke', room: '406' };
  const litE = { ...lit, name: 'Foundations in Literature: Inquiry and Analysis E' };
  function school() {
    const f = fixture();
    const friend = f.user();
    f.service.join(friend, { schoolId: f.school.id, choice: 'community', grade: '9' });
    f.joinBeta(f.student); f.joinBeta(friend);
    const save = (id: string, classes: object[]) => f.service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: f.service.entity(id, 'personal'), data: { ...emptyPersonalSchedule(), grade: '9', classes } } as never);
    const classes = (id: string) => (readEntity(f.db, id, 'personal')!.data as { classes: { id: string; directoryId?: string }[] }).classes;
    const open = () => f.service.requests(f.owner).filter(request => request.kind === 'directory:merge');
    return { ...f, friend, save, classes, open };
  }

  it('files one request per entry when students link a new spelling, and merging keeps it under the chosen name', () => {
    const f = school();
    const entry = f.directory.publish(f.student, { schoolId: f.school.id, grade: '9', classes: [{ id: 'lit', ...lit }] }).links[0];
    f.directory.confirmSame(f.student, { schoolId: f.school.id, grade: '9', mine: { ...lit, directoryId: entry.directoryId }, theirs: litE });
    f.directory.confirmSame(f.friend, { schoolId: f.school.id, grade: '9', mine: litE, theirs: { ...lit, directoryId: entry.directoryId } });
    const [request] = f.open();
    expect(f.open()).toHaveLength(1);
    expect(request).toMatchObject({ userId: f.student, merge: { entry: { id: entry.directoryId, name: lit.name }, aliases: [litE], duplicates: [] } });
    expect(request.message).toContain('“Foundations in Literature: Inquiry and Analysis E” (Polly Duke · 406)');
    // Not counted against the student's own five open requests.
    for (let n = 0; n < 5; n++) f.service.feedback(f.student, `Feedback number ${n} for support`);
    f.directory.resolveMerge(f.owner, { requestId: request.id, decision: 'merge', name: litE.name });
    expect(f.directory.list(f.student, f.school.id).classes[0]).toMatchObject({ name: litE.name, aliases: [lit] });
    expect(f.open()).toHaveLength(0);
    expect(() => f.directory.resolveMerge(f.owner, { requestId: request.id, decision: 'merge' })).toThrow('already resolved');
    expect(() => f.directory.resolveMerge(f.student, { requestId: request.id, decision: 'merge' })).toThrow('Owner access');
  });

  it('merging folds a duplicate entry in and moves its students’ classes', () => {
    const f = school();
    const theirs = f.directory.save(f.owner, { schoolId: f.school.id, details: { ...litE, grades: ['9'] } });
    const mine = f.directory.save(f.owner, { schoolId: f.school.id, details: { ...lit, grades: ['9'] } });
    f.save(f.student, [{ id: 'lit', ...lit, directoryId: mine.id }]);
    f.save(f.friend, [{ id: 'lit-e', ...litE, directoryId: theirs.id }]);
    f.directory.confirmSame(f.student, { schoolId: f.school.id, grade: '9', mine: { ...lit, directoryId: mine.id }, theirs: { ...litE, directoryId: theirs.id } });
    const [request] = f.open();
    expect(request.merge).toMatchObject({ entry: { id: theirs.id, linked: 1 }, duplicates: [{ id: mine.id, linked: 1 }] });
    expect(f.directory.resolveMerge(f.owner, { requestId: request.id, decision: 'merge' })).toEqual({ classesChanged: 1 });
    expect(f.directory.list(f.student, f.school.id).classes.map(entry => entry.id)).toEqual([theirs.id]);
    expect(f.classes(f.student)[0].directoryId).toBe(theirs.id);
  });

  it('publishing relinks a class whose entry was removed', () => {
    const f = school();
    const spanish = { name: 'Honors Spanish 2', teacher: 'Rut Lloves', room: '303' };
    const old = f.directory.save(f.owner, { schoolId: f.school.id, details: { ...spanish, name: 'Spanish 2H', grades: ['9'] } });
    f.directory.remove(f.owner, { schoolId: f.school.id, id: old.id, expectedVersion: old.version });
    const live = f.directory.save(f.owner, { schoolId: f.school.id, details: { ...spanish, grades: ['9'] } });
    const links = f.directory.publish(f.friend, { schoolId: f.school.id, grade: '9', classes: [{ id: 'spanish', ...spanish, directoryId: old.id }, { id: 'live', ...spanish, directoryId: live.id }] }).links;
    expect(links).toEqual([{ id: 'spanish', directoryId: live.id }]);
  });

  it('keeping them separate drops the spelling, unlinks only its classes and refuses the same link again', () => {
    const f = school();
    const entry = f.directory.publish(f.student, { schoolId: f.school.id, grade: '9', classes: [{ id: 'lit', ...lit }] }).links[0];
    f.directory.confirmSame(f.student, { schoolId: f.school.id, grade: '9', mine: { ...lit, directoryId: entry.directoryId }, theirs: litE });
    f.save(f.student, [{ id: 'lit', ...lit, directoryId: entry.directoryId }]);
    f.save(f.friend, [{ id: 'lit-e', ...litE, directoryId: entry.directoryId }]);
    const [request] = f.open();
    expect(f.directory.resolveMerge(f.owner, { requestId: request.id, decision: 'separate' })).toEqual({ classesChanged: 1 });
    expect(f.classes(f.student)[0].directoryId).toBe(entry.directoryId);
    expect(f.classes(f.friend)[0].directoryId).toBeUndefined();
    expect(f.directory.list(f.student, f.school.id).classes[0]).toMatchObject({ separate: [litE] });
    expect(f.directory.list(f.student, f.school.id).classes[0].aliases).toBeUndefined();
    expect(() => f.directory.confirmSame(f.student, { schoolId: f.school.id, grade: '9', mine: { ...lit, directoryId: entry.directoryId }, theirs: litE })).toThrow('different classes');
    expect(f.open()).toHaveLength(0);
  });
});
