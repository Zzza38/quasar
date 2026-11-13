import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { MergeService } from './merges';
import { AiService, autoMergeable, type AiConfig, type AiFetch } from './ai';
import { mergeTasks, pickKeep } from '@/domain/task-merge';
import type { Task } from '@/domain/task';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const server: AiConfig = { url: 'https://ai.example/v1', key: 'k', model: 'm', json: true, openRouter: false };
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const bio = '11111111-1111-4111-8111-111111111111';
const base: Task = { title: 'Task', dueDate: null, dueTime: null, classId: null, notes: '', completed: false };
const imported = (uid: string, subscriptionId = 'feed-1'): Task['imported'] => ({ subscriptionId, uid, recurrenceId: null, startDate: '2026-11-03', startTime: null, endDate: null, endTime: null, timeZone: 'America/New_York', allDay: true, sourceRemoved: false, sourceUpdatedAt: '2026-10-29T12:00:00.000Z' });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const student = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(student, student, `${student}@example.com`, 'Student', 'Student Name', new Date().toISOString());
  const school = service.createSchool(student, { name: 'Merge High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(student, { schoolId: school.id, choice: 'community', grade: '9' });
  const put = (id: string, task: Partial<Task>, version = 1) => db.prepare("INSERT OR REPLACE INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,'task',?,?,0)").run(student, id, version, JSON.stringify({ ...base, ...task }));
  const read = (id: string) => { const row = db.prepare('SELECT version, data, deleted FROM entities WHERE owner_id=? AND id=?').get(student, id) as { version: number; data: string; deleted: number }; return { version: row.version, deleted: !!row.deleted, data: JSON.parse(row.data) }; };
  return { db, service, student, put, read, merges: new MergeService(service) };
}

describe('Merging tasks', () => {
  it.each(['deleted', 'changed'])('skips only a %s duplicate group after the model wait', async mutation => {
    const f = fixture();
    for (const id of ['a', 'b', 'c', 'd']) f.put(id, { title: 'Lab' });
    const fetcher = vi.fn<AiFetch>(async () => {
      if (mutation === 'deleted') f.db.prepare('UPDATE entities SET deleted=1 WHERE owner_id=? AND id=?').run(f.student, 'a');
      else f.put('a', { title: 'Different assignment' }, 2);
      return reply({ groups: [{ ids: ['a', 'b'], sure: true, reason: 'Same lab' }, { ids: ['c', 'd'], sure: true, reason: 'Same lab' }] });
    });
    const ai = new AiService(f.service, { config: server, fetcher, inBeta: () => true, codex: null });
    const result = await ai.duplicates(f.student, { auto: false });
    expect(result.groups.map(group => group.ids)).toEqual([['c', 'd']]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM ai_duplicate_checks WHERE owner_id=?').get(f.student)).toEqual({ n: 4 });
  });

  it.each([new Error('database failed'), new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'database failed' })])('propagates unrelated duplicate lookup errors: %s', async failure => {
    const f = fixture();
    f.put('a', { title: 'Lab' }); f.put('b', { title: 'Lab' });
    const fetcher = vi.fn<AiFetch>(async () => reply({ groups: [{ ids: ['a', 'b'], sure: true, reason: 'Same lab' }] }));
    const ai = new AiService(f.service, { config: server, fetcher, inBeta: () => true, codex: null });
    const lookup = vi.spyOn(MergeService.prototype, 'keepOf').mockImplementation(() => { throw failure; });
    try { await expect(ai.duplicates(f.student, { auto: false })).rejects.toThrow('database failed'); }
    finally { lookup.mockRestore(); }
  });

  it('keeps the live calendar import and copies over what only the student’s copy has', () => {
    const mine = { id: 'mine', task: { ...base, title: 'unit 2 test', classId: bio, priority: 'high' as const, notes: 'Study ch 4-5', completed: true, completedAt: '2026-10-28T20:00:00.000Z',
      subtasks: [{ id: '8b0c2f63-8d3f-4c3a-9b8e-3a5b1d2e4f60', title: 'Flashcards', completed: true }] } };
    const feed = { id: 'feed', task: { ...base, title: 'Unit 2 Test', dueDate: '2026-11-03', priority: 'normal' as const, imported: imported('u1') } };
    expect(pickKeep([mine, feed]).id).toBe('feed');
    // A source-removed import no longer updates, so the fuller copy wins.
    expect(pickKeep([mine, { ...feed, task: { ...feed.task, imported: { ...imported('u1')!, sourceRemoved: true } } }]).id).toBe('mine');
    expect(mergeTasks(feed.task, [mine.task])).toEqual({ ...feed.task, classId: bio, priority: 'high', notes: 'Study ch 4-5', completed: true, completedAt: '2026-10-28T20:00:00.000Z', subtasks: mine.task.subtasks });
    // Notes already there and steps with the same name aren't doubled.
    expect(mergeTasks(mine.task, [{ ...mine.task, notes: 'Study ch 4-5', subtasks: [{ id: '9b0c2f63-8d3f-4c3a-9b8e-3a5b1d2e4f61', title: ' flashcards ', completed: false }] }])).toEqual(mine.task);
  });

  it('merges on the server, lists it in the history, and undoes it, calendar link and all', () => {
    const f = fixture();
    f.put('mine', { title: 'unit 2 test', classId: bio, notes: 'Study ch 4-5' }, 3);
    f.put('ical_1', { title: 'Unit 2 Test', dueDate: '2026-11-03', imported: imported('u1') }, 2);
    const entry = f.merges.merge(f.student, { keepId: 'ical_1', removeIds: ['mine'] });
    expect(entry).toMatchObject({ source: 'manual', kept: { id: 'ical_1', title: 'Unit 2 Test', exists: true }, removed: [{ id: 'mine', title: 'unit 2 test' }], undoneAt: null });
    expect(f.read('ical_1')).toMatchObject({ version: 3, data: { classId: bio, notes: 'Study ch 4-5', imported: { uid: 'u1' } } });
    expect(f.read('mine')).toEqual({ version: 4, deleted: true, data: {} });
    expect(f.merges.history(f.student).map((row) => row.id)).toEqual([entry.id]);
    expect(f.merges.undo(f.student, { id: entry.id })).toEqual({ restored: 1, skipped: 0, keptChanged: false });
    expect(f.read('mine')).toMatchObject({ version: 5, deleted: false, data: { title: 'unit 2 test', notes: 'Study ch 4-5' } });
    expect(f.read('ical_1')).toMatchObject({ version: 4, data: { classId: null, notes: '', imported: { uid: 'u1' } } });
    expect(() => f.merges.undo(f.student, { id: entry.id })).toThrow('already undone');
    // Undoing marks the pair as not duplicates.
    expect(f.merges.apart(f.student, ['ical_1', 'mine'])).toBe(true);
  });

  it('leaves alone what changed after the merge, and refuses tasks that are gone', () => {
    const f = fixture();
    f.put('a', { title: 'Lab report', notes: 'a' }); f.put('b', { title: 'lab report' }); f.put('c', { title: 'Lab Report!' });
    const entry = f.merges.merge(f.student, { keepId: 'a', removeIds: ['b', 'c'] });
    f.put('a', { title: 'Lab report (edited)' }, 5);
    f.put('c', { title: 'Re-added' }, 7);
    expect(f.merges.undo(f.student, { id: entry.id })).toEqual({ restored: 1, skipped: 1, keptChanged: true });
    expect(f.read('a').data.title).toBe('Lab report (edited)');
    expect(f.read('c').data.title).toBe('Re-added');
    expect(() => f.merges.merge(f.student, { keepId: 'a', removeIds: ['nope'] })).toThrow('deleted or changed');
    expect(() => f.merges.merge(f.student, { keepId: 'a', removeIds: ['a'] })).toThrow('once');
  });

  it('distinguishes same-title copies in history and keeps their original details after edits', () => {
    const f = fixture();
    f.put('ical_1', { title: 'Popcorn Lab', dueDate: '2026-11-03', dueTime: '14:00', imported: imported('lab') });
    const steps = [{ id: randomUUID(), title: 'Record every measurement', completed: true }];
    f.put('sgy_123', { title: 'Popcorn Lab', classId: bio, dueDate: '2026-11-04', notes: 'Keep the full lab instructions.\nInclude all observations.', priority: 'high', subtasks: steps,
      reminder: { minutesBefore: 60, timeZone: 'America/New_York' } });
    f.merges.merge(f.student, { keepId: 'ical_1', removeIds: ['sgy_123'], reason: 'Same lab assignment' }, 'ai');
    f.put('ical_1', { title: 'Edited later', dueDate: '2026-11-10' }, 3);
    const [entry] = f.merges.history(f.student);
    expect(entry).toMatchObject({
      source: 'ai', reason: 'Same lab assignment',
      kept: { title: 'Popcorn Lab', origin: 'calendar', classId: null, dueDate: '2026-11-03', dueTime: '14:00', exists: true },
      removed: [{ title: 'Popcorn Lab', origin: 'schoology', classId: bio, dueDate: '2026-11-04', dueTime: null,
        details: { notes: 'Keep the full lab instructions.\nInclude all observations.', priority: 'high', subtasks: steps, reminder: { minutesBefore: 60, timeZone: 'America/New_York' } } }],
      current: { title: 'Edited later', details: { title: 'Edited later', dueDate: '2026-11-10' } },
    });
    expect(entry.kept.details?.imported?.uid).toBe('lab');
    f.db.prepare('UPDATE entities SET deleted=1 WHERE owner_id=? AND id=?').run(f.student, 'ical_1');
    expect(f.merges.history(f.student)[0].current).toBeNull();
  });
});

