import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BetaDiagnostics } from '@/domain/betas';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { appRouter } from './router';
import { BETA_GUESS_LIMIT, WRONG_CODE_MESSAGE } from './betas';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const owner = randomUUID(), member = randomUUID(), other = randomUUID();
  const insert = db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)');
  for (const [id, email] of [[owner, 'owner@example.com'], [member, 'member@example.com'], [other, 'other@example.com']]) insert.run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
  const service = new Service(db, 'owner@example.com');
  const caller = (userId: string | null) => appRouter.createCaller({ service, userId, authAt: Date.now() });
  const create = (key = 'month-grid', code = 'GRID-2026', maxMembers: number | null = null) =>
    caller(owner).admin.betas.create({ accountId: owner, key, name: 'Month grid', description: 'Try the new month view.', code, maxMembers });
  const join = (userId: string, code: string) => caller(userId).beta.join({ accountId: userId, code });
  const keys = (userId: string) => service.workspace(userId).betas.map(beta => beta.key);
  return { db, service, owner, member, other, caller, create, join, keys };
}

const diagnostics: BetaDiagnostics = { page: '/schedule', theme: 'dark (system)', viewport: '390×844 @3x', browser: 'Test', online: true, betas: ['month-grid'], errors: ['12:00:00 boom'], at: '2026-10-19T12:00:00.000Z' };

describe('betas', () => {
  it('joins with the code in any case or spacing, keeps only its hash, and shows the beta in the workspace', async () => {
    const f = fixture();
    await f.create();
    expect(JSON.stringify(f.db.prepare('SELECT * FROM betas').all())).not.toMatch(/GRID-?2026/i);
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
    await f.create();
    for (let i = 0; i < BETA_GUESS_LIMIT; i++) await expect(f.join(f.member, `WRONG${i}`)).rejects.toThrow(WRONG_CODE_MESSAGE);
    await expect(f.join(f.member, 'GRID-2026')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    // The limit is per account.
    expect((await f.join(f.other, 'GRID-2026')).length).toBe(1);
  });

  it('says a paused or full beta is closed instead of calling the code wrong, and keeps members already in', async () => {
    const f = fixture();
    await f.create('month-grid', 'GRID-2026', 1);
    await f.join(f.member, 'GRID-2026');
    await expect(f.join(f.other, 'GRID-2026')).rejects.toThrow('Month grid is full.');
    await f.caller(f.owner).admin.betas.update({ accountId: f.owner, key: 'month-grid', name: 'Month grid', description: '', open: false, maxMembers: null });
    await expect(f.join(f.other, 'GRID-2026')).rejects.toThrow('isn’t taking new testers');
    expect(f.keys(f.member)).toEqual(['month-grid']);
  });

  it('leaves without a code, one beta or all of them', async () => {
    const f = fixture();
    await f.create();
    await f.create('quick-add', 'QUICK-ADD');
    await f.join(f.member, 'GRID-2026');
    await f.join(f.member, 'QUICK-ADD');
    expect((await f.caller(f.member).beta.leave({ accountId: f.member, key: 'month-grid' })).map(beta => beta.key)).toEqual(['quick-add']);
    await f.join(f.member, 'GRID-2026');
    expect(await f.caller(f.member).beta.leaveAll({ accountId: f.member })).toEqual([]);
    expect(f.keys(f.member)).toEqual([]);
    // Leaving something you are not in is fine too.
    expect(await f.caller(f.member).beta.leave({ accountId: f.member, key: 'month-grid' })).toEqual([]);
  });

  it('files beta feedback in the support inbox with its diagnostics and the server build, for members only', async () => {
    const f = fixture();
    await f.create();
    await expect(f.caller(f.member).beta.feedback({ accountId: f.member, key: 'month-grid', message: 'The grid is great', diagnostics })).rejects.toThrow('not in that beta');
    await f.join(f.member, 'GRID-2026');
    await f.caller(f.member).beta.feedback({ accountId: f.member, key: 'month-grid', message: 'Week 3 overlaps the header', diagnostics });
    const [request] = await f.caller(f.owner).admin.requests();
    expect(request).toMatchObject({ kind: 'beta:month-grid', message: 'Week 3 overlaps the header', userId: f.member, diagnostics: { ...diagnostics, build: expect.any(String) } });
    expect((await f.caller(f.owner).admin.betas.list())[0].openFeedback).toBe(1);
  });

  it('keeps owner tools from members and binds owner changes to the signed-in account', async () => {
    const f = fixture();
    await expect(f.caller(f.member).admin.betas.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(f.member).admin.betas.create({ accountId: f.member, key: 'x-beta', name: 'X beta', description: '', code: 'XXXX', maxMembers: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(f.owner).admin.betas.create({ accountId: f.member, key: 'x-beta', name: 'X beta', description: '', code: 'XXXX', maxMembers: null })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.member).beta.join({ accountId: f.other, code: 'XXXX' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('swaps a code without dropping members, refuses a code another beta uses, and closes a beta with its members', async () => {
    const f = fixture();
    await f.create();
    await f.join(f.member, 'GRID-2026');
    await expect(f.create('quick-add', 'grid 2026')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(f.create('month-grid', 'OTHER-CODE')).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.caller(f.owner).admin.betas.changeCode({ accountId: f.owner, key: 'month-grid', code: 'NEW-CODE' });
    await expect(f.join(f.other, 'GRID-2026')).rejects.toThrow(WRONG_CODE_MESSAGE);
    await f.join(f.other, 'NEW-CODE');
    expect((await f.caller(f.owner).admin.betas.list())[0].members.map(member => member.userId)).toEqual([f.member, f.other]);
    await f.caller(f.owner).admin.betas.removeMember({ accountId: f.owner, key: 'month-grid', userId: f.other });
    expect(f.keys(f.other)).toEqual([]);
    await f.caller(f.member).beta.feedback({ accountId: f.member, key: 'month-grid', message: 'Before it closes', diagnostics });
    await f.caller(f.owner).admin.betas.close({ accountId: f.owner, key: 'month-grid' });
    expect(f.keys(f.member)).toEqual([]);
    expect(await f.caller(f.owner).admin.betas.list()).toEqual([]);
    expect((await f.caller(f.owner).admin.requests()).map(request => request.kind)).toEqual(['beta:month-grid']);
    const actions = (f.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'beta.%' ORDER BY rowid").all() as { action: string }[]).map(row => row.action);
    expect(actions).toEqual(['beta.create', 'beta.join', 'beta.changeCode', 'beta.wrongCode', 'beta.join', 'beta.removeMember', 'beta.close']);
  });
});
