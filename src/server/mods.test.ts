import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MOD_OVERRIDES, type ModId, type ModOverrideState } from '@/domain/mods';
import { ADMIN_REAUTH_MESSAGE, ADMIN_SIGN_IN_MAX_AGE_MS } from '@/lib/admin-session';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { appRouter } from './router';

const databases: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(path = ':memory:') {
  const db = openDatabase(path); databases.push(db);
  const owner = randomUUID(), member = randomUUID(), other = randomUUID();
  const insert = db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)');
  for (const [id, email] of [[owner, 'owner@example.com'], [member, 'member@example.com'], [other, 'other@example.com']]) insert.run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
  const service = new Service(db, 'owner@example.com');
  const caller = (userId: string | null, authAt: number | null = Date.now()) => appRouter.createCaller({ service, userId, authAt });
  const set = (mod: ModId, state: ModOverrideState, userId = member) => caller(owner).admin.setModOverride({ accountId: owner, userId, mod, state });
  return { db, owner, member, other, caller, set };
}

describe('per-account mod overrides', () => {
  it('returns only the signed-in account policy, isolating the owner, two members and signed-out clients', async () => {
    const f = fixture();
    expect(await f.caller(null).mods()).toEqual({ accountId: null, overrides: DEFAULT_MOD_OVERRIDES });
    await f.set('rgb', 'on');
    await f.set('rgb', 'off', f.other);
    expect(await f.caller(f.member).mods()).toEqual({ accountId: f.member, overrides: { ...DEFAULT_MOD_OVERRIDES, rgb: 'on' } });
    expect(await f.caller(f.other).mods()).toEqual({ accountId: f.other, overrides: { ...DEFAULT_MOD_OVERRIDES, rgb: 'off' } });
    expect(await f.caller(f.owner).mods()).toEqual({ accountId: f.owner, overrides: DEFAULT_MOD_OVERRIDES });
    expect(await f.caller(null).mods()).toEqual({ accountId: null, overrides: DEFAULT_MOD_OVERRIDES });
    expect(await f.caller(f.owner).admin.modOverrides({ userId: f.member })).toEqual({ ...DEFAULT_MOD_OVERRIDES, rgb: 'on' });
    await expect(f.caller(f.member).admin.modOverrides({ userId: f.other })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(null).admin.modOverrides({ userId: f.member })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('requires an owner and a recent sign-in, and records denied member access', async () => {
    const f = fixture();
    const input = { accountId: f.owner, userId: f.member, mod: 'shy' as const, state: 'on' as const };
    await expect(f.caller(null).admin.setModOverride(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.member).admin.setModOverride({ ...input, accountId: f.member })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const authAt of [null, Date.now() - ADMIN_SIGN_IN_MAX_AGE_MS - 1000]) {
      await expect(f.caller(f.owner, authAt).admin.setModOverride(input)).rejects.toMatchObject({ code: 'FORBIDDEN', message: ADMIN_REAUTH_MESSAGE });
      await expect(f.caller(f.owner, authAt).admin.modOverrides({ userId: f.member })).rejects.toMatchObject({ code: 'FORBIDDEN', message: ADMIN_REAUTH_MESSAGE });
    }
    expect(await f.caller(f.member).mods()).toEqual({ accountId: f.member, overrides: DEFAULT_MOD_OVERRIDES });
    expect(f.db.prepare("SELECT action FROM audit_log WHERE action='admin.denied'").all()).toHaveLength(1);
  });

  it('rejects account switches and unknown mods or states without writing', async () => {
    const f = fixture();
    await expect(f.caller(f.owner).admin.setModOverride({ accountId: f.member, userId: f.member, mod: 'rgb', state: 'on' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.owner).admin.setModOverride({ accountId: f.owner, userId: f.member, mod: 'bogus' as ModId, state: 'on' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(f.caller(f.owner).admin.setModOverride({ accountId: f.owner, userId: f.member, mod: 'rgb', state: 'bogus' as ModOverrideState })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const missing = randomUUID();
    await expect(f.caller(f.owner).admin.setModOverride({ accountId: f.owner, userId: missing, mod: 'rgb', state: 'on' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.caller(f.owner).admin.modOverrides({ userId: missing })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.db.prepare('SELECT * FROM user_mod_overrides').all()).toHaveLength(0);
    expect(await f.caller(f.member).mods()).toEqual({ accountId: f.member, overrides: DEFAULT_MOD_OVERRIDES });
  });

  it('persists independent changes across database reopening, and allows releasing a forced mod', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quasar-mod-policy-')); directories.push(directory);
    const path = join(directory, 'test.sqlite');
    const f = fixture(path);
    await f.set('rgb', 'on');
    await f.set('attention', 'off');
    await f.set('shy', 'on');
    await f.set('rgb', 'default');
    f.db.close();
    const reopened = openDatabase(path); databases.push(reopened);
    const caller = appRouter.createCaller({ service: new Service(reopened, 'owner@example.com'), userId: f.member });
    expect(await caller.mods()).toEqual({ accountId: f.member, overrides: { rgb: 'default', attention: 'off', backwards: 'default', shy: 'on', spin: 'default' } });
    const audits = reopened.prepare("SELECT actor_id,detail FROM audit_log WHERE action='admin.modOverride' ORDER BY id").all() as { actor_id: string; detail: string }[];
    expect(audits).toHaveLength(4);
    expect(audits.every(row => row.actor_id === f.owner)).toBe(true);
    expect(JSON.parse(audits[3]!.detail)).toEqual({ userId: f.member, mod: 'rgb', from: 'on', to: 'default' });
  });
});
