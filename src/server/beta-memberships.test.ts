import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createBeta, EMPTY_BETA_REGISTRY, readBetaRegistry, writeBetaRegistry } from './beta-registry';
import { removeRetiredBetaMemberships } from './beta-memberships';

it('the remove command deletes every member and cleanup can repair older removals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'beta-removal-'));
  const databasePath = join(directory, 'test.sqlite');
  const registryPath = join(directory, 'betas.json');
  const db = new Database(databasePath);
  try {
    db.exec("CREATE TABLE beta_members(beta_key TEXT, user_id TEXT); INSERT INTO beta_members VALUES ('ended', 'one'), ('ended', 'two'), ('active', 'one')");
    writeBetaRegistry(createBeta(createBeta(EMPTY_BETA_REGISTRY, { key: 'ended', name: 'Ended', public: true }), { key: 'active', name: 'Active', public: true }), registryPath);
    const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/beta.ts', ...args], {
      env: { ...process.env, DATABASE_PATH: databasePath, BETAS_PATH: registryPath }, encoding: 'utf8',
    });
    expect(run('remove', 'ended')).toContain('Removed 2 retired beta memberships.');
    expect(readBetaRegistry(registryPath).retired).toEqual(['ended']);
    expect(db.prepare('SELECT * FROM beta_members').all()).toEqual([{ beta_key: 'active', user_id: 'one' }]);
    db.exec("INSERT INTO beta_members VALUES ('ended', 'three')");
    expect(run('cleanup')).toContain('Removed 1 retired beta memberships.');
    expect(run('cleanup')).toContain('Removed 0 retired beta memberships.');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not delete memberships when the registry is unavailable or empty', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE beta_members(beta_key TEXT); INSERT INTO beta_members VALUES ('active')");
    expect(removeRetiredBetaMemberships(db, EMPTY_BETA_REGISTRY)).toBe(0);
    expect(db.prepare('SELECT * FROM beta_members').all()).toEqual([{ beta_key: 'active' }]);
  } finally { db.close(); }
});