describe('AI duplicate check', () => {
  it('merges what it is sure of, leaves the rest as suggestions, and skips an unchanged list', async () => {
    const f = fixture();
    f.put('mine', { title: 'ch 5 hw', dueDate: '2026-11-03', completed: false });
    f.put('ical_1', { title: 'Chapter 5 Homework', dueDate: '2026-11-03', imported: imported('u1') });
    f.put('maybe-a', { title: 'Essay draft', dueDate: '2026-11-05' });
    f.put('maybe-b', { title: 'Essay', dueDate: '2026-11-06' });
    f.put('quiz-1', { title: 'Quiz 3.1', dueDate: '2026-11-04' });
    const fetcher = vi.fn<AiFetch>().mockImplementation(async () => reply({ groups: [
      { ids: ['mine', 'ical_1'], reason: 'Same chapter 5 homework', sure: true },
      { ids: ['maybe-a', 'maybe-b'], reason: 'Maybe the same essay', sure: false },
      { ids: ['quiz-1', 'nope'], reason: 'x', sure: true },
    ] }));
    const ai = new AiService(f.service, { config: server, fetcher, inBeta: () => true, codex: null, plus: () => false, billing: false });
    const result = await ai.duplicates(f.student, { auto: true });
    expect(result.merged).toMatchObject([{ source: 'ai', reason: 'Same chapter 5 homework', kept: { id: 'ical_1' }, removed: [{ id: 'mine' }] }]);
    expect(result.groups).toEqual([{ ids: ['maybe-a', 'maybe-b'], keepId: 'maybe-a', reason: 'Maybe the same essay', sure: false }]);
    expect(f.read('mine').deleted).toBe(true);
    const prompt = JSON.parse(String(fetcher.mock.calls[0][1].body)).messages[1].content as string;
    expect(prompt).toContain('id "ical_1" NEW: "Chapter 5 Homework" (due 2026-11-03, from a calendar)');
    // Nothing new since: the automatic check doesn't ask again.
    expect(await ai.duplicates(f.student, { auto: true })).toEqual({ checked: false, merged: [], groups: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A manual check asks, merges nothing, and drops pairs marked not duplicates.
    f.merges.notDuplicates(f.student, { ids: ['maybe-a', 'maybe-b'] });
    const manual = await ai.duplicates(f.student, { auto: false });
    expect(manual).toEqual({ checked: true, merged: [], groups: [] });
  });

  it('only merges small, close, non-repeating groups automatically', () => {
    const a = { ...base, dueDate: '2026-11-03' };
    expect(autoMergeable([a, { ...a, dueDate: '2026-11-04' }])).toBe(true);
    expect(autoMergeable([a, { ...a, dueDate: '2026-11-10' }])).toBe(false);
    expect(autoMergeable([a, a, a, a])).toBe(false);
    expect(autoMergeable([a, { ...a, recurrence: { frequency: 'weekly', interval: 1, until: null } }])).toBe(false);
    // Two events in one feed are two events; one from each feed may be the same.
    expect(autoMergeable([{ ...a, imported: imported('u1') }, { ...a, imported: imported('u2') }])).toBe(false);
    expect(autoMergeable([{ ...a, imported: imported('u1') }, { ...a, imported: imported('u2', 'feed-2') }])).toBe(true);
  });
});
