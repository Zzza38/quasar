import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BetaDiagnostics } from '@/domain/betas';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { appRouter } from './router';
import { BETA_GUESS_LIMIT, NOT_PUBLIC_MESSAGE, WRONG_CODE_MESSAGE } from './betas';
import { EMPTY_BETA_REGISTRY, createBeta, removeBeta, setBetaOpen, writeBetaRegistry, type BetaRegistry } from './beta-registry';

const databases: Db[] = [];
let directory = '';
let previousPath: string | undefined;
// Each test gets its own beta list, read the way the server reads it (BETAS_PATH, re-read when it changes).
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'quasar-betas-')); previousPath = process.env.BETAS_PATH; process.env.BETAS_PATH = join(directory, 'betas.json'); });
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
  if (previousPath === undefined) delete process.env.BETAS_PATH; else process.env.BETAS_PATH = previousPath;
});

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const owner = randomUUID(), member = randomUUID(), other = randomUUID();
  const insert = db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)');
  for (const [id, email] of [[owner, 'owner@example.com'], [member, 'member@example.com'], [other, 'other@example.com']]) insert.run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
  const service = new Service(db, 'owner@example.com');
  const caller = (userId: string | null) => appRouter.createCaller({ service, userId, authAt: Date.now() });
  let registry: BetaRegistry = createBeta(EMPTY_BETA_REGISTRY, { key: 'month-grid', name: 'Month grid', description: 'Try the new month view.', code: 'GRID-2026' });
  const save = (next: BetaRegistry) => { registry = next; writeBetaRegistry(next); };
  save(registry);
  const join = (userId: string, code: string) => caller(userId).beta.join({ accountId: userId, code });
  const keys = (userId: string) => service.workspace(userId).betas.map(beta => beta.key);
  return { db, service, owner, member, other, caller, join, keys, save, registry: () => registry };
}

const diagnostics: BetaDiagnostics = { page: '/schedule', theme: 'dark (system)', viewport: '390×844 @3x', browser: 'Test', online: true, betas: ['month-grid'], errors: ['12:00:00 boom'], at: '2026-10-19T12:00:00.000Z' };

