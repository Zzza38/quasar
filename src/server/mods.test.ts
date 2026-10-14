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
  const owner = randomUUID(), member = randomUUID();
  const insert = db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)');
  for (const [id, email] of [[owner, 'owner@example.com'], [member, 'member@example.com']]) insert.run(id, id, email, 'Student', 'Student Name', new Date().toISOString());
  const service = new Service(db, 'owner@example.com');
  const caller = (userId: string | null, authAt: number | null = Date.now()) => appRouter.createCaller({ service, userId, authAt });
  const set = (mod: ModId, state: ModOverrideState) => caller(owner).admin.setModOverride({ accountId: owner, mod, state });
  return { db, owner, member, caller, set };
}

describe('global mod overrides', () => {
  it('lets everyone read only policy, with defaults before an owner sets anything', async () => {
    const f = fixture();
    expect(await f.caller(null).mods()).toEqual(DEFAULT_MOD_OVERRIDES);
    await f.set('rgb', 'on');
    expect(await f.caller(null).mods()).toEqual({ ...DEFAULT_MOD_OVERRIDES, rgb: 'on' });
    expect(await f.caller(f.member).mods()).toEqual(await f.caller(null).mods());
  });

  it('requires an owner and a recent sign-in, and records denied member access', async () => {
    const f = fixture();
    const input = { accountId: f.owner, mod: 'shy' as const, state: 'on' as const };
    await expect(f.caller(null).admin.setModOverride(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.member).admin.setModOverride({ ...input, accountId: f.member })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const authAt of [null, Date.now() - ADMIN_SIGN_IN_MAX_AGE_MS - 1000]) {
      await expect(f.caller(f.owner, authAt).admin.setModOverride(input)).rejects.toMatchObject({ code: 'FORBIDDEN', message: ADMIN_REAUTH_MESSAGE });
    }
    expect(await f.caller(null).mods()).toEqual(DEFAULT_MOD_OVERRIDES);
    expect(f.db.prepare("SELECT action FROM audit_log WHERE action='admin.denied'").all()).toHaveLength(1);
  });

  it('rejects account switches and unknown mods or states without writing', async () => {
    const f = fixture();
    await expect(f.caller(f.owner).admin.setModOverride({ accountId: f.member, mod: 'rgb', state: 'on' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(f.owner).admin.setModOverride({ accountId: f.owner, mod: 'bogus' as ModId, state: 'on' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(f.caller(f.owner).admin.setModOverride({ accountId: f.owner, mod: 'rgb', state: 'bogus' as ModOverrideState })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await f.caller(null).mods()).toEqual(DEFAULT_MOD_OVERRIDES);
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
    const caller = appRouter.createCaller({ service: new Service(reopened, 'owner@example.com'), userId: null });
    expect(await caller.mods()).toEqual({ rgb: 'default', attention: 'off', backwards: 'default', shy: 'on' });
    const audits = reopened.prepare("SELECT actor_id,detail FROM audit_log WHERE action='admin.modOverride' ORDER BY id").all() as { actor_id: string; detail: string }[];
    expect(audits).toHaveLength(4);
    expect(audits.every(row => row.actor_id === f.owner)).toBe(true);
    expect(JSON.parse(audits[3]!.detail)).toEqual({ mod: 'rgb', from: 'on', to: 'default' });
  });
});
