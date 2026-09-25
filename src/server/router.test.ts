import { TRPCError } from '@trpc/server';
import { getErrorShape } from '@trpc/server/unstable-core-do-not-import';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { appRouter, INVALID_INPUT_MESSAGE, OUTDATED_CLIENT_MESSAGE, SERVER_ERROR_MESSAGE } from './router';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { TASK_CLIENT_VERSION } from '@/domain/task';
import type { Entity, SyncResult } from '@/domain/sync';

const shapeOf = (error: TRPCError) => getErrorShape({ config: appRouter._def._config, error, type: 'mutation', path: 'profile.save', input: {}, ctx: undefined });

describe('error formatter', () => {
  it('replaces a serialized Zod issue list with plain text and keeps the code', () => {
    const parsed = z.object({ first: z.string().min(1) }).safeParse({ first: '' });
    if (parsed.success) throw new Error('expected a validation failure');
    const shape = shapeOf(new TRPCError({ code: 'BAD_REQUEST', cause: parsed.error }));
    expect(shape.message).toBe(INVALID_INPUT_MESSAGE);
    expect(shape.data.code).toBe('BAD_REQUEST');
    expect(shape.data.httpStatus).toBe(400);
  });

  it('keeps a custom schema message and replaces a built-in one', () => {
    const custom = z.object({ domain: z.string().refine((v) => v.includes('.'), 'Enter a domain such as students.example.org') }).safeParse({ domain: 'nope' });
    if (custom.success) throw new Error('expected a validation failure');
    expect(shapeOf(new TRPCError({ code: 'BAD_REQUEST', cause: custom.error })).message).toBe('Enter a domain such as students.example.org');
    const builtIn = z.object({ count: z.number().max(3) }).safeParse({ count: 9 });
    if (builtIn.success) throw new Error('expected a validation failure');
    expect(shapeOf(new TRPCError({ code: 'BAD_REQUEST', cause: builtIn.error })).message).toBe(INVALID_INPUT_MESSAGE);
  });

  it('hides the raw message of an unexpected server error such as a SqliteError', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users(email TEXT UNIQUE)');
    db.prepare('INSERT INTO users VALUES(?)').run('a@example.com');
    let thrown: unknown;
    try { db.prepare('INSERT INTO users VALUES(?)').run('a@example.com'); } catch (error) { thrown = error; } finally { db.close(); }
    expect(thrown).toBeInstanceOf(Error);
    // tRPC wraps a thrown plain Error like this, copying its message.
    const wrapped = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: thrown as Error });
    expect(wrapped.message).toContain('UNIQUE constraint failed');
    const shape = shapeOf(wrapped);
    expect(shape.message).toBe(SERVER_ERROR_MESSAGE);
    expect(shape.data.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('passes messages written for students through unchanged', () => {
    const shape = shapeOf(new TRPCError({ code: 'CONFLICT', message: 'This directory class changed. Reload and review it before saving.' }));
    expect(shape.message).toBe('This directory class changed. Reload and review it before saving.');
    expect(shape.data.code).toBe('CONFLICT');
  });
});