describe('betas', () => {
  it('joins with the code in any case or spacing and shows the beta in the workspace', async () => {
    const f = fixture();
    expect(f.keys(f.member)).toEqual([]);
    const joined = await f.join(f.member, ' grid 2026 ');
    expect(joined.map(beta => beta.name)).toEqual(['Month grid']);
    expect(f.keys(f.member)).toEqual(['month-grid']);
    expect(f.keys(f.other)).toEqual([]);
    // Joining again is a no-op.
    expect((await f.join(f.member, 'GRID2026')).length).toBe(1);
  });

  it('refuses wrong codes and stops guessing after the limit, even with the right code', async () => {
    const f = fixture();
    for (let i = 0; i < BETA_GUESS_LIMIT; i++) await expect(f.join(f.member, `WRONG${i}`)).rejects.toThrow(WRONG_CODE_MESSAGE);
    await expect(f.join(f.member, 'GRID-2026')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    // The limit is per account.
    expect((await f.join(f.other, 'GRID-2026')).length).toBe(1);
  });

  it('follows changes to the beta list without a restart: a cap, a pause and a removal', async () => {
    const f = fixture();
    f.save({ ...f.registry(), betas: [{ ...f.registry().betas[0], maxMembers: 1 }] });
    await f.join(f.member, 'GRID-2026');
    await expect(f.join(f.other, 'GRID-2026')).rejects.toThrow('Month grid is full.');
    f.save(setBetaOpen({ ...f.registry(), betas: [{ ...f.registry().betas[0], maxMembers: null }] }, 'month-grid', false));
    await expect(f.join(f.other, 'GRID-2026')).rejects.toThrow('isn’t taking new testers');
    expect(f.keys(f.member)).toEqual(['month-grid']);
    // Removing the beta from the list switches it off for its members, and its code stops working.
    f.save(removeBeta(f.registry(), 'month-grid'));
    expect(f.keys(f.member)).toEqual([]);
    await expect(f.join(f.other, 'GRID-2026')).rejects.toThrow(WRONG_CODE_MESSAGE);
    await expect(f.caller(f.member).beta.feedback({ accountId: f.member, key: 'month-grid', message: 'After it ended', diagnostics })).rejects.toThrow('not in that beta');
  });

  it('lists open public betas and joins one with a tap, but never a private one', async () => {
    const f = fixture();
    f.save(createBeta(f.registry(), { key: 'quick-add', name: 'Quick add', description: 'Add tasks faster.', public: true, maxMembers: 1 }));
    f.save(setBetaOpen(createBeta(f.registry(), { key: 'paused-one', name: 'Paused one', public: true }), 'paused-one', false));
    const available = (userId: string) => f.caller(userId).beta.available();
    const enroll = (userId: string, key: string) => f.caller(userId).beta.enroll({ accountId: userId, key });
    // Private and paused betas are not on offer.
    expect(await available(f.member)).toEqual([{ key: 'quick-add', name: 'Quick add', description: 'Add tasks faster.', full: false }]);
    expect((await enroll(f.member, 'quick-add')).map(beta => ({ key: beta.key, public: beta.public }))).toEqual([{ key: 'quick-add', public: true }]);
    expect(f.keys(f.member)).toEqual(['quick-add']);
    // Joined betas drop off the list; a full one stays on it for others, marked full, and refuses them.
    expect(await available(f.member)).toEqual([]);
    expect(await available(f.other)).toEqual([expect.objectContaining({ key: 'quick-add', full: true })]);
    await expect(enroll(f.other, 'quick-add')).rejects.toThrow('Quick add is full.');
    // Joining again is a no-op; private betas, paused ones and unknown keys need the code or are refused.
    expect((await enroll(f.member, 'quick-add')).length).toBe(1);
    await expect(enroll(f.other, 'month-grid')).rejects.toThrow(NOT_PUBLIC_MESSAGE);
    await expect(enroll(f.other, 'no-such-beta')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(enroll(f.other, 'paused-one')).rejects.toThrow('isn’t taking new testers');
    await expect(f.caller(f.member).beta.enroll({ accountId: f.other, key: 'quick-add' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // No code was typed, so nothing counts toward the wrong-code limit.
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='beta.wrongCode'").get()).toEqual({ n: 0 });
  });

  it('leaves without a code, one beta or all of them', async () => {
    const f = fixture();
    f.save(createBeta(f.registry(), { key: 'quick-add', name: 'Quick add', code: 'QUICK-ADD' }));
    await f.join(f.member, 'GRID-2026');
    await f.join(f.member, 'QUICK-ADD');
    expect((await f.caller(f.member).beta.leave({ accountId: f.member, key: 'month-grid' })).map(beta => beta.key)).toEqual(['quick-add']);
    await f.join(f.member, 'GRID-2026');
    expect(await f.caller(f.member).beta.leaveAll({ accountId: f.member })).toEqual([]);
    expect(f.keys(f.member)).toEqual([]);
    expect(f.db.prepare('SELECT count(*) n FROM beta_members').get()).toEqual({ n: 0 });
    // Leaving something you are not in is fine too.
    expect(await f.caller(f.member).beta.leave({ accountId: f.member, key: 'month-grid' })).toEqual([]);
  });

  it('files beta feedback in the support inbox with its diagnostics and the server build, for members only', async () => {
    const f = fixture();
    await expect(f.caller(f.member).beta.feedback({ accountId: f.member, key: 'month-grid', message: 'The grid is great', diagnostics })).rejects.toThrow('not in that beta');
    await f.join(f.member, 'GRID-2026');
    await f.caller(f.member).beta.feedback({ accountId: f.member, key: 'month-grid', message: 'Week 3 overlaps the header', diagnostics });
    const [request] = await f.caller(f.owner).admin.requests();
    expect(request).toMatchObject({ kind: 'beta:month-grid', message: 'Week 3 overlaps the header', userId: f.member, diagnostics: { ...diagnostics, build: expect.any(String) } });
    expect((await f.caller(f.owner).admin.betas.list()).betas[0].openFeedback).toBe(1);
  });

  it('shows the owner every beta with its code and members, and lets the owner take a member out', async () => {
    const f = fixture();
    await f.join(f.member, 'GRID-2026');
    const list = await f.caller(f.owner).admin.betas.list();
    expect(list.path).toBe(process.env.BETAS_PATH);
    expect(list.betas).toEqual([expect.objectContaining({ key: 'month-grid', code: 'GRID-2026', open: true, members: [expect.objectContaining({ userId: f.member, email: 'member@example.com' })] })]);
    await f.caller(f.owner).admin.betas.removeMember({ accountId: f.owner, key: 'month-grid', userId: f.member });
    expect(f.keys(f.member)).toEqual([]);
    await expect(f.caller(f.owner).admin.betas.removeMember({ accountId: f.owner, key: 'month-grid', userId: f.member })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const actions = (f.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'beta.%' ORDER BY rowid").all() as { action: string }[]).map(row => row.action);
    expect(actions).toEqual(['beta.join', 'beta.removeMember']);
  });

  it('keeps owner tools and codes from members and binds changes to the signed-in account', async () => {
    const f = fixture();
    await expect(f.caller(f.member).admin.betas.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(f.member).admin.betas.removeMember({ accountId: f.member, key: 'month-grid', userId: f.other })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(f.owner).admin.betas.removeMember({ accountId: f.member, key: 'month-grid', userId: f.other })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.member).beta.join({ accountId: f.other, code: 'GRID-2026' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // A member's workspace names their betas but never carries a code.
    await f.join(f.member, 'GRID-2026');
    expect(JSON.stringify(f.service.workspace(f.member))).not.toContain('GRID-2026');
  });
});