describe('task data for clients built before completedAt', () => {
  const databases: Db[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  function fixture() {
    const db = openDatabase(':memory:'); databases.push(db);
    const accountId = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(accountId, accountId, 'student@example.com', 'Student', 'Student Name', new Date().toISOString());
    return { accountId, caller: appRouter.createCaller({ userId: accountId, service: new Service(db, 'owner@example.com') }) };
  }
  const open = { title: 'Read chapter 1', dueDate: null, dueTime: null, classId: null, notes: '', completed: false };
  const applied = (result: SyncResult): Entity => { if (result.status !== 'applied') throw new Error('Expected applied'); return result.entity; };
  const current = { clientVersion: TASK_CLIENT_VERSION };

  it('leaves completedAt out of what an older client receives, while a current client gets it', async () => {
    const { accountId, caller } = fixture();
    const created = applied(await caller.sync({ accountId, mutationId: randomUUID(), id: 't1', kind: 'task', base: null, data: open }));
    // An older bundle (no clientVersion) checks the task off: its reply must still pass its strict task schema.
    const completion = { accountId, mutationId: randomUUID(), id: 't1', kind: 'task' as const, base: created, data: { ...open, completed: true } };
    const done = applied(await caller.sync(completion));
    expect(done.data).toEqual({ ...open, completed: true });
    expect(applied(await caller.sync(completion)).data).not.toHaveProperty('completedAt');
    expect((await caller.workspace()).entities.find(entity => entity.id === 't1')!.data).not.toHaveProperty('completedAt');
    // The stamp is stored, and a current client (including a replay of the same receipt) sees it.
    const stored = (await caller.workspace(current)).entities.find(entity => entity.id === 't1')!;
    expect(typeof stored.data.completedAt).toBe('string');
    expect(applied(await caller.sync({ ...completion, ...current })).data.completedAt).toBe(stored.data.completedAt);
  });

  it('accepts an older client\'s base without completedAt and keeps the stored stamp', async () => {
    const { accountId, caller } = fixture();
    const created = applied(await caller.sync({ accountId, mutationId: randomUUID(), id: 't1', kind: 'task', base: null, data: open, ...current }));
    const done = applied(await caller.sync({ accountId, mutationId: randomUUID(), id: 't1', kind: 'task', base: created, data: { ...created.data, completed: true }, ...current }));
    const stamp = done.data.completedAt;
    expect(typeof stamp).toBe('string');
    // The older tab only ever saw the task without the stamp, and renames it.
    const { completedAt: _completedAt, ...seen } = done.data;
    const renamed = applied(await caller.sync({ accountId, mutationId: randomUUID(), id: 't1', kind: 'task', base: { ...done, data: seen }, data: { ...seen, title: 'Read chapter 2' } }));
    expect(renamed.data).toEqual({ ...seen, title: 'Read chapter 2' });
    const stored = (await caller.workspace(current)).entities.find(entity => entity.id === 't1')!;
    expect(stored.data).toMatchObject({ title: 'Read chapter 2', completed: true, completedAt: stamp });
  });
});

describe('requests from a bundle built before the current API', () => {
  const databases: Db[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  function fixture() {
    const db = openDatabase(':memory:'); databases.push(db);
    const accountId = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(accountId, accountId, 'student@example.com', 'Student', 'Student Name', new Date().toISOString());
    // The caller is typed for the current API; an older bundle sends what its own types allowed.
    return { accountId, caller: appRouter.createCaller({ userId: accountId, service: new Service(db, 'owner@example.com') }) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>> };
  }
  const outdated = { code: 'PRECONDITION_FAILED', message: OUTDATED_CLIENT_MESSAGE };

  it('asks it to reload instead of failing with a vague validation message or crashing on a school summary', async () => {
    const { caller } = fixture();
    await expect(caller.profile.save({ displayName: 'Maya', fullName: 'Maya Chen' })).rejects.toMatchObject(outdated);
    await expect(caller.school.acknowledge({ version: 2 })).rejects.toMatchObject(outdated);
    await expect(caller.school.feedback({ message: 'The bell times look wrong.' })).rejects.toMatchObject(outdated);
    await expect(caller.school.list({ query: '' })).rejects.toMatchObject(outdated);
  });

  it('still validates what a current client sends, and serves it', async () => {
    const { accountId, caller } = fixture();
    await expect(caller.profile.save({ accountId: 'not-an-id', displayName: 'Maya', fullName: 'Maya Chen' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.profile.save({ accountId, displayName: 'Maya', fullName: 'Maya Chen' })).resolves.toMatchObject({ displayName: 'Maya' });
    await expect(caller.school.list({ query: '', summaries: true })).resolves.toEqual([]);
  });
});
